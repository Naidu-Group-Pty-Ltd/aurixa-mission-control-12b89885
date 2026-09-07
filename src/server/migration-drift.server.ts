/**
 * The drift alarm: ask the database whether the migrations actually took.
 *
 * ## The question nothing could answer
 *
 * `supabase_migrations.schema_migrations` is a record of what RAN, and on this
 * deployment it is not even that: 40 of 211 repo versions appear in it and 103
 * of its rows correspond to no repo file at all, because Lovable stamps its own
 * apply timestamps. Two namespaces, barely overlapping. So "has this migration
 * been applied?" had no answer, which is how 67 files came to sit in a
 * documented backlog nobody could resolve.
 *
 * This asks a different question, and it is the one that actually matters:
 * **is the thing the migration was for present in the database?** A migration
 * declares that in a `-- @asserts` comment; the generator compiles those into
 * `migrationAssertions.generated.ts`; this goes and looks.
 *
 * It catches something no applier can. A `DO $$ ... EXCEPTION WHEN OTHERS THEN
 * NULL $$` block -- and this corpus contains that shape -- RUNS, SUCCEEDS, and
 * achieves nothing. Every ledger in the world records that as applied.
 *
 * ## Zero new privilege, and that is the point
 *
 * `docs/MIGRATION_AUTOMATION_OPTIONS.md` rejects the obvious automation because
 * granting Mission Control DDL over its own database is one forgotten `REVOKE`
 * word away from granting it to `anon` -- a line this repository writes wrong
 * 71% of the time. This adds no database function, no grant and no DDL
 * capability. It reads, with a credential the server already holds.
 *
 * ## Four channels, and why not a fifth
 *
 * | claim | channel |
 * | --- | --- |
 * | `table`, `column` | `GET /rest/v1/<t>?select=...&limit=0` -- 200 present, `PGRST205`/`42703` absent |
 * | `rows` | the same GET with `Prefer: count=exact`, read off `content-range` |
 * | `rpc` | the PostgREST schema description at `GET /rest/v1/` (service_role only) |
 * | `cron` | `public.cron_delivery_health()`, which already joins `cron.job` |
 * | `enum` | none -- `pg_type` is outside the exposed schemas, reported unassertable |
 *
 * An `rpc` claim is answered from the schema description and **never by calling
 * the function**. Probing a function by invoking it is how a checker fires a
 * webhook, drains a queue or charges a card to find out whether it exists.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { Assertion } from "./migrationAssertions.pure";
import { formatAssertion } from "./migrationAssertions.pure";
import { MIGRATION_CLAIMS, type MigrationClaims } from "./migrationAssertions.generated";
import {
  judge,
  summariseDrift,
  type CheckResult,
  type DriftSummary,
  type Probe,
} from "./migrationDrift.pure";
import { notifyOperators } from "./audit.server";

type Db = SupabaseClient<Database>;

/**
 * Wall-clock budget for one run, well inside a Worker's ceiling. The run banks
 * every claim it checked before stopping and orders by staleness, so a corpus
 * larger than one run finishes across ticks rather than never.
 */
const BUDGET_MS = 20_000;
/** Distinct probe targets per run. Claims sharing a target cost one probe. */
const MAX_TARGETS = 80;

export type MigrationDriftOptions = {
  readonly claims?: readonly MigrationClaims[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly budgetMs?: number;
  readonly maxTargets?: number;
  readonly supabaseUrl?: string;
  readonly serviceRoleKey?: string;
};

export type MigrationDriftRun = {
  readonly claims: number;
  /** Distinct targets actually probed this run. */
  readonly probed: number;
  /** Claims left for a later tick because the budget ran out. */
  readonly deferred: number;
  /** Rows removed because their claim no longer exists in the corpus. */
  readonly pruned: number;
  readonly summary: DriftSummary;
  readonly newlyDrifted: readonly string[];
  readonly notified: boolean;
};

// -- Targets -----------------------------------------------------------------
//
// Several migrations legitimately assert the same object, and a `rows:t>=17`
// and a `rows:t>=3` are one COUNT. Deduplicating by target is what keeps the
// probe count proportional to the schema rather than to the corpus.

type Target =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "count"; table: string }
  | { kind: "rpc"; fn: string }
  | { kind: "cron"; jobname: string };

function targetFor(a: Assertion): Target | null {
  switch (a.kind) {
    case "table":
      return { kind: "table", table: a.table };
    case "column":
      return { kind: "column", table: a.table, column: a.column };
    case "rows":
      // Deliberately drops `atLeast`: the probe is a count, the threshold is a
      // judgement, and two thresholds on one table must not cost two counts.
      return { kind: "count", table: a.table };
    case "rpc":
      return { kind: "rpc", fn: a.fn };
    case "cron":
      return { kind: "cron", jobname: a.jobname };
    case "enum":
    case "check":
    case "none":
      return null;
  }
}

