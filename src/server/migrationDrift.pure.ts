/**
 * Judging one `-- @asserts` claim against what the database actually answered.
 *
 * ## Why this is separate from the probing
 *
 * The probes are four HTTP shapes; the judgement is a set of rules this
 * repository has already paid to learn, and they are the part worth pinning
 * with tests. Keeping them here means the rule that "a failed read is not an
 * absent object" is asserted rather than implied by a `catch` block somewhere.
 *
 * ## The five verdicts, and why there are five
 *
 * A two-state answer (pass / fail) is what makes a drift alarm useless. Three
 * distinct things are NOT failure and none of them is success:
 *
 * - `error` — the probe itself did not complete. A read that FAILED is not a
 *   row that is ABSENT. `aml.cases` cost this platform twelve handlers
 *   reporting "Case not found" about a case the operator had open, because a
 *   `42703` was read as an empty result. Here the same confusion would report a
 *   migration as never applied because the network blipped, and somebody would
 *   go and re-run it.
 * - `unassertable` — there is no channel that can answer. `enum` claims are
 *   this: `pg_type` lives outside the two schemas PostgREST exposes
 *   (`PGRST106`), so nothing short of a new database object can see it. Saying
 *   "I could not check this" is the whole point; a checker that drops what it
 *   cannot see reports coverage it does not have.
 * - `not_applicable` — a `none:` claim. The migration says in words that it
 *   makes nothing observable. That is a valid thing to have written and it is
 *   not evidence of anything, so it must never be counted as a satisfied claim.
 *
 * Only `unsatisfied` is an alarm. That is deliberate and narrow: an alarm that
 * also fires for "could not reach the database" is one people mute.
 */

import type { Assertion } from "./migrationAssertions.pure";

export type CheckStatus = "satisfied" | "unsatisfied" | "unassertable" | "not_applicable" | "error";

/**
 * What a probe came back with.
 *
 * `exists` covers `table`, `column` and `rpc`; `count` covers `rows`; `cron`
 * covers a scheduled job. `failed` is the probe not completing, and it is a
 * separate member rather than `exists: false` for exactly the reason in the
 * module header.
 */
export type Probe =
  | { kind: "exists"; exists: boolean }
  | { kind: "count"; count: number }
  | { kind: "cron"; scheduled: boolean; active: boolean }
  | { kind: "failed"; message: string };

export type CheckResult = {
  readonly assertion: Assertion;
  readonly status: CheckStatus;
  /** One line, for the operator. Always populated. */
  readonly detail: string;
};

/**
 * Judge one assertion against one probe.
 *
 * `probe` is null when nothing was run — either because the claim has no
 * channel (`enum`), because it is not a claim about the database (`none`), or
 * because the run's budget was reached. All three are "not checked", and none
 * of them is a pass.
 */
