import { createFileRoute } from "@tanstack/react-router";
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { createCascadeForAllClones } from "@/server/cascade-trigger.server";
import { executeCascade } from "@/server/cascade-engine.server";
import { enqueueScanNoAuth, resolveScanTarget } from "@/server/codex-scheduling.server";
import { writeAuditLog } from "@/server/audit.server";

// GitHub webhook receiver. Verifies HMAC-SHA256 signature with
// GITHUB_WEBHOOK_SECRET, and on a `push` event to prime's default branch
// auto-fires a cascade in prime_config.default_cascade_mode.

function verifySignature(secret: string, payload: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const Route = createFileRoute("/hooks/github")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        if (!secret) {
          return new Response(JSON.stringify({ error: "Webhook secret not configured" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");
        if (!verifySignature(secret, rawBody, signature)) {
          return new Response(JSON.stringify({ error: "Invalid signature" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const eventType = request.headers.get("x-github-event");
        const deliveryId = request.headers.get("x-github-delivery") ?? "unknown";

        // Respond fast to ping
        if (eventType === "ping") {
          return new Response(JSON.stringify({ pong: true, delivery: deliveryId }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Phase 4 — PR-driven Codex Security scans. `pull_request` opens,
        // synchronizes, or reopens trigger a scan against the PR head SHA;
        // scans are deduped within prime_config.codex_scan_dedup_hours.
        if (eventType === "pull_request") {
          let prPayload: any;
          try {
            prPayload = JSON.parse(rawBody);
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          const action = prPayload?.action as string | undefined;
          // Declared once for both branches below: the merged-PR cascade needs
          // to know whether this repository is prime before it does anything.
          const repoOwner =
            prPayload?.repository?.owner?.login ?? prPayload?.repository?.owner?.name ?? "";
          const repoName = prPayload?.repository?.name ?? "";
          const repoFullName = repoOwner && repoName ? `${repoOwner}/${repoName}` : "";

          // ── A merged pull request is prime moving ──────────────────────────
          //
          // This is the trigger an operator actually thinks in: work lands when
          // a PR merges. The `push` handler below already fires on the commit
          // that same merge creates, and both now go through
          // `createCascadeForAllClones`, which deduplicates on the prime SHA --
          // so a merge produces exactly one cascade whichever delivery arrives
          // first, and a direct push (Lovable writes to this prime's main
          // constantly) still cascades on its own.
          //
          // A closed-unmerged pull request changes nothing on prime and must
          // not cascade.
          if (action === "closed") {
            const merged = prPayload?.pull_request?.merged === true;
            const mergeSha: string | null = prPayload?.pull_request?.merge_commit_sha ?? null;
            const baseBranch: string | null = prPayload?.pull_request?.base?.ref ?? null;
            const prNum = prPayload?.pull_request?.number ?? null;

            const { data: primeCfgForMerge } = await supabaseAdmin
              .from("prime_config")
              .select("*")
              .limit(1)
              .maybeSingle();

            const primeBranch = primeCfgForMerge?.default_branch || "main";
            const onPrime =
              Boolean(primeCfgForMerge) &&
              repoOwner.toLowerCase() === primeCfgForMerge!.github_owner.toLowerCase() &&
              repoName.toLowerCase() === primeCfgForMerge!.github_repo.toLowerCase();

            const decline =
              !primeCfgForMerge
                ? "prime_not_configured"
                : !onPrime
                  ? `not_prime:${repoOwner}/${repoName}`
                  : !merged
                    ? "closed_without_merge"
                    : baseBranch !== primeBranch
                      ? `not_default_branch:${baseBranch}`
                      : !mergeSha
                        ? "no_merge_commit_sha"
                        : null;

            if (decline) {
              await writeAuditLog({
                action: "webhook.skipped",
                entityType: "cascade_event",
                metadata: { delivery: deliveryId, event: "pull_request.closed", reason: decline },
              });
              return new Response(JSON.stringify({ skipped: true, reason: decline }), {
                headers: { "Content-Type": "application/json" },
              });
            }

            const merge = await createCascadeForAllClones({
              supabase: supabaseAdmin,
              mode: primeCfgForMerge!.default_cascade_mode,
              trigger: "commit",
              sourceBranch: primeBranch,
              sourceSha: mergeSha,
              initiatedBy: null,
              summary: `PR #${prNum}: ${String(prPayload?.pull_request?.title ?? "").slice(0, 180)}`,
            });

            if (merge.alreadyExisted) {
              return new Response(
                JSON.stringify({
                  skipped: true,
                  reason: "already_cascaded_for_sha",
                  cascadeEventId: merge.eventId,
                }),
                { headers: { "Content-Type": "application/json" } },
              );
            }

            if (merge.error || !merge.eventId) {
              await writeAuditLog({
                action: "webhook.skipped",
                entityType: "cascade_event",
                metadata: {
                  delivery: deliveryId,
                  event: "pull_request.closed",
                  reason: merge.error ?? "no event",
                },
              });
              return new Response(
                JSON.stringify({ skipped: true, reason: merge.error ?? "no clones" }),
                { headers: { "Content-Type": "application/json" } },
              );
            }

            await writeAuditLog({
              action: "webhook.cascade_triggered",
              entityType: "cascade_event",
              entityId: merge.eventId,
              metadata: {
                delivery: deliveryId,
                event: "pull_request.closed",
                pr: prNum,
                sha: mergeSha,
                mode: primeCfgForMerge!.default_cascade_mode,
                cloneCount: merge.cloneCount,
              },
            });

            executeCascade(supabaseAdmin, merge.eventId).catch((e) => {
              console.error("PR-merge cascade failed:", e);
            });

            return new Response(
              JSON.stringify({
                success: true,
                cascadeEventId: merge.eventId,
                trigger: "pull_request.closed",
                pr: prNum,
                sha: mergeSha,
                cloneCount: merge.cloneCount,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }

          if (
            !action ||
            !["opened", "reopened", "synchronize", "ready_for_review"].includes(action)
          ) {
            return new Response(
              JSON.stringify({
                skipped: true,
                reason: `pull_request action ${action ?? "?"} ignored`,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const headSha = prPayload?.pull_request?.head?.sha ?? null;
          const prNumber = prPayload?.pull_request?.number ?? null;
          const baseRef = prPayload?.pull_request?.base?.ref ?? null;

          const { data: primeCfg } = await supabaseAdmin
            .from("prime_config")
            .select("codex_pr_scan_enabled, codex_scan_dedup_hours")
            .limit(1)
            .maybeSingle();
          if (!primeCfg?.codex_pr_scan_enabled) {
            return new Response(
              JSON.stringify({ skipped: true, reason: "codex_pr_scan_disabled" }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          const target = repoFullName ? await resolveScanTarget(repoFullName) : null;
          if (!target) {
            return new Response(
              JSON.stringify({ skipped: true, reason: `unknown_repo:${repoFullName}` }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
          try {
            const r = await enqueueScanNoAuth({
              kind: "pr_open",
              targetKind: target.targetKind,
              cloneId: target.cloneId ?? null,
              repoFullName,
              ref: headSha,
              // Scope the scan to the PR's own diff: a full-tree scan on
              // every push would take minutes and drown the PR in findings
              // the author did not introduce.
              diffBase: baseRef,
              dedupWindowHours: primeCfg.codex_scan_dedup_hours ?? 6,
              requestPayload: {
                source: "github_pr",
                delivery: deliveryId,
                action,
                pr: prNumber,
                baseRef,
              },
            });
            return new Response(JSON.stringify({ success: true, ...r }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            return new Response(JSON.stringify({ success: false, error: (err as Error).message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        /*
          A CHECK SUITE FINISHING IS THE MOMENT THE ANSWER CHANGED.

          The merge drain polls every five minutes. That is a fixed cost per
          tick multiplied by the fleet size, and — because a run is bounded by
          a 45-second budget — the poll is also what decides how long a clone
          waits for its turn. GitHub already knows the instant a pull request
          becomes mergeable; asking it every five minutes instead is the whole
          reason the drain's cost grows with the fleet at all.

          So the check suite completing drains THAT clone, immediately. The
          five-minute poll stays exactly as it is and becomes the reconciler: it
          catches what webhooks miss (a delivery dropped, a repository whose
          App installation is gone, a row whose pull request was merged by
          hand), which is precisely what a poll is good at and an event is
          not.

          Three rules.

          ONE ENGINE. This narrows `drainCascadeMerges` to one clone with a
          short budget; it is not a second merge path. Everything the gate
          decides — the required checks, the never-started ceiling, the base
          comparison, the oldest-first ordering, the reconciliation writes —
          is the same code the poll runs, because two implementations of "may
          this merge" is how one of them becomes wrong.

          IT NEVER REPORTS FAILURE TO GITHUB. A webhook that 500s is retried
          and then disabled by GitHub; this is an OPTIMISATION over a poll
          that will run anyway, so a fault here costs at most five minutes and
          must never cost the delivery endpoint.

          AND IT IS NOT A CASCADE TRIGGER. A completed check suite says
          something about a tree that already exists. It opens nothing,
          proposes nothing, and touches no clone but the one whose repository
          sent it.
        */
        if (eventType === "check_suite" || eventType === "check_run") {
          let payload: {
            action?: string;
            repository?: { name?: string; owner?: { login?: string } };
            check_suite?: { status?: string; pull_requests?: Array<{ number?: number }> };
            check_run?: { status?: string; pull_requests?: Array<{ number?: number }> };
          };
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return new Response(JSON.stringify({ error: "Invalid JSON" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }

          const unit = payload.check_suite ?? payload.check_run;
          // Only a FINISHED suite changes the answer. A queued or running one
          // is the state the gate already reports as `pending`, and draining
          // on it would be the poll again, faster and no more informative.
          if (payload.action !== "completed" || unit?.status !== "completed") {
            return new Response(JSON.stringify({ skipped: true, reason: "check not completed" }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          // No pull request attached: a check suite on a branch nobody has
          // proposed. There is nothing for the drain to consider.
          if (!(unit.pull_requests ?? []).some((p) => typeof p?.number === "number")) {
            return new Response(
              JSON.stringify({ skipped: true, reason: "no pull request on this check suite" }),
              { headers: { "Content-Type": "application/json" } },
            );
          }

          const owner = payload.repository?.owner?.login ?? null;
          const name = payload.repository?.name ?? null;
          if (!owner || !name) {
            return new Response(
              JSON.stringify({ skipped: true, reason: "no repository on the payload" }),
              { headers: { "Content-Type": "application/json" } },
            );
          }

          try {
            const { data: clone } = await supabaseAdmin
              .from("clones")
              .select("id")
              .eq("github_owner", owner)
              .eq("github_repo", name)
              .maybeSingle();
            // Not a clone. The prime's own check suites arrive here too, and
            // the prime is not in the merge drain's work list.
            if (!clone) {
              return new Response(
                JSON.stringify({ skipped: true, reason: "not a clone repository" }),
                { headers: { "Content-Type": "application/json" } },
              );
            }

            const { drainCascadeMerges } = await import("@/server/cascadeMergeDrain.server");
            const report = await drainCascadeMerges(supabaseAdmin, {
              // One clone, and a budget far under the poll's: this runs inside
              // a webhook delivery, which GitHub expects to be answered
              // promptly.
              cloneId: clone.id,
              budgetMs: 20_000,
              concurrency: 1,
            });
            return new Response(JSON.stringify({ success: true, clone: clone.id, ...report }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            // 200, deliberately. See the rule above: the poll will do this
            // anyway within five minutes, and a webhook GitHub disables is a
            // far worse outcome than one slow merge.
            console.error("[hooks/github] check-suite drain failed", err);
            return new Response(
              JSON.stringify({
                success: false,
                deferred_to_poll: true,
                error: (err as Error).message,
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (eventType !== "push") {
          // Acknowledge but don't act on other events
          return new Response(
            JSON.stringify({ skipped: true, reason: `Unhandled event: ${eventType}` }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        type PushPayload = {
          ref?: string;
          after?: string;
          repository?: { name?: string; owner?: { login?: string; name?: string } };
          head_commit?: { message?: string };
        };
        let payload: PushPayload;
        try {
          payload = JSON.parse(rawBody) as PushPayload;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const repoOwner = payload.repository?.owner?.login ?? payload.repository?.owner?.name ?? "";
        const repoName = payload.repository?.name ?? "";
        const ref = payload.ref ?? "";
        const sourceSha = payload.after ?? null;

        // Verify this push is on prime
        const { data: prime } = await supabaseAdmin
          .from("prime_config")
          .select("*")
          .limit(1)
          .maybeSingle();
        if (!prime) {
          return new Response(JSON.stringify({ skipped: true, reason: "Prime not configured" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        const isPrimeRepo =
          repoOwner.toLowerCase() === prime.github_owner.toLowerCase() &&
          repoName.toLowerCase() === prime.github_repo.toLowerCase();
        const expectedRef = `refs/heads/${prime.default_branch || "main"}`;
        if (!isPrimeRepo || ref !== expectedRef) {
          return new Response(
            JSON.stringify({
              skipped: true,
              reason: `Not prime default branch (got ${repoOwner}/${repoName}@${ref})`,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        const mode = prime.default_cascade_mode;
        const sourceBranch = prime.default_branch || "main";
        const summary = payload.head_commit?.message?.slice(0, 200) ?? null;

        const { eventId, cloneCount, error } = await createCascadeForAllClones({
          supabase: supabaseAdmin,
          mode,
          trigger: "commit",
          sourceBranch,
          sourceSha,
          initiatedBy: null,
          summary,
        });

        if (error || !eventId) {
          await writeAuditLog({
            action: "webhook.skipped",
            entityType: "cascade_event",
            metadata: { delivery: deliveryId, reason: error ?? "no event" },
          });
          return new Response(JSON.stringify({ skipped: true, reason: error ?? "no clones" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        await writeAuditLog({
          action: "webhook.cascade_triggered",
          entityType: "cascade_event",
          entityId: eventId,
          metadata: { delivery: deliveryId, mode, sourceSha, cloneCount },
        });

        // Fire the cascade. We don't await — return 200 fast so GitHub doesn't
        // retry. (Cloudflare Workers will keep the promise alive long enough
        // for the cascade to finish in practice; if not, the event remains
        // pending and can be retried from the UI.)
        executeCascade(supabaseAdmin, eventId).catch((e) => {
          console.error("Webhook-triggered cascade failed:", e);
        });

        // Phase 4 — post-merge revalidate: run a Codex Security scan against
        // the freshly merged SHA so drift/fix regressions are caught fast.
        if (prime.codex_post_merge_revalidate !== false) {
          const primeRepo = `${prime.github_owner}/${prime.github_repo}`;
          // Awaited: dispatch is a couple of GitHub calls, and a floating
          // promise here dies with the isolate before the scan is ever sent.
          try {
            await enqueueScanNoAuth({
              kind: "post_merge_revalidate",
              targetKind: "prime",
              repoFullName: primeRepo,
              ref: sourceSha,
              dedupWindowHours: prime.codex_scan_dedup_hours ?? 6,
              requestPayload: { source: "post_merge", delivery: deliveryId, sha: sourceSha },
            });
          } catch (e) {
            console.error("post-merge codex scan enqueue failed:", e);
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            cascadeEventId: eventId,
            mode,
            cloneCount,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
