/**
 * Give every existing clone the prime's function EXECUTE grants and view
 * options, and report the table privileges its browser roles hold that the
 * prime's do not.
 *
 * ## Why a sweep, and not only the provisioner
 *
 * Provisioning now converges these in its grants stage
 * (`planClonePrivilegeConvergence`). A clone whose schema was verified before
 * that existed never re-enters introspection — `schema_verified_at` skips it,
 * correctly, because re-walking twelve stages over ~650 tables a minute is what
 * once starved its edge-function deploys. So the fleet as it stands on 3 Oct
 * 2026 — four clones, 238 to 247 SECURITY DEFINER functions each callable with
 * the anon key — would never be repaired by the code that now builds clones
 * correctly. This is what repairs them, and what catches any drift a later
 * hand edit introduces.
 *
 * ## What it may touch
 *
 * The target comes from `resolveCloneSecretTarget`, the one resolver that
 * refuses the prime's project and Mission Control's own and refuses when it
 * cannot tell. Every statement is a GRANT or REVOKE of EXECUTE on a function
 * both sides hold, or an `alter view … set/reset` of three named options —
 * nothing else can be planned (see `routinePrivileges.pure.ts`). No row is
 * read or written.
 *
 * ## Table privileges: compared, reported, never taken back
 *
 * On 28 Oct 2026 every clone gave `anon` SELECT, INSERT, UPDATE and DELETE on
 * 24 tables whose policies are `TO public USING (true)`, because a clone is
 * built with Supabase's default privileges and the grants stage adds what a
 * clone lacks without ever revoking what it holds. So each pass also compares
 * the table-level privileges of `anon` and `authenticated` on every `public`
 * relation both sides hold against the prime's live ACL
 * (`tablePrivileges.pure.ts`), and says what differs: in its result, in its
 * audit row, and in a notice for a person when a clone's surplus changes.
 *
 * It revokes nothing. The owner decided on 28 Oct 2026 to have it report for a
 * week and to review the reports before anything is enforced, and
 * `ENFORCE_TABLE_GRANTS` is off with nothing behind it. The table stage only
 * reads: the comparison returns counts and names, never a statement.
 *
 * ## Budget
 *
 * The first pass on a clone is a few hundred statements; every later one is
 * none. The plan is re-derived from both catalogues on every call, so a pass
 * the budget stops loses nothing and the next one carries only what is still
 * different. The starting clone rotates with the clock so one large clone
 * cannot starve the others.
 *
 * Reading costs six Management API calls a clone (three on each side) plus one
 * per 200 functions only the clone holds. The table comparison adds one
 * statement on each side, and no more: the prime's is read once a pass and
 * shared by every clone, and each clone's runs beside that clone's function
 * reads, so it adds a call and not a round trip of waiting. Four clones go from
 * 24 calls a pass to 29. Each table read answers about 610 rows, 75 to 100 KB
 * (measured 28 Oct 2026). A notice costs one read of Mission Control's own
 * `notifications` a pass, and an insert only when a clone's surplus changes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "./audit.server";
import { resolveCloneSecretTarget, CloneSecretTargetError } from "./cloneAllowedOrigins.server";
import { BudgetPause, pastDeadline } from "./provisioningBudget";
import {
  TABLE_GRANT_NOTICE_SOURCE,
  compareTableGrants,
  decideTableGrantNotice,
  describeTableGrantNotice,
  summariseTableGrants,
  tableGrantMode,
  type RelationAclReading,
  type TableGrantMode,
  type TableGrantSummary,
} from "./tablePrivileges.pure";

type Db = SupabaseClient<Database>;

export type ClonePrivilegeOutcome = {
  cloneId: string;
  cloneName: string;
  projectRef: string;
  applied: number;
  failed: number;
  grants: number;
  revokes: number;
  viewStatements: number;
  closedDefinerExposures: number;
  invokerRestored: number;
  heldForReference: number;
  cloneOnlyExposedDefiners: string[];
  errors?: string[];
  sample?: string[];
};

/**
 * One clone's table privileges against the prime's. Every clone a pass reaches
 * has one, so a clone that could not be compared says why and is never read as
 * a clone with nothing to report.
 */
export type CloneTableGrantReport =
  | ({ cloneId: string; cloneName: string; projectRef: string; read: "ok" } & TableGrantSummary)
  | {
      cloneId: string;
      cloneName: string;
      projectRef: string;
      read: "unreadable";
      /** Which catalogue could not be read. */
      side: "prime" | "clone";
      error: string;
    }
  | {
      cloneId: string;
      cloneName: string;
      projectRef: string;
      /** Both sides were read and the comparison itself threw. */
      read: "failed";
      error: string;
    }
  | { cloneId: string; read: "not_read"; why: string };