export function judge(assertion: Assertion, probe: Probe | null): CheckResult {
  // `none` is a statement about the migration, not about the database. It is
  // answered by reading it, and it is never evidence that anything is true.
  if (assertion.kind === "none") {
    return { assertion, status: "not_applicable", detail: assertion.reason };
  }

  if (assertion.kind === "enum") {
    return {
      assertion,
      status: "unassertable",
      detail:
        `pg_type is not exposed by PostgREST (PGRST106), so \`${assertion.type}\` ` +
        `cannot be observed from here. Regenerating src/integrations/supabase/types.ts ` +
        `is what catches an enum that did not arrive.`,
    };
  }

  // A widened CHECK constraint lives in pg_constraint, which PostgREST does
  // not expose either. The claim is still worth writing down — it is what the
  // migration makes true, and `none` would say the opposite — but the thing
  // that catches a value the column still refuses is a write that fails, so
  // the detail says where to look rather than pretending to have looked.
  if (assertion.kind === "check") {
    return {
      assertion,
      status: "unassertable",
      detail:
        `pg_constraint is not exposed by PostgREST, so the CHECK on ` +
        `\`${assertion.table}.${assertion.column}\` cannot be observed from here. ` +
        `A value the column refuses fails at the write, not here.`,
    };
  }

  if (probe === null) {
    return { assertion, status: "unassertable", detail: "not probed on this run" };
  }

  if (probe.kind === "failed") {
    // Never `unsatisfied`. The remedy for a failed probe is to look at the
    // probe; the remedy for an unsatisfied claim is to apply a migration.
    // Conflating them sends somebody to re-run SQL because of a 502.
    return { assertion, status: "error", detail: probe.message };
  }

  switch (assertion.kind) {
    case "table":
      if (probe.kind !== "exists") return mismatch(assertion, probe);
      return probe.exists
        ? { assertion, status: "satisfied", detail: `table ${assertion.table} exists` }
        : {
            assertion,
            status: "unsatisfied",
            detail: `table ${assertion.table} does not exist`,
          };

    case "column":
      if (probe.kind !== "exists") return mismatch(assertion, probe);
      return probe.exists
        ? {
            assertion,
            status: "satisfied",
            detail: `${assertion.table}.${assertion.column} exists`,
          }
        : {
            assertion,
            status: "unsatisfied",
            detail: `${assertion.table}.${assertion.column} does not exist`,
          };

    case "rpc":
      if (probe.kind !== "exists") return mismatch(assertion, probe);
      return probe.exists
        ? { assertion, status: "satisfied", detail: `function ${assertion.fn} is exposed` }
        : {
            assertion,
            status: "unsatisfied",
            detail: `function ${assertion.fn} is not exposed by PostgREST`,
          };

    case "rows": {
      if (probe.kind !== "count") return mismatch(assertion, probe);
      const enough = probe.count >= assertion.atLeast;
      return {
        assertion,
        status: enough ? "satisfied" : "unsatisfied",
        detail: `${assertion.table} holds ${probe.count} row(s), claim is >= ${assertion.atLeast}`,
      };
    }

    case "cron": {
      if (probe.kind !== "cron") return mismatch(assertion, probe);
      if (!probe.scheduled) {
        return {
          assertion,
          status: "unsatisfied",
          detail: `no cron job named ${assertion.jobname}`,
        };
      }
      // Scheduled-but-inactive is the shape six workers shipped in: the
      // migration recorded as applied, `cron.schedule` never reached, and a
      // RAISE NOTICE nobody reads as the only trace. A job that exists and does
      // not run has not made the claim true.
      return probe.active
        ? { assertion, status: "satisfied", detail: `${assertion.jobname} is scheduled and active` }
        : {
            assertion,
            status: "unsatisfied",
            detail: `${assertion.jobname} exists but is inactive`,
          };
    }
  }
}

/**
 * A probe of the wrong shape for the claim is a programming error in the
 * prober, not a fact about the database — so it is an `error`, which is the
 * verdict that says "look at the checker".
 */
function mismatch(assertion: Assertion, probe: Probe): CheckResult {
  return {
    assertion,
    status: "error",
    detail: `internal: ${assertion.kind} claim answered with a ${probe.kind} probe`,
  };
}

export type DriftSummary = {
  readonly checked: number;
  readonly satisfied: number;
  /** The alarm. Nothing else in this summary is one. */
  readonly unsatisfied: number;
  readonly unassertable: number;
  readonly notApplicable: number;
  readonly errors: number;
  /** Every unsatisfied claim, formatted for an operator notification. */
  readonly drifted: readonly string[];
};

/**
 * Roll a run's results up.
 *
 * `checked` counts only the claims that got a real answer — satisfied plus
 * unsatisfied. Counting the unassertable ones would let coverage rise by adding
 * claims nothing can see, which is precisely the way a green number stops
 * meaning anything.
 */
export function summariseDrift(
  results: readonly { readonly migration: string; readonly result: CheckResult }[],
): DriftSummary {
  const count = (s: CheckStatus) => results.filter((r) => r.result.status === s).length;
  const satisfied = count("satisfied");
  const unsatisfied = count("unsatisfied");
  return {
    checked: satisfied + unsatisfied,
    satisfied,
    unsatisfied,
    unassertable: count("unassertable"),
    notApplicable: count("not_applicable"),
    errors: count("error"),
    drifted: results
      .filter((r) => r.result.status === "unsatisfied")
      .map((r) => `${r.migration}: ${r.result.detail}`),
  };
}
