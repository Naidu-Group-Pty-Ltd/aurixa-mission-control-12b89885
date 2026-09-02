import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  classifySecret,
  IDENTITY_SECRETS,
  DEPLOYMENT_CONFIG_SECRETS,
} from "./prime-backend.server";
import {
  enforceRequiredExtensions,
  quoteExtensionIdent,
  resolveRequiredExtensions,
  REQUIRED_EXTENSION_FLOOR,
  planCloneSecrets,
  cloneAllowedOrigins,
} from "./backend-provisioning.server";

/**
 * Fidelity rules for cloning a prime, each one learned from a clone that was
 * wrong in a way that looked right. See docs/CLONE_PIPELINE_GAPS.md.
 */

describe("resolveRequiredExtensions", () => {
  it("names supabase_vault, because `vault` is not an extension", () => {
    // The old hard-coded list said "vault". `create extension vault` fails —
    // non-fatally — so clones were provisioned with no vault at all, which is
    // what the cron auth and secret decryption read.
    expect(REQUIRED_EXTENSION_FLOOR).toContain("supabase_vault");
    expect(REQUIRED_EXTENSION_FLOOR as readonly string[]).not.toContain("vault");
  });

  it("mirrors what the prime actually has, not a fixed guess", () => {
    // `vector` is the one that bites: the prime's embedding columns cannot be
    // created without it, so a migration declaring one fails outright.
    const out = resolveRequiredExtensions(["vector", "uuid-ossp", "pg_stat_statements"]);
    expect(out).toContain("vector");
    expect(out).toContain("uuid-ossp");
    expect(out).toContain("pg_stat_statements");
  });

  it("keeps the floor even when the prime reports nothing", () => {
    const out = resolveRequiredExtensions([]);
    for (const e of REQUIRED_EXTENSION_FLOOR) expect(out).toContain(e);
  });

  it("drops what Postgres ships anyway, and is stable", () => {
    expect(resolveRequiredExtensions(["plpgsql"])).not.toContain("plpgsql");
    expect(resolveRequiredExtensions(["b", "a"])).toEqual(resolveRequiredExtensions(["a", "b"]));
  });

  it("does not duplicate an extension the prime shares with the floor", () => {
    const out = resolveRequiredExtensions(["pg_cron", "pg_cron"]);
    expect(out.filter((n) => n === "pg_cron")).toHaveLength(1);
  });
});