function targetKey(t: Target): string {
  switch (t.kind) {
    case "table":
      return `table:${t.table}`;
    case "column":
      return `column:${t.table}.${t.column}`;
    case "count":
      return `count:${t.table}`;
    case "rpc":
      return `rpc:${t.fn}`;
    case "cron":
      return `cron:${t.jobname}`;
  }
}

// -- Probing -----------------------------------------------------------------

type Rest = {
  readonly url: string;
  readonly key: string;
  readonly fetchImpl: typeof fetch;
};

/**
 * The global `fetch`, wrapped so it is always called as a FREE function.
 *
 * In a Cloudflare Worker `fetch` is bound to the global scope. Storing the bare
 * global on an object and calling it as `rest.fetchImpl(...)` sets `this` to
 * that object, and the runtime answers:
 *
 *     Illegal invocation: function called with incorrect `this` reference.
 *
 * This alarm found that in itself, on its first live run: both `table:` claims
 * came back `error` with exactly that message while both `cron:` claims (which
 * go through supabase-js, not this) came back satisfied. Every test injects
 * `fetchImpl`, so the default was the one path nothing exercised -- which is
 * why `defaults to a global fetch that survives being stored on an object`
 * exists below it.
 */
const globalFetch: typeof fetch = (input, init) => fetch(input, init);

function restHeaders(rest: Rest, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: rest.key,
    Authorization: `Bearer ${rest.key}`,
    ...extra,
  };
}

/** PostgREST puts its machine-readable code in the body; read it, not the prose. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : "";
  } catch {
    return "";
  }
}

/**
 * The codes that mean ABSENT, and only these.
 *
 * Anything else -- a 401, a 503, a gateway page -- is the probe failing, not
 * the object missing. `aml.cases` cost twelve handlers reporting "Case not
 * found" about a case the operator had open, because a failed read was read as
 * an absent row; here the same conflation would report a migration as never
 * applied because of a blip, and somebody would go and re-run SQL.
 */
const ABSENT_CODES = new Set(["PGRST205", "PGRST204", "PGRST202", "42P01", "42703"]);

async function probeExists(rest: Rest, table: string, select: string): Promise<Probe> {
  const path =
    `${rest.url}/rest/v1/${encodeURIComponent(table)}` +
    `?select=${encodeURIComponent(select)}&limit=0`;
  let res: Response;
  try {
    res = await rest.fetchImpl(path, { headers: restHeaders(rest) });
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "fetch failed" };
  }
  if (res.ok) return { kind: "exists", exists: true };
  const code = await errorCode(res);
  if (ABSENT_CODES.has(code)) return { kind: "exists", exists: false };
  return { kind: "failed", message: `HTTP ${res.status}${code ? ` (${code})` : ""} on ${table}` };
}

async function probeCount(rest: Rest, table: string): Promise<Probe> {
  const path = `${rest.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=0`;
  let res: Response;
  try {
    res = await rest.fetchImpl(path, {
      headers: restHeaders(rest, { Prefer: "count=exact" }),
    });
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : "fetch failed" };
  }
  if (!res.ok) {
    const code = await errorCode(res);
    // A table that does not exist has no row count. Reporting 0 would let a
    // `rows:` claim fail with "holds 0 rows" and send somebody looking for a
    // seed script for a table that was never created.
    return { kind: "failed", message: `HTTP ${res.status}${code ? ` (${code})` : ""} on ${table}` };
  }
  const range = res.headers.get("content-range") ?? "";
  const total = /\/(\d+)$/.exec(range)?.[1];
  if (total === undefined) {
    return { kind: "failed", message: `no exact count in content-range (${range || "absent"})` };
  }
  return { kind: "count", count: Number(total) };
}

/**
 * Every function PostgREST exposes, from its own schema description.
 *
 * One request answers every `rpc` claim, and it answers them without invoking
 * anything. The endpoint accepts only the service-role key -- measured, with
 * the publishable key it answers 401 `{"message":"Invalid API key","hint":"Only
 * the service_role API key can be used for this endpoint."}` -- which is why
 * this channel is not offered to CI, where there is no such credential.
 */
