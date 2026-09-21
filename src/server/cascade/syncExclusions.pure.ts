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

/**
 * Why a path was withheld.
 *
 * `protected` is identity the clone owns and the engine refuses to touch
 * whatever anybody approves. `manual_reconcile` is a DECISION owed to a
 * person: the clone's copy and prime's have diverged and somebody has to say
 * which wins. `oversize` is neither — it is a CEILING, and no approval can
 * discharge it.
 *
 * The third one exists because conflating it with the second built a dead
 * control. `oversizeHold` returned `manual_reconcile`, so the dry-run card
 * offered "Approve prime's copy for held path(s)…" over it and
 * `approveCascadePaths` wrote a fourteen-day approval row — while
 * `decideHoldRelease` filters `partition.held` some four hundred lines BEFORE
 * an oversize hold is pushed into it, so the approval could never reach one.
 * An operator could approve, be told it had worked, and watch the next cascade
 * hold the same file again, for ever.
 *
 * Moving the push above the release block was the other candidate fix and it
 * is the wrong one: releasing an oversize path sends it into the prepare loop,
 * which fetches it and hits the identical ceiling. The approval would have
 * started succeeding while the file still did not land — a dead control that
 * had learned to say yes.
 */
export type ExclusionReason = "protected" | "manual_reconcile" | "oversize";

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

/**
 * The held paths worth telling a human about — see the header.
 *
 * Deliberately BOTH kinds. An oversize file is not a decision anybody can
 * take, but it is still a file that differs upstream and is not travelling,
 * and dropping it from this list would return it to the silence this function
 * was written to end. What separates them is `approvableHeld` below, which is
 * about what may be OFFERED rather than what must be SAID.
 */
export function reportableHeld(held: readonly HeldPath[]): HeldPath[] {
  return held.filter((h) => h.reason === "manual_reconcile" || h.reason === "oversize");
}

/**
 * The held paths an operator may actually decide.
 *
 * `manual_reconcile` alone. This is the set `decideHoldRelease` can release,
 * so it is the only set an approval dialog may be drawn over — an approval
 * offered anywhere else is a control that reports success and changes nothing.
 * Named here rather than re-filtered at each surface, because the engine's
 * release filter and the card's offer are the two ends that drifted.
 */
export function approvableHeld(held: readonly HeldPath[]): HeldPath[] {
  return held.filter((h) => h.reason === "manual_reconcile");
}

/**
 * What a pass that wrote NOTHING still owes a person about its oversize holds.
 *
 * A cascade whose every differing path was withheld returns `skipped` before
 * it opens a pull request, so the "Needs a human" section — the only place
 * `reportableHeld` has ever been rendered — is never composed. All that
 * survives is one line of `diff_summary`, and that line said a count.
 *
 * The count is the wrong unit for this hold. A `protected` path differs for
 * ever by design and an operator can safely read past it; an `oversize` path
 * is a file prime HAS, the clone LACKS, and no cascade will ever deliver,
 * because `CASCADE_MAX_FILE_BYTES` is a ceiling rather than a decision. Folded
 * into "all 23 differing path(s) are withheld by this clone's exclusion
 * policy", the two are indistinguishable, and the second one is invisible.
 *
 * Measured 21 Sep 2026: all three mirrors skipped on exactly that sentence
 * while `npc-client-dashboard` sat six template-library seed versions behind
 * prime — v13 to v18, ~39.8 MB each against an 8 MB ceiling — and the only
 * way to learn it was to query `cascade_results` by hand.
 *
 * Paths and not notes: `oversizeHold` writes a ~250-character note per file
 * and six of them would bury the sentence they qualify. The note still travels
 * in the PR body on every pass that opens one; this is the summary field, and
 * a summary nobody finishes reading is the silence again in a longer form.
 */