describe("enforceRequiredExtensions", () => {
  // This step runs BEFORE the schema build, out of the same 50-second
  // invocation budget the build spends. The first version asked the clone
  // "is <name> installed?" and then issued `create extension if not exists`
  // for every extension in the set — two serial Management-API round trips
  // each, every pass, whether or not anything was absent.
  //
  // Measured on the 1 Sep 2026 dry run against a clone where all twelve had
  // been installed on the very first pass: ~30 seconds of every ~50-second
  // pass, so the schema build got under half a budget to make progress in.
  // Same class as the ten schema stages that never asked whether they were
  // already done — verifying a built thing must not cost what building it did.

  const originalFetch = globalThis.fetch;
  const originalToken = process.env.SB_MGMT_API_TOKEN;
  let bodies: string[] = [];

  const stubFetch = (installedOnClone: readonly string[]) => {
    bodies = [];
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const sql = init?.body ? String(JSON.parse(String(init.body)).query ?? "") : "";
      bodies.push(sql);
      const forClone = String(url).includes("/projects/clone-ref/");
      const rows = /from pg_extension/.test(sql)
        ? (forClone ? installedOnClone : PRIME_EXTENSIONS).map((extname) => ({ extname }))
        : [];
      return {
        ok: true,
        status: 200,
        json: async () => rows,
        text: async () => JSON.stringify(rows),
      };
    }) as unknown as typeof fetch;
  };

  const PRIME_EXTENSIONS = ["pg_cron", "pg_net", "vector", "uuid-ossp"];

  beforeEach(() => {
    // `headers()` throws without it, before a request is ever built — so
    // without this the stub below is never reached and every extension comes
    // back `failed`.
    process.env.SB_MGMT_API_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.SB_MGMT_API_TOKEN;
    else process.env.SB_MGMT_API_TOKEN = originalToken;
  });

  it("asks the clone what it holds once, and creates nothing when it holds everything", async () => {
    const wanted = resolveRequiredExtensions(PRIME_EXTENSIONS);
    stubFetch(wanted);

    const results = await enforceRequiredExtensions("clone-ref", "prime-ref");

    expect(results.map((r) => r.name)).toEqual(wanted);
    for (const r of results) expect(r.status).toBe("already_present");

    // One read per side, and not one statement more. The per-extension probe
    // is what this is here to keep gone.
    expect(bodies.filter((b) => /from pg_extension/.test(b))).toHaveLength(2);
    expect(bodies.filter((b) => /create extension/i.test(b))).toHaveLength(0);
    expect(bodies).toHaveLength(2);
  });

  it("creates exactly what is missing, and reports the rest as present", async () => {
    const wanted = resolveRequiredExtensions(PRIME_EXTENSIONS);
    const absent = ["vector", "uuid-ossp"];
    stubFetch(wanted.filter((n) => !absent.includes(n)));

    const results = await enforceRequiredExtensions("clone-ref", "prime-ref");

    for (const name of absent) {
      expect(results.find((r) => r.name === name)?.status).toBe("installed");
    }
    for (const r of results) {
      if (!absent.includes(r.name)) expect(r.status).toBe("already_present");
    }

    const creates = bodies.filter((b) => /create extension/i.test(b));
    expect(creates).toHaveLength(absent.length);
    // `uuid-ossp` is not a bare identifier; an unquoted one is a syntax error.
    expect(creates.some((b) => b.includes('"uuid-ossp"'))).toBe(true);
  });

  it("puts every extension back on the create path when the clone cannot be read", async () => {
    // `fetchProjectExtensionNames` swallows its error and answers []. Reading
    // that as "nothing is installed" is the safe direction: the fallback does
    // the work rather than assuming it is already done.
    const wanted = resolveRequiredExtensions(PRIME_EXTENSIONS);
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const sql = init?.body ? String(JSON.parse(String(init.body)).query ?? "") : "";
      const forClone = String(url).includes("/projects/clone-ref/");
      if (forClone && /from pg_extension/.test(sql)) {
        return { ok: false, status: 500, text: async () => "boom", json: async () => ({}) };
      }
      const rows = /from pg_extension/.test(sql)
        ? PRIME_EXTENSIONS.map((extname) => ({ extname }))
        : [];
      return { ok: true, status: 200, json: async () => rows, text: async () => "[]" };
    }) as unknown as typeof fetch;

    const results = await enforceRequiredExtensions("clone-ref", "prime-ref");
    expect(results).toHaveLength(wanted.length);
    for (const r of results) expect(r.status).toBe("installed");
  });

  it("keeps a failed extension non-fatal and named", async () => {
    // A clone missing pg_cron or pg_net has no background layer at all, so
    // the failure has to reach the parity report rather than the console.
    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      const sql = init?.body ? String(JSON.parse(String(init.body)).query ?? "") : "";
      if (/create extension/i.test(sql) && sql.includes("vector")) {
        return { ok: false, status: 400, text: async () => "no such extension", json: async () => ({}) };
      }
      const rows = /from pg_extension/.test(sql)
        ? (String(url).includes("/projects/clone-ref/") ? [] : PRIME_EXTENSIONS).map((extname) => ({
            extname,
          }))
        : [];
      return { ok: true, status: 200, json: async () => rows, text: async () => "[]" };
    }) as unknown as typeof fetch;

    const results = await enforceRequiredExtensions("clone-ref", "prime-ref");
    const vector = results.find((r) => r.name === "vector");
    expect(vector?.status).toBe("failed");
    expect(vector?.error).toContain("no such extension");
    expect(results.some((r) => r.status === "installed")).toBe(true);
  });
});

describe("quoteExtensionIdent", () => {
  it("quotes a name that is not a bare identifier", () => {
    // `create extension if not exists uuid-ossp` is a syntax error: the
    // hyphen ends the identifier. Unquoted interpolation silently lost it.
    expect(quoteExtensionIdent("uuid-ossp")).toBe('"uuid-ossp"');
  });

  it("leaves ordinary names alone", () => {
    expect(quoteExtensionIdent("pg_cron")).toBe("pg_cron");
    expect(quoteExtensionIdent("supabase_vault")).toBe("supabase_vault");
  });
});

