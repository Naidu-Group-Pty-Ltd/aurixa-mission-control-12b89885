import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MANAGED_ENV_NAMES,
  staleManagedNames,
  EnvPolicyError,
  backendRefusalReason,
  buildCloneEnv,
  envDigest,
  isPublicName,
  looksSecret,
  projectRefFromAnonKey,
  projectRefFromUrl,
  refuseReason,
} from "./envPolicy.pure";

/** A real anon-key shape: header.payload.signature, `ref` in the payload. */
function anonKeyFor(ref: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref, role: "anon" })}.sig`;
}

const CLONE = "plisdzywzleljorrphxv";
const PRIME = "dduzbchuswwbefdunfct";
const cloneBackend = {
  supabaseUrl: `https://${CLONE}.supabase.co`,
  supabaseProjectRef: CLONE,
  supabaseAnonKey: anonKeyFor(CLONE),
};

describe("public-name classification", () => {
  it("knows which prefixes a bundler inlines", () => {
    expect(isPublicName("VITE_SUPABASE_URL")).toBe(true);
    expect(isPublicName("NEXT_PUBLIC_API")).toBe(true);
    expect(isPublicName("SUPABASE_SERVICE_ROLE_KEY")).toBe(false);
  });

  it("does not flag the keys that are publishable by design", () => {
    // A rule that flags every name containing KEY is a rule people turn off.
    expect(looksSecret("VITE_SUPABASE_ANON_KEY")).toBe(false);
    expect(looksSecret("VITE_SUPABASE_PUBLISHABLE_KEY")).toBe(false);
  });

  it("flags authority-granting names wherever the fragment sits", () => {
    expect(looksSecret("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(looksSecret("VITE_STRIPE_WEBHOOK_SECRET")).toBe(true);
    expect(looksSecret("db_pass")).toBe(true);
  });
});

describe("refuseReason", () => {
  it("is silent for a secret with a private name", () => {
    // Nothing wrong with a service-role key that is NOT public — that is where
    // it belongs.
    expect(refuseReason("SUPABASE_SERVICE_ROLE_KEY")).toBeNull();
  });

  it("is silent for a publishable value with a public name", () => {
    expect(refuseReason("VITE_SUPABASE_ANON_KEY")).toBeNull();
  });

  it("refuses a secret given a public prefix, and names the fragment", () => {
    const reason = refuseReason("VITE_SUPABASE_SERVICE_ROLE_KEY");
    expect(reason).toContain("SERVICE_ROLE");
    expect(reason).toContain("client bundle");
  });
});

describe("buildCloneEnv", () => {
  it("emits both anon-key spellings so an older clone still builds", () => {
    const vars = buildCloneEnv(cloneBackend);
    const keys = vars.map((v) => v.key);
    expect(keys).toContain("VITE_SUPABASE_ANON_KEY");
    expect(keys).toContain("VITE_SUPABASE_PUBLISHABLE_KEY");
  });

  it("drops empty and absent values rather than publishing an empty string", () => {
    // An empty VITE_SUPABASE_URL builds fine and fails at the first request.
    const vars = buildCloneEnv({ supabaseUrl: "  ", supabaseAnonKey: null });
    expect(vars).toEqual([]);
  });

  it("REFUSES half a Supabase pair", () => {
    // This used to emit the URL alone. A URL with no key is not a partial
    // configuration, it is a client rejected on every request — and it
    // overwrites whatever working default the clone's own build carries.
    expect(() => buildCloneEnv({ supabaseUrl: `https://${CLONE}.supabase.co` })).toThrow(
      EnvPolicyError,
    );
    expect(() => buildCloneEnv({ supabaseAnonKey: anonKeyFor(CLONE) })).toThrow(EnvPolicyError);
  });

  it("REFUSES a URL and a key from different projects", () => {
    expect(() =>
      buildCloneEnv({
        supabaseUrl: `https://${CLONE}.supabase.co`,
        supabaseAnonKey: anonKeyFor(PRIME),
      }),
    ).toThrow(/authenticates to nothing/);
  });

  it("REFUSES an environment that names the prime's backend", () => {
    // The rule the deployed client dashboard was the counter-example to.
    expect(() =>
      buildCloneEnv({
        supabaseUrl: `https://${PRIME}.supabase.co`,
        supabaseProjectRef: PRIME,
        supabaseAnonKey: anonKeyFor(PRIME),
        primeProjectRef: PRIME,
      }),
    ).toThrow(/never be able to reach the prime/);
  });

  it("publishes the clone's own pair with the same prime configured", () => {
    // The refusal must be about WHOSE project it is, not about the check being
    // switched on. Same prime, clone's own backend, published.
    const vars = buildCloneEnv({ ...cloneBackend, primeProjectRef: PRIME });
    expect(vars.find((v) => v.key === "VITE_SUPABASE_URL")?.value).toBe(
      `https://${CLONE}.supabase.co`,
    );
  });

  it("THROWS when an extra would publish a secret", () => {
    expect(() => buildCloneEnv({ extra: { VITE_SUPABASE_SERVICE_ROLE_KEY: "sk-real" } })).toThrow(
      EnvPolicyError,
    );
  });

  it("has no parameter for the service-role key at all", () => {
    // The strongest form of the guarantee: a caller cannot pass what the type
    // does not name. This asserts the shape rather than a runtime filter.
    const input: Parameters<typeof buildCloneEnv>[0] = {};
    expect(Object.keys(input)).not.toContain("supabaseServiceRoleKey");
  });

  it("marks every emitted var with whether the bundle will carry it", () => {
    const vars = buildCloneEnv({ ...cloneBackend, extra: { SENTRY_DSN: "https://x@y/1" } });
    expect(vars.find((v) => v.key === "VITE_SUPABASE_URL")?.publicToBundle).toBe(true);
    expect(vars.find((v) => v.key === "SENTRY_DSN")?.publicToBundle).toBe(false);
  });
});

describe("envDigest", () => {
  it("is stable across ordering", () => {
    const a = buildCloneEnv(cloneBackend);
    const b = [...a].reverse();
    expect(envDigest(a)).toBe(envDigest(b));
  });

  it("changes when a VALUE changes, not just a name", () => {
    // A rotated API key keeps its name. A digest over names alone would skip
    // the re-sync and leave the clone building against the revoked key.
    const before = buildCloneEnv({ extra: { VITE_FEATURE_TOKENS: "a" } });
    const after = buildCloneEnv({ extra: { VITE_FEATURE_TOKENS: "b" } });
    expect(envDigest(before)).not.toBe(envDigest(after));
  });

  it("changes when a variable is added", () => {
    const one = buildCloneEnv(cloneBackend);
    const two = buildCloneEnv({ ...cloneBackend, extra: { VITE_FEATURE_TOKENS: "a" } });
    expect(envDigest(one)).not.toBe(envDigest(two));
  });
});

describe("reading which project a value belongs to", () => {
  it("reads the ref from a project URL", () => {
    expect(projectRefFromUrl(`https://${CLONE}.supabase.co`)).toBe(CLONE);
    expect(projectRefFromUrl("https://example.com")).toBeNull();
  });

  it("reads the ref claim from a publishable key", () => {
    expect(projectRefFromAnonKey(anonKeyFor(PRIME))).toBe(PRIME);
    expect(projectRefFromAnonKey("not-a-jwt")).toBeNull();
  });

  it("an UNREADABLE ref is not a MISMATCHED one", () => {
    // A self-hosted URL has no <ref>.supabase.co and an opaque key has no ref
    // claim. Guessing in either direction is worse than the check not applying,
    // so a half that cannot be read is passed over rather than refused.
    expect(
      backendRefusalReason({
        supabaseUrl: "https://supabase.internal.example",
        supabaseAnonKey: "opaque-token",
      }),
    ).toBeNull();
  });

  it("says nothing when there is no backend to judge", () => {
    expect(backendRefusalReason({})).toBeNull();
  });
});

/**
 * The names that must not be producible.
 *
 * A parameter that nothing passes and nothing reads looks like dead weight and
 * is actually an invitation: `aurixaApiKey` was documented as "the clone's
 * Mission Control API key" and pushed under a `VITE_` prefix, which this
 * module's own header opens by explaining is inlined into the JavaScript every
 * visitor downloads. `refuseReason` would not have caught it — `SECRET_FRAGMENTS`
 * omits bare `KEY` deliberately and carries no `API_KEY` — so the only thing
 * standing between that key and the public bundle was that no caller had got
 * round to using the parameter.
 *
 * Asserted over the BUILT environment rather than over the source, so it stays
 * true however the value might arrive: the `extra` passthrough is checked with
 * the same names.
 */
describe("a Mission Control credential cannot be given a public name", () => {
  const namesFrom = (input: Parameters<typeof buildCloneEnv>[0]) =>
    buildCloneEnv(input).map((v) => v.key);

  it("never emits VITE_AURIXA_API_KEY from any supported input", () => {
    // Every field this function accepts, all at once. If a parameter for it
    // comes back, one of these is the shape it will arrive in.
    const everything = {
      ...cloneBackend,
      siteOrigin: "https://acme.aurixasystems.com.au",
      aurixaApiKey: "ak_live_should_never_be_published",
    } as Parameters<typeof buildCloneEnv>[0];
    expect(namesFrom(everything)).not.toContain("VITE_AURIXA_API_KEY");
  });

  it("does not quietly reintroduce VITE_SITE_URL either", () => {
    const withOrigin = {
      ...cloneBackend,
      siteOrigin: "https://acme.aurixasystems.com.au",
    } as Parameters<typeof buildCloneEnv>[0];
    expect(namesFrom(withOrigin)).not.toContain("VITE_SITE_URL");
  });

  it("emits exactly the four names a clone's bundle needs, plus what is asked for", () => {
    // Stated as a whole set rather than a prohibition: a new name arriving by
    // accident is the failure mode, and a list of things-not-to-emit cannot
    // see one nobody thought of.
    expect(namesFrom(cloneBackend).sort()).toEqual([
      "VITE_SUPABASE_ANON_KEY",
      "VITE_SUPABASE_PROJECT_ID",
      "VITE_SUPABASE_PUBLISHABLE_KEY",
      "VITE_SUPABASE_URL",
    ]);
  });
});

/**
 * Removing what we stopped pushing, and nothing else.
 *
 * `syncEnv` upserted and never removed — `removed: 0` was a literal in its
 * return — so a name this pipeline stopped emitting stayed on the hosting
 * project for ever and the next build inlined it. The obvious repair is to
 * delete whatever is not in the set being pushed, and it is wrong in the
 * direction this codebase keeps paying for: an operator's own variable, set
 * for a reason nobody wrote down, would go with it.
 */
describe("stale managed variables", () => {
  it("removes a name we used to emit and no longer do", () => {
    expect(
      staleManagedNames({
        onProject: ["VITE_SUPABASE_URL", "VITE_AURIXA_API_KEY", "VITE_SITE_URL"],
        pushing: ["VITE_SUPABASE_URL"],
      }),
    ).toEqual(["VITE_AURIXA_API_KEY", "VITE_SITE_URL"]);
  });

  it("never touches a variable this pipeline does not manage", () => {
    // The whole reason the list is declared rather than derived.
    expect(
      staleManagedNames({
        onProject: ["OPERATORS_OWN_FLAG", "VITE_SOMETHING_THEY_ADDED", "SENTRY_DSN"],
        pushing: ["VITE_SUPABASE_URL"],
      }),
    ).toEqual([]);
  });

  it("keeps a managed name that is being pushed", () => {
    expect(
      staleManagedNames({
        onProject: [...MANAGED_ENV_NAMES],
        pushing: [...MANAGED_ENV_NAMES],
      }),
    ).toEqual([]);
  });

  it("names a stale Turnstile site key, because a stale one is worse than none", () => {
    // It verifies against a secret this deployment no longer holds, so the
    // login page draws a CAPTCHA that cannot be satisfied.
    expect(
      staleManagedNames({
        onProject: ["VITE_TURNSTILE_SITE_KEY", "VITE_SUPABASE_URL"],
        pushing: ["VITE_SUPABASE_URL"],
      }),
    ).toEqual(["VITE_TURNSTILE_SITE_KEY"]);
  });

  it("keeps every retired name on the list", () => {
    // Dropping a retired name from the list is how it gets stranded on every
    // project that already has it — the list is what makes removal possible,
    // so it is the last place a retired name may be deleted from.
    expect(MANAGED_ENV_NAMES).toContain("VITE_AURIXA_API_KEY");
    expect(MANAGED_ENV_NAMES).toContain("VITE_SITE_URL");
  });

  it("covers every name buildCloneEnv can emit", () => {
    // The failure this catches: somebody adds a push and forgets the list, so
    // the new name can never be retired later.
    const emitted = buildCloneEnv({
      ...cloneBackend,
      extra: { VITE_TURNSTILE_SITE_KEY: "0x4AAA" },
    }).map((v) => v.key);
    for (const name of emitted) expect(MANAGED_ENV_NAMES).toContain(name);
  });

  it("is case-sensitive, because environment variable names are", () => {
    expect(staleManagedNames({ onProject: ["vite_site_url"], pushing: [] })).toEqual([]);
  });
});

/**
 * `staleManagedNames` can be exactly right and nothing ever remove a variable,
 * because the provider is free not to call it — which is what it did for the
 * whole life of this pipeline, with `removed: 0` written as a literal. So the
 * call site is asserted, the same reason `deploymentState.test.ts` asserts
 * `statusSince: row.status_since` rather than trusting `judgeWait`.
 */
describe("the hosting provider actually prunes", () => {
  const PROVIDER = readFileSync("src/server/hosting/vercel-provider.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const syncEnv = PROVIDER.slice(
    PROVIDER.indexOf("async syncEnv("),
    PROVIDER.indexOf("async describeProject("),
  );

  it("asks which names are stale rather than deciding for itself", () => {
    expect(syncEnv).toMatch(/staleManagedNames\s*\(/);
  });

  it("deletes them", () => {
    expect(syncEnv).toMatch(/deleteEnv\s*\(/);
  });

  it("prunes AFTER writing, never before", () => {
    // A prune that runs first and then fails to write leaves the clone with
    // neither value. This order means the worst case is the state we had.
    expect(syncEnv.indexOf("upsertEnv")).toBeLessThan(syncEnv.indexOf("deleteEnv"));
  });

  it("treats an empty environment as nothing to do, not as a clear-down", () => {
    // What a deployment whose backend has not reported yet produces. Removing
    // the managed set there strips a working clone's Supabase pair.
    expect(syncEnv).toMatch(/vars\.length === 0\)\s*return \{ written: 0, removed: 0 \}/);
  });

  it("reports what it removed instead of a literal zero", () => {
    expect(syncEnv).not.toMatch(/return \{ written: vars\.length, removed: 0 \}/);
    expect(syncEnv).toMatch(/return \{ written: vars\.length, removed \}/);
  });
});
