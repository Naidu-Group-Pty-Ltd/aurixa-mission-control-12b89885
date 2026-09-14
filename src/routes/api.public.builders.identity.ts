/**
 * Hand one workspace an assertion the Builders Network can verify.
 *
 * `POST /api/public/builders/identity`, authenticated with the clone's own
 * Mission Control key (`builders:federate`). The answer is a five-minute
 * signed assertion naming this workspace — subject `clone:<uuid>`, audience
 * the network's origin — plus the profile the network's registry reads out
 * of it. The network verifies OFFLINE against the JWKS at
 * `/api/public/builders/jwks`: Mission Control sits on the token path, about
 * once an hour per connected workspace, and portal traffic never touches it.
 *
 * This is the second relying party on the federation machinery
 * `anthropic:federate` proved out, deliberately a SIBLING route rather than a
 * generalisation of the Anthropic one: that handler is vendor-specific in
 * ways worth keeping (its audience is Anthropic's token URL, its answer
 * carries Anthropic rule ids read from `clone_anthropic_identity`), and one
 * handler serving two vendors is one refactor away from serving one of them
 * wrongly. What IS shared is what must never fork — the signing key, the
 * subject scheme, the claim lifetimes and the merge rule — all imported from
 * the modules the Anthropic flow already uses.
 *
 * ## What a caller can and cannot ask for
 *
 * Nothing in the body names a workspace this endpoint will honour: every
 * claim in the assertion is read from the authenticated clone's own row. The
 * optional `clone_id` in the body is checked AGAINST that key and refused
 * when it disagrees — a silent correction makes a misconfiguration permanent
 * and invisible.
 *
 * The per-workspace opt-in IS the scope: `builders:federate` defaults off in
 * the catalogue, so a workspace federates only after an operator granted it,
 * and revoking the scope is a complete rollback of Phase 1 for that
 * workspace.
 */
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { federationSubject } from "@/server/anthropicFederation.pure";
import {
  BUILDERS_AUDIENCE,
  BUILDERS_IDENTITY_ENDPOINT,
  BUILDERS_JWKS_PATH,
  buildersIdentityRefusal,
  buildersProfileClaims,
  buildersScopesOf,
} from "@/server/buildersFederation.pure";
import {
  missionControlOrigin,
  signCloneAssertion,
  signingKeyPresent,
} from "@/server/anthropicOidc.server";

/**
 * Mission Control's own refusals carry this header; what it relays never
 * does. Both ends of a brokered path answer 401 with similar JSON and send an
 * operator to opposite remedies — the verification broker paid for that
 * lesson and every refusal surface since carries the marker.
 */
const refuse = (error: string, message: string, status: number) =>
  new Response(JSON.stringify({ ok: false, error, message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-mission-control-refusal": error,
    },
  });

export const Route = createFileRoute("/api/public/builders/identity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "builders:federate",
        );
        if (!key) {
          return refuse(
            "unauthorized",
            "This Mission Control key is unknown, revoked, or lacks the builders:federate scope.",
            401,
          );
        }

        const rl = await checkRateLimit(key.id).catch(() => ({ ok: true as const }));
        if (!rl.ok) {
          const res = refuse("rate_limited", "Too many identity requests.", 429);
          const retry = (rl as { retry_after_seconds?: number }).retry_after_seconds;
          if (retry != null) res.headers.set("Retry-After", String(retry));
          return res;
        }

        /*
         * A prime-scoped key has no clone. The network's counterparty is a
         * WORKSPACE — the operator plane reaches the network's admin API
         * under `builders:operate`, which is a different door on purpose.
         */
        if (!key.clone_id) {
          return refuse(
            "not_a_clone_key",
            "This is a prime-scoped key. Only a workspace federates into the Builders Network; " +
              "the operator plane uses builders:operate against the network's admin API.",
            403,
          );
        }

        const row = await supabaseAdmin
          .from("clones")
          .select("slug, name")
          .eq("id", key.clone_id)
          .maybeSingle();

        if (row.error) {
          // A read that FAILED is not a workspace that is absent: 503 so the
          // caller retries rather than concluding it was never federated.
          return refuse(
            "unreadable",
            "This workspace's directory row could not be read. Try again shortly.",
            503,
          );
        }
        if (!row.data) {
          // Absent IS final: a key whose clone row is gone speaks for nobody.
          return refuse(
            "unknown_workspace",
            "No workspace exists for this key's clone id, so there is no identity to assert.",
            403,
          );
        }

        let body: { clone_id?: string } = {};
        try {
          body = (await request.json()) as { clone_id?: string };
        } catch {
          body = {};
        }
        const refusal = buildersIdentityRefusal({
          requestedCloneId: body?.clone_id,
          keyCloneId: key.clone_id,
        });
        if (refusal) return refuse("wrong_workspace", refusal, 403);

        if (!signingKeyPresent()) {
          return refuse(
            "unconfigured",
            "Mission Control holds no federation signing key, so it cannot assert anyone's identity.",
            503,
          );
        }

        let assertion: string;
        try {
          assertion = await signCloneAssertion({
            subject: federationSubject(key.clone_id),
            audience: BUILDERS_AUDIENCE,
            claims: buildersProfileClaims({
              cloneId: key.clone_id,
              slug: row.data.slug,
              displayName: row.data.name ?? null,
              scopes: key.scopes,
            }),
          });
        } catch (e) {
          return refuse(
            "unsigned",
            `Mission Control could not sign a Builders Network identity: ${
              e instanceof Error ? e.message : String(e)
            }`,
            503,
          );
        }

        /*
         * The assertion and where to verify it. Everything else in this
         * answer is a convenience copy of what the token already says — the
         * network must read the SIGNED values, never these.
         */
        return new Response(
          JSON.stringify({
            assertion,
            audience: BUILDERS_AUDIENCE,
            clone_id: key.clone_id,
            slug: row.data.slug,
            display_name: row.data.name ?? null,
            scopes: buildersScopesOf(key.scopes),
            jwks_url: `${missionControlOrigin()}${BUILDERS_JWKS_PATH}`,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              // A positive marker of arrival, so a clone can tell "Mission
              // Control answered" from "something on the way answered".
              "x-mission-control-endpoint": BUILDERS_IDENTITY_ENDPOINT,
              // A five-minute credential must not be cached by anything.
              "cache-control": "no-store",
            },
          },
        );
      },
    },
  },
});
