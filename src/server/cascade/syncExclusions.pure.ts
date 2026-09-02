/**
 * What a cascade is NOT allowed to write into a clone.
 *
 * ## Why this exists
 *
 * The cascade engine copies files out of prime and commits them into a clone.
 * Until now it only ever touched files matching the globs of the modules
 * installed on that clone, so "which files must it leave alone" never had to be
 * answered — a clone simply did not install a module it wanted to diverge on.
 *
 * A MIRROR clone breaks that. `npc-client-dashboard` is the whole prime
 * application with one build flag flipped, so its scope is the entire tree, and
 * inside that tree are a handful of files whose whole purpose is to be
 * different. The worst of them is `src/integrations/supabase/env.ts`: it names
 * the Supabase project this deployment talks to, and its own header records
 * what happened the last time it resolved to prime's — the deployed client
 * dashboard served the PRIME's production database, and signing in there
 * authenticated against real staff accounts.
 *
 * So the rule this module exists for is not stylistic:
 *
 *   **A clone's identity is not a file the cascade owns.**
 *
 * A cascade that overwrites `env.ts` does not fail. It succeeds, reports green,
 * redeploys the clone, and points a customer's dashboard at another tenant's
 * data. Nothing downstream of the commit can tell that apart from a correct
 * sync, which is exactly why the decision has to be made here, before the blob
 * is written, from a list an operator can read.
 *
 * ## Two reasons, both excluded, only one silent
 *
 * `protected` — the clone owns this file outright. Config, identity, the
 * fail-closed workflow guards. Prime's version is never interesting and the
 * divergence is permanent, so a difference is not news.
 *
 * `manual_reconcile` — the clone's version is a deliberate SUPERSET of prime's
 * (`App.tsx` carries the route gates, `clientFacing.ts` hides 46 paths where
 * prime hides 24). Taking prime's version would revert real work; skipping it
 * silently means the clone never learns about a new route. So these are held
 * back from the commit AND named in the pull request, because the failure mode
 * of the quiet version is slow and invisible.
 *
 * ## Fail closed
 *
 * An exclusion set that could not be READ is not an empty exclusion set. If the
 * policy query fails, `partitionCascadePaths` must not be called with `[]` —
 * callers use `requireExclusions`, which throws. The cascade failing loudly is
 * recoverable; a cascade that ran without its guard rails is not.
 *
 * Client-safe: no imports beyond the shared glob compiler, so the operator UI
 * can render the same partition the engine will perform.
 */
import { globToRegex, isSafeRepoPath } from "@/lib/module-globs";

export type ExclusionReason = "protected" | "manual_reconcile";

export type SyncExclusion = {
  pattern: string;
  reason: ExclusionReason;
  note?: string | null;
};

export type HeldPath = {
  path: string;
  pattern: string;
  reason: ExclusionReason;
  note: string | null;
};

export type CascadePartition = {
  /** Paths the cascade may write. */
  write: string[];
  /** Paths withheld, with the rule that withheld each one. */
  held: HeldPath[];
};

export class MissingExclusionPolicyError extends Error {
  constructor(cloneId: string, cause: string) {
    super(
      `Refusing to cascade into clone ${cloneId}: its sync exclusion policy could not be read (${cause}). ` +
        `An unreadable policy is not an empty policy.`,
    );
    this.name = "MissingExclusionPolicyError";
  }
}

/**
 * Fail-closed accessor. `rows` is what the database returned; `error` is
 * whatever it returned alongside. A read that FAILED and a clone that
 * genuinely has no exclusions are different states and only one of them is
 * safe to cascade under.
 *
 * An empty list is allowed — a module-scoped clone legitimately has none — but
 * it has to be an empty list that was actually read.
 */
export function requireExclusions(
  cloneId: string,
  rows: SyncExclusion[] | null | undefined,
  error?: { message: string } | null,
): SyncExclusion[] {
  if (error) throw new MissingExclusionPolicyError(cloneId, error.message);
  if (rows == null) throw new MissingExclusionPolicyError(cloneId, "no rows returned");
  return rows;
}

/**
 * A mirror with no exclusions at all is a configuration accident, not a policy.
 *
 * An empty set is perfectly legitimate for a module-scoped clone — it receives
 * only the globs of what it installed, and nothing it installed is contested.
 * A MIRROR receives the whole tree, so an empty set means "overwrite
 * everything", identity included. That state is reachable by ordinary means:
 * register a mirror and forget to seed it, or delete the rows while tidying.
 *
 * There is no safe default to fall back to, because the right set is a property
 * of the clone. So this refuses, and the refusal names the fix.
 */
