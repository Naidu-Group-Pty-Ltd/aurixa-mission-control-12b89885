/**
 * What may be given a PUBLIC name, and what must never be.
 *
 * Vite inlines every `VITE_`-prefixed variable into the client bundle at build
 * time. Marking it "encrypted" on the hosting provider protects it at rest and
 * not at all in the artefact — the value is a string literal in the JavaScript
 * every visitor downloads. The same is true of `NEXT_PUBLIC_`.
 *
 * That makes one mistake catastrophic and completely silent: give the Supabase
 * SERVICE-ROLE key a `VITE_` name and the build succeeds, the deployment goes
 * live, and a key that bypasses every RLS policy on the clone's database is
 * served to the public. Nothing fails. Nothing logs. The repo already refuses to
 * write `.aurixa/credentials.json` into a non-private repository for the same
 * class of reason (`clone-credentials.server.ts`); this is that guardrail for
 * the deployment path.
 *
 * So the rule is enforced rather than documented: `buildCloneEnv` THROWS when a
 * value whose name matches a secret pattern is about to be published, and the
 * worker imports this module rather than re-deriving the rule at the call site.
 * One implementation, rendered in the operator preview and enforced on the way
 * out — the same shape as `assessPepEvidence` in the property dashboard, where
 * what an operator is asked for and what the server accepts cannot become two
 * standards.
 *
 * ── The second rule: WHOSE backend this environment names ────────────────────
 *
 * A clone's environment is the only thing standing between that clone and some
 * other tenant's database, so this module also refuses an environment that does
 * not coherently name the clone's OWN project.
 *
 * The URL and the publishable key are a MATCHED PAIR — the anon key is a JWT
 * whose `ref` claim names the project it belongs to — so a URL from one project
 * with a key from another authenticates to nothing, and half a pair is worse
 * than none: it overrides whatever correct default the clone's own build
 * carries and replaces it with one that 401s on every request.
 *
 * `npc-client-dashboard` is why the prime check exists. Its hosting project was
 * created outside this pipeline and never had `VITE_SUPABASE_URL` set at all;
 * its build fell through to a built-in fallback that was the PRIME's project,
 * and the deployed client dashboard served the prime's production database —
 * live, on a custom domain, for a week. That clone's resolver now falls back to
 * its own project instead, which is what actually holds when nothing is
 * configured. This is the other half: when Mission Control DOES publish a pair,
 * it can never publish the prime's.
 */

/** Prefixes a bundler inlines into client-side code. */
export const PUBLIC_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "PUBLIC_", "REACT_APP_"] as const;

/**
 * Name fragments that mean "this value grants authority".
 *
 * Matched case-insensitively against the WHOLE name, so `VITE_SUPABASE_SERVICE_ROLE_KEY`
 * is caught by `SERVICE_ROLE` even though the name starts with a public prefix.
 * `KEY` alone is deliberately absent — `ANON_KEY` and `PUBLISHABLE_KEY` are
 * publishable by design, and a rule that flags every key is a rule people turn
 * off.
 */
export const SECRET_FRAGMENTS = [
  "SERVICE_ROLE",
  "SERVICE_KEY",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PRIVATE_KEY",
  "ACCESS_TOKEN",
  "API_TOKEN",
  "CLIENT_SECRET",
  "WEBHOOK_SECRET",
  "DB_PASS",
  "DATABASE_URL",
  "CONNECTION_STRING",
] as const;

export type EnvTarget = "production" | "preview" | "development";

export type CloneEnvVar = {
  key: string;
  value: string;
  /** True when the bundler will inline this into client-side code. */
  publicToBundle: boolean;
  targets: EnvTarget[];
};

export class EnvPolicyError extends Error {
  constructor(
    message: string,
    public readonly key: string,
  ) {
    super(message);
    this.name = "EnvPolicyError";
  }
}

export function isPublicName(key: string): boolean {
  return PUBLIC_PREFIXES.some((p) => key.startsWith(p));
}

export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_FRAGMENTS.some((f) => upper.includes(f));
}

/**
 * The check, on its own so a preview surface can call it without building the
 * whole environment. Returns the reason a name is refused, or null.
 */
export function refuseReason(key: string): string | null {
  if (!isPublicName(key)) return null;
  if (!looksSecret(key)) return null;
  const fragment = SECRET_FRAGMENTS.find((f) => key.toUpperCase().includes(f));
  return (
    `${key} would be inlined into the client bundle by its prefix, and its name ` +
    `contains "${fragment}". A value that grants authority cannot have a public name.`
  );
}