async function loadExposedFunctions(
  rest: Rest,
): Promise<{ ok: true; names: ReadonlySet<string> } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await rest.fetchImpl(`${rest.url}/rest/v1/`, {
      headers: restHeaders(rest, { Accept: "application/openapi+json" }),
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "fetch failed" };
  }
  if (!res.ok) {
    return { ok: false, message: `schema description unavailable (HTTP ${res.status})` };
  }
  let spec: { paths?: Record<string, unknown> };
  try {
    spec = (await res.json()) as { paths?: Record<string, unknown> };
  } catch {
    return { ok: false, message: "schema description was not JSON" };
  }
  if (!spec.paths || typeof spec.paths !== "object") {
    return { ok: false, message: "schema description carried no paths" };
  }
  const names = new Set<string>();
  for (const p of Object.keys(spec.paths)) {
    const m = /^\/rpc\/(.+)$/.exec(p);
    if (m) names.add(m[1]);
  }
  return { ok: true, names };
}

type CronRow = { jobname?: unknown; active?: unknown };

/** Every scheduled job, from the helper that already reaches `cron.job`. */
async function loadCronJobs(
  db: Db,
): Promise<{ ok: true; jobs: ReadonlyMap<string, boolean> } | { ok: false; message: string }> {
  const { data, error } = await db.rpc("cron_delivery_health", { _since_hours: 1 });
  if (error) return { ok: false, message: `cron_delivery_health: ${error.message}` };
  const jobs = new Map<string, boolean>();
  for (const row of (data ?? []) as CronRow[]) {
    if (typeof row.jobname === "string") jobs.set(row.jobname, row.active === true);
  }
  return { ok: true, jobs };
}

// -- The run -----------------------------------------------------------------

type StoredRow = {
  migration: string;
  assertion: string;
  status: string;
  last_satisfied_at: string | null;
};

