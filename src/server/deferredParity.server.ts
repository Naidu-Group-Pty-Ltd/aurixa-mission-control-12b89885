/**
 * Parity for a backend whose finishing pass had no time left to compare it.
 *
 * `provisioningFinish.pure.ts` lets the pass that finishes a backend skip the
 * comparison with the prime when it would outlive the pass — the ready write
 * has to land — and records `parity_checked_at: null` with a line saying so.
 * Nothing ever came back for it. `fleetBlockageRecord.pure.ts` keeps every
 * migration lane off that line, rightly, so it stood for good, and a clone
 * that does not match the prime would have said so nowhere. Measured 30 Oct
 * 2026: `tutorial-demo-orrimere-c158c7` was finished at 02:17:42 by a pass
 * with no time left; the four other clones carried a parity report and it
 * never would.
 *
 * So the half-hourly backend catch-up asks for it: one comparison per pass,
 * for the backend waiting longest, and only while the pass has the step's own
 * time left (`finishingStepFits`). The report and the time land together, and
 * only on a row nobody compared in the meantime. The verdict's line is
 * `lateParityVerdict`'s, in the finishing pass's own words; a mismatch is
 * raised to the operators, because nobody was watching when it was found.
 *
 * A comparison that cannot run is recorded and the next backend waiting is
 * tried, up to {@link DEFERRED_PARITY_CANDIDATES}: taking only the one waiting
 * longest would hand every pass to a backend whose comparison fails every
 * time, and nothing behind it would ever be compared.
 *
 * ## And a comparison is kept current (PF-30)
 *
 * Nothing else ever compared a backend again. Measured 30 Oct 2026, four of
 * the five clones' reports dated from 4–19 September, and the demo's (04:50)
 * still listed the table, functions and indexes the 05:00 migration lane
 * applied. So a pass with no backend owed its first comparison, or none it
 * could compare, refreshes the one compared longest ago, once that is more
 * than {@link PARITY_REFRESH_AFTER_MS} old: a backend whose first comparison
 * fails every pass must not stop every refresh behind it, for the reason
 * above. Its line is replaced only where a parity sentence stands, and it is
 * raised only for a replication gap the earlier comparison did not have
 * (`refreshedParityVerdict`); the clone page's backend card shows the
 * comparison either way.
 *
 * Read-only on the clone and on the prime: `computeParity` introspects both
 * and changes neither.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import { finishingStepFits } from "./provisioningFinish.pure";
import {
  lateParityVerdict,
  parityMismatchLine,
  refreshedParityVerdict,
} from "./parityVerdict.pure";

type Db = SupabaseClient<Database>;

/** How many backends waiting for a comparison one pass will try, at most one of them to completion. */
export const DEFERRED_PARITY_CANDIDATES = 3;

/** How old a comparison may grow before a pass with nothing owed compares the backend again. */
export const PARITY_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

export type DeferredParityReport = {
  /** The comparison this pass recorded, or null when it recorded none. */
  checked: {
    cloneId: string;
    riskLevel: string;
    blockingIssues: string[];
    surplus: number;
    /** The line written, or null where another writer's line stands. */
    detail: string | null;
    raised: boolean;
    /** True when this refreshed an earlier comparison rather than making the first. */
    refreshed: boolean;
  } | null;
  /** Why none was recorded, when none was. */
  why?: string;
  /** Backends whose comparison could not run this pass, and why. Each is also in the audit log. */
  failed: Array<{ cloneId: string; error: string }>;
};

/** A backend one pass may compare, with the comparison it would refresh. */
type Candidate = {
  clone_id: string;
  supabase_project_ref: string;
  status_detail: string | null;
  /** The comparison being refreshed, when this pass refreshes one. */
  previous: { checkedAt: string; blocking: string[] } | null;
};

/**
 * The ready backends compared longest ago, once that is more than
 * {@link PARITY_REFRESH_AFTER_MS} ago, each with the comparison it holds. A
 * failed read throws, as the read of the backends owed one does.
 */