describe("classifySecret", () => {
  it("treats signing secrets as identity, not credentials", () => {
    // A vendor key is shared on purpose — that is the forwarded-key billing
    // model. A signing secret's whole value is that ONE deployment holds it.
    for (const n of IDENTITY_SECRETS) expect(classifySecret(n)).toBe("identity");
  });

  it("treats origin/URL settings as deployment config", () => {
    for (const n of DEPLOYMENT_CONFIG_SECRETS) expect(classifySecret(n)).toBe("deployment_config");
  });

  it("treats SUPABASE_* as platform", () => {
    expect(classifySecret("SUPABASE_URL")).toBe("platform");
    expect(classifySecret("SUPABASE_SERVICE_ROLE_KEY")).toBe("platform");
    expect(classifySecret("SUPABASE_JWKS")).toBe("platform");
  });

  it("treats everything else as an inheritable vendor credential", () => {
    expect(classifySecret("ANTHROPIC_API_KEY")).toBe("vendor");
    expect(classifySecret("AIRTABLE_TOKEN")).toBe("vendor");
  });

  it("treats a project signing key as tenant-scoped, never vendor", () => {
    expect(classifySecret("JWT_SECRET")).toBe("tenant_scoped");
    // The SUPABASE_-prefixed spelling stays `platform`: the secrets API
    // reserves that prefix, so it cannot be written at all and must not be
    // presented to an operator as something they can set.
    expect(classifySecret("SUPABASE_JWT_SECRET")).toBe("platform");
  });
});

