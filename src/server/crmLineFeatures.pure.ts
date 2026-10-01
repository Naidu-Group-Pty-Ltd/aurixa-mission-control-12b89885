/**
 * What a CRM LINE does not carry.
 *
 * ## What this is for
 *
 * The fleet has two CRM lines (`clones.crm_mode`, see `crmMode.pure.ts`). A
 * `dependent` clone runs its CRM through GoHighLevel, as the prime does. An
 * `independent` clone is a VARIANT, not a copy: its CRM lives in its own
 * Postgres (`crm-calendar`, `crm-send-message`, `crm-inbound-message`) and it
 * operates as a closed system, with no dependency on GoHighLevel at all.
 *
 * Until now nothing said so outside the browser. The independent line head
 * (`npc-crm-independent`) routed its own pages to the native functions, while
 * every other stage treated it as the prime:
 *
 * - provisioning and the half-hourly deploy lane deployed the prime's
 *   GoHighLevel functions onto its project — fifteen were live on
 *   `qvuwrvwzjyigptmnijyb` on 29 Sep 2026;
 * - cron replication and every migration re-scheduled the four GoHighLevel
 *   jobs there, each firing into a function with no account behind it;
 * - the cascade carried the functions' files back every time the prime
 *   touched them, and parity counted their absence as BLOCKED.
 *
 * ## The rule
 *
 * `primeOnlyFeatures.pure.ts`'s rule, applied to a line instead of the prime:
 * **a line's withheld feature is withheld by CLASS, in code, and every stage
 * reads this one list**, keyed on the clone's recorded `crm_mode`. A clone
 * converted to the independent line tomorrow is covered the moment its mode
 * is written, with no per-clone row to remember.
 *
 * - The cascade holds a WRITE of its paths as `protected`
 *   (`partitionCascadePaths` with `crmMode`). A deletion is not held: a
 *   withheld path still on an independent clone is one a cascade carried
 *   before this rule, and taking it off is the rule working.
 * - The pumps reconcile the derived files without its functions
 *   (`withheldLineFunctions`), as they do for the prime-only set.
 * - Backend work planned from a cascade skips its function paths, and the
 *   deploy lane never deploys them to an independent project.
 * - Cron replication never schedules its jobs there, and the sweeps take off
 *   what a migration or an earlier deploy put there.
 * - Parity does not count their absence on the independent line.
 *
 * ## What is deliberately NOT here
 *
 * **The schema.** `ghl_conversations` and `ghl_conversation_messages` are the
 * native CRM's own storage — `crm-send-message` and `crm-inbound-message`
 * write them — and every table stays ledger-identical with the prime, because
 * a withheld migration is a ledger hole and `partitionByDependency` treats a
 * hole as a barrier. The prefix is historical, not a dependency.
 *
 * **Mixed functions.** `check-integration-secrets`, `finance-portal-client-
 * comms`, `manage-lead-magnets`, `portal-book-appointment`,
 * `request-lead-magnet`, `vapi-call-webhook` and `cleanup-call-log-names`
 * each carry a GoHighLevel half that stands down when no key is set, and a
 * product half the independent line needs. So do the two shared modules they
 * import (`ghl-account.ts`, `ghlConversationMap.pure.ts`).
 *
 * **The pages and functions the line carries in its own shape.** A page that
 * routes through `crmProvider.ts`, an agent whose calendar is `crm-calendar`:
 * those are not withheld, they are VARIANTS, and they are the second register
 * at the foot of this module (`CRM_LINE_VARIANT_PATTERNS`). They are held as
 * `manual_reconcile`, and only where a delivery's bytes come from outside the
 * line, so the head's own children still receive the head's copy. The head's
 * `crmIndependence.spec.ts` and `crmLineFeatures.spec.ts` are what fail when
 * a page or a function spells a withheld name.
 *
 * Measured on prime@386e7a4: every function listed holds only `index.ts`;
 * the four shared modules are imported by nothing outside this set and the
 * prime-only migration workers; and the four jobs below are the only live
 * jobs on the prime that reach any of these functions.
 *
 * Pure: no network, no Deno, no Supabase client.
 */