async function readStaleBackends(supabase: Db): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - PARITY_REFRESH_AFTER_MS).toISOString();
  const { data: staleRows, error: staleErr } = await supabase
    .from("clone_backends")
    .select(
      "clone_id, supabase_project_ref, status_detail, parity_checked_at, blocking:parity_report->blocking_issues",
    )
    .eq("status", "ready")
    .lt("parity_checked_at", cutoff)
    .not("supabase_project_ref", "is", null)
    .order("parity_checked_at", { ascending: true })
    .limit(DEFERRED_PARITY_CANDIDATES);
  if (staleErr) {
    throw new Error(`The backends due a fresh comparison could not be read: ${staleErr.message}`);
  }
  return ((staleRows ?? []) as Array<Record<string, unknown>>).flatMap((r) =>
    typeof r.supabase_project_ref === "string" && typeof r.parity_checked_at === "string"
      ? [
          {
            clone_id: String(r.clone_id),
            supabase_project_ref: r.supabase_project_ref,
            status_detail: typeof r.status_detail === "string" ? r.status_detail : null,
            previous: {
              checkedAt: r.parity_checked_at,
              blocking: Array.isArray(r.blocking)
                ? r.blocking.filter((i): i is string => typeof i === "string")
                : [],
            },
          },
        ]
      : [],
  );
}

