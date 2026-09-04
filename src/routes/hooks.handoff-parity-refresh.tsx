// G19 — Handoff parity refresh worker.
//
// Cron-invoked endpoint that keeps `handoff_parity_reports` fresh for every
// non-terminal handoff. It selects handoffs whose latest parity report is
// missing or older than 6 hours, resolves each handoff's target Supabase
// project ref via `clone_backends`, runs `computeParity`, and writes a new
// row. Every run inserts an `audit_log` entry summarising how many handoffs
// were refreshed / skipped / failed. Kept idempotent so pg_cron can retry.
//
// Auth: Bearer DRIFT_REFRESH_TOKEN (same shared cron secret we use for
// expire-reservations and edge-drain).
//
// Budget: max 10 handoffs per invocation, max ~45s wall clock. The
// scheduler is expected to run this every 15 minutes.

import { createFileRoute } from "@tanstack/react-router";
import { asJson } from "@/lib/json-cast";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

const MAX_PER_RUN = 10;
const STALE_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEADLINE_MS = 45_000;
const NON_TERMINAL = [
  "draft",
  "dry_run_ready",
  "twin_provisioning",
  "twin_ready",
  "snapshot_pending",
  "data_syncing",
  "cutover_in_progress",
] as const;

async function resolveTargetRef(handoff: any): Promise<string | null> {
  let q = supabaseAdmin
    .from("clone_backends")
    .select("supabase_project_ref, status, created_at")
    .not("supabase_project_ref", "is", null)
    .not("status", "in", "(failed,deleted,destroyed)")
    .order("created_at", { ascending: false })
    .limit(1);
  q = handoff.backend_id ? q.eq("id", handoff.backend_id) : q.eq("clone_id", handoff.clone_id);
  const { data } = await q.maybeSingle();
  return data?.supabase_project_ref ?? null;
}

export const Route = createFileRoute("/hooks/handoff-parity-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        const started = Date.now();

        // Fetch candidates. We over-select then filter by staleness in memory
        // so we don't need a lateral join.
        const { data: handoffs, error: hErr } = await supabaseAdmin
          .from("clone_handoffs")
          .select("id, state, clone_id, backend_id")
          .in("state", NON_TERMINAL as any)
          .order("updated_at", { ascending: true })
          .limit(50);
        if (hErr) {
          return new Response(JSON.stringify({ success: false, error: hErr.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        const cutoff = new Date(Date.now() - STALE_MS).toISOString();
        const stale: any[] = [];
        for (const h of handoffs ?? []) {
          // The column is `generated_at`. `computed_at` does not exist on this
          // table and never has, so PostgREST answered 42703 to every one of
          // these reads — and because the error was discarded, `latest` came
          // back null and EVERY handoff looked stale. This loop was refreshing
          // parity for the whole fleet on every run, up to MAX_PER_RUN, and
          // reporting that as normal operation.
          const { data: latest, error: latestErr } = await supabaseAdmin
            .from("handoff_parity_reports")
            .select("id, generated_at")
            .eq("handoff_id", h.id)
            .order("generated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          // A read that FAILED is not a report that is ABSENT. Refreshing on a
          // failed read is how the bug above stayed invisible; skip instead.
          if (latestErr) {
            console.warn("[parity-refresh] staleness read failed", h.id, latestErr.message);
            continue;
          }
          if (!latest || latest.generated_at < cutoff) stale.push(h);
          if (stale.length >= MAX_PER_RUN) break;
        }

        const { computeParity } = await import("@/server/handoff-parity.server");
        const { resolvePrimeBackendRef, resolvePrimeSource, fetchDeclaredEdgeFunctionSlugs } =
          await import("@/server/prime-backend.server");
        const primeRef = await resolvePrimeBackendRef(supabaseAdmin);
        // Resolved ONCE: every handoff in this sweep is measured against the
        // same prime, and a tree walk per handoff would spend the GitHub App's
        // quota on the same answer. Null when it cannot be established — the
        // comparison then reads deployment-against-deployment, as it always did.
        const declaredEdgeFunctions = await (async () => {
          try {
            const { getAppOctokit } = await import("@/server/github-app.server");
            const source = await resolvePrimeSource(supabaseAdmin);
            if (!source) return null;
            return await fetchDeclaredEdgeFunctionSlugs(getAppOctokit(), source);
          } catch {
            return null;
          }
        })();

        const results = { refreshed: 0, skipped: 0, failed: 0, details: [] as any[] };
        for (const h of stale) {
          if (Date.now() - started > DEADLINE_MS) break;
          try {
            const targetRef = await resolveTargetRef(h);
            if (!targetRef) {
              results.skipped += 1;
              results.details.push({ id: h.id, reason: "no_target_backend" });
              continue;
            }
            const parity = await computeParity(primeRef, targetRef, { declaredEdgeFunctions });
            const { data: row, error: insErr } = await supabaseAdmin
              .from("handoff_parity_reports")
              .insert({
                handoff_id: h.id,
                prime_ref: parity.prime_ref,
                target_ref: parity.target_ref,
                risk_level: parity.risk_level,
                tables_diff: asJson(parity.tables_diff),
                policies_diff: asJson(parity.policies_diff),
                functions_diff: asJson(parity.functions_diff),
                buckets_diff: asJson(parity.buckets_diff),
                cron_diff: asJson(parity.cron_diff),
                edge_functions_diff: asJson(parity.edge_functions_diff),
                secrets_diff: asJson(parity.secrets_diff),
                auth_diff: asJson(parity.auth_config_diff),
                extensions_diff: asJson(parity.extensions_diff),
                blocking_issues: parity.blocking_issues,
                summary: parity.summary,
              })
              .select("id")
              .single();
            if (insErr) throw insErr;
            await supabaseAdmin.from("handoff_events").insert({
              handoff_id: h.id,
              kind: "handoff.parity_refreshed",
              details: {
                parity_id: row.id,
                risk_level: parity.risk_level,
                blocking_count: parity.blocking_issues.length,
                source: "cron_g19",
              },
            });
            // Optional auto-advance: draft → dry_run_ready when clean.
            if (h.state === "draft" && parity.blocking_issues.length === 0) {
              await supabaseAdmin
                .from("clone_handoffs")
                .update({ state: "dry_run_ready" })
                .eq("id", h.id);
              await supabaseAdmin.from("handoff_events").insert({
                handoff_id: h.id,
                kind: "handoff.transitioned",
                details: {
                  from: "draft",
                  to: "dry_run_ready",
                  note: "auto: parity clean (cron_g19)",
                },
              });
            }
            results.refreshed += 1;
            results.details.push({
              id: h.id,
              parity_id: row.id,
              risk: parity.risk_level,
              blocking: parity.blocking_issues.length,
            });
          } catch (e: any) {
            results.failed += 1;
            results.details.push({ id: h.id, error: String(e?.message ?? e) });
          }
        }

        await supabaseAdmin.from("audit_log").insert({
          action: "handoff_parity_refresh_cron",
          entity_type: "cron",
          metadata: {
            ...results,
            duration_ms: Date.now() - started,
            candidates: handoffs?.length ?? 0,
            considered: stale.length,
          },
        });

        return new Response(
          JSON.stringify({
            success: true,
            duration_ms: Date.now() - started,
            ...results,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