import { globToRegex } from "@/lib/module-globs";
import type { CrmMode } from "@/lib/crmMode.pure";
import { describeWithheldFunctions, functionsInvokedByCron } from "./primeOnlyFeatures.pure";

export type CrmLineFeature = {
  /** Stable key. A held path's pattern reads `(crm-line: <key>)`. */
  readonly key: string;
  readonly title: string;
  /** The line that does NOT carry this feature. */
  readonly withheldFrom: CrmMode;
  /** Short: the lateral detail panel renders every held entry's note. */
  readonly reason: string;
  /** Exact repository paths. */
  readonly files: readonly string[];
  /** Function names, matched by the directory `supabase/functions/<name>/`. */
  readonly functions: readonly string[];
  /** pg_cron jobname globs. A job invoking a listed function is caught as well. */
  readonly cronJobs: readonly string[];
};

export const CRM_LINE_FEATURES: readonly CrmLineFeature[] = [
  {
    key: "ghl-integration",
    title: "GoHighLevel integration",
    withheldFrom: "independent",
    reason:
      "Independent CRM line: the GoHighLevel integration is not carried — this clone's CRM is its own.",
    files: [
      "supabase/functions/_shared/ghlBootstrapWindow.pure.ts",
      "supabase/functions/_shared/ghlConversationPaging.ts",
      "supabase/functions/_shared/ghlConversationStore.ts",
      "supabase/functions/_shared/ghl-rate-limiter.ts",
      // The specs whose SUBJECT is the modules above. A spec carried without
      // its subject fails in the clone's CI and names nothing wrong with it.
      "src/lib/sync/__tests__/ghlBootstrapWindow.test.ts",
      "src/lib/sync/__tests__/ghlConversationPaging.test.ts",
      "src/pages/__tests__/crmConversations.spec.ts",
      "src/lib/security/bulkConversationSync.security.test.ts",
    ],
    functions: [
      "backfill-lead-attributions",
      "backfill-message-directions",
      "backfill-notes-to-ghl",
      "conversation-sync-cron",
      "diagnose-ghl-attribution",
      "ghl-calendar",
      "ghl-calendar-proxy",
      "ghl-calendar-test",
      "ghl-conversations-cron",
      "ghl-webhook-receiver",
      "import-clients-from-ghl",
      "one-time-bulk-conversation-sync",
      "send-ghl-message",
      "sync-client-to-ghl",
      "sync-ghl-conversations",
      "sync-ghl-marketing-assets",
      "sync-ghl-pipelines",
      "sync-notes-to-ghl",
      "update-ghl-opportunity-stage",
    ],
    cronJobs: [
      "import-clients-from-ghl-6h",
      "sync-ghl-conversations-cron",
      "sync-ghl-marketing-assets*",
      "sync-ghl-pipelines*",
      "conversation-sync-cron*",
      "ghl-conversations-cron*",
    ],
  },
];

const FUNCTIONS_PREFIX = "supabase/functions/";

type Index = {
  byFile: Map<string, CrmLineFeature>;
  byFunction: Map<string, CrmLineFeature>;
  cronRules: { rx: RegExp; feature: CrmLineFeature }[];
};

const byMode = new Map<CrmMode, Index>();
for (const feature of CRM_LINE_FEATURES) {
  let idx = byMode.get(feature.withheldFrom);
  if (!idx) {
    idx = { byFile: new Map(), byFunction: new Map(), cronRules: [] };
    byMode.set(feature.withheldFrom, idx);
  }
  for (const f of feature.files) idx.byFile.set(f, feature);
  for (const fn of feature.functions) idx.byFunction.set(fn, feature);
  for (const glob of feature.cronJobs) idx.cronRules.push({ rx: globToRegex(glob), feature });
}

/**
 * The line a recorded `crm_mode` names, or null. An unrecorded or unknown
 * mode withholds NOTHING: every clone that existed before the column behaves
 * exactly as it did, and a line is never guessed from a repository name.
 */