export function assertMirrorPolicy(cloneId: string, exclusions: readonly SyncExclusion[]): void {
  if (exclusions.length === 0) {
    throw new MissingExclusionPolicyError(
      cloneId,
      "sync_scope is 'mirror' but clone_sync_exclusions is empty — a whole-tree cascade with no " +
        "exclusions would overwrite this clone's backend identity. Seed it from " +
        "DEFAULT_MIRROR_EXCLUSIONS before cascading",
    );
  }
}

/**
 * Split the paths a cascade would write into those it may write and those it
 * must not, against one clone's exclusion patterns.
 *
 * A path matching several patterns is attributed to the FIRST match in the
 * given order, and `protected` is checked before `manual_reconcile` so a path
 * covered by both reports as the stronger of the two.
 *
 * A path that is not a safe repo path is withheld regardless of the patterns.
 * `listTreeEntries` already filters those out; this is the second line, in the
 * place that decides what gets committed.
 */
export function partitionCascadePaths(
  candidates: readonly string[],
  exclusions: readonly SyncExclusion[],
): CascadePartition {
  const ordered = [
    ...exclusions.filter((e) => e.reason === "protected"),
    ...exclusions.filter((e) => e.reason !== "protected"),
  ];
  const compiled = ordered.map((e) => ({ ...e, rx: globToRegex(e.pattern) }));

  const write: string[] = [];
  const held: HeldPath[] = [];

  for (const path of candidates) {
    if (!isSafeRepoPath(path)) {
      held.push({
        path,
        pattern: "(unsafe path)",
        reason: "protected",
        note: "Refused by isSafeRepoPath",
      });
      continue;
    }
    const hit = compiled.find((e) => e.rx.test(path));
    if (hit) {
      held.push({
        path,
        pattern: hit.pattern,
        reason: hit.reason,
        note: hit.note ?? null,
      });
      continue;
    }
    write.push(path);
  }

  return { write, held };
}

/** The held paths worth telling a human about — see the header. */
export function reportableHeld(held: readonly HeldPath[]): HeldPath[] {
  return held.filter((h) => h.reason === "manual_reconcile");
}

/**
 * The phrase a per-clone result uses to say a human is owed work, defined here
 * so the engine that WRITES it and the summary that COUNTS it cannot drift.
 *
 * It exists because a cascade that held a `manual_reconcile` path was reported
 * as an unqualified success. `src/App.tsx` is held on the client-facing mirror
 * — it carries route gates the prime does not — so when the prime added
 * `/passport/:token` and `/partner-acknowledgement/:token` together with source
 * tests asserting those routes are in `App.tsx`, the tests cascaded and the
 * routes could not. The clone's CI went red on every run for over twelve hours,
 * the "never merge into a clone whose CI is red" rule correctly refused, and
 * the only thing anyone was told was `cascade_completed · success · 0 merged`.
 *
 * The PR body has always carried a "Needs a human" section. Nobody reads a PR
 * body to find out why drift will not clear.
 */
export const RECONCILE_MARKER = "need reconciling";

/** How the per-clone `diff_summary` says it. One writer, one reader. */
export function reconcileSuffixFor(count: number): string {
  return count > 0 ? ` · ${count} ${RECONCILE_MARKER}` : "";
}

/** Read back what `reconcileSuffixFor` wrote, from a stored result summary. */
export function summaryOwesReconcile(diffSummary: string | null | undefined): boolean {
  return typeof diffSummary === "string" && diffSummary.includes(RECONCILE_MARKER);
}

/**
 * The exclusion set a client-facing mirror of this prime needs on day one.
 *
 * Not invented here. Every entry is a divergence that already exists between
 * `npc-property-dashbord` and `npc-client-dashboard` and is written down in the
 * clone's own `docs/CLIENT_FACING_MODE.md` — this is that table, in the one
 * place the cascade can enforce it.
 *
 * Seeded when a mirror is registered, and editable afterwards: it is a starting
 * policy, not a constant. What must not happen is a mirror registered with NO
 * policy, which is why registration seeds and `requireExclusions` refuses to
 * treat an unreadable set as an empty one.
 */
