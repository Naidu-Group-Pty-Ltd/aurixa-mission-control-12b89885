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
 * ## Table privileges: compared, reported, and taken back where enforced
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
 * It reported only, by the owner's decision of 28 Oct 2026, until the owner
 * chose on 31 Oct 2026 to take the surplus back on every clone
 * (`tableGrantEnforcement.pure.ts`). On a clone `TABLE_GRANT_ENFORCEMENT`
 * reaches (every clone since 31 Oct 2026, the demo first), a pass files the
 * grants that would undo it, takes the surplus back, and reads the clone
 * again, so its report is what the catalogue says after, not what the
 * statements meant. On any clone a narrower scope leaves out it reports, with
 * the list of what would be taken back.
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
  type RelationAcl,
  type RelationAclReading,
  type TableGrantComparison,
  type TableGrantMode,
  type TableGrantSummary,
} from "./tablePrivileges.pure";
import {
  TABLE_GRANT_ENFORCEMENT,
  enforcesTableGrants,
  planTableGrantRevokes,
  revokeLines,
  type EnforcementCandidate,
  type TableGrantEnforcementScope,
} from "./tableGrantEnforcement.pure";

/** The audit action that files a clone's revoke plan, and the grants that undo it, before it runs. */
export const TABLE_GRANT_REVOKE_ACTION = "clone_table_privileges_revoked";

/**
 * At most this many relations a clone a pass, worst first, so one pass's
 * statements always go in one call. The widest clone measured, the tutorial
 * demo, had 139 on 31 Oct 2026.
 */
export const TABLE_GRANT_RELATIONS_PER_PASS = 200;

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
/** What a pass did about one clone's surplus, beside the reading after it. */
export type TableGrantEnforcementOutcome =
  | {
      done: "revoked";
      /** Table-level privileges the plan took back, and on how many relations. */
      privileges: number;
      relations: number;
      applied: number;
      failed: number;
      errors?: string[];
      /** The reading the plan was made from. The report itself is the reading after. */
      before: { surplus: number; relations: number };
      /** Relations left for the next pass, past `TABLE_GRANT_RELATIONS_PER_PASS`. */
      deferred?: number;
      refused?: Array<{ relation: string; why: string }>;
    }
  | {
      done: "planned";
      /** A dry run: what a pass would take back, and the first statements. */
      privileges: number;
      relations: number;
      sample: string[];
      refused?: Array<{ relation: string; why: string }>;
    }
  | {
      done: "withheld";
      /** Nothing was taken back, and why. */
      why: string;
    };

export type CloneTableGrantReport =
  | ({
      cloneId: string;
      cloneName: string;
      projectRef: string;
      read: "ok";
      /** Present where the pass took the surplus back, or would have. */
      enforcement?: TableGrantEnforcementOutcome;
      /**
       * Out of scope: what a pass would revoke on each relation, PUBLIC's
       * included, for the review before the scope widens (`revokeLines`).
       */
      wouldRevoke?: string[];
    } & TableGrantSummary)
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
  /** Whether a pass takes anything back, and on which clones (`TABLE_GRANT_ENFORCEMENT`). */
  mode: TableGrantMode;
  scope: TableGrantEnforcementScope;
  /** Set when the clones' records, which decide the demo scope, could not be read. */
  scopeUnread?: string;
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
  opts: {
    deadlineAt: number;
    dryRun?: boolean;
    cloneId?: string;
    now?: number;
    /** Which clones a pass takes the surplus back on. `TABLE_GRANT_ENFORCEMENT` when absent. */
    tableGrantScope?: TableGrantEnforcementScope;
  },
): Promise<ClonePrivilegeReconcileResult> {
  const dryRun = Boolean(opts.dryRun);
  const scope = opts.tableGrantScope ?? TABLE_GRANT_ENFORCEMENT;
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
      mode: tableGrantMode(scope),
      scope,
      clones: [],
      notReached: [],
      notices: { raised: 0, failed: 0, ledger: "nothing_read" },
    },
  };
  if (candidates.length === 0) return out;

  // Who is a demo is read from Mission Control's own records, once a pass. A
  // read that fails puts no clone in the demo scope: taking privileges back is
  // the write, and a guess must never decide one.
  const records = new Map<string, EnforcementCandidate>();
  if (scope === "demo") {
    const { data: rows, error: recordsError } = await supabase
      .from("clones")
      .select("id, billing_stripe_customer_id, entitled_plan_slug, tags")
      .in("id", candidates);
    if (recordsError) {
      out.tables.scopeUnread = recordsError.message;
    } else {
      for (const r of (rows ?? []) as Array<EnforcementCandidate & { id: string }>) {
        records.set(r.id, r);
      }
    }
  }

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
    const surveyed = await tables;
    let report: CloneTableGrantReport = surveyed.report;
    const ok = surveyed.report.read === "ok" ? surveyed.report : null;
    if (ok && surveyed.detail && ok.relations > 0) {
      if (!enforcesTableGrants(scope, records.get(cloneId) ?? null)) {
        const { comparison, prime, clone, maintainOnBoth } = surveyed.detail;
        report = {
          ...ok,
          wouldRevoke: revokeLines(
            planTableGrantRevokes({ entries: comparison.entries, prime, clone, maintainOnBoth }),
          ),
        };
      } else if (paused) {
        // The budget is spent; the next pass re-plans from both catalogues.
        report = {
          ...ok,
          enforcement: { done: "withheld", why: "the pass ran out of time on this clone" },
        };
      } else {
        try {
          report = await enforceCloneTableGrants(cloneId, ok, surveyed.detail, {
            scope,
            dryRun,
            deadlineAt: opts.deadlineAt,
            readClone: () => readRelationAcls(cloneRef),
          });
        } catch (e) {
          // A fault in taking back is this clone's, and said as one: the
          // function work and every other clone are still reported. The call
          // that writes is one transaction, so a fault leaves none of it half
          // done; the planned row filed before it says what was attempted.
          report = {
            ...ok,
            enforcement: { done: "withheld", why: `taking back failed: ${msg(e).slice(0, 300)}` },
          };
        }
      }
    }
    out.tables.clones.push(report);
    if (paused) {
      out.tables.notReached = order.slice(i + 1);
      break;
    }
  }

  out.tables.notices = await announceTableGrantChanges(supabase, out.tables.clones, dryRun, scope);
  return out;
}

