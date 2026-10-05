/**
 * Who may EXECUTE a database function, and which views run with the caller's
 * rights — the two privileges the catalogue clone path never carried.
 *
 * ## What this fixes
 *
 * The functions stage writes each prime function with `pg_get_functiondef`,
 * which renders the body and nothing about its ACL. A function Postgres creates
 * starts with EXECUTE granted to PUBLIC, so every function on every
 * engine-built clone was callable by anybody holding the project's anon key —
 * whatever the prime had revoked. Measured 3 Oct 2026 with Supabase's own
 * advisor:
 *
 *   - the prime: 4 SECURITY DEFINER functions callable by `anon`, 16 by
 *     `authenticated`;
 *   - `npc-crm-independent-6505dc`: 247 and 248;
 *   - each of the other three clones: 238 and 239.
 *
 * Among them `cron_service_role_headers` (it returns the project's internal
 * edge secret and, where the vault holds it, the service-role key),
 * `bootstrap_cron_vault` (it overwrites those secrets) and
 * `admin_set_aml_roles_for_user` (it grants any AML role to any user). The
 * prime's own migrations revoke all three; the clone path never replays those
 * migrations, so the revokes never ran.
 *
 * The views stage had the same blind spot, one layer over. It wrote
 * `create or replace view … as <definition>`, and Postgres REPLACES a view's
 * options on `create or replace` with whatever the statement names — nothing,
 * here — so `security_invoker` was absent on 10 to 13 views per clone and those
 * views read their tables with the OWNER's rights, past every RLS policy the
 * prime relies on.
 *
 * ## The rules
 *
 * 1. **The prime is the authority.** A function that exists on both sides ends
 *    up with exactly the API grantees the prime gives it. That is what the
 *    prime's production traffic already runs on, so it is the one ACL known to
 *    work with this code.
 * 2. **Only shared functions are touched.** A function the clone holds and the
 *    prime does not (a variant's own) is left exactly as it is, and counted.
 * 3. **`service_role` is never revoked.** It is the backend's own key, removing
 *    it closes no exposure, and it is the one revoke that can break an edge
 *    function the prime does not have. It is still GRANTED where the prime
 *    grants it — which matters, because revoking PUBLIC removes whatever
 *    service_role held only through PUBLIC.
 * 4. **A function a VARIANT's own objects call is never made less
 *    reachable.** RLS evaluates a policy as the querying role, so a revoke
 *    there turns a table unreadable rather than a function private. Anything
 *    the prime's own objects call the prime already grants, so only the
 *    policies, views, defaults, checks, indexes, triggers and function bodies
 *    the prime does NOT hold can hold a revoke back (`variantReferenceTexts`)
 *    — reported, not silently dropped.
 * 5. **Grants before revokes.** A pass the budget interrupts leaves a function
 *    with more access than intended, never with less.
 */

/** The API grantees this converges. PUBLIC is the implicit everybody-role (grantee oid 0). */
export const CONVERGED_GRANTEES = ["PUBLIC", "anon", "authenticated", "service_role"] as const;
export type ConvergedGrantee = (typeof CONVERGED_GRANTEES)[number];

/** The grantees a revoke may name — every one that exposes a function, and only those. */
export const REVOCABLE_GRANTEES: readonly ConvergedGrantee[] = ["PUBLIC", "anon", "authenticated"];

/** One function as read from a project's catalogue. */
export type RoutineAcl = {
  /** `schema.name(identity args)`, rendered by the catalogue itself (quote_ident + pg_get_function_identity_arguments). */
  signature: string;
  /** Bare function name, lower-case, for matching references in policy/view/default text. */
  name: string;
  /** SECURITY DEFINER — only used to rank what is reported. */
  securityDefiner: boolean;
  /** API grantees holding EXECUTE (PUBLIC included). */
  grantees: readonly string[];
};

export type RoutineAclPlan = {
  /** `grant execute on routine … to …` — applied first. */
  grants: string[];
  /** `revoke execute on routine … from …` — applied after every grant. */
  revokes: string[];
  /** Revokes withheld by rule 4, by signature. */
  heldForReference: Array<{ signature: string; grantees: string[] }>;
  /** Functions only the clone holds (rule 2). */
  cloneOnly: number;
  /** Of those, SECURITY DEFINER functions an exposed grantee can execute — the residue an operator should look at. */
  cloneOnlyExposedDefiners: string[];
  /** Shared functions whose exposure this plan closes: SECURITY DEFINER and losing anon or PUBLIC. */
  closedDefinerExposures: number;
};

