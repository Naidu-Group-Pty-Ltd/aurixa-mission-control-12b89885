import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";

// How many non-terminal envelopes one sweep polls. DocuSign's resource
// limits are generous, but a sweep is not a backfill: at 25 per 10 minutes
// the whole realistic in-flight population clears in one pass.
const REFRESH_BATCH = 25;

// How many signed Subscription Agreements one sweep tries to retain. Each is
// one DocuSign download and one storage upload; a backlog clears over a few
// sweeps rather than in one long request.
const RETAIN_BATCH = 10;

// How many retained, still-armed Subscription Agreements one sweep releases
// into provisioning. Each creates a repository, reconciles entitlements and
// queues a dedicated backend, so a backlog is released a couple at a time.
const RELEASE_BATCH = 2;

// Cron-invoked agreements sweep: polls every sent/delivered envelope through
// the same JWT credentials the send path uses and folds the status in via
// applyDocusignStatus — which is also where provision-on-signature fires. So
// a signed agreement provisions its clone within ten minutes even with NO
// Connect webhook configured; the webhook only makes it instant.
// Auth: requires Bearer DRIFT_REFRESH_TOKEN. Scheduled by the
// `agreements-refresh` pg_cron job (see 20260828070000_agreement_provisioning.sql).
export const Route = createFileRoute("/hooks/agreements-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // A signature can provision a clone from this sweep — inline, when
        // the status is folded in, or below, when a retained record releases
        // it — and that spends the App installation's window. Name the lane
        // so those calls are attributed rather than unattributed.
        beginGithubLane("agreements-refresh");

        const { docusignConfig, refreshEnvelopeStatus } =
          await import("@/server/agreements.server");
        const config = docusignConfig();
        if (!config.ready) {
          // Dormant, not broken: nothing to poll with until the DocuSign
          // secrets exist. A 200 keeps the cron ledger green — the missing
          // configuration is already surfaced on /agreements itself.
          return new Response(
            JSON.stringify({
              success: true,
              skipped: "docusign_not_configured",
              missing: config.missing,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        const { data: pending, error } = await supabaseAdmin
          .from("client_agreements")
          .select("id, client_name")
          .not("docusign_envelope_id", "is", null)
          .in("status", ["sent", "delivered"])
          // Oldest first: an envelope that has been out longest is the one
          // whose signature we are most likely already late on.
          .order("docusign_sent_at", { ascending: true })
          .limit(REFRESH_BATCH);
        if (error) {
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let refreshed = 0;
        let transitioned = 0;
        const failures: Array<{ id: string; error: string }> = [];
        for (const row of pending ?? []) {
          try {
            const result = await refreshEnvelopeStatus(row.id);
            refreshed += 1;
            if (result.status !== "sent" && result.status !== "delivered") transitioned += 1;
          } catch (e) {
            // One stuck envelope must not stop the sweep for the others.
            failures.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
          }
        }

        // Signed Subscription Agreements whose signed record could not be
        // retained at the moment of signature. The retention is what clause
        // 1.2 requires before the purchase activates, so it is retried here
        // rather than left to whoever next opens the agreement. Newest first:
        // a fresh signature is the one waiting to provision, and an old record
        // DocuSign will not supply must not hold the batch for ever.
        const { data: unretained, error: unretainedError } = await supabaseAdmin
          .from("client_agreements")
          .select("id")
          .eq("document_kind", "subscription")
          .eq("status", "signed")
          .is("signed_record_path", null)
          .order("docusign_signed_at", { ascending: false })
          .limit(RETAIN_BATCH);
        let retained = 0;
        if (unretainedError) {
          failures.push({ id: "retention-sweep", error: unretainedError.message });
        } else if (unretained?.length) {
          const { retainSignedSubscriptionRecord } =
            await import("@/server/subscription-agreements.server");
          for (const row of unretained) {
            const result = await retainSignedSubscriptionRecord(row.id);
            if (result.ok) retained += 1;
            else failures.push({ id: row.id, error: `retention: ${result.error}` });
          }
        }

        // Retained, still-armed Subscription Agreements: the provisioning a
        // signature could not start because the record was not yet retained,
        // or that a low window deferred on an earlier sweep. Provisioning
        // creates a repository on the App installation, so it is an ACTOR: it
        // asks the budget first and stands down at the reserve floor, leaving
        // the rows armed for the next sweep. Nothing above waits on GitHub.
        //
        // Every refusal `decideProvisionOnSignature` can give such a row is
        // filtered out here, so a row selected is one that provisions — none
        // can sit at the head of the queue being skipped for ever.
        const { data: releasable, error: releasableError } = await supabaseAdmin
          .from("client_agreements")
          .select("id")
          .eq("document_kind", "subscription")
          .eq("status", "signed")
          .not("signed_record_path", "is", null)
          .eq("provision_on_signature", true)
          .eq("provision_status", "armed")
          .not("plan_slug", "is", null)
          .not("created_by", "is", null)
          .order("docusign_signed_at", { ascending: true })
          .limit(RELEASE_BATCH);
        let released = 0;
        let releaseDeferred: string | null = null;
        if (releasableError) {
          failures.push({ id: "release-sweep", error: releasableError.message });
        } else if (releasable?.length) {
          const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            releaseDeferred = spend.why;
          } else {
            const { provisionCloneFromAgreement } =
              await import("@/server/agreement-provisioning.server");
            for (const row of releasable) {
              const result = await provisionCloneFromAgreement(row.id, { trigger: "signature" });
              if (!result.ok) failures.push({ id: row.id, error: `provisioning: ${result.error}` });
              else if (!result.skipped) released += 1;
            }
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            polled: pending?.length ?? 0,
            refreshed,
            transitioned,
            retained,
            released,
            ...(releaseDeferred ? { release_deferred: releaseDeferred } : {}),
            failures,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