/** What a survey compared, kept for the pass that takes the surplus back. */
type SurveyDetail = {
  comparison: TableGrantComparison;
  prime: readonly RelationAcl[];
  clone: readonly RelationAcl[];
  maintainOnBoth: boolean;
};

/**
 * One clone's table privileges against the prime's. Reads only, and never
 * rejects: a side that could not be read is reported by name.
 */
async function surveyCloneTableGrants(
  target: { cloneId: string; cloneName: string; projectRef: string },
  prime: Promise<Settled<RelationAclReading>>,
  readClone: () => Promise<RelationAclReading>,
): Promise<{ report: CloneTableGrantReport; detail?: SurveyDetail }> {
  const [p, c] = await Promise.all([prime, settle(readClone)]);
  const base = {
    cloneId: target.cloneId,
    cloneName: target.cloneName,
    projectRef: target.projectRef,
  };
  const unreadable = (side: "prime" | "clone", error: string) => ({
    report: { ...base, read: "unreadable" as const, side, error },
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
    const maintainOnBoth = p.value.maintain && c.value.maintain;
    const comparison = compareTableGrants({
      prime: p.value.relations,
      clone: c.value.relations,
      maintainOnBoth,
    });
    return {
      report: { ...base, read: "ok", ...summariseTableGrants(comparison) },
      detail: { comparison, prime: p.value.relations, clone: c.value.relations, maintainOnBoth },
    };
  } catch (e) {
    return { report: { ...base, read: "failed", error: msg(e).slice(0, 300) } };
  }
}

type OkReport = Extract<CloneTableGrantReport, { read: "ok" }>;

/**
 * Take one clone's surplus back, and say what its catalogue holds after.
 *
 * In order, and each step only when the one before it held:
 *   1. plan from the comparison and both readings (`planTableGrantRevokes`);
 *   2. file the plan and the grants that undo it in the audit log. A plan that
 *      could not be filed is not run: once the privileges are gone, that row
 *      is the only record of what they were;
 *   3. run it, one subtransaction a relation, all in one call to the batch
 *      helper, which is one transaction: the clone holds the whole pass's work
 *      or none of it. The budget is checked before anything is filed, never
 *      between batches, and one pass carries at most
 *      `TABLE_GRANT_RELATIONS_PER_PASS` relations, worst first;
 *   4. read the clone again and compare, so the report is the catalogue after
 *      and never the statements' intent. A clone that cannot be read after
 *      keeps the reading before, said as such.
 *
 * A dry run stops after the plan and answers with a sample. A fault of its
 * own is thrown, and the sweep reports it for this clone.
 */
async function enforceCloneTableGrants(
  cloneId: string,
  before: OkReport,
  detail: SurveyDetail,
  opts: {
    scope: TableGrantEnforcementScope;
    dryRun: boolean;
    deadlineAt: number;
    readClone: () => Promise<RelationAclReading>;
  },
): Promise<CloneTableGrantReport> {
  const plan = planTableGrantRevokes({
    entries: detail.comparison.entries,
    prime: detail.prime,
    clone: detail.clone,
    maintainOnBoth: detail.maintainOnBoth,
  });
  const refused = plan.refused.length ? { refused: plan.refused } : {};
  if (opts.dryRun) {
    return {
      ...before,
      enforcement: {
        done: "planned",
        privileges: plan.privileges,
        relations: plan.relations.length,
        sample: plan.relations.slice(0, 10).map((r) => r.statement),
        ...refused,
      },
    };
  }
  if (plan.relations.length === 0) {
    return {
      ...before,
      enforcement: {
        done: "withheld",
        why: plan.refused.length
          ? `no relation could be planned: ${plan.refused.map((r) => `${r.relation} (${r.why})`).join("; ")}`
          : "the surplus is all held through grants this sweep does not take back",
      },
    };
  }

  // Nothing is filed or sent once the budget is spent: the next pass plans it
  // again from both catalogues.
  if (pastDeadline(opts.deadlineAt)) {
    return {
      ...before,
      enforcement: {
        done: "withheld",
        why: "no time was left in this pass; the next pass plans it again",
      },
    };
  }
  const thisPass = plan.relations.slice(0, TABLE_GRANT_RELATIONS_PER_PASS);
  const deferred = plan.relations.length - thisPass.length;
  const privileges = thisPass.reduce(
    (n, r) => n + r.revoke.anon.length + r.revoke.authenticated.length + r.revoke.PUBLIC.length,
    0,
  );

  const filed = await writeAuditLog({
    action: TABLE_GRANT_REVOKE_ACTION,
    entityType: "clone",
    entityId: cloneId,
    metadata: {
      stage: "planned",
      scope: opts.scope,
      privileges,
      surplusBefore: before.surplus,
      relations: thisPass.map(({ statement: _statement, ...r }) => r),
      ...(deferred > 0 ? { deferred } : {}),
      ...refused,
    },
  });
  if (!filed) {
    return {
      ...before,
      enforcement: {
        done: "withheld",
        why: "the plan and the grants that undo it could not be filed in the audit log, so nothing was taken back",
      },
    };
  }

  const { applyTableGrantRevokes } = await import("./schema-introspection.server");
  const applied = await applyTableGrantRevokes(
    before.projectRef,
    thisPass.map((r) => r.statement),
  );

  const outcome: TableGrantEnforcementOutcome = {
    done: "revoked",
    privileges,
    relations: thisPass.length,
    applied: applied.applied,
    failed: applied.failed,
    ...(applied.errors.length ? { errors: applied.errors.slice(0, 10) } : {}),
    before: { surplus: before.surplus, relations: before.relations },
    ...(deferred > 0 ? { deferred } : {}),
    ...refused,
  };

  // By effect: what the clone's catalogue says now.
  const reread = await settle(opts.readClone);
  let after: CloneTableGrantReport = { ...before, enforcement: outcome };
  if (reread.ok && reread.value.relations.length > 0) {
    const maintainOnBoth = detail.maintainOnBoth && reread.value.maintain;
    after = {
      ...before,
      ...summariseTableGrants(
        compareTableGrants({ prime: detail.prime, clone: reread.value.relations, maintainOnBoth }),
      ),
      enforcement: outcome,
    };
  } else {
    outcome.errors = [
      ...(outcome.errors ?? []),
      `the clone could not be read after: ${reread.ok ? "it answered no relation" : reread.error}; the reading shown is from before`,
    ];
  }

  await writeAuditLog({
    action: TABLE_GRANT_REVOKE_ACTION,
    entityType: "clone",
    entityId: cloneId,
    metadata: {
      stage: "applied",
      scope: opts.scope,
      privileges,
      relations: thisPass.length,
      applied: applied.applied,
      failed: applied.failed,
      errors: outcome.errors ?? [],
      surplusBefore: before.surplus,
      surplusAfter: after.read === "ok" ? after.surplus : null,
    },
  });
  return after;
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
  scope: TableGrantEnforcementScope,
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
    const notice = describeTableGrantNotice(r.cloneName, r, decision.kind, {
      mode: tableGrantMode(scope),
      enforcedHere: r.enforcement?.done === "revoked",
    });
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
        mode: tableGrantMode(scope),
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
        mode: tableGrantMode(scope),
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
  const wrote =
    report.changed.some((c) => c.applied > 0 || c.failed > 0) ||
    report.tables.clones.some(
      (c) =>
        c.read === "ok" &&
        (c.enforcement?.done === "revoked" || c.enforcement?.done === "withheld"),
    );
  if (wrote || report.refused.length > 0 || report.tables.scopeUnread) return true;
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