const GRANTEE_SET = new Set<string>(CONVERGED_GRANTEES);

/** Normalise a grantee list read back from the catalogue (`'PUBLIC,anon'`, an array, or nothing). */
export function parseGrantees(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out = new Set<string>();
  for (const g of raw) {
    const t = g.trim().replace(/^"|"$/g, "");
    if (!t) continue;
    const norm = t.toLowerCase() === "public" ? "PUBLIC" : t;
    if (GRANTEE_SET.has(norm)) out.add(norm);
  }
  return [...out].sort();
}

/** PUBLIC is a keyword, never quoted; a role is an identifier. */
export function renderGrantee(g: string): string {
  if (g === "PUBLIC") return "public";
  return /^[a-z_][a-z0-9_]*$/.test(g) ? g : `"${g.replace(/"/g, '""')}"`;
}

/**
 * Every function name a piece of SQL text calls. Deliberately generous — a
 * keyword like `coalesce(` lands in the set too and matches no function — so it
 * can only ever HOLD a revoke back, never let one through.
 */
export function referencedFunctionNames(
  texts: readonly (string | null | undefined)[],
): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|[^a-z0-9_$"])"?([a-z_][a-z0-9_$]*)"?\s*\(/gi;
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(re)) out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * The reference texts only the CLONE holds — a variant's own policies, views,
 * defaults, checks, indexes and triggers.
 *
 * A text the prime holds too is the prime's own object, and the prime already
 * grants every function it calls to every role that evaluates it, or the
 * prime itself would fail. Converging to the prime's grants therefore keeps it
 * working, and holding its functions back would leave exactly the
 * most-referenced functions (`has_role` and its siblings) exposed for no
 * reason. What the prime cannot vouch for is what it does not hold.
 * Whitespace is collapsed so a re-rendered definition is not mistaken for a
 * variant's.
 */
export function variantReferenceTexts(
  prime: readonly (string | null | undefined)[],
  clone: readonly (string | null | undefined)[],
): string[] {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim();
  const primeSet = new Set(prime.filter((t): t is string => !!t).map(norm));
  return clone.filter((t): t is string => !!t && !primeSet.has(norm(t)));
}

/**
 * A signature is executed as SQL, so it must look like one the catalogue
 * rendered: a qualified name and a parenthesised argument list with nothing
 * after it. Anything else is skipped rather than interpolated.
 */
export function isRenderedSignature(signature: string): boolean {
  if (!/^("[^"]+"|[a-z_][a-z0-9_$]*)\.("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\(.*\)$/i.test(signature)) {
    return false;
  }
  // A statement separator or comment anywhere in it is not a type list.
  return !/;|--|\/\*/.test(signature);
}

export function planRoutineAclConvergence(input: {
  prime: readonly RoutineAcl[];
  clone: readonly RoutineAcl[];
  /** Function names the CLONE's policies, views and column defaults call (rule 4). */
  referencedOnClone?: ReadonlySet<string>;
}): RoutineAclPlan {
  const primeBySig = new Map(input.prime.map((r) => [r.signature, r]));
  const referenced = input.referencedOnClone ?? new Set<string>();

  const grants: string[] = [];
  const revokes: string[] = [];
  const heldForReference: RoutineAclPlan["heldForReference"] = [];
  const cloneOnlyExposedDefiners: string[] = [];
  let cloneOnly = 0;
  let closedDefinerExposures = 0;

  for (const c of [...input.clone].sort((a, b) => a.signature.localeCompare(b.signature))) {
    const p = primeBySig.get(c.signature);
    if (!p) {
      cloneOnly += 1;
      if (c.securityDefiner && c.grantees.some((g) => g === "PUBLIC" || g === "anon")) {
        cloneOnlyExposedDefiners.push(c.signature);
      }
      continue;
    }
    if (!isRenderedSignature(c.signature)) continue;

    const want = new Set(parseGrantees(p.grantees));
    const have = new Set(parseGrantees(c.grantees));

    const toGrant = CONVERGED_GRANTEES.filter((g) => want.has(g) && !have.has(g));
    let toRevoke = REVOCABLE_GRANTEES.filter((g) => have.has(g) && !want.has(g));

    if (toRevoke.length && referenced.has(c.name.toLowerCase())) {
      heldForReference.push({ signature: c.signature, grantees: [...toRevoke] });
      toRevoke = [];
    }

    if (toGrant.length) {
      grants.push(
        `grant execute on routine ${c.signature} to ${toGrant.map(renderGrantee).join(", ")}`,
      );
    }
    if (toRevoke.length) {
      revokes.push(
        `revoke execute on routine ${c.signature} from ${toRevoke.map(renderGrantee).join(", ")}`,
      );
      if (c.securityDefiner && toRevoke.some((g) => g === "PUBLIC" || g === "anon")) {
        closedDefinerExposures += 1;
      }
    }
  }

  return {
    grants,
    revokes,
    heldForReference,
    cloneOnly,
    cloneOnlyExposedDefiners,
    closedDefinerExposures,
  };
}