/** The `ref` sub-domain of a Supabase project URL, or null if it is not one. */
export function projectRefFromUrl(url: string): string | null {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.(co|in|net)/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * The `ref` claim of a Supabase publishable (anon) JWT, or null if it cannot be
 * read. Decoding is base64url of the payload segment — no signature check,
 * because this is not authenticating anything, only asking which project the
 * key was issued for.
 */
export function projectRefFromAnonKey(key: string): string | null {
  try {
    const payload = key.trim().split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
    const ref = (JSON.parse(json) as { ref?: unknown }).ref;
    return typeof ref === "string" ? ref.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type BackendCoherenceInput = {
  supabaseUrl?: string | null;
  supabaseProjectRef?: string | null;
  supabaseAnonKey?: string | null;
  /** The prime BACKEND's ref, when the deployment has one configured. */
  primeProjectRef?: string | null;
};

const clean = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * Why this environment must not be published, or null.
 *
 * Exported separately so an operator preview can show the refusal beside the
 * variables rather than discovering it as a thrown error mid-deploy — the same
 * split as `refuseReason` above.
 *
 * A ref that cannot be READ is not a ref that DISAGREES. A self-hosted URL has
 * no `<ref>.supabase.co` to parse and an opaque key has no `ref` claim, so an
 * unreadable half is passed over rather than treated as a mismatch; guessing in
 * either direction is worse than the check not applying.
 */
export function backendRefusalReason(input: BackendCoherenceInput): string | null {
  const url = clean(input.supabaseUrl);
  const anonKey = clean(input.supabaseAnonKey);
  const declaredRef = clean(input.supabaseProjectRef).toLowerCase();
  const primeRef = clean(input.primeProjectRef).toLowerCase();

  if (!url && !anonKey) return null;

  if (!url || !anonKey) {
    const present = url ? "VITE_SUPABASE_URL" : "the publishable key";
    const missing = url ? "the publishable key" : "VITE_SUPABASE_URL";
    return (
      `Half a Supabase pair: ${present} is set and ${missing} is not. The URL and ` +
      `the key authenticate together, so publishing one alone gives the clone a ` +
      `client that is rejected on every request — and overwrites whatever working ` +
      `default its own build carries.`
    );
  }

  const urlRef = projectRefFromUrl(url);
  const keyRef = projectRefFromAnonKey(anonKey);

  if (urlRef && keyRef && urlRef !== keyRef) {
    return (
      `The Supabase URL names project "${urlRef}" but the publishable key was ` +
      `issued for "${keyRef}". They authenticate as a pair, so this environment ` +
      `authenticates to nothing.`
    );
  }
  if (urlRef && declaredRef && urlRef !== declaredRef) {
    return (
      `The Supabase URL names project "${urlRef}" but the backend record says ` +
      `"${declaredRef}". One of the two is stale; publishing either is a guess.`
    );
  }

  // The rule the deployed client dashboard was the counter-example to.
  if (primeRef) {
    const named = [urlRef, keyRef, declaredRef || null].filter(
      (r): r is string => r !== null && r === primeRef,
    );
    if (named.length > 0) {
      return (
        `This environment names the PRIME's backend (${primeRef}). A clone must ` +
        `never be able to reach the prime's database: it holds another tenant's ` +
        `clients, listings and AML records, and a clone pointed at it authenticates ` +
        `its sign-ins against the prime's real staff accounts. Point this ` +
        `deployment at the clone's own project.`
      );
    }
  }

  return null;
}

export type BuildCloneEnvInput = {
  /** The clone's own Supabase project URL, e.g. https://abc.supabase.co */
  supabaseUrl?: string | null;
  /** The clone's own project ref. */
  supabaseProjectRef?: string | null;
  /** The PUBLISHABLE (anon) key. Never the service-role key. */
  supabaseAnonKey?: string | null;
  //
  // There is deliberately no parameter for the clone's Mission Control API key.
  // There WAS one — `aurixaApiKey`, pushed as `VITE_AURIXA_API_KEY` — and its
  // own doc comment called it "the clone's Mission Control API key", which is
  // a credential, under a prefix this module's header opens by explaining gets
  // inlined into the JavaScript every visitor downloads. Nothing ever passed
  // it and nothing in a clone ever read it, so no key was published; but the
  // parameter is the invitation, and `refuseReason` would not have caught it:
  // `SECRET_FRAGMENTS` omits bare `KEY` on purpose (`ANON_KEY` and
  // `PUBLISHABLE_KEY` are publishable by design) and carries no `API_KEY`.
  //
  // It is removed rather than guarded, for the reason this module already
  // gives for the service-role key: a caller cannot pass what the type does
  // not name, and that is a stronger guarantee than a filter. A clone that
  // needs to speak to Mission Control does it from its own Supabase project,
  // where a secret is a secret.
  //
  // `siteOrigin` / `VITE_SITE_URL` went with it and for a plainer reason:
  // nothing supplied it and nothing read it. The clone's own origins are
  // derived server-side by `applyCloneDerivedConfig` once the deployment is
  // live, which is the first moment they are actually known.
  /**
   * The prime BACKEND's project ref, when this deployment has one configured
   * (`resolvePrimeBackendRef`). Optional: a deployment that has not configured
   * it still gets the pairing checks, it just has no name to compare against.
   * Never defaulted — a guessed prime ref would refuse the wrong deployments.
   */
  primeProjectRef?: string | null;
  /** Anything else the operator has configured. Classified by the same rule. */
  extra?: Record<string, string | null | undefined>;
};

/**
 * Build the environment for a clone's hosting project.
 *
 * Only values that are publishable by design get a public prefix. The
 * service-role key and the database password are NOT accepted by this function
 * at all — there is no parameter for them, which is a stronger guarantee than
 * filtering them out, because a caller cannot pass what the type does not name.
 */
export function buildCloneEnv(input: BuildCloneEnvInput): CloneEnvVar[] {
  // Whose backend this is, before what may be published. An incoherent pair is
  // refused outright rather than emitted minus the half that did not parse.
  const refusal = backendRefusalReason(input);
  if (refusal) throw new EnvPolicyError(refusal, "VITE_SUPABASE_URL");

  const all: EnvTarget[] = ["production", "preview", "development"];
  const out: CloneEnvVar[] = [];

  const push = (key: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    const trimmed = String(value).trim();
    if (!trimmed) return;
    const reason = refuseReason(key);
    if (reason) throw new EnvPolicyError(reason, key);
    out.push({ key, value: trimmed, publicToBundle: isPublicName(key), targets: all });
  };

  push("VITE_SUPABASE_URL", input.supabaseUrl);
  push("VITE_SUPABASE_PROJECT_ID", input.supabaseProjectRef);
  // Both spellings: the prime reads one and older clones read the other, and a
  // clone that builds against a missing name fails at runtime with an
  // unauthenticated Supabase client rather than at build time.
  push("VITE_SUPABASE_ANON_KEY", input.supabaseAnonKey);
  push("VITE_SUPABASE_PUBLISHABLE_KEY", input.supabaseAnonKey);

  for (const [key, value] of Object.entries(input.extra ?? {})) push(key, value);

  return out;
}

/**
 * A stable digest of what we last pushed, so a re-sync that would change
 * nothing is skipped rather than burning a rate-limited write per clone per
 * run. Sorted by key, and it covers VALUES as well as names — a rotated API key
 * with the same name has to re-sync, and a digest over names alone would not
 * notice.
 *
 * Not a cryptographic hash and does not need to be: it compares two things we
 * produced ourselves, and a collision costs one skipped sync, not a security
 * property. Written this way because the Workers runtime gives us no
 * synchronous hash and this stays pure and testable.
 */
export function envDigest(vars: CloneEnvVar[]): string {
  const canonical = [...vars]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => `${v.key}=${v.value}`)
    .join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Every variable name this pipeline owns on a clone's hosting project.
 *
 * ## Why a declared list and not "everything we just pushed"
 *
 * `syncEnv` upserts. It has never removed anything, and its own return type
 * has carried `removed: 0` as a literal since it was written. So a name this
 * pipeline stops emitting stays on the project for ever, and the next build
 * inlines it — which is not a hypothetical: `VITE_AURIXA_API_KEY` and
 * `VITE_SITE_URL` were emitted by `buildCloneEnv` until today, and a clone
 * whose operator ever set them by hand still carries them.
 *
 * The obvious repair — delete anything not in the set we are pushing — is
 * wrong, and wrong in the direction this codebase keeps paying for: an
 * operator's own variable, set on the Vercel project for a reason nobody
 * recorded, would be destroyed by a sync that knows nothing about it. That is
 * the correction losing to the document it corrects.
 *
 * So removal is bounded by a list of names we have DECLARED, the same
 * discipline `aml-idv-retention` uses for storage objects: a fixed enumeration,
 * where a new name is invisible until somebody names it. A variable outside
 * this list is somebody else's and is never touched.
 *
 * Retired names stay in the list. That is the entire point of the list — a
 * name is removed from a clone BECAUSE it is managed and no longer emitted,
 * so dropping it from here would strand it on every project that has it.
 */
export const MANAGED_ENV_NAMES = [
  // Emitted by `buildCloneEnv` today.
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PROJECT_ID",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  // Passed through `extra` by the deployment drain. Declared here rather than
  // inferred, because a clone that stops getting a widget must stop carrying
  // the site key of one — a stale key renders a CAPTCHA that verifies against
  // a secret this deployment no longer holds.
  "VITE_TURNSTILE_SITE_KEY",
  // Retired. Kept so they are taken OFF the projects that still have them.
  "VITE_AURIXA_API_KEY",
  "VITE_SITE_URL",
] as const;

/**
 * Managed names present on the project that the environment being pushed does
 * not contain — the set a sync should remove.
 *
 * Pure and given both sides, so the rule is testable without a Vercel project:
 * the interesting part is which names are in scope, not how they are fetched.
 * Case-sensitive, because environment variable names are.
 */
export function staleManagedNames(input: {
  /** Names currently on the hosting project. */
  onProject: Iterable<string>;
  /** Names in the environment being pushed. */
  pushing: Iterable<string>;
}): string[] {
  const managed = new Set<string>(MANAGED_ENV_NAMES);
  const pushing = new Set(input.pushing);
  const out: string[] = [];
  for (const name of input.onProject) {
    if (!managed.has(name)) continue; // Somebody else's. Never ours to delete.
    if (pushing.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