export const DEFAULT_MIRROR_EXCLUSIONS: readonly SyncExclusion[] = [
  // ── Identity. The reason this whole module exists. ────────────────────────
  {
    pattern: "src/integrations/supabase/env.ts",
    reason: "protected",
    note: "Names the Supabase project this deployment talks to. Prime's version points at prime's database.",
  },
  {
    pattern: "supabase/config.toml",
    reason: "protected",
    note: "Carries the clone's own project ref and per-function verify_jwt declarations.",
  },
  {
    pattern: "supabase/.temp/**",
    reason: "protected",
    note: "Tracked upstream and holds the prime's project ref; backendIsolation.spec.ts asserts it stays untracked here.",
  },
  // ── Build and deploy configuration ────────────────────────────────────────
  {
    pattern: "vite.config.ts",
    reason: "protected",
    note: "Pins VITE_CLIENT_FACING and defines __CLIENT_FACING__ for this repository.",
  },
  { pattern: "vercel.json", reason: "protected", note: "This deployment's hosting config." },
  { pattern: ".env.example", reason: "protected", note: "Documents the clone's own variables." },
  { pattern: ".gitignore", reason: "protected", note: "Keeps supabase/.temp untracked here." },
  {
    pattern: ".gitleaks.toml",
    reason: "protected",
    note: "Allowlists THIS deployment's own publishable anon key by literal. Prime's copy would allow prime's key and re-flag the clone's.",
  },
  {
    pattern: ".github/workflows/deploy-supabase-functions.yml",
    reason: "protected",
    note: "Fail-closed guard against deploying into the wrong project.",
  },
  {
    pattern: ".github/workflows/apply-migration.yml",
    reason: "protected",
    note: "Fail-closed guard against applying migrations to the wrong project.",
  },
  {
    pattern: "docs/CLIENT_FACING_MODE.md",
    reason: "protected",
    note: "Describes this repository, not prime.",
  },
  // ── Deliberate supersets: withheld, and reported every time ───────────────
  {
    pattern: "src/App.tsx",
    reason: "manual_reconcile",
    note: "Clone carries RouteExcludedFromBuild and __CLIENT_FACING__ gates prime does not. New upstream routes have to be brought across by hand.",
  },
  {
    pattern: "src/lib/clientFacing.ts",
    reason: "manual_reconcile",
    note: "Clone hides a strict superset of prime's paths.",
  },
  {
    pattern: "src/lib/__tests__/clientFacing.test.ts",
    reason: "manual_reconcile",
    note: "Asserts the clone's hiding decisions, which contradict prime's.",
  },
  {
    pattern: "src/components/call-logs/CleanupTestCalls.tsx",
    reason: "manual_reconcile",
    note: "Clone reads VITE_TEST_CALL_NUMBERS instead of hardcoding staff mobiles.",
  },
  // ── Added after a cascade reverted them. Both are backend identity. ───────
  //
  // These two were overwritten by the 26 Aug mirror cascade of prime@14af87a
  // and are the reason `backendIdentityHold` exists: a list only protects what
  // somebody remembered to add to it, and nobody had added these.
  {
    pattern: "public/lead-magnet-embed.html",
    reason: "manual_reconcile",
    note: "Served verbatim from public/ and hard-codes a Supabase URL and anon key. Prime's pair is prime's project — this embed captured leads into the prime's database from the clone's own domain until it was fixed, and the next cascade wrote prime's copy straight back over it.",
  },
  {
    pattern: "src/lib/reportTemplate/__tests__/renderAssetNormalisation.spec.ts",
    reason: "manual_reconcile",
    note: "Clone derives PROJECT from SUPABASE_URL; prime hard-codes its own project. compileTemplateHtmlForPdf admits SUPABASE_URL and nothing else, so prime's literal is a FOREIGN origin here and the fixture is correctly dropped — the assertion fails on any clone with its own backend.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The content rule: a clone's backend identity is not a file the cascade owns,
// whatever the file is called.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Supabase project ref is exactly twenty lowercase letters. Both shapes that
 * carry one into a shipped file are matched: the project URL, and the `ref`
 * claim inside an anon key — a URL from one project with a key from another
 * authenticates to nothing, so the pair travels together and both halves have
 * to be seen.
 */
const PROJECT_URL_REF = /\b([a-z]{20})\.supabase\.co\b/g;
const JWT_CLAIM_REF = /"ref"\s*:\s*"([a-z]{20})"/g;

/** Every Supabase project this content names, deduplicated, in first-seen order. */
export function backendRefsIn(content: string): string[] {
  const seen = new Set<string>();
  for (const rx of [PROJECT_URL_REF, JWT_CLAIM_REF]) {
    rx.lastIndex = 0;
    for (const m of content.matchAll(rx)) seen.add(m[1]);
  }
  return [...seen];
}

/**
 * Whether a path is one whose content this deployment SHIPS or EXECUTES — the
 * only paths where naming another tenant's project has a consequence.
 *
 * Deliberately the same rule the clone's own `backendIsolation.spec.ts`
 * enforces, and no wider. `src/**` excluding tests, plus the whole of
 * `public/**` — every file in it is copied into `dist/` untouched and is
 * reachable on the deployment's own domain, which makes it the most exposed
 * directory rather than the least.
 *
 * `docs/**` is deliberately OUT. 185 tracked files in the mirror name the
 * prime's ref, nearly all of them prose and captured integration payloads,
 * and holding those back on every cascade would bury the four lines that
 * matter under a list nobody reads.
 */
export function isShippedPath(path: string): boolean {
  if (path.startsWith("public/")) return true;
  if (!path.startsWith("src/")) return false;
  if (path.includes("/__tests__/")) return false;
  if (/\.(test|spec)\.[jt]sx?$/.test(path)) return false;
  return /\.[jt]sx?$/.test(path);
}

/**
 * Decide whether prime's copy of one path would revert this clone's backend.
 *
 * The question is NOT "does prime's version name a foreign project" on its own.
 * Prime naming its own project is prime being correct. What matters is whether
 * writing it here would UNDO a divergence: the clone's copy is clean and
 * prime's is not.
 *
 * That distinction is the difference between a guard and a nuisance. Three
 * `supabase/functions/**` files in the mirror name the prime today, inherited
 * and never fixed; a rule keyed on prime's content alone would report those on
 * every cascade forever, and a "needs a human" section that is never empty is
 * one nobody reads.
 *
 * ## Why this is not covered by the path list
 *
 * It already wasn't. `public/lead-magnet-embed.html` was fixed on the clone on
 * 26 Aug — the embed had been posting names, emails and phone numbers into the
 * PRIME's database from the clone's own domain — and the very next cascade
 * wrote prime's copy back over it, because nobody had thought to add that path
 * to `clone_sync_exclusions`. A list only protects what somebody remembered.
 * This protects the property.
 *
 * ## `ownRef` unknown is not `ownRef` absent
 *
 * A clone with no registered backend cannot have "its own project" compared
 * against, so every foreign ref is unresolvable rather than benign. Pass null
 * and every ref counts as foreign: the cascade still runs, and the handful of
 * paths that name a project are held and named instead of written blind.
 */
export function backendIdentityHold(args: {
  path: string;
  primeContent: string;
  /** The clone's copy, or null when the clone does not have this file. */
  cloneContent: string | null;
  /** This clone's own Supabase project ref, or null when it has no backend. */
  ownRef: string | null;
}): HeldPath | null {
  const { path, primeContent, cloneContent, ownRef } = args;
  if (!isShippedPath(path)) return null;

  const foreign = (c: string) => backendRefsIn(c).filter((r) => r !== ownRef);
  const primeForeign = foreign(primeContent);
  if (primeForeign.length === 0) return null;

  // The clone does not have this file. Writing it would introduce a foreign
  // project into a shipped path, which is the clone's own isolation spec going
  // red on the cascade's own pull request.
  if (cloneContent === null) {
    return {
      path,
      pattern: "(content: foreign backend ref)",
      reason: "manual_reconcile",
      note:
        `New upstream file names Supabase project ${primeForeign.join(", ")}, which is not this ` +
        `clone's. Bring it across with this deployment's own project and key.`,
    };
  }

  // The clone's copy names one too — nothing is being reverted, so this is
  // prime moving and the clone following. Not this guard's business.
  if (foreign(cloneContent).length > 0) return null;

  return {
    path,
    pattern: "(content: foreign backend ref)",
    reason: "manual_reconcile",
    note:
      `This clone's copy names no foreign project and prime's names ` +
      `${primeForeign.join(", ")}. Writing prime's version would point a shipped file at ` +
      `another tenant's database.`,
  };
}

/**
 * The most a cascade will carry in one file.
 *
 * A cascade reads a file whole from prime, base64-encodes it and posts it as
 * one blob, and the invocation doing that has a ceiling the file does not.
 * Measured 2 Sep 2026: the pending cascade to `npc-client-dashboard` was 48
 * files, one of them a 39 MB migration seed, and the pass died on that one
 * file on every attempt — three events exhausted their claims on it while a
 * 55-file cascade with nothing large in it landed first time. Eight megabytes
 * is the migration corpus's own `MAX_MIGRATION_BYTES`: a body the migration
 * sync refuses to carry is not one the repository cascade should carry
 * either.
 */
export const CASCADE_MAX_FILE_BYTES = 8 * 1024 * 1024;

const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * Hold a file that is too large to cascade, and say so where a person reads.
 *
 * `manual_reconcile`, so it is counted and listed rather than withheld in
 * silence: the file still differs upstream and somebody has to bring it
 * across — by hand, because the migration sync refuses a body over its own
 * ceiling as well.
 */
export function oversizeHold(path: string, bytes: number, maxBytes: number): HeldPath {
  return {
    path,
    pattern: "(size: over the cascade ceiling)",
    reason: "manual_reconcile",
    note:
      `${megabytes(bytes)} upstream, over the ${megabytes(maxBytes)} a cascade will carry in ` +
      `one file. Bring it across by hand; the migration sync refuses a body this size as well.`,
  };
}
