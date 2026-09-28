/**
 * The features that exist on the prime and nowhere else.
 *
 * ## What this is for
 *
 * The prime carries a GoHighLevel ACCOUNT MIGRATION: twenty-eight edge
 * functions, a dispatcher firing every fifteen seconds, a storage bucket of raw
 * marketing exports and an admin page. It was built on the prime after a
 * security breach, to move the house's own data between two GoHighLevel
 * accounts. It is an operation on the prime's own accounts, not a product
 * feature, and no clone receives it or needs it (the owner's decision,
 * 27 Sep 2026).
 *
 * Until now nothing said so. The cascade carried its files, provisioning
 * deployed its functions and scheduled its dispatcher, and parity counted
 * their absence as BLOCKED.
 *
 * ## The rule
 *
 * **A prime-only feature is withheld by CLASS, in code, and every stage reads
 * this one list.** Not by per-clone exclusion rows: a clone provisioned
 * tomorrow would carry the feature, and the seed array those rows come from is
 * append-only.
 *
 * - The cascade holds its files as `protected` (`partitionCascadePaths`).
 * - Provisioning never deploys its functions: the prime's function tree is
 *   read without them (`prime-backend.server.ts`), so the declared contract,
 *   the deploy set and the secret scan all agree.
 * - Provisioning never schedules its crons, and never creates or reconfigures
 *   its bucket (`replicateCronJobs`, `replicateStorageBuckets`).
 * - Parity does not count their absence, and names what a clone still holds.
 * - What a migration schedules is swept after it applies, and by the cron
 *   step, from any project that is not the prime (`sweepPrimeOnlyCronJobs`).
 * - What a clone's project still RUNS is deleted from it by the half-hourly
 *   backend sweep, from any project that is not the prime
 *   (`sweepPrimeOnlyFunctions`). Withholding a function only stops the next
 *   deploy; every clone provisioned before this register existed was given all
 *   twenty-eight, and nothing took them off again.
 *
 * ## What is deliberately NOT here
 *
 * The ordinary GoHighLevel integration: `_shared/ghl-account.ts`,
 * `_shared/ghl-rate-limiter.ts`, the calendar, webhook and conversation
 * functions, the `sync-ghl-*` jobs and the Integrations card. Matching is by
 * exact file and by function DIRECTORY, so `ghl-calendar` and a future
 * `migration-dispatcher-v2` are not caught.
 *
 * Nor the feature's SCHEMA (eleven tables and their SQL functions). A withheld
 * migration is a ledger hole, `partitionByDependency` treats a hole as a
 * barrier, and an empty table costs nothing. But seven migrations (re)schedule
 * the dispatcher, each first unscheduling `migration-dispatcher%`, so a clone
 * that applies them schedules a job invoking a function it does not have. That
 * is what `isPrimeOnlyCronJob` exists to find after every apply.
 *
 * The BUCKET is schema in the same sense. `20260507171554` creates
 * `ghl-marketing-dump` in the same file as the feature's tables, so every
 * clone that applies the corpus holds it — measured 27 Sep 2026: all four,
 * private, zero objects. It stays, like the tables. What the register decides
 * is that nothing ELSE puts it there or keeps it in step: replication neither
 * creates it nor copies into it, and parity does not count its absence. It is
 * never deleted by this platform — a bucket with an object in it is somebody's
 * data, and the only way to know it is empty is to have looked.
 *
 * Measured on prime@387feb03: each function directory holds only `index.ts`,
 * nothing outside the set imports into it except `src/App.tsx` (the route),
 * and the only live prime-only job is `migration-dispatcher-15s`.
 *
 * Pure: no network, no Deno, no Supabase client, so the contract tests import
 * it directly.
 */
import { globToRegex } from "@/lib/module-globs";

export type PrimeOnlyFeature = {
  /** Stable key. It appears in a held path's pattern as `(prime-only: <key>)`. */
  readonly key: string;
  readonly title: string;
  /** Short: the lateral detail panel renders every held entry's note. */
  readonly reason: string;
  /** Exact repository paths. */
  readonly files: readonly string[];
  /** Function names, matched by the directory `supabase/functions/<name>/`. */
  readonly functions: readonly string[];
  /** pg_cron jobname globs. */
  readonly cronJobs: readonly string[];
  /** Storage bucket ids. */
  readonly buckets: readonly string[];
};