export type TableGrantSweep = {
  /** `report_only`: nothing is revoked (the owner, 28 Oct 2026). */
  mode: TableGrantMode;
  clones: CloneTableGrantReport[];
  /** Clones the budget stopped the pass before. This pass says nothing about them. */
  notReached: string[];
  notices: {
    raised: number;
    /** Notices the database refused, logged by `notifyOperators`. */
    failed: number;
    /** What the last notices could be read as. A ledger that was not read raises nothing. */
    ledger: "read" | "unreadable" | "dry_run" | "nothing_read";
    error?: string;
  };
};

export type ClonePrivilegeReconcileResult = {
  dryRun: boolean;
  considered: number;
  /** Clones that needed nothing — the settled state. */
  alreadyAligned: number;
  changed: ClonePrivilegeOutcome[];
  /** The clone the budget stopped in, if any. The next pass resumes it. */
  pausedAt: string | null;
  refused: Array<{ cloneId: string; reason: string; error: string }>;
  /** Table privileges, compared and reported. Report-only. */
  tables: TableGrantSweep;
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Rotate `items` so the run starts at `offset` — fairness across passes, no state needed. */
export function rotate<T>(items: readonly T[], offset: number): T[] {
  if (items.length === 0) return [];
  const k = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(k), ...items.slice(0, k)];
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

function settle<T>(run: () => Promise<T>): Promise<Settled<T>> {
  return Promise.resolve()
    .then(run)
    .then(
      (value): Settled<T> => ({ ok: true, value }),
      (e: unknown): Settled<T> => ({ ok: false, error: msg(e).slice(0, 300) }),
    );
}

export async function reconcileClonePrivileges(
  supabase: Db,
  opts: { deadlineAt: number; dryRun?: boolean; cloneId?: string; now?: number },
): Promise<ClonePrivilegeReconcileResult> {
  const dryRun = Boolean(opts.dryRun);
  let q = supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  if (opts.cloneId) q = q.eq("clone_id", opts.cloneId);
  const { data, error } = await q;
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => (r as { clone_id: string | null }).clone_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();

  const out: ClonePrivilegeReconcileResult = {
    dryRun,
    considered: candidates.length,
    alreadyAligned: 0,
    changed: [],
    pausedAt: null,
    refused: [],
    tables: {
      mode: tableGrantMode(),
      clones: [],
      notReached: [],
      notices: { raised: 0, failed: 0, ledger: "nothing_read" },
    },
  };
  if (candidates.length === 0) return out;

  const { resolvePrimeBackendRef } = await import("./prime-backend.server");
  // Unset is fatal here, as it is for provisioning: with no prime there is no
  // authority to converge towards, and guessing one is how the wrong database
  // was once copied.
  const primeRef = await resolvePrimeBackendRef(supabase);
  const { convergeClonePrivileges, readRelationAcls } =
    await import("./schema-introspection.server");

  // The prime's side of the table comparison: one statement, read when the
  // first clone needs it and shared by every clone in the pass.
  let primeTables: Promise<Settled<RelationAclReading>> | undefined;
  const readPrimeTables = () => (primeTables ??= settle(() => readRelationAcls(primeRef)));

  const minute = Math.floor((opts.now ?? Date.now()) / 60_000);
  const order = rotate(candidates, minute);
  for (const [i, cloneId] of order.entries()) {
    if (pastDeadline(opts.deadlineAt)) {
      out.pausedAt = cloneId;
      out.tables.notReached = order.slice(i);
      break;
    }
    let target: Awaited<ReturnType<typeof resolveCloneSecretTarget>>;
    try {
      target = await resolveCloneSecretTarget(supabase, cloneId);
    } catch (e) {
      out.refused.push({
        cloneId,
        reason: e instanceof CloneSecretTargetError ? e.reason : "target_unresolved",
        error: msg(e),
      });
      out.tables.clones.push({
        cloneId,
        read: "not_read",
        why: "the clone's project could not be resolved, so nothing was compared",
      });
      continue;
    }

    // Started beside the function reads rather than after them.
    const cloneRef = target.projectRef;
    const tables = surveyCloneTableGrants(target, readPrimeTables(), () =>
      readRelationAcls(cloneRef),
    );

    let paused = false;
    try {
      const r = await convergeClonePrivileges(target.projectRef, {
        primeRef,
        deadlineAt: opts.deadlineAt,
        dryRun,
      });
      const planned = r.plan.routines.grants + r.plan.routines.revokes + r.plan.views.statements;
      const outcome: ClonePrivilegeOutcome = {
        cloneId,
        cloneName: target.cloneName,
        projectRef: target.projectRef,
        applied: r.applied,
        failed: r.failed,
        grants: r.plan.routines.grants,
        revokes: r.plan.routines.revokes,
        viewStatements: r.plan.views.statements,
        closedDefinerExposures: r.plan.routines.closedDefinerExposures,
        invokerRestored: r.plan.views.invokerRestored,
        heldForReference: r.plan.routines.heldForReference.length,
        cloneOnlyExposedDefiners: r.plan.routines.cloneOnlyExposedDefiners.slice(0, 20),
        ...(r.errors.length ? { errors: r.errors.slice(0, 10) } : {}),
        ...(dryRun ? { sample: r.sample } : {}),
      };
      if (planned === 0) {
        out.alreadyAligned += 1;
        // A clone-only exposure is not this sweep's to close, but it is worth
        // a line wherever somebody reads the result.
        if (outcome.cloneOnlyExposedDefiners.length) out.changed.push(outcome);
      } else {
        out.changed.push(outcome);
      }
    } catch (e) {
      if (e instanceof BudgetPause) {
        out.pausedAt = cloneId;
        paused = true;
      } else {
        out.refused.push({ cloneId, reason: "converge_failed", error: msg(e) });
      }
    }

    // A read only, so it is kept even when the function pass on the same
    // clone was stopped or refused: the two are independent questions.
    out.tables.clones.push(await tables);
    if (paused) {
      out.tables.notReached = order.slice(i + 1);
      break;
    }
  }

  out.tables.notices = await announceTableGrantChanges(supabase, out.tables.clones, dryRun);
  return out;
}

/**
 * One clone's table privileges against the prime's. Reads only, and never
 * rejects: a side that could not be read is reported by name.
 */
async function surveyCloneTableGrants(
  target: { cloneId: string; cloneName: string; projectRef: string },
  prime: Promise<Settled<RelationAclReading>>,
  readClone: () => Promise<RelationAclReading>,
): Promise<CloneTableGrantReport> {
  const [p, c] = await Promise.all([prime, settle(readClone)]);
  const base = {
    cloneId: target.cloneId,
    cloneName: target.cloneName,
    projectRef: target.projectRef,
  };
  const unreadable = (side: "prime" | "clone", error: string): CloneTableGrantReport => ({
    ...base,
    read: "unreadable",
    side,
    error,
  });
  if (!p.ok) return unreadable("prime", p.error);
  if (!c.ok) return unreadable("clone", c.error);
  // No project in this fleet holds fewer than 600 relations in `public`, and
  // `toRows` reads a body it does not recognise as no rows at all. A side that
  // answered none was not read, and a comparison against nothing would report
  // a clean clone and clear a finding announced before.
  if (p.value.relations.length === 0) {
    return unreadable("prime", "the catalogue answered no relation in public");
  }
  if (c.value.relations.length === 0) {
    return unreadable("clone", "the catalogue answered no relation in public");
  }
  // A comparison that throws is a fault in this code, and it is said as one
  // for this clone rather than failing the pass: the function work on every
  // clone is still reported.
  try {
    const comparison = compareTableGrants({
      prime: p.value.relations,
      clone: c.value.relations,
      maintainOnBoth: p.value.maintain && c.value.maintain,
    });
    return { ...base, read: "ok", ...summariseTableGrants(comparison) };
  } catch (e) {
    return { ...base, read: "failed", error: msg(e).slice(0, 300) };
  }
}

/**
 * Tell a person when a clone's table surplus CHANGES: when one first appears,
 * when it grows or shrinks, and when it clears. Never once a half hour for the
 * same thing (`decideTableGrantNotice`).
 *
 * The ledger is the audit log: one row per notice that landed, keyed on what
 * was DELIVERED rather than on what was observed, so a notice the database
 * refused is raised again on the next pass instead of being recorded as told.
 * It is not the notices themselves, because an operator may purge read
 * notifications (`purgeReadNotifications`). Read from there, a purged notice
 * would read as never told, so a standing surplus would be announced again
 * as new, and a clearance after the purge would never be announced. Nothing
 * deletes from the audit log, and the held-file drift sweep and the clone CI
 * watch keep their fingerprints there for the same reason.
 */
async function announceTableGrantChanges(
  supabase: Db,
  reports: readonly CloneTableGrantReport[],
  dryRun: boolean,
): Promise<TableGrantSweep["notices"]> {
  const read = reports.filter(
    (r): r is Extract<CloneTableGrantReport, { read: "ok" }> => r.read === "ok",
  );
  if (read.length === 0) return { raised: 0, failed: 0, ledger: "nothing_read" };
  // A dry run is somebody looking. It answers them, and tells nobody else.
  if (dryRun) return { raised: 0, failed: 0, ledger: "dry_run" };

  // The last row for each clone, one read each, so a clone whose surplus has
  // stood unchanged for months is never pushed out of a shared window by
  // another clone's history.
  const readings = await Promise.all(
    read.map(async (r) => {
      const { data, error } = await supabase
        .from("audit_log")
        .select("metadata")
        .eq("action", TABLE_GRANT_NOTICE_SOURCE)
        .eq("entity_id", r.cloneId)
        .order("created_at", { ascending: false })
        .limit(1);
      return { cloneId: r.cloneId, data, error };
    }),
  );
  // A ledger that could not be read is not one that says "never told": read
  // that way, every standing surplus would be announced again on every
  // database hiccup.
  const unread = readings.find((x) => x.error);
  if (unread?.error) {
    return { raised: 0, failed: 0, ledger: "unreadable", error: unread.error.message };
  }

  const last = new Map<string, string | null>();
  for (const { cloneId, data } of readings) {
    const fp = (data?.[0]?.metadata as { fingerprint?: unknown } | null | undefined)?.fingerprint;
    // A row with no fingerprint cannot vouch for anything, so it reads as
    // none: the worst that does is one notice too many.
    last.set(cloneId, typeof fp === "string" ? fp : null);
  }

  let raised = 0;
  let failed = 0;
  for (const r of read) {
    const decision = decideTableGrantNotice({ previous: last.get(r.cloneId) ?? null, current: r });
    if (!decision.notify) continue;
    const notice = describeTableGrantNotice(r.cloneName, r, decision.kind);
    const landed = await notifyOperators({
      kind: "drift_medium",
      severity: notice.severity,
      title: notice.title,
      body: notice.body,
      cloneId: r.cloneId,
      url: `/clones/${r.cloneId}`,
      metadata: {
        source: TABLE_GRANT_NOTICE_SOURCE,
        fingerprint: decision.fingerprint,
        mode: tableGrantMode(),
        surplus: r.surplus,
        relations: r.relations,
        columnSurplus: r.columnSurplus,
      },
    });
    if (!landed) {
      failed += 1;
      continue;
    }
    raised += 1;
    // `writeAuditLog` logs a failed insert rather than throwing, so a lost
    // row means the next pass announces this again: noise, the safe direction.
    await writeAuditLog({
      action: TABLE_GRANT_NOTICE_SOURCE,
      entityType: "clone",
      entityId: r.cloneId,
      metadata: {
        fingerprint: decision.fingerprint,
        kind: decision.kind,
        mode: tableGrantMode(),
        surplus: r.surplus,
        relations: r.relations,
        columnSurplus: r.columnSurplus,
      },
    });
  }
  return { raised, failed, ledger: "read" };
}

/**
 * Whether a pass deserves a line in the audit log.
 *
 * Function EXECUTE and view options settle, and once they have, a pass writes
 * nothing and has nothing to say. The table comparison is different for now:
 * it is report-only for a week, and its report is what the owner reviews, so a
 * scheduled pass in which any clone holds a table surplus, or could not be
 * compared, or whose notices changed, files its row. Once every clone matches
 * the prime the sweep is quiet again. A dry run answers its caller instead.
 */
export function privilegeSweepIsNoteworthy(report: ClonePrivilegeReconcileResult): boolean {
  const wrote = report.changed.some((c) => c.applied > 0 || c.failed > 0);
  if (wrote || report.refused.length > 0) return true;
  if (report.dryRun) return false;
  if (report.pausedAt) return true;
  const t = report.tables;
  return (
    t.clones.some((c) => c.read !== "ok" || c.surplus > 0 || c.columnSurplus > 0) ||
    t.notices.raised > 0 ||
    t.notices.failed > 0 ||
    t.notices.ledger === "unreadable"
  );
}