describe("planCloneSecrets", () => {
  const gen = () => "GENERATED";

  it("NEVER hands a clone the prime's token-signing key", () => {
    // The sharpest case in the tenant-scoped set. JWT_SECRET was classified
    // `vendor` — the class that copies the prime's value whenever a
    // forwarding row exists. A clone holding it could mint access tokens the
    // PRIME's database accepts, for any subject and any role.
    const { toWrite, results } = planCloneSecrets(
      ["JWT_SECRET"],
      { JWT_SECRET: "the-primes-signing-key" },
      gen,
    );
    expect(toWrite).toHaveLength(0);
    expect(results.get("JWT_SECRET")?.status).toBe("tenant_scoped_pending");
    expect(results.get("JWT_SECRET")?.error).not.toContain("the-primes-signing-key");
  });

  it("writes the clone's OWN signing key when provisioning captured one", () => {
    // Never inherited is not the same as never written: a value belonging to
    // this clone is exactly what should land.
    const { toWrite, results } = planCloneSecrets(
      ["JWT_SECRET"],
      { JWT_SECRET: "the-primes-signing-key" },
      gen,
      null,
      undefined,
      { JWT_SECRET: "this-clones-own-key" },
    );
    expect(toWrite).toEqual([{ name: "JWT_SECRET", value: "this-clones-own-key" }]);
    expect(results.get("JWT_SECRET")?.status).toBe("derived");
  });

  it("never generates a signing key, because a random one signs nothing valid", () => {
    // `identity` secrets get a fresh random value and that is right for them.
    // It would be actively worse here: PostgREST validates against the
    // project's own key, so a generated one produces tokens rejected by the
    // very database they are for.
    const { toWrite } = planCloneSecrets(["JWT_SECRET"], {}, gen);
    expect(toWrite).toHaveLength(0);
  });

  it("names a remedy an operator can actually act on", () => {
    const { results } = planCloneSecrets(["JWT_SECRET"], {}, gen);
    const err = results.get("JWT_SECRET")?.error ?? "";
    // Not the CAPTCHA's "mint it from the identity panel" — nothing mints this.
    expect(err).toContain("JWT Settings");
    expect(err).not.toContain("identity panel");
  });

  it("NEVER copies an identity secret, even when a value is available", () => {
    const { toWrite, results } = planCloneSecrets(
      ["INTERNAL_EDGE_SECRET"],
      { INTERNAL_EDGE_SECRET: "the-primes-signing-secret" },
      gen,
    );
    expect(toWrite).toEqual([{ name: "INTERNAL_EDGE_SECRET", value: "GENERATED" }]);
    expect(results.get("INTERNAL_EDGE_SECRET")?.status).toBe("generated");
  });

  it("gives each identity secret its own value", () => {
    let n = 0;
    const { toWrite } = planCloneSecrets(
      ["INTERNAL_EDGE_SECRET", "CSRF_TOKEN_PEPPER"],
      {},
      () => `v${n++}`,
    );
    expect(new Set(toWrite.map((s) => s.value)).size).toBe(2);
  });

  it("inherits vendor credentials", () => {
    const { toWrite, results } = planCloneSecrets(
      ["ANTHROPIC_API_KEY"],
      { ANTHROPIC_API_KEY: "sk-ant-x" },
      gen,
    );
    expect(toWrite).toEqual([{ name: "ANTHROPIC_API_KEY", value: "sk-ant-x" }]);
    expect(results.get("ANTHROPIC_API_KEY")?.status).toBe("inherited");
  });

  it("reports a vendor credential with no value as missing rather than inventing one", () => {
    const { toWrite, results } = planCloneSecrets(["DOMAIN_API_KEY"], {}, gen);
    expect(toWrite).toHaveLength(0);
    expect(results.get("DOMAIN_API_KEY")?.status).toBe("missing");
  });

  it("does not carry the prime's own origins across", () => {
    const { toWrite, results } = planCloneSecrets(
      ["ALLOWED_ORIGINS"],
      { ALLOWED_ORIGINS: "https://prime.example" },
      gen,
    );
    expect(toWrite).toHaveLength(0);
    expect(results.get("ALLOWED_ORIGINS")?.status).toBe("skipped_deployment_config");
  });

  it("refuses a platform name even if one reaches it", () => {
    const { toWrite, results } = planCloneSecrets(
      ["SUPABASE_SERVICE_ROLE_KEY"],
      { SUPABASE_SERVICE_ROLE_KEY: "prime-service-role" },
      gen,
    );
    expect(toWrite).toHaveLength(0);
    expect(results.get("SUPABASE_SERVICE_ROLE_KEY")?.status).toBe("skipped_platform");
  });

  it("returns a result for every name it was given", () => {
    const names = ["INTERNAL_EDGE_SECRET", "ANTHROPIC_API_KEY", "ALLOWED_ORIGINS", "NOPE"];
    const { results } = planCloneSecrets(names, { ANTHROPIC_API_KEY: "x" }, gen);
    for (const n of names) expect(results.get(n)).toBeDefined();
  });

  // ── ALLOWED_ORIGINS is derived, not skipped, when we know the clone's hosts ──
  //
  // Skipping it was only half right. The prime's value must not be copied, but
  // leaving the secret unset makes the prime's edge functions fall back to a
  // hard-coded pair of the PRIME's hostnames — so a clone answered its own
  // login request with `access-control-allow-origin:
  // https://command-centre.npcservices.com.au` and the browser refused the
  // response. Correct credentials, healthy account, no server-side error.

  it("writes THIS clone's origins rather than leaving the secret unset", () => {
    const { toWrite, results } = planCloneSecrets(
      ["ALLOWED_ORIGINS"],
      { ALLOWED_ORIGINS: "https://command-centre.npcservices.com.au" },
      gen,
      {
        siteUrl: "https://npc.aurixasystems.com.au",
        additionalRedirectUrls: ["https://npc-client-dashboard.vercel.app"],
      },
    );
    expect(results.get("ALLOWED_ORIGINS")?.status).toBe("derived");
    expect(toWrite).toEqual([
      {
        name: "ALLOWED_ORIGINS",
        value: "https://npc.aurixasystems.com.au,https://npc-client-dashboard.vercel.app",
      },
    ]);
  });

  it("never lets the prime's value reach the clone, origins or no origins", () => {
    const primeValue = "https://command-centre.npcservices.com.au";
    for (const origins of [
      null,
      { siteUrl: "https://clone.example" },
      { siteUrl: null, additionalRedirectUrls: [] },
    ]) {
      const { toWrite } = planCloneSecrets(
        ["ALLOWED_ORIGINS"],
        { ALLOWED_ORIGINS: primeValue },
        gen,
        origins,
      );
      expect(toWrite.some((s) => s.value.includes(primeValue))).toBe(false);
    }
  });

  it("still skips when nothing usable can be derived", () => {
    // Unset beats a guess: the operator fills it in from the clone page.
    const { toWrite, results } = planCloneSecrets(["ALLOWED_ORIGINS"], {}, gen, {
      siteUrl: "localhost",
      additionalRedirectUrls: ["", null, undefined],
    });
    expect(toWrite).toHaveLength(0);
    expect(results.get("ALLOWED_ORIGINS")?.status).toBe("skipped_deployment_config");
  });

  it("leaves every other deployment_config name alone", () => {
    // Guessing a webhook URL or a sender address is how a clone starts writing
    // into somebody else's account. Only names in DERIVED_DEPLOYMENT_CONFIG.
    const { results } = planCloneSecrets(["CORS_STRICT_ALLOWED_ORIGINS"], {}, gen, {
      siteUrl: "https://clone.example",
    });
    expect(results.get("CORS_STRICT_ALLOWED_ORIGINS")?.status).toBe("skipped_deployment_config");
  });
});

describe("cloneAllowedOrigins", () => {
  it("puts the canonical site first and deduplicates", () => {
    expect(
      cloneAllowedOrigins({
        siteUrl: "https://a.example",
        additionalRedirectUrls: ["https://b.example", "https://a.example"],
      }),
    ).toBe("https://a.example,https://b.example");
  });

  it("normalises a bare host and strips a path", () => {
    expect(cloneAllowedOrigins({ siteUrl: "clone.example/login" })).toBe("https://clone.example");
  });

  it("is null when there is nothing to say", () => {
    expect(cloneAllowedOrigins(null)).toBeNull();
    expect(cloneAllowedOrigins({ siteUrl: "localhost" })).toBeNull();
  });
});