export const PRIME_ONLY_FEATURES: readonly PrimeOnlyFeature[] = [
  {
    key: "ghl-account-migration",
    title: "GoHighLevel account migration",
    reason: "Prime-only: the GoHighLevel account migration is never carried to a clone.",
    files: [
      "docs/GHL_MIGRATION_CASCADE_INVESTIGATION_2026-04-25.md",
      "src/pages/admin/GhlMigration.tsx",
      "src/components/admin/GhlMarketingRawDump.tsx",
      "src/components/admin/GhlWorkflowVisualizer.tsx",
      "src/components/admin/LegacyAccountKillSwitch.tsx",
      "src/components/admin/MigrationAdvancedOptions.tsx",
      "src/components/admin/MigrationSourceUploader.tsx",
      "src/components/admin/WorkflowBlueprintEditor.tsx",
      "supabase/functions/_shared/ghl-asset-harvester.ts",
      "supabase/functions/_shared/ghl-worker-fetch.ts",
      "supabase/functions/_shared/migration-jobs.ts",
    ],
    functions: [
      "backfill-opportunity-mappings",
      "ghl-account-preview",
      "ghl-legacy-backfill-gaps",
      "ghl-legacy-wipe-orchestrator",
      "ghl-legacy-wipe-worker",
      "ghl-marketing-dump-enqueue",
      "ghl-marketing-dump-export",
      "ghl-marketing-dump-worker",
      "ghl-marketing-raw-dump",
      "ghl-migrate-bookings-worker",
      "ghl-migrate-calendar-groups-worker",
      "ghl-migrate-calendars-worker",
      "ghl-migrate-contacts-worker",
      "ghl-migrate-conversations-replay-worker",
      "ghl-migrate-conversations-reset-phantoms",
      "ghl-migrate-conversations-worker",
      "ghl-migrate-notes-worker",
      "ghl-migrate-opportunities-worker",
      "ghl-migrate-workflow-enrollments-worker",
      "ghl-migrate-workflow-reenroll-worker",
      "ghl-migrate-workflows-snapshot-worker",
      "ghl-test-credentials",
      "ghl-workflow-visualizer",
      "migration-dispatcher",
      "migration-job-control",
      "migration-job-status",
      "migration-orchestrator",
      "migration-upload-source",
    ],
    cronJobs: ["migration-dispatcher*"],
    buckets: ["ghl-marketing-dump"],
  },
];

const FUNCTIONS_PREFIX = "supabase/functions/";

const byFile = new Map<string, PrimeOnlyFeature>();
const byFunction = new Map<string, PrimeOnlyFeature>();
const byBucket = new Map<string, PrimeOnlyFeature>();
const cronRules: { rx: RegExp; feature: PrimeOnlyFeature }[] = [];
for (const feature of PRIME_ONLY_FEATURES) {
  for (const f of feature.files) byFile.set(f, feature);
  for (const fn of feature.functions) byFunction.set(fn, feature);
  for (const b of feature.buckets) byBucket.set(b, feature);
  for (const glob of feature.cronJobs) cronRules.push({ rx: globToRegex(glob), feature });
}

/** The function a path belongs to, when it sits in a function's own directory. */
function functionDirectoryOf(path: string): string | null {
  if (!path.startsWith(FUNCTIONS_PREFIX)) return null;
  const rest = path.slice(FUNCTIONS_PREFIX.length);
  const slash = rest.indexOf("/");
  // A trailing slash is required: `supabase/functions/<name>` alone is not a file in it.
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/** The prime-only feature a repository path belongs to, or null. */
export function primeOnlyFeatureForPath(path: string): PrimeOnlyFeature | null {
  const exact = byFile.get(path);
  if (exact) return exact;
  const fn = functionDirectoryOf(path);
  return fn ? (byFunction.get(fn) ?? null) : null;
}

export function isPrimeOnlyPath(path: string): boolean {
  return primeOnlyFeatureForPath(path) !== null;
}

/** The prime-only paths among these, sorted and de-duplicated. */
export function primeOnlyPathsIn(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) if (isPrimeOnlyPath(p)) out.add(p);
  return [...out].sort();
}

export function primeOnlyFunctionNames(): ReadonlySet<string> {
  return new Set(byFunction.keys());
}

export function isPrimeOnlyFunction(name: string): boolean {
  return byFunction.has((name ?? "").trim());
}

export function isPrimeOnlyBucket(id: string): boolean {
  return primeOnlyBucketReason(id) !== null;
}

/** Why a storage bucket is the prime's alone, or null when it is not. */
export function primeOnlyBucketReason(id: string): string | null {
  const feature = byBucket.get((id ?? "").trim());
  return feature ? `${feature.title}: the bucket belongs to the prime's own feature.` : null;
}

/**
 * The first argument of every `cron_invoke_signed_function(` call in a command,
 * unquoted. Quote-aware (with `''` as an escaped quote) and balanced across
 * lines, because migration 20260725000000 writes the call over four lines and a
 * line-based match missed it.
 */
function signedInvocationTargets(command: string): string[] {
  const out: string[] = [];
  const opener = /cron_invoke_signed_function\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(command))) {
    let i = m.index + m[0].length;
    while (i < command.length && /\s/.test(command[i])) i += 1;
    if (command[i] !== "'") continue;
    let value = "";
    for (i += 1; i < command.length; i += 1) {
      if (command[i] === "'") {
        if (command[i + 1] === "'") {
          value += "'";
          i += 1;
          continue;
        }
        out.push(value);
        break;
      }
      value += command[i];
    }
  }
  return out;
}

