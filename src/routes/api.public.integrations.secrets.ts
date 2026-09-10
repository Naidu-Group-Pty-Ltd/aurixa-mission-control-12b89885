/**
 * Write vendor credentials a tenant typed on its OWN Integrations page into
 * its OWN Supabase project's function environment.
 *
 * `POST /api/public/integrations/secrets`, body `{ secrets: [{name, value}] }`,
 * authenticated with the clone's own Mission Control key (`integrations:write`).
 *
 * ## Why this endpoint exists
 *
 * The runtime reads vendor keys from the function environment. Writing that
 * environment needs a Supabase management token, which is scoped to an ACCOUNT
 * rather than a project — it reaches every project this organisation owns,
 * including the prime's and this one — and Supabase mints no per-project
 * variant. So it never travels to a tenant, and until now that meant the
 * Integrations page on every clone had one button that needed a credential the
 * clone must not hold, and one that wrote to a table nothing reads.
 *
 * The credential stays here and the CALL travels, which is the shape Mission
 * Control already uses for Didit and for Airtable.
 *
 * ## The two things that make it safe
 *
 * **The caller cannot name a project.** There is no project field in the body
 * and none in this file. `resolveCloneSecretTarget` derives it from the
 * presented key, and refuses Mission Control's own project, refuses the
 * prime's, and refuses when it cannot tell which is which.
 *
 * **The deny-list here is independent of the prime's.** The caller is a
 * tenant's edge function; what arrives is a request, not an instruction.
 * `integrationSecretBroker.pure.ts` carries the list and the reasoning, and a
 * test asserts it stays a superset of the prime's own.
 */
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import {
  planIntegrationSecretWrite,
  refusalHeaders,
  relayHeaders,
} from "@/server/integrationSecretBroker.pure";

/** A refusal this endpoint makes, marked as ours. */
const refuse = (error: string, extra: Record<string, unknown>, status: number) =>
  new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: refusalHeaders(error),
  });

export const Route = createFileRoute("/api/public/integrations/secrets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(
          request.headers.get("x-clone-api-key"),
          "integrations:write",
        );
        if (!key) {
          return refuse(
            "unauthorized",
            {
              message:
                "This Mission Control key is unknown, revoked, or lacks the integrations:write scope.",
            },
            401,
          );
        }

        const rl = await checkRateLimit(key.id).catch(() => ({ ok: true as const }));
        if (!rl.ok) {
          const res = refuse(
            "rate_limited",
            { retry_after_seconds: (rl as { retry_after_seconds?: number }).retry_after_seconds },
            429,
          );
          const retry = (rl as { retry_after_seconds?: number }).retry_after_seconds;
          if (retry != null) res.headers.set("Retry-After", String(retry));
          return res;
        }

        /*
         * A prime-scoped key has no clone to resolve a project from.
         *
         * Refused rather than falling back to the prime's own project: the
         * prime holds its own management token and writes its own secrets
         * directly, so there is no case where this endpoint should be the way
         * anything reaches it — and a fallback here would be a route by which
         * a key could write the prime's environment.
         */
        if (!key.clone_id) {
          return refuse(
            "not_a_clone_key",
            {
              message:
                "This is a prime-scoped key. A deployment that holds its own Supabase management " +
                "token writes its own secrets directly and never through this broker.",
            },
            403,
          );
        }

        let body: unknown = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }

        const plan = planIntegrationSecretWrite(body);
        if (plan.fatal) {
          return refuse("invalid_body", { message: plan.fatal }, 400);
        }
        if (plan.write.length === 0) {
          /*
           * Everything was refused. A 200 with an empty list would let the
           * page print a green toast over a name that was declined, which is
           * the failure this whole area already had once — a Save that
           * reported success and changed nothing.
           */
          return refuse(
            "no_writable_secrets",
            {
              message: "Every name in this request was refused.",
              refused: plan.refused,
            },
            400,
          );
        }

        const { resolveCloneSecretTarget, CloneSecretTargetError } =
          await import("@/server/cloneAllowedOrigins.server");

        let target: { cloneId: string; cloneName: string; projectRef: string };
        try {
          target = await resolveCloneSecretTarget(supabaseAdmin, key.clone_id);
        } catch (e) {
          if (e instanceof CloneSecretTargetError) {
            /*
             * `unreadable` is a read that FAILED, which is not a clone that is
             * ABSENT — it answers 503 so the caller retries, while every other
             * refusal is final and answers 409.
             */
            return refuse(e.reason, { message: e.message }, e.reason === "unreadable" ? 503 : 409);
          }
          throw e;
        }

        const { setCloneSecretValues } = await import("@/server/backend-provisioning.server");
        const res = await setCloneSecretValues(target.projectRef, plan.write);

        const now = new Date().toISOString();
        const names = plan.write.map((s) => s.name);

        /*
         * The ledger is what the clone page reads, so a secret written here
         * and not recorded is a divergence with no signal anywhere. The status
         * is `set`: the tenant supplied this value, so it is neither
         * `inherited` (forwarded from the prime) nor `withheld`. That
         * distinction is what stops a tenant's own key being billed to the
         * prime — see `apiUsageBilling.pure.ts` on the clone side.
         */
        const { error: ledgerErr } = await supabaseAdmin.from("clone_backend_secrets").upsert(
          names.map((name) => ({
            clone_id: target.cloneId,
            name,
            status: res.ok ? "set" : "failed",
            last_set_at: res.ok ? now : null,
            last_error: res.ok ? null : res.error,
          })),
          { onConflict: "clone_id,name" },
        );
        if (ledgerErr) {
          console.error("[integrations.secrets] secrets written but ledger not updated", {
            cloneId: target.cloneId,
            projectRef: target.projectRef,
            names,
            error: ledgerErr.message,
          });
        }

        if (!res.ok) {
          /*
           * The Management API refused. Relayed WITHOUT the refusal header,
           * because this is not Mission Control's no — the clone must be able
           * to tell the two apart, and only this side can set that header.
           */
          console.error("[integrations.secrets] management API refused", {
            cloneId: target.cloneId,
            names,
            error: res.error,
          });
          return new Response(
            JSON.stringify({
              ok: false,
              error: "write_failed",
              message: res.error,
              refused: plan.refused,
            }),
            { status: 502, headers: relayHeaders() },
          );
        }

        console.log("[integrations.secrets] wrote", {
          clone: target.cloneName,
          projectRef: target.projectRef,
          names,
          refused: plan.refused.length,
          ledgerRecorded: !ledgerErr,
        });

        return new Response(
          JSON.stringify({
            ok: true,
            updated: names,
            // Names this side declined, so the page can show them beside the
            // ones that landed rather than reporting a clean success.
            refused: plan.refused,
            ledgerRecorded: !ledgerErr,
          }),
          { status: 200, headers: relayHeaders() },
        );
      },
    },
  },
});