export async function runMigrationDrift(
  db: Db,
  opts: MigrationDriftOptions = {},
): Promise<MigrationDriftRun> {
  const claims = opts.claims ?? MIGRATION_CLAIMS;
  const now = opts.now ?? (() => Date.now());
  const budgetMs = opts.budgetMs ?? BUDGET_MS;
  const maxTargets = opts.maxTargets ?? MAX_TARGETS;
  const startedAt = now();

  const url = opts.supabaseUrl ?? process.env.SUPABASE_URL;
  const key = opts.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - the drift alarm reads the schema over PostgREST.",
    );
  }
  const rest: Rest = {
    url: url.replace(/\/+$/, ""),
    key,
    fetchImpl: opts.fetchImpl ?? globalFetch,
  };

  // Flatten to one row per claim, keeping which migration made it.
  const flat = claims.flatMap((c) =>
    c.assertions.map((assertion) => ({
      migration: c.migration,
      assertion,
      key: formatAssertion(assertion),
    })),
  );

  // What we knew last time. Used for three things: ordering by staleness,
  // preserving `last_satisfied_at`, and telling a NEW drift from a standing one
  // so the alarm does not re-fire every hour on the same finding.
  const { data: storedData, error: storedErr } = await db
    .from("migration_assertion_checks")
    .select("migration, assertion, status, last_satisfied_at, checked_at")
    .order("checked_at", { ascending: true });
  if (storedErr) {
    throw new Error(`Could not read migration_assertion_checks: ${storedErr.message}`);
  }
  const stored = new Map<string, StoredRow>();
  const staleness = new Map<string, number>();
  let rank = 0;
  for (const row of (storedData ?? []) as (StoredRow & { checked_at: string })[]) {
    const k = `${row.migration} ${row.assertion}`;
    stored.set(k, row);
    staleness.set(k, ++rank);
  }

  // Never-checked claims first, then oldest-checked. A claim added today must
  // not wait behind 200 that were checked an hour ago.
  const ordered = [...flat].sort((a, b) => {
    const ka = staleness.get(`${a.migration} ${a.key}`) ?? 0;
    const kb = staleness.get(`${b.migration} ${b.key}`) ?? 0;
    return ka - kb;
  });

  // Decide the probe set before probing: a claim is deferred because its TARGET
  // did not fit, so two claims on one object are never split across ticks.
  const targets = new Map<string, Target>();
  for (const item of ordered) {
    const t = targetFor(item.assertion);
    if (!t) continue;
    const tk = targetKey(t);
    if (targets.has(tk)) continue;
    if (targets.size >= maxTargets) continue;
    targets.set(tk, t);
  }

  // The two shared loads, done once and only if something needs them.
  const wantsRpc = [...targets.values()].some((t) => t.kind === "rpc");
  const wantsCron = [...targets.values()].some((t) => t.kind === "cron");
  const exposed = wantsRpc ? await loadExposedFunctions(rest) : null;
  const cronJobs = wantsCron ? await loadCronJobs(db) : null;

  const probes = new Map<string, Probe>();
  let outOfBudget = false;
  for (const [tk, t] of targets) {
    if (outOfBudget) continue;
    // `probes.size > 0` so a run always makes at least one probe. A budget
    // check that can refuse the FIRST one turns a slow cold start into a worker
    // that ticks forever and never advances -- which reads, from the outside,
    // exactly like a healthy schedule.
    if (probes.size > 0 && now() - startedAt > budgetMs) {
      outOfBudget = true;
      continue;
    }
    switch (t.kind) {
      case "table":
        probes.set(tk, await probeExists(rest, t.table, "*"));
        break;
      case "column":
        probes.set(tk, await probeExists(rest, t.table, t.column));
        break;
      case "count":
        probes.set(tk, await probeCount(rest, t.table));
        break;
      case "rpc":
        probes.set(
          tk,
          exposed && exposed.ok
            ? { kind: "exists", exists: exposed.names.has(t.fn) }
            : { kind: "failed", message: exposed?.message ?? "schema description not loaded" },
        );
        break;
      case "cron":
        probes.set(
          tk,
          cronJobs && cronJobs.ok
            ? {
                kind: "cron",
                scheduled: cronJobs.jobs.has(t.jobname),
                active: cronJobs.jobs.get(t.jobname) === true,
              }
            : { kind: "failed", message: cronJobs?.message ?? "cron health not loaded" },
        );
        break;
    }
  }

  const checkedAt = new Date(now()).toISOString();
  const results: { migration: string; result: CheckResult }[] = [];
  const rows: {
    migration: string;
    assertion: string;
    kind: string;
    status: string;
    detail: string;
    checked_at: string;
    last_satisfied_at: string | null;
  }[] = [];
  const newlyDrifted: string[] = [];
  let deferred = 0;

  for (const item of ordered) {
    const t = targetFor(item.assertion);
    const probe = t ? (probes.get(targetKey(t)) ?? null) : null;
    const wasDeferred = t !== null && probe === null;
    if (wasDeferred) deferred += 1;
    const result = judge(item.assertion, probe);
    results.push({ migration: item.migration, result });

    // A deferred claim is not a verdict, so it must not overwrite the verdict
    // already stored for it. Writing "unassertable" over yesterday's
    // "unsatisfied" would quietly clear an open alarm by running out of budget.
    if (wasDeferred) continue;

    const k = `${item.migration} ${item.key}`;
    const prev = stored.get(k);
    if (result.status === "unsatisfied" && prev?.status !== "unsatisfied") {
      newlyDrifted.push(`${item.migration}: ${result.detail}`);
    }
    rows.push({
      migration: item.migration,
      assertion: item.key,
      kind: item.assertion.kind,
      status: result.status,
      detail: result.detail,
      checked_at: checkedAt,
      last_satisfied_at:
        result.status === "satisfied" ? checkedAt : (prev?.last_satisfied_at ?? null),
    });
  }

  if (rows.length > 0) {
    const { error } = await db
      .from("migration_assertion_checks")
      .upsert(rows, { onConflict: "migration,assertion" });
    if (error) throw new Error(`Could not record assertion checks: ${error.message}`);
  }

  // A claim that has been edited, or a migration that has been renamed, leaves
  // a row behind. Left in place it keeps reporting on something that no longer
  // exists -- and an alarm nobody can clear is one people learn to ignore.
  const live = new Set(flat.map((f) => `${f.migration} ${f.key}`));
  let pruned = 0;
  for (const row of stored.values()) {
    if (live.has(`${row.migration} ${row.assertion}`)) continue;
    const { error } = await db
      .from("migration_assertion_checks")
      .delete()
      .eq("migration", row.migration)
      .eq("assertion", row.assertion);
    if (error) {
      console.error(
        `[migration-drift] could not prune ${row.migration} / ${row.assertion}:`,
        error.message,
      );
      continue;
    }
    pruned += 1;
  }

  const summary = summariseDrift(results);

  // Only a NEW unsatisfied claim raises anything. A standing one is already on
  // the operator's screen, and an alarm that re-fires hourly on a finding
  // somebody has seen is how the next one gets missed.
  let notified = false;
  if (newlyDrifted.length > 0) {
    await notifyOperators({
      kind: "migration_drift",
      severity: "error",
      title:
        newlyDrifted.length === 1
          ? "A migration's effect is missing from the database"
          : `${newlyDrifted.length} migration effects are missing from the database`,
      body:
        `The database does not carry what these migrations said they would make true:\n\n` +
        newlyDrifted.map((d) => `- ${d}`).join("\n") +
        `\n\nEither the migration never applied, or it applied and did nothing: a DO ` +
        `block that swallows its own exception succeeds either way. Apply it and the ` +
        `alarm clears on the next run.`,
      url: "/settings",
      metadata: { drifted: newlyDrifted, checked_at: checkedAt },
    });
    notified = true;
  }

  return {
    claims: flat.length,
    probed: probes.size,
    deferred,
    pruned,
    summary,
    newlyDrifted,
    notified,
  };
}
