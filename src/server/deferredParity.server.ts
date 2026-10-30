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
 * Read-only on the clone and on the prime: `computeParity` introspects both
 * and changes neither.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import { finishingStepFits } from "./provisioningFinish.pure";
import { lateParityVerdict } from "./parityVerdict.pure";

type Db = SupabaseClient<Database>;

/** How many backends waiting for a comparison one pass will try, at most one of them to completion. */
export const DEFERRED_PARITY_CANDIDATES = 3;

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
  } | null;
  /** Why none was recorded, when none was. */
  why?: string;
  /** Backends whose comparison could not run this pass, and why. Each is also in the audit log. */
  failed: Array<{ cloneId: string; error: string }>;
};

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
  const owed = (rows ?? []).filter(
    (r): r is typeof r & { supabase_project_ref: string } => !!r.supabase_project_ref,
  );
  if (owed.length === 0) return { checked: null, why: "no backend is owed a comparison", failed };

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

  const { computeParity, readCloneCrmMode, readWithheldSecretNames } =
    await import("./handoff-parity.server");
  const { notifyOperators, writeAuditLog } = await import("./audit.server");

  for (const row of owed) {
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
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failed.push({ cloneId: row.clone_id, error: message });
      await writeAuditLog({
        action: "clone_backend.parity_caught_up",
        entityType: "clone",
        entityId: row.clone_id,
        metadata: { error: message },
      });
      continue;
    }

    const verdict = lateParityVerdict({
      blockingIssues: parity.blocking_issues,
      surplusTotal: parity.surplus_in_target?.total ?? 0,
      cloneId: row.clone_id,
      standing: row.status_detail,
    });

    // The report and its time together, on a row nobody compared meanwhile.
    const { data: landed, error: writeErr } = await supabase
      .from("clone_backends")
      .update({
        parity_report: asJson(parity),
        parity_checked_at: new Date().toISOString(),
        ...(verdict.detail ? { status_detail: verdict.detail } : {}),
      })
      .eq("clone_id", row.clone_id)
      .is("parity_checked_at", null)
      .select("clone_id");
    if (writeErr) throw new Error(`The comparison could not be recorded: ${writeErr.message}`);
    if (!landed || landed.length === 0) {
      return { checked: null, why: "another pass compared this backend first", failed };
    }

    await writeAuditLog({
      action: "clone_backend.parity_caught_up",
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
        title: "A clone's backend does not match the prime",
        body: verdict.detail ?? undefined,
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
      },
      failed,
    };
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