// ─── View options ────────────────────────────────────────────────────

/**
 * The view options this converges. `security_invoker` is the one that matters
 * (it decides whose rights a view reads its tables with); the other two are the
 * rest of what `CREATE VIEW … WITH (…)` accepts, carried so that converging one
 * cannot silently drop another.
 */
export const MANAGED_VIEW_OPTIONS = [
  "security_invoker",
  "security_barrier",
  "check_option",
] as const;
const MANAGED_VIEW_OPTION_SET = new Set<string>(MANAGED_VIEW_OPTIONS);
const BOOLEAN_VIEW_OPTIONS = new Set(["security_invoker", "security_barrier"]);

export type ViewOptions = {
  /** `schema.name`, rendered by the catalogue (quote_ident). */
  view: string;
  /** `pg_class.reloptions` — `{security_invoker=true}`, an array, or null. */
  options: unknown;
};

/** `{security_invoker=on,check_option=local}` → managed keys only, booleans normalised. */
export function parseViewOptions(value: unknown): Map<string, string> {
  const items = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? (() => {
          const s = value.trim();
          const inner = s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s;
          return inner ? inner.split(",") : [];
        })()
      : [];
  const out = new Map<string, string>();
  for (const item of items) {
    const [k, ...rest] = item.trim().replace(/^"|"$/g, "").split("=");
    const key = (k ?? "").trim().toLowerCase();
    if (!MANAGED_VIEW_OPTION_SET.has(key)) continue;
    let val = rest.join("=").trim().toLowerCase();
    if (!/^[a-z0-9_]+$/.test(val)) continue; // never interpolate something that is not a word
    if (BOOLEAN_VIEW_OPTIONS.has(key)) {
      if (["true", "on", "yes", "1"].includes(val)) val = "true";
      else if (["false", "off", "no", "0"].includes(val)) val = "false";
      else continue;
    }
    out.set(key, val);
  }
  return out;
}

/** `with (security_invoker=true)` for a CREATE VIEW, or the empty string. */
export function viewWithClause(options: unknown): string {
  const opts = parseViewOptions(options);
  if (opts.size === 0) return "";
  const parts = MANAGED_VIEW_OPTIONS.filter((k) => opts.has(k)).map((k) => `${k}=${opts.get(k)}`);
  return ` with (${parts.join(", ")})`;
}

export function isRenderedViewName(view: string): boolean {
  return /^("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\.("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)$/i.test(view);
}

/** Statements that give every view both sides hold the prime's options. */
export function planViewOptionConvergence(input: {
  prime: readonly ViewOptions[];
  clone: readonly ViewOptions[];
}): { statements: string[]; invokerRestored: number } {
  const primeByView = new Map(input.prime.map((v) => [v.view, parseViewOptions(v.options)]));
  const statements: string[] = [];
  let invokerRestored = 0;

  for (const c of [...input.clone].sort((a, b) => a.view.localeCompare(b.view))) {
    const want = primeByView.get(c.view);
    if (!want || !isRenderedViewName(c.view)) continue;
    const have = parseViewOptions(c.options);

    const toSet = MANAGED_VIEW_OPTIONS.filter((k) => want.has(k) && have.get(k) !== want.get(k));
    const toReset = MANAGED_VIEW_OPTIONS.filter((k) => !want.has(k) && have.has(k));

    if (toSet.length) {
      statements.push(
        `alter view ${c.view} set (${toSet.map((k) => `${k}=${want.get(k)}`).join(", ")})`,
      );
      if (want.get("security_invoker") === "true" && have.get("security_invoker") !== "true") {
        invokerRestored += 1;
      }
    }
    if (toReset.length) {
      statements.push(`alter view ${c.view} reset (${toReset.join(", ")})`);
    }
  }
  return { statements, invokerRestored };
}