export function oversizeHoldNotice(held: readonly HeldPath[], maxListed = 4): string {
  const over = held.filter((h) => h.reason === "oversize");
  if (over.length === 0) return "";
  const listed = over.slice(0, maxListed).map((h) => `  ${h.path}`);
  if (over.length > maxListed) listed.push(`  (+${over.length - maxListed} more)`);
  return (
    `\n${over.length} of them exceed the size a cascade carries in one file, so prime holds ` +
    `them and this clone never will. No approval can release a ceiling — bring these across ` +
    `by hand:\n${listed.join("\n")}`
  );
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
 *
 * ## A new entry is APPENDED, and arrives with its own migration
 *
 * Registration seeds this list, so a mirror that already exists never sees an
 * entry added after it was registered. The seed migrations carry that delta —
 * `20260826070000_seed_mirror_exclusions.sql` first, and one more for each
 * later addition. An applied migration is never edited, so a new default goes
 * on the END of this array and gets a new file; inserting one in the middle
 * would make the migrations and this list disagree about order while agreeing
 * about content.
 *
 * `syncExclusions.test.ts` finds those migrations by what their SQL DOES rather
 * than from a list of filenames, concatenates their rows in filename order, and
 * requires the result to equal this array exactly. A seed file nobody
 * remembered to register therefore cannot slip past, and a migration that
 * writes an exclusion row for some other purpose fails loudly instead.
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
  //
  // ## Why they are `manual_reconcile` and not `protected`
  //
  // Asked and settled 20 Sep 2026, after the embeds on both children were
  // found shipping the prime's project and key. `protected` reads like the
  // stronger word and is the WRONG one here, for three reasons:
  //
  //  1. **`protected` is silent.** `reportableHeld` carries
  //     `manual_reconcile` and `oversize` and deliberately not `protected`, so
  //     promoting these would take the embed out of every "needs a human"
  //     count and out of the PR body that names them. The defect this pair
  //     records went unseen for weeks; muting the one line that would have
  //     said so is the opposite of the fix.
  //  2. **Holding is identical either way.** Both reasons withhold the path.
  //     What `protected` adds is that `decideHoldRelease` refuses it — and an
  //     approved release does not reach the repository unguarded anyway:
  //     releases are decided BEFORE the write list is read, so a released path
  //     still goes through `backendIdentityHold` on content, which now refuses
  //     a swap between two DIFFERENT foreign projects as well as a revert.
  //  3. **There is a legitimate reconcile.** Prime genuinely does change this
  //     embed's markup, and a clone genuinely does want those changes with its
  //     own pair. That is a decision owed to a person, which is precisely what
  //     `manual_reconcile` means and `protected` denies.
  //
  // The list is append-only by construction (`syncExclusions.test.ts` requires
  // the seed migrations to project onto this array exactly, and forbids them
  // to DELETE), so changing a reason in place is not a cheap edit either. It
  // did not need to be.
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
  // ── Appended, never inserted. See the header. ─────────────────────────────
  //
  // Everything below arrived after a mirror was already registered, so it
  // reached the live table through a seed migration rather than through
  // registration. The order here is the order those migrations wrote, which is
  // what lets `syncExclusions.test.ts` check one against the other.

  // The login CAPTCHA. Both of these were on all three mirrors and in NO
  // list — put there by hand when the per-clone Turnstile identity was built,
  // which is the same way the first policy came to be incomplete. A mirror
  // registered today would have received neither.
  //
  // The prime declares a built-in site key literal; the clone declares `null`
  // and uses `VITE_TURNSTILE_SITE_KEY` alone. Carrying prime's copy would put
  // the prime's live site key into a tenant's bundle — the pairing rule stops
  // it RENDERING, because the built-in is bound to the backend its secret lives
  // in, but the literal is still in that repository and its build.
  {
    pattern: "src/lib/turnstileSiteKey.ts",
    reason: "protected",
    note: "Declares this deployment's built-in Turnstile site key and the backend its secret is paired with. Prime declares a literal, a clone declares null and uses VITE_TURNSTILE_SITE_KEY.",
  },
  {
    pattern: "src/lib/__tests__/turnstileIdentity.spec.ts",
    reason: "protected",
    note: "Asserts THIS deployment's Turnstile decisions, which contradict prime's. It travels with turnstileSiteKey.ts because a spec and the module it pins are one setting in two files — the split is what turned renderAssetNormalisation.spec.ts red on a clone.",
  },

  // ── The three workflows that write an Edge secret ─────────────────────────
  //
  // Writing a Supabase Edge secret from CI needs a Supabase management
  // credential, and the prime repository is the only one in this fleet that
  // holds one — `PRIME_ONLY_SECRETS` refuses to forward `SUPABASE_ACCESS_TOKEN`
  // by name. So on a clone all three can only reach their own "check the
  // credential" step and fail, naming a missing setting that must never be
  // supplied there.
  //
  // Freezing them costs nothing, and that is the whole test for whether a
  // workflow belongs on this list. `deploy-supabase-functions.yml` is the
  // cautionary case: it was excluded for an equally good reason and it runs on
  // PUSH, so the exclusion also froze the stand-down out of two clones and
  // they failed 100% of their runs for a week — which is what
  // `deployWorkflowReconcile` exists to undo. These three are
  // `workflow_dispatch` only. Nothing runs them, nothing is judged by them, and
  // prime's copy of a file a clone can never execute is never interesting.
  //
  // What the exclusion protects is a clone's right to diverge on them — to
  // delete them, or to point them at infrastructure it actually owns — without
  // the next cascade writing prime's copy back over it. That is the
  // `public/lead-magnet-embed.html` lesson, and a list only protects what
  // somebody remembered to add.
  {
    pattern: ".github/workflows/set-builder-stock-pdf-worker-secrets.yml",
    reason: "protected",
    note: "Writes an Edge secret and a Cloudflare worker secret. wrangler.jsonc names one worker on one account, so running it from a clone would rotate the prime's worker bearer and store the new value in the clone's own project. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone's own divergence is never reverted.",
  },
  {
    pattern: ".github/workflows/set-builder-stock-link-secrets.yml",
    reason: "protected",
    note: "Writes an Edge secret, which needs a Supabase management credential no clone repository may hold. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone's own divergence is never reverted.",
  },
  {
    pattern: ".github/workflows/rotate-internal-edge-secret.yml",
    reason: "protected",
    note: "Rotates INTERNAL_EDGE_SECRET, which Mission Control mints and rotates per clone through cloneSigningPair. Guarded at source by EDGE_SECRET_OWNER_REPO; held here so a clone's own divergence is never reverted.",
  },
  {
    pattern: ".github/dependabot.yml",
    reason: "protected",
    note: "Describes the prime's dependency graph, which a mirror does not own: package.json and package-lock.json are REPOSITORY_INVARIANTS, so a bump merged on a clone is reverted by the next cascade. Measured 20 Sep 2026 — all five deployments carried the byte-identical pair, and prime's config had produced 18 open PRs across four clones that could never merge. Removed from a clone rather than rewritten; this stops the cascade putting it back.",
  },
  {
    pattern: "src/integrations/supabase/supabaseTarget.pure.ts",
    reason: "protected",
    note:
      "The other place a deployment can declare its built-in Supabase pair. " +
      "`env.ts` beside it has been protected since this list was written; this " +
      "is the same setting after npc-crm-independent split the reads out so a " +
      "Vite config could import them. Prime does not carry the file today, so " +
      "a cascade delivers nothing and the omission is invisible — containment " +
      "by accident, which ends the day prime adopts the split. The clone's " +
      "shippedBackendIdentity guard would turn red rather than the swap being " +
      "silent, but a guard catching it afterwards is not a reason to let the " +
      "cascade write prime's database into a tenant's resolver.",
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
/**
 * Do two readings name the same set of foreign projects?
 *
 * Order and repetition are not information here — a file may name a ref in a
 * URL and again in the key's own `ref` claim — so this compares sets. Equal
 * means nothing is being re-pointed; unequal means something is.
 */
function sameRefs(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const ref of left) if (!right.has(ref)) return false;
  return true;
}

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

  const cloneForeign = foreign(cloneContent);
  if (cloneForeign.length > 0) {
    // The clone's copy names the SAME foreign project. Nothing is being
    // re-pointed — this is prime moving and the clone following, and holding
    // it would be the nuisance the header warns about: three
    // `supabase/functions/**` files in the mirror name the prime today,
    // inherited and never fixed, and a "needs a human" section that is never
    // empty is one nobody reads.
    if (sameRefs(cloneForeign, primeForeign)) return null;

    // A DIFFERENT foreign project, which is a re-pointing rather than a
    // follow. This branch used to be part of the stand-down above, and it was
    // safe for exactly as long as prime was the only thing a cascade could
    // read from: with one source, "the clone already names somebody else's
    // project" really did mean "nothing is being reverted here".
    //
    // `cascade_follows_lineage` ended that. A clone whose parent is another
    // clone receives the PARENT'S tree, so a shipped file can go from naming
    // the prime's project to naming a SIBLING'S — measured 20 Sep 2026 on
    // `npc-test-76b3b3` and `preflight-property-group`, whose
    // `public/lead-magnet-embed.html` carried the prime's ref and key and
    // would have been handed `npc-client-dashboard`'s. Both values are wrong
    // for those deployments; the incoming one is worse, because their own
    // `backendIsolation.spec.ts` fails on the PRIME's ref alone, so the write
    // would have turned a detectable defect into a green one.
    //
    // Swapping one foreign tenant for another is never a follow, whoever the
    // source is.
    return {
      path,
      pattern: "(content: foreign backend ref)",
      reason: "manual_reconcile",
      note:
        `This clone's copy names Supabase project ${cloneForeign.join(", ")} and the incoming ` +
        `copy names ${primeForeign.join(", ")} — neither is this deployment's. Writing it would ` +
        `re-point a shipped file from one foreign tenant's database to another's.`,
    };
  }

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
 * `oversize` rather than `manual_reconcile`, so it is counted and listed
 * without being offered as a decision nobody can take — see `ExclusionReason`.
 *
 * The note used to end "the migration sync refuses a body this size as well",
 * and that stopped being true: the migration lane chunks a seed-shaped INSERT
 * from a stream and carries these two files to the clone's DATABASE. What does
 * not travel is the file in the clone's REPOSITORY, which is a different
 * absence with a different remedy, and telling an operator the database is
 * also refusing it sends them to the wrong place.
 */
export function oversizeHold(path: string, bytes: number, maxBytes: number): HeldPath {
  return {
    path,
    pattern: "(size: over the cascade ceiling)",
    reason: "oversize",
    note:
      `${megabytes(bytes)} upstream, over the ${megabytes(maxBytes)} a cascade will carry in ` +
      `one file, so the clone's REPOSITORY does not receive it. No approval can release a ` +
      `ceiling — bring the file across by hand. Where it is a migration, the migration sync ` +
      `chunks it and the clone's database still gets it.`,
  };
}