/**
 * Why a pg_cron job belongs to a prime-only feature, or null when it does not.
 *
 * A job is prime-only when its name matches a feature's jobname glob, or when
 * its command invokes a prime-only function by URL or through
 * `cron_invoke_signed_function`. A job that also invokes ordinary functions is
 * still caught: it could not run on a clone either. None exists today.
 */
export function primeOnlyCronReason(job: {
  jobname?: string | null;
  command?: string | null;
}): string | null {
  const name = (job.jobname ?? "").trim();
  for (const rule of cronRules) {
    if (name && rule.rx.test(name)) {
      return `${rule.feature.title}: the job name matches ${rule.feature.cronJobs.join(", ")}.`;
    }
  }
  const command = job.command ?? "";
  for (const hit of command.matchAll(/functions\/v1\/([A-Za-z0-9_-]+)/g)) {
    const feature = byFunction.get(hit[1]);
    if (feature) return `${feature.title}: the job calls ${hit[1]}.`;
  }
  for (const target of signedInvocationTargets(command)) {
    const feature = byFunction.get(target.trim());
    if (feature) return `${feature.title}: the job invokes ${target.trim()}.`;
  }
  return null;
}

export function isPrimeOnlyCronJob(job: {
  jobname?: string | null;
  command?: string | null;
}): boolean {
  return primeOnlyCronReason(job) !== null;
}

/**
 * The prime-only jobs among a project's `cron.job` rows, each with its reason,
 * in the order they were given.
 *
 * What the sweep acts on and what parity reports, so the two cannot disagree
 * about which job is the prime's.
 */
export function primeOnlyCronJobsIn<T extends { jobname?: string | null; command?: string | null }>(
  jobs: readonly T[],
): Array<{ job: T; reason: string }> {
  const out: Array<{ job: T; reason: string }> = [];
  for (const job of jobs) {
    const reason = primeOnlyCronReason(job);
    if (reason) out.push({ job, reason });
  }
  return out;
}

/**
 * The prime-only functions among a project's deployed slugs, each with its
 * reason, sorted and de-duplicated.
 *
 * What `sweepPrimeOnlyFunctions` deletes and nothing else, so what is taken off
 * a clone is decided by the same list as what is withheld from it. Matching is
 * by exact function name, the rule `isPrimeOnlyFunction` applies: `ghl-calendar`
 * and a future `migration-dispatcher-v2` are not caught.
 */
export function primeOnlyFunctionsIn(
  slugs: Iterable<string>,
): Array<{ slug: string; reason: string }> {
  const found = new Map<string, string>();
  for (const raw of slugs) {
    const slug = (raw ?? "").trim();
    const feature = byFunction.get(slug);
    if (feature && !found.has(slug)) {
      found.set(slug, `${feature.title}: the function belongs to the prime's own feature.`);
    }
  }
  return [...found.keys()].sort().map((slug) => ({ slug, reason: found.get(slug) as string }));
}

/**
 * A withheld set named the way a person reads it: by feature, with a count.
 *
 * `the GoHighLevel account migration (all 28 functions)` rather than 28
 * names, because this is written into hold notes and into a comment in a
 * spec, where a list that long buries the sentence it sits in. A partial set
 * names what is withheld, since a partial set is the case somebody has to
 * look at. A name belonging to no feature is listed as itself.
 */
export function describeWithheldFunctions(names: Iterable<string>): string {
  const wanted = new Set(names);
  const parts: string[] = [];
  for (const feature of PRIME_ONLY_FEATURES) {
    const hit = feature.functions.filter((fn) => wanted.has(fn)).sort();
    if (hit.length === 0) continue;
    const total = feature.functions.length;
    // Never re-cased: a title opens on a proper noun ("GoHighLevel").
    const title = `the ${feature.title}`;
    parts.push(
      hit.length === total
        ? `${title} (all ${total} functions)`
        : `${title} (${hit.length} of ${total} functions: ${hit.join(", ")})`,
    );
  }
  const loose = [...wanted].filter((fn) => !byFunction.has(fn)).sort();
  if (loose.length > 0) parts.push(loose.join(", "));
  return parts.join("; ");
}

/**
 * The prime-only functions a tree does not hold, sorted.
 *
 * A function counts as held when any file sits under its directory. This is
 * what the pumps read to know which derived entries (config blocks, registry
 * entries, inventory lines) a clone's tree can no longer back.
 */
export function withheldPrimeOnlyFunctions(treePaths: Iterable<string>): string[] {
  const held = new Set<string>();
  for (const p of treePaths) {
    const fn = functionDirectoryOf(p);
    if (fn && byFunction.has(fn)) held.add(fn);
  }
  return [...byFunction.keys()].filter((fn) => !held.has(fn)).sort();
}
