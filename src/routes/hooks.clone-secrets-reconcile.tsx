import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here twice an hour, offset from the
// signing-pair sweep. Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Three sweeps, one hook, because they are one question — "does this clone's
// function environment hold what belongs to it?" — asked of three classes:
//
//   1. The clone-OWNED secrets: the reset and CSRF peppers and the VAPID pair,
//      minted once and mirrored in the clone's vault so a pass re-asserts
//      rather than rotates. Every clone was without a pepper (no password
//      reset could be issued) and without a VAPID pair (every push answered
//      503) on 6 Sep 2026.
//   2. The Mission Control LINK: the URL, the API key, the agency name and the
//      webhook secret, written to the environment that reads them. The key
//      used to be committed to a repository file nothing reads, and no clone
//      had ever presented one.
//   3. The DERIVED deployment config — public URL, WebAuthn relying party,
//      web-push host — re-computed from the clone's current origins, so a
//      domain going live after provisioning is reflected rather than frozen.
//   0. What the clone must NOT hold: a Supabase management credential. Run
//      FIRST, because it is the only sweep that removes rather than writes
//      and the only one whose absence is a live security exposure — a PAT is
//      scoped to an ACCOUNT, so one sitting on a tenant project reaches the
//      prime, Mission Control and every other tenant. It reads what the
//      project HOLDS rather than what the ledger says was forwarded: on
//      12 Sep 2026 `npc-client-dashboard` held SB_MANAGEMENT_ACCESS_TOKEN
//      while `clone_backend_secrets` recorded it `missing`, because Mission
//      Control never wrote it and so could not see it.
//   4. The clone's OWN model keys, minted on Aurixa's provider accounts so the
//      vendor's dashboard attributes spend per clone rather than showing one
//      undifferentiated bill. A sweep rather than a provisioning step for two
//      reasons: every clone that already exists runs on the forwarded fleet
//      key, and each provider is switched on by its own credential appearing
//      in Mission Control's environment — an event with no hook to hang off.
//      It never replaces a key the TENANT supplied, and a clone whose minting
//      fails keeps the forwarded key, so this can only improve attribution
//      and never take a workspace off the air.
//
// Each can only ever write to a clone: the ref comes from
// `resolveCloneSecretTarget`, which refuses the prime and Mission Control's
// own. See `cloneOwnedSecrets.server.ts`, `cloneMissionControlLink.server.ts`
// and `cloneDerivedConfig.server.ts`.
export const Route = createFileRoute("/hooks/clone-secrets-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneOwnedSecrets } = await import("@/server/cloneOwnedSecrets.server");
          const { reconcileCloneMissionControlLinks } =
            await import("@/server/cloneMissionControlLink.server");
          const { reconcileCloneDerivedConfig } =
            await import("@/server/cloneDerivedConfig.server");
          const { reconcileLlmKeys } = await import("@/server/llmKeyProvisioning.server");
          const { reconcileAnthropicWorkspaces } =
            await import("@/server/anthropicWorkspace.server");
          const { reconcileAnthropicFederation } =
            await import("@/server/anthropicFederation.server");
          /*
           * First, and never allowed to fail the sweep.
           *
           * It removes rather than writes, so a failure here leaves the clone
           * exactly as it was — whereas letting it throw would cost the four
           * repairs below their run, and those fix workspaces that are BROKEN
           * without them. The outcome is returned either way so an operator
           * reads `unreadable` rather than nothing.
           */
          let prohibited: unknown;
          try {
            const { reconcileProhibitedSecrets } =
              await import("@/server/cloneProhibitedSecrets.server");
            prohibited = await reconcileProhibitedSecrets(supabaseAdmin);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error("Prohibited-secret sweep failed:", detail);
            prohibited = { ok: false, error: detail };
          }
          const owned = await reconcileCloneOwnedSecrets(supabaseAdmin);
          const link = await reconcileCloneMissionControlLinks(supabaseAdmin);
          const derived = await reconcileCloneDerivedConfig(supabaseAdmin);
          /*
           * Last, and never allowed to fail the sweep.
           *
           * The three above repair things a clone is BROKEN without — a
           * password reset it cannot issue, a Mission Control key it cannot
           * present, an origin it cannot be loaded from. Minting improves
           * attribution on a workspace that already works, so a vendor being
           * unreachable must not cost the other three their run.
           */
          let llm: unknown;
          try {
            llm = await reconcileLlmKeys(supabaseAdmin);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error("LLM key reconcile failed:", detail);
            llm = { ok: false, error: detail };
          }
          // Same treatment, its own try/catch: an Anthropic outage must not
          // cost the model keys their run any more than the reverse.
          let anthropicWorkspaces: unknown;
          try {
            anthropicWorkspaces = await reconcileAnthropicWorkspaces(supabaseAdmin);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error("Anthropic workspace reconcile failed:", detail);
            anthropicWorkspaces = { ok: false, error: detail };
          }
          /*
           * Federation last, and after the workspaces above — a rule is
           * created IN a workspace, so a clone federated before it has one
           * would be bound to the organisation's default and land in the very
           * undifferentiated line the workspace exists to leave behind.
           * `decideFederation` refuses that case anyway; the ordering means it
           * does not have to wait a whole sweep to stop refusing.
           */
          let anthropicFederation: unknown;
          try {
            anthropicFederation = await reconcileAnthropicFederation(supabaseAdmin);
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error("Anthropic federation reconcile failed:", detail);
            anthropicFederation = { ok: false, error: detail };
          }

          /*
           * And then ask whether any of it actually WORKS.
           *
           * Everything above is configuration, and this platform has already
           * had the failure where every configuration reading was green on
           * three tenants that had never completed a single verification. This
           * pass is the one that can tell the difference, and it runs here
           * rather than from a button because a reading that only a click
           * produces makes a clone's provability depend on whether anybody
           * looked.
           *
           * Last on purpose: it probes what the passes above have just
           * repaired, so a clone federated this tick is proved in the same
           * tick rather than the next one. Bounded at two, so the cost of a
           * tick does not grow with the fleet.
           */
          let anthropicReach: unknown;
          try {
            const { sweepAnthropicReachability } = await import(
              /* @vite-ignore */ "@/server/anthropicSelftest.server"
            );
            anthropicReach = await sweepAnthropicReachability();
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.error("Anthropic reachability sweep failed:", detail);
            anthropicReach = { ok: false, error: detail };
          }
          // 200 with the refusals in the body: one clone that cannot be
          // repaired is not a failed sweep.
          return new Response(
            JSON.stringify({
              success: true,
              prohibited,
              owned,
              link,
              derived,
              llm,
              anthropicWorkspaces,
              anthropicFederation,
              anthropicReach,
            }),
            {
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Clone secrets reconcile failed";
          console.error("Clone secrets reconcile failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