function indexFor(crmMode: string | null | undefined): Index | null {
  if (crmMode !== "independent" && crmMode !== "dependent") return null;
  return byMode.get(crmMode) ?? null;
}

function functionDirectoryOf(path: string): string | null {
  if (!path.startsWith(FUNCTIONS_PREFIX)) return null;
  const rest = path.slice(FUNCTIONS_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/** The feature a path belongs to on this line, or null. */
export function crmLineFeatureForPath(
  path: string,
  crmMode: string | null | undefined,
): CrmLineFeature | null {
  const idx = indexFor(crmMode);
  if (!idx) return null;
  const exact = idx.byFile.get(path);
  if (exact) return exact;
  const fn = functionDirectoryOf(path);
  return fn ? (idx.byFunction.get(fn) ?? null) : null;
}

export function isCrmLineWithheldPath(path: string, crmMode: string | null | undefined): boolean {
  return crmLineFeatureForPath(path, crmMode) !== null;
}

/** Every function this line does not carry, sorted. Empty for an unrecorded mode. */
export function crmLineWithheldFunctionNames(crmMode: string | null | undefined): string[] {
  const idx = indexFor(crmMode);
  return idx ? [...idx.byFunction.keys()].sort() : [];
}

export function isCrmLineWithheldFunction(
  name: string,
  crmMode: string | null | undefined,
): boolean {
  return indexFor(crmMode)?.byFunction.has((name ?? "").trim()) ?? false;
}

/**
 * Why a pg_cron job belongs to a feature this line does not carry, or null.
 * The job is caught by its name, or by any function it reaches — read by the
 * same parser the prime-only register uses.
 */
export function crmLineCronReason(
  job: { jobname?: string | null; command?: string | null },
  crmMode: string | null | undefined,
): string | null {
  const idx = indexFor(crmMode);
  if (!idx) return null;
  const name = (job.jobname ?? "").trim();
  for (const rule of idx.cronRules) {
    if (name && rule.rx.test(name)) {
      return `${rule.feature.title}: the ${crmMode} CRM line does not run ${name}.`;
    }
  }
  for (const call of functionsInvokedByCron(job.command ?? "")) {
    const feature = idx.byFunction.get(call.name);
    if (feature) {
      return `${feature.title}: the job ${call.how} ${call.name}, which the ${crmMode} CRM line does not carry.`;
    }
  }
  return null;
}

export function crmLineCronJobsIn<T extends { jobname?: string | null; command?: string | null }>(
  jobs: readonly T[],
  crmMode: string | null | undefined,
): Array<{ job: T; reason: string }> {
  const out: Array<{ job: T; reason: string }> = [];
  for (const job of jobs) {
    const reason = crmLineCronReason(job, crmMode);
    if (reason) out.push({ job, reason });
  }
  return out;
}

/** The withheld functions among a project's deployed slugs, with reasons, sorted. */
export function crmLineFunctionsIn(
  slugs: Iterable<string>,
  crmMode: string | null | undefined,
): Array<{ slug: string; reason: string }> {
  const idx = indexFor(crmMode);
  if (!idx) return [];
  const found = new Map<string, string>();
  for (const raw of slugs) {
    const slug = (raw ?? "").trim();
    const feature = idx.byFunction.get(slug);
    if (feature && !found.has(slug)) {
      found.set(slug, `${feature.title}: the ${crmMode} CRM line does not carry this function.`);
    }
  }
  return [...found.keys()].sort().map((slug) => ({ slug, reason: found.get(slug) as string }));
}

/**
 * The line-withheld functions a tree does not hold, sorted — the pumps'
 * counterpart of `withheldPrimeOnlyFunctions`. A function counts as held when
 * any file sits under its directory, so a clone that still carries the
 * feature yields an empty set and its derived files are left exactly as they
 * were until the removal lands.
 */
export function withheldLineFunctions(
  treePaths: Iterable<string>,
  crmMode: string | null | undefined,
): string[] {
  const idx = indexFor(crmMode);
  if (!idx) return [];
  const held = new Set<string>();
  for (const p of treePaths) {
    const fn = functionDirectoryOf(p);
    if (fn && idx.byFunction.has(fn)) held.add(fn);
  }
  return [...idx.byFunction.keys()].filter((fn) => !held.has(fn)).sort();
}

/** `describeWithheldFunctions`' phrasing for this register's share of a set. */
export function describeCrmLineWithheld(names: Iterable<string>): string | null {
  const wanted = new Set(names);
  const parts: string[] = [];
  for (const feature of CRM_LINE_FEATURES) {
    const hit = feature.functions.filter((fn) => wanted.has(fn)).sort();
    if (hit.length === 0) continue;
    const total = feature.functions.length;
    parts.push(
      hit.length === total
        ? `the ${feature.title} (all ${total} functions, withheld from the ${feature.withheldFrom} CRM line)`
        : `the ${feature.title} (${hit.length} of ${total} functions, withheld from the ${feature.withheldFrom} CRM line: ${hit.join(", ")})`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Every function any line withholds — for the describer's "loose" test. */
export function allCrmLineFunctionNames(): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of CRM_LINE_FEATURES) for (const fn of f.functions) out.add(fn);
  return out;
}

/**
 * A withheld set named by feature — the prime's own and the CRM line's —
 * with anything neither register names listed as itself. What the engine
 * writes into hold notes, so a note names the GoHighLevel integration rather
 * than nineteen slugs.
 */
export function describeWithheldAcrossRegisters(names: Iterable<string>): string {
  const all = [...new Set(names)];
  const line = allCrmLineFunctionNames();
  const lineShare = describeCrmLineWithheld(all.filter((n) => line.has(n)));
  const rest = all.filter((n) => !line.has(n));
  const restShare = rest.length > 0 ? describeWithheldFunctions(rest) : "";
  return [restShare, lineShare].filter((p): p is string => Boolean(p)).join("; ");
}

/**
 * The withheld share of a sentence, with its owner named.
 *
 * Prime-only functions are withheld because "the prime keeps them for itself";
 * a CRM-line function is withheld because the clone's line does not carry it.
 * Saying "which the prime keeps for itself" about the GoHighLevel integration
 * on the independent line would be false — the prime ships it to every
 * dependent clone — so each share carries its own reason. With no line names
 * this is byte-identical to the sentence every existing hold already writes.
 */
export function withheldClause(names: Iterable<string>): string {
  const all = [...new Set(names)].sort();
  const line = allCrmLineFunctionNames();
  const rest = all.filter((n) => !line.has(n));
  const lineShare = describeCrmLineWithheld(all.filter((n) => line.has(n)));
  const restShare =
    rest.length > 0 ? `${describeWithheldFunctions(rest)}, which the prime keeps for itself` : "";
  return [restShare, lineShare].filter((p): p is string => Boolean(p)).join(", and ");
}

// ─────────────────────────────────────────────────────────────────────────────
// The files the independent line holds as its OWN copy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Paths whose copy on the independent line differs from the prime's BY DESIGN.
 *
 * The withheld features above are files the line does not carry at all. These
 * are files it carries in a different shape: a page that routes through
 * `crmProvider.ts` instead of calling GoHighLevel, an agent whose calendar is
 * `crm-calendar`, an import that does not sync, and the specs and CI gates that
 * hold those shapes in place. A cascade from the prime writes the prime's copy
 * over each one, and nothing fails — the page compiles, it just calls a
 * function this line no longer deploys. `2fc9c46` and `5517a62` on the head are
 * that revert happening, seven files at a time, once per cascade.
 *
 * ## Held only where the bytes come from the PRIME
 *
 * The head reads from the prime; its children read from the head. A hold keyed
 * on the line alone would stop the head's variant reaching the children, which
 * is the one copy they are meant to have — which is why this was once left to
 * per-clone rows. Keyed on the SOURCE as well, one list covers the head and
 * leaves its children receiving it (`fromAnotherLine` in `partitionCascadePaths`).
 *
 * ## `manual_reconcile`, never `protected`
 *
 * A prime change to one of these files is real work the line may want, not an
 * identity it must refuse. So the hold is a decision an operator can take
 * (`approvableHeld`), and the evidence rule releases it by itself where the
 * clone's copy is byte-identical to a version the prime held — a file the line
 * has not actually changed protects nothing. A recorded exclusion row for the
 * same path is asked FIRST, so a `protected` row is never weakened by this.
 *
 * A conversion delivers none of these holds: converting is the act of taking
 * the other line's copy of exactly these files.
 *
 * Measured against prime@559c5ff on 1 Oct 2026: every exact path below differs
 * from the prime's copy, and each was changed on the head by a commit whose
 * purpose was the line (#7, #8, #15, `5517a62`, `2e7cf3f`, #56). The globs name
 * what only the line carries, so a same-named prime file cannot land on it.
 */
export const CRM_LINE_VARIANT_PATTERNS: Readonly<Partial<Record<CrmMode, readonly string[]>>> = {
  independent: [
    // The CRM this deployment is, and everything that speaks for it.
    "src/lib/crm/**",
    "supabase/functions/_shared/crm/**",
    "supabase/functions/crm-calendar/**",
    "supabase/functions/crm-inbound-message/**",
    "supabase/functions/crm-send-message/**",
    "scripts/lib/crmLineFeatures.*",
    ".github/workflows/decommission-crm-line-functions.yml",
    "docs/crm/**",
    // Pages and components that route through it.
    "src/components/clients/ClientAppointmentsTab.tsx",
    "src/components/clients/ClientBulkActions.tsx",
    "src/components/clients/ClientCard.tsx",
    "src/components/clients/ClientConversationsTab.tsx",
    "src/components/clients/ExcelDropzone.tsx",
    "src/components/clients/NativePipelineCreator.tsx",
    "src/components/clients/add-client/StandardAddClientForm.tsx",
    "src/components/marketing/LeadAttributionPanel.tsx",
    "src/hooks/useGHLCalendar.tsx",
    "src/lib/secureInvoke.ts",
    "src/pages/ClientManagement.tsx",
    "src/pages/ClientTracker.tsx",
    "src/pages/Conversations.tsx",
    "src/pages/finance-portal/FinancePortalClients.tsx",
    // Server code that no longer reaches a withheld function.
    "supabase/functions/ai-dashboard-agent/index.ts",
    "supabase/functions/finance-portal-client-data/index.ts",
    "supabase/functions/manage-automation-settings/index.ts",
    // The specs and gates that hold the shapes above.
    "src/components/clients/add-client/AddClientModal.test.tsx",
    "src/lib/security/__tests__/phantomColumnWrites.spec.ts",
    "src/lib/security/auditRemediation.spec.ts",
    "src/lib/sync/__tests__/ghlConversationMap.test.ts",
    "scripts/security/check-cron-caller-names.mjs",
    "scripts/security/check-ghl-message-authz.mjs",
    ".github/workflows/ci.yml",
    "CLAUDE.md",
  ],
};

const variantRules = new Map<CrmMode, { pattern: string; rx: RegExp }[]>();
for (const [mode, patterns] of Object.entries(CRM_LINE_VARIANT_PATTERNS) as [
  CrmMode,
  readonly string[],
][]) {
  variantRules.set(
    mode,
    patterns.map((pattern) => ({ pattern, rx: globToRegex(pattern) })),
  );
}

/** The variant pattern a path falls under on this line, or null. */
export function crmLineVariantPattern(
  path: string,
  crmMode: string | null | undefined,
): string | null {
  if (crmMode !== "independent" && crmMode !== "dependent") return null;
  const hit = variantRules.get(crmMode)?.find((r) => r.rx.test(path));
  return hit?.pattern ?? null;
}

export const CRM_LINE_VARIANT_NOTE =
  "Independent CRM line: this clone's copy is the line's own, so the prime's does not overwrite it. " +
  "Approve an overwrite here only to take the prime's version deliberately.";