export async function catchUpDeferredParity(input: {
  supabase: Db;
  /** When the invocation must be done; a comparison starts only with its own time left. */
  deadlineAt: number;
}): Promise<DeferredParityReport> {
  const { supabase } = input;
  const failed: DeferredParityReport["failed"] = [];
  if (!finishingStepFits("parity", input.deadlineAt, Date.now())) {
    return { checked: null, why: "this pass has no time left for a comparison", failed };
  }

  // A failed read throws: "could not look" is the caller's to record, and is
  // not "nothing is owed".
  const { data: rows, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref, status_detail")
    .eq("status", "ready")
    .is("parity_checked_at", null)
    .not("supabase_project_ref", "is", null)
    .order("updated_at", { ascending: true })
    .limit(DEFERRED_PARITY_CANDIDATES);
  if (error) throw new Error(`The backends owed a comparison could not be read: ${error.message}`);
  const owed: Candidate[] = (rows ?? [])
    .filter((r): r is typeof r & { supabase_project_ref: string } => !!r.supabase_project_ref)
    .map((r) => ({ ...r, previous: null }));

  // Nothing owed a first comparison: refresh the one compared longest ago.
  const first = owed.length > 0 ? owed : await readStaleBackends(supabase);
  if (first.length === 0) {
    return { checked: null, why: "no backend is owed a comparison, and none is stale", failed };
  }

  const {
    resolvePrimeBackendRef,
    resolvePrimeSource,
    fetchDeclaredEdgeFunctionSlugs,
    fetchMigrationObjectIndex,
  } = await import("./prime-backend.server");
  const primeRef = await resolvePrimeBackendRef(supabase);

  // Read once for every candidate, and best effort, exactly as the finishing
  // pass reads them: unread, the comparison reads deployment against
  // deployment and a surplus object reads `undetermined`.
  const { getAppOctokit } = await import("./github-app.server");
  const source = await resolvePrimeSource(supabase).catch(() => null);
  const declaredEdgeFunctions = source
    ? await fetchDeclaredEdgeFunctionSlugs(getAppOctokit(), source).catch(() => null)
    : null;
  const migrationObjectIndex = source
    ? await fetchMigrationObjectIndex(getAppOctokit(), source).catch(() => null)
    : null;

  const { computeParity, readCloneCrmMode, readWithheldSecretNames, readForwardedSecretNames } =
    await import("./handoff-parity.server");
  const caughtUp = "clone_backend.parity_caught_up";
  const refreshed = "clone_backend.parity_refreshed";
  const { notifyOperators, writeAuditLog } = await import("./audit.server");

  /** Compares the first of `rows` that can be; null when none of them could be. */
  const compareFirstOf = async (rows: Candidate[]): Promise<DeferredParityReport | null> => {
    for (const row of rows) {
      const action = row.previous ? refreshed : caughtUp;
      // Never compared with itself, and never written to as a clone.
      if (row.supabase_project_ref === primeRef) continue;
      if (!finishingStepFits("parity", input.deadlineAt, Date.now())) {
        return { checked: null, why: "this pass ran out of time for a comparison", failed };
      }

      let parity: Awaited<ReturnType<typeof computeParity>>;
      try {
        parity = await computeParity(primeRef, row.supabase_project_ref, {
          declaredEdgeFunctions,
          migrationObjectIndex,
          crmMode: await readCloneCrmMode(supabase, row.clone_id),
          withheldSecretNames: await readWithheldSecretNames(supabase, row.clone_id),
          forwardedSecretNames: await readForwardedSecretNames(supabase, row.clone_id),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        failed.push({ cloneId: row.clone_id, error: message });
        await writeAuditLog({
          action,
          entityType: "clone",
          entityId: row.clone_id,
          metadata: { error: message },
        });
        continue;
      }

      const reading = {
        blockingIssues: parity.blocking_issues,
        surplusTotal: parity.surplus_in_target?.total ?? 0,
        cloneId: row.clone_id,
        standing: row.status_detail,
      };
      const verdict = row.previous
        ? refreshedParityVerdict({ ...reading, previousBlocking: row.previous.blocking })
        : lateParityVerdict(reading);

      // The report and its time together, on a row nobody compared meanwhile:
      // still uncompared, or still holding the comparison this one refreshes.
      // `.eq` never matches NULL, so an uncompared row needs `.is`; each branch
      // carries the whole chain so the write and its `error` are one statement,
      // as in `fleet-migration.server.ts`.
      const patch = {
        parity_report: asJson(parity),
        parity_checked_at: new Date().toISOString(),
        ...(verdict.detail ? { status_detail: verdict.detail } : {}),
      };
      const since = row.previous?.checkedAt ?? null;
      const { data: landed, error: writeErr } = await (
        since === null
          ? supabase.from("clone_backends").update(patch).is("parity_checked_at", null)
          : supabase.from("clone_backends").update(patch).eq("parity_checked_at", since)
      )
        .eq("clone_id", row.clone_id)
        .select("clone_id");
      if (writeErr) throw new Error(`The comparison could not be recorded: ${writeErr.message}`);
      if (!landed || landed.length === 0) {
        return { checked: null, why: "another pass compared this backend first", failed };
      }

      await writeAuditLog({
        action,
        entityType: "clone",
        entityId: row.clone_id,
        metadata: {
          risk_level: parity.risk_level,
          blocking_issues: parity.blocking_issues,
          surplus: parity.surplus_in_target?.total ?? 0,
          summary: parity.summary,
        },
      });
      let raised = false;
      if (verdict.raise) {
        raised = await notifyOperators({
          // A clone drifted from the prime, raised as the fleet raises one.
          kind: "drift_high",
          severity: "warning",
          title: row.previous
            ? "A clone's backend has drifted from the prime"
            : "A clone's backend does not match the prime",
          // A refresh leaves a lane's line standing, so the alarm says it itself.
          body: verdict.detail ?? parityMismatchLine(parity.blocking_issues, row.clone_id),
          cloneId: row.clone_id,
          url: `/clones/${row.clone_id}`,
          metadata: { blocking_issues: parity.blocking_issues },
        });
      }

      return {
        checked: {
          cloneId: row.clone_id,
          riskLevel: parity.risk_level,
          blockingIssues: parity.blocking_issues,
          surplus: parity.surplus_in_target?.total ?? 0,
          detail: verdict.detail,
          raised,
          refreshed: row.previous !== null,
        },
        failed,
      };
    }
    return null;
  };

  const report = await compareFirstOf(first);
  if (report) return report;
  // Something was owed and none of it could be compared. The refresh is next,
  // so a backend whose first comparison fails every pass (a paused project)
  // does not stop every refresh behind it.
  if (owed.length > 0) {
    const refresh = await compareFirstOf(await readStaleBackends(supabase));
    if (refresh) return refresh;
  }

  return {
    checked: null,
    why:
      failed.length > 0
        ? "no comparison could run this pass"
        : "the backend owed a comparison is the prime's own",
    failed,
  };
}
