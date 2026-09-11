/**
 * Hand one clone an assertion naming itself.
 *
 * `POST /api/public/anthropic/identity`, authenticated with the clone's own
 * Mission Control key (`anthropic:federate`). The answer is everything the
 * clone needs to exchange at Anthropic's token endpoint and nothing else.
 *
 * ## Why this is not a broker
 *
 * Didit and Airtable are brokered: Mission Control holds the credential and
 * makes the vendor call. This does not, and the difference is the traffic.
 * Model calls are the highest-volume vendor traffic in the product, they
 * stream, and they run against a ~150s edge ceiling — so Mission Control sits
 * on the TOKEN path, about once an hour per clone, and inference goes clone →
 * Anthropic directly. A broker in front of every report generation would buy a
 * new failure domain and nothing else.
 *
 * ## What a caller can and cannot ask for
 *
 * Nothing in the body names a workspace, a service account or a rule that this
 * endpoint will honour: every identifier in the answer is read from the
 * authenticated clone's own row. The optional `workspace_id` in the body is
 * checked AGAINST that row and refused when it disagrees, rather than quietly
 * answered for the right one — a silent correction makes a misconfiguration
 * permanent and invisible, and a clone asking for a workspace that is not its
 * own is worth telling.
 *
 * The assertion itself is bounded on three axes: five minutes, one subject,
 * and an audience of Anthropic's token endpoint. It cannot be replayed
 * elsewhere, it names one clone, and Anthropic accepts its `jti` exactly once.
 */
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import {
  FEDERATION_ORG_ENV,
  federationSubject,
  identityRefusal,
} from "@/server/anthropicFederation.pure";
import { signCloneAssertion } from "@/server/anthropicOidc.server";

/** Anthropic's token endpoint — the audience the assertion is bound to. */
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

/**
 * Mission Control's own refusals carry this header; what it relays never does.
 *
 * Both ends answer 401 with similar JSON and send an operator to opposite
 * remedies, which is the lesson the verification broker already paid for.
 */
const refuse = (error: string, message: string, status: number) =>
  new Response(JSON.stringify({ ok: false, error, message }), {
    status,
    headers: {
      "content-type": "application/json",
      "x-mission-control-refusal": error,
    },
  });

export const Route = createFileRoute("/api/public/anthropic/identity")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "anthropic:federate",
        );
        if (!key) {
          return refuse(
            "unauthorized",
            "This Mission Control key is unknown, revoked, or lacks the anthropic:federate scope.",
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
         * A prime-scoped key has no clone, and therefore no workspace of its
         * own to be federated into. The prime holds the organisation key
         * directly; there is no case where this endpoint is how it reaches
         * Anthropic.
         */
        if (!key.clone_id) {
          return refuse(
            "not_a_clone_key",
            "This is a prime-scoped key. The prime reaches Anthropic with the key it already holds.",
            403,
          );
        }

        const identity = await supabaseAdmin
          .from("clone_anthropic_identity")
          .select("workspace_id, service_account_id, federation_rule_id")
          .eq("clone_id", key.clone_id)
          .maybeSingle();

        if (identity.error) {
          // A read that FAILED is not a clone that does not federate: 503 so
          // the caller retries rather than falling back to a key it may no
          // longer hold.
          return refuse(
            "unreadable",
            "This deployment's Anthropic identity could not be read. Try again shortly.",
            503,
          );
        }

        let body: { workspace_id?: string } = {};
        try {
          body = (await request.json()) as { workspace_id?: string };
        } catch {
          body = {};
        }

        const refusal = identityRefusal({
          requestedWorkspaceId: body?.workspace_id,
          cloneWorkspaceId: identity.data?.workspace_id ?? null,
          federationRuleId: identity.data?.federation_rule_id ?? null,
          serviceAccountId: identity.data?.service_account_id ?? null,
        });
        if (refusal) return refuse("not_federated", refusal, 403);

        const organizationId = (process.env[FEDERATION_ORG_ENV] ?? "").trim();
        if (!organizationId) {
          return refuse(
            "unconfigured",
            `Mission Control holds no ${FEDERATION_ORG_ENV}, so it cannot say which organisation ` +
              "this token belongs to.",
            503,
          );
        }

        let assertion: string;
        try {
          assertion = await signCloneAssertion({
            subject: federationSubject(key.clone_id),
            audience: TOKEN_URL,
          });
        } catch (e) {
          return refuse(
            "unsigned",
            `Mission Control could not sign an Anthropic identity: ${
              e instanceof Error ? e.message : String(e)
            }`,
            503,
          );
        }

        /*
         * The assertion, and the four identifiers the exchange needs. No
         * credential of Mission Control's own is in this answer and none of it
         * is useful to any clone but this one.
         */
        return new Response(
          JSON.stringify({
            assertion,
            organization_id: organizationId,
            service_account_id: identity.data!.service_account_id,
            federation_rule_id: identity.data!.federation_rule_id,
            workspace_id: identity.data!.workspace_id,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              // A positive marker of arrival, so a clone can tell "Mission
              // Control answered" from "something on the way answered".
              "x-mission-control-endpoint": "anthropic-identity",
              // A five-minute credential must not be cached by anything.
              "cache-control": "no-store",
            },
          },
        );
      },
    },
  },
});
