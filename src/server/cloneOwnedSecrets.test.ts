import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  OWNED_SECRET_SPECS,
  PRIME_PAIR_SPECS,
  MIN_OWNED_SECRET_LENGTH,
  OWNED_SECRETS_REPAIR_COOLDOWN_MS,
  planOwnedSecrets,
  decideOwnedSecretsRepair,
  isVapidPublicKey,
  isVapidPrivateKey,
  ownedSecretEnvNames,
  ownedSecretVaultNames,
  ownedSecretGucNames,
  type OwnedSecretFacts,
  type PrimeShape,
} from "./cloneOwnedSecrets.pure";

const NOW = Date.parse("2026-09-06T06:00:00.000Z");
const PUB = "B" + "a".repeat(86);
const PRIV = "b".repeat(43);
const mint = {
  random: (bytes: number) => "r".repeat(bytes * 2),
  vapid: () => ({ publicKey: "B" + "m".repeat(86), privateKey: "n".repeat(43) }),
};
const shape = (over: Partial<PrimeShape> = {}): PrimeShape => ({
  vaultNames: new Set(["internal_edge_secret", "supabase_service_role_key", "supabase_url"]),
  gucNames: new Set(["app.settings.jwt_exp"]),
  ...over,
});
const facts = (over: Partial<OwnedSecretFacts> = {}): OwnedSecretFacts => ({
  vault: {},
  guc: {},
  primeShape: shape(),
  ...over,
});
const write = (plan: ReturnType<typeof planOwnedSecrets>, env: string) =>
  plan.writes.find((w) => w.env === env);

describe("the specs name the prime's contract", () => {
  it("a clone owns the pepper that throws, the CSRF pepper, the VAPID pair and the two cron pairs", () => {
    expect(ownedSecretEnvNames()).toEqual([
      "RESET_TOKEN_PEPPER",
      "CSRF_TOKEN_PEPPER",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "FINANCE_PORTAL_CRON_SECRET",
      "MARKET_INGESTION_CRON_SECRET",
    ]);
    // The finance function's older schedule read exactly this vault name; the
    // market jobs read exactly this setting.
    expect(ownedSecretVaultNames()).toContain("finance_portal_cron_secret");
    expect(ownedSecretGucNames()).toEqual(["app.market_ingestion_cron_secret"]);
  });

  it("the prime is paired with the two cron pairs and nothing else, ungated", () => {
    expect(ownedSecretEnvNames(PRIME_PAIR_SPECS)).toEqual(["FINANCE_PORTAL_CRON_SECRET", "MARKET_INGESTION_CRON_SECRET"]);
    for (const spec of PRIME_PAIR_SPECS) {
      expect(spec.kind).toBe("random");
      expect((spec as { requiresPrime?: true }).requiresPrime).toBeUndefined();
    }
    // The prime's peppers and push identity are the owner's, not the engine's.
    expect(ownedSecretVaultNames(PRIME_PAIR_SPECS)).toEqual(["finance_portal_cron_secret"]);
  });

  it("the clone's copies of the two pairs ARE gated on the prime", () => {
    for (const spec of OWNED_SECRET_SPECS) {
      if (spec.kind === "random" && /CRON/.test(spec.env)) expect(spec.requiresPrime).toBe(true);
    }
  });

  it("every random floor is the consumers' floor", () => {
    for (const spec of [...OWNED_SECRET_SPECS, ...PRIME_PAIR_SPECS]) {
      if (spec.kind === "random") expect(spec.floor).toBeGreaterThanOrEqual(MIN_OWNED_SECRET_LENGTH);
    }
  });
});

describe("planOwnedSecrets — minted once, mirrored, re-asserted", () => {
  it("reuses a usable vault value and re-asserts the environment with it", () => {
    const plan = planOwnedSecrets(OWNED_SECRET_SPECS, facts({ vault: { reset_token_pepper: "p".repeat(40) } }), mint);
    const w = write(plan, "RESET_TOKEN_PEPPER");
    expect(w?.value).toBe("p".repeat(40));
    expect(w?.source).toBe("mirror");
    expect(w?.store).toBe("vault");
  });

  it("mints when the vault holds nothing", () => {
    const plan = planOwnedSecrets(OWNED_SECRET_SPECS, facts(), mint);
    const w = write(plan, "RESET_TOKEN_PEPPER");
    expect(w?.source).toBe("minted");
    expect(w?.value.length).toBe(64);
  });

  it("treats a mirrored value below the consumer's floor as absent", () => {
    // `resetTokens.ts` throws under 16 characters; reusing it would write a
    // pepper the consumer refuses and stamp the ledger `set`.
    const plan = planOwnedSecrets(OWNED_SECRET_SPECS, facts({ vault: { reset_token_pepper: "short" } }), mint);
    expect(write(plan, "RESET_TOKEN_PEPPER")?.source).toBe("minted");
  });

  it("refuses a generator that cannot meet the floor", () => {
    expect(() => planOwnedSecrets(OWNED_SECRET_SPECS, facts(), { ...mint, random: () => "x" })).toThrow(/at least/);
  });

  it("reuses a well-formed VAPID pair as a pair", () => {
    const plan = planOwnedSecrets(
      OWNED_SECRET_SPECS,
      facts({ vault: { vapid_public_key: PUB, vapid_private_key: PRIV } }),
      mint,
    );
    expect(write(plan, "VAPID_PUBLIC_KEY")?.value).toBe(PUB);
    expect(write(plan, "VAPID_PRIVATE_KEY")?.value).toBe(PRIV);
    expect(write(plan, "VAPID_PUBLIC_KEY")?.source).toBe("mirror");
  });

  it("re-mints the WHOLE pair when either half is missing or malformed", () => {
    // A public key without its private half signs nothing; a private key
    // whose public half nobody holds delivers to nobody.
    const halves: Record<string, string | null>[] = [
      { vapid_public_key: PUB },
      { vapid_private_key: PRIV },
      { vapid_public_key: "not-a-key", vapid_private_key: PRIV },
      { vapid_public_key: PUB, vapid_private_key: "short" },
    ];
    for (const vault of halves) {
      const plan = planOwnedSecrets(OWNED_SECRET_SPECS, facts({ vault }), mint);
      expect(write(plan, "VAPID_PUBLIC_KEY")?.source).toBe("minted");
      expect(write(plan, "VAPID_PRIVATE_KEY")?.source).toBe("minted");
      expect(write(plan, "VAPID_PUBLIC_KEY")?.value).toBe("B" + "m".repeat(86));
    }
  });

  it("refuses a VAPID generator that produces a malformed pair", () => {
    // web-push throws at setVapidDetails on a malformed key, failing every
    // push rather than none.
    expect(() =>
      planOwnedSecrets(OWNED_SECRET_SPECS, facts(), { ...mint, vapid: () => ({ publicKey: "x", privateKey: "y" }) }),
    ).toThrow(/malformed/);
  });

  it("pairs the finance secret only where the prime's vault holds it", () => {
    const without = planOwnedSecrets(OWNED_SECRET_SPECS, facts(), mint);
    expect(write(without, "FINANCE_PORTAL_CRON_SECRET")).toBeUndefined();
    expect(without.skipped).toContainEqual({
      env: "FINANCE_PORTAL_CRON_SECRET",
      store: "vault",
      key: "finance_portal_cron_secret",
      reason: "prime_holds_none",
    });

    const withIt = planOwnedSecrets(
      OWNED_SECRET_SPECS,
      facts({ primeShape: shape({ vaultNames: new Set(["finance_portal_cron_secret"]) }) }),
      mint,
    );
    expect(write(withIt, "FINANCE_PORTAL_CRON_SECRET")?.source).toBe("minted");
    expect(withIt.skipped.map((s) => s.env)).not.toContain("FINANCE_PORTAL_CRON_SECRET");
  });

  it("pairs the market secret only where the prime holds the database setting, and mirrors it as a setting", () => {
    const without = planOwnedSecrets(OWNED_SECRET_SPECS, facts(), mint);
    expect(write(without, "MARKET_INGESTION_CRON_SECRET")).toBeUndefined();
    expect(without.skipped).toContainEqual({
      env: "MARKET_INGESTION_CRON_SECRET",
      store: "guc",
      key: "app.market_ingestion_cron_secret",
      reason: "prime_holds_none",
    });

    const withIt = planOwnedSecrets(
      OWNED_SECRET_SPECS,
      facts({ primeShape: shape({ gucNames: new Set(["app.market_ingestion_cron_secret"]) }) }),
      mint,
    );
    const w = write(withIt, "MARKET_INGESTION_CRON_SECRET");
    expect(w?.source).toBe("minted");
    expect(w?.store).toBe("guc");
    expect(w?.key).toBe("app.market_ingestion_cron_secret");

    // And a clone whose setting is already there reuses it — never the prime's value.
    const held = planOwnedSecrets(
      OWNED_SECRET_SPECS,
      facts({
        guc: { "app.market_ingestion_cron_secret": "m".repeat(64) },
        primeShape: shape({ gucNames: new Set(["app.market_ingestion_cron_secret"]) }),
      }),
      mint,
    );
    expect(write(held, "MARKET_INGESTION_CRON_SECRET")).toMatchObject({ source: "mirror", value: "m".repeat(64) });
  });

  it("the prime's own list needs no prime shape and mints both pairs", () => {
    const plan = planOwnedSecrets(PRIME_PAIR_SPECS, facts({ primeShape: null }), mint);
    expect(plan.skipped).toEqual([]);
    expect(plan.writes.map((w) => [w.env, w.store, w.source])).toEqual([
      ["FINANCE_PORTAL_CRON_SECRET", "vault", "minted"],
      ["MARKET_INGESTION_CRON_SECRET", "guc", "minted"],
    ]);
  });

  it("an unreadable prime is unknown, never none", () => {
    // Inventing a pair because the probe failed is the confident answer
    // against nothing this platform has shipped before.
    const plan = planOwnedSecrets(OWNED_SECRET_SPECS, facts({ primeShape: null }), mint);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["prime_unreadable", "prime_unreadable"]);
    // The specs that need no prime are still written.
    expect(write(plan, "RESET_TOKEN_PEPPER")).toBeDefined();
    expect(write(plan, "VAPID_PUBLIC_KEY")).toBeDefined();
  });

  it("never puts a value in the reason lines", () => {
    const plan = planOwnedSecrets(
      [...OWNED_SECRET_SPECS, ...PRIME_PAIR_SPECS],
      facts({
        vault: { reset_token_pepper: "p".repeat(40), vapid_public_key: PUB, vapid_private_key: PRIV },
        guc: { "app.market_ingestion_cron_secret": "m".repeat(64) },
      }),
      mint,
    );
    for (const w of plan.writes) for (const line of plan.why) expect(line).not.toContain(w.value);
  });
});

describe("VAPID key shape", () => {
  it("recognises the 65-byte uncompressed point and the 32-byte scalar", () => {
    expect(isVapidPublicKey(PUB)).toBe(true);
    expect(isVapidPrivateKey(PRIV)).toBe(true);
    expect(isVapidPublicKey("A" + "a".repeat(86))).toBe(false); // not 0x04-led
    expect(isVapidPublicKey("B" + "a".repeat(85))).toBe(false);
    expect(isVapidPrivateKey("b".repeat(44))).toBe(false);
    expect(isVapidPublicKey(null)).toBe(false);
  });

  it("the server mints a pair the shape check accepts", async () => {
    const { mintVapidKeyPair } = await import("./cloneOwnedSecrets.server");
    const pair = mintVapidKeyPair();
    expect(isVapidPublicKey(pair.publicKey)).toBe(true);
    expect(isVapidPrivateKey(pair.privateKey)).toBe(true);
    // Decoded, the public key is the uncompressed point web-push expects.
    const pub = Buffer.from(pair.publicKey, "base64url");
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(Buffer.from(pair.privateKey, "base64url").length).toBe(32);
    expect(mintVapidKeyPair().publicKey).not.toBe(pair.publicKey);
  });
});

describe("decideOwnedSecretsRepair", () => {
  const base = { projectRef: "plisdzywzleljorrphxv", ledger: [], now: NOW };

  it("skips a clone with no backend", () => {
    expect(decideOwnedSecretsRepair({ ...base, projectRef: null })).toEqual({ act: false, reason: "no_backend" });
  });

  it("STILL acts on a ledger that says set", () => {
    expect(decideOwnedSecretsRepair({ ...base, ledger: [{ status: "set", lastError: null, updatedAt: null }] }).act).toBe(true);
  });

  it("cools off after a recent failure on ANY of its names, then retries", () => {
    const recent = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(
      decideOwnedSecretsRepair({
        ...base,
        ledger: [
          { status: "set", lastError: null, updatedAt: recent },
          { status: "failed", lastError: "x", updatedAt: recent },
        ],
      }),
    ).toEqual({ act: false, reason: "cooling_off" });
    const old = new Date(NOW - OWNED_SECRETS_REPAIR_COOLDOWN_MS - 1000).toISOString();
    expect(decideOwnedSecretsRepair({ ...base, ledger: [{ status: "failed", lastError: "x", updatedAt: old }] }).act).toBe(true);
  });
});

describe("the step is written mirror first, fed to the batch, and never logged", () => {
  const provisioning = () => readFileSync("src/server/backend-provisioning.server.ts", "utf8");
  const server = () => readFileSync("src/server/cloneOwnedSecrets.server.ts", "utf8");

  it("provisioning runs the owned-secrets and link steps AFTER the pair and BEFORE the batch, and feeds their values in", () => {
    const s = provisioning();
    const pair = s.indexOf('pauseIfDue("writing the internal signing pair")');
    const owned = s.indexOf('pauseIfDue("writing clone-owned secrets")');
    const link = s.indexOf('pauseIfDue("linking to Mission Control")');
    const batch = s.indexOf('pauseIfDue("syncing secrets")');
    expect(pair).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(pair);
    expect(link).toBeGreaterThan(owned);
    expect(batch).toBeGreaterThan(link);
    const between = s.slice(batch, s.indexOf("// Step 7:", batch));
    expect(between).toContain("...ownedValues,");
    expect(between).toContain("...linkValues,");
    // The batch is told the clone's name and what other steps settled.
    expect(between).toMatch(/displayName: input\.cloneName/);
    expect(between).toMatch(/settled: new Map\(Object\.entries\(input\.settledSecrets \?\? \{\}\)\)/);
    // The prime is consulted for its SHAPE, through the one probe.
    expect(s).toMatch(/ensureCloneOwnedSecrets\(projectRef, await readPrimeShape\(input\.primeBackendRef\)\)/);
  });

  it("the pipeline reports names and counts, never a value", () => {
    const s = provisioning();
    const block = s.slice(
      s.indexOf('pauseIfDue("writing clone-owned secrets")'),
      s.indexOf('pauseIfDue("syncing secrets")'),
    );
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*owned\.values/);
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*link\.values/);
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*ownedValues/);
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*linkValues/);
  });

  it("the server step writes the mirror before the environment, and only what was minted", () => {
    const s = server();
    const mirror = s.indexOf("do $owned$ begin");
    const env = s.indexOf("setCloneSecretValues(");
    expect(mirror).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(mirror);
    expect(s).toMatch(/const minted = plan\.writes\.filter\(\(w\) => w\.source === "minted"\)/);
  });

  it("a database setting is written at the level the cron reads it, and read back from the same place", () => {
    const s = server();
    // Database-wide where this role owns the database, on the role otherwise —
    // and the settings read covers both.
    expect(s).toMatch(/alter database %I set \$\{name\} = %L/);
    expect(s).toMatch(/alter role %I set \$\{name\} = %L/);
    expect(s).toMatch(/s\.setrole = 0 or s\.setrole = \(select oid from pg_roles where rolname = current_user\)/);
    // Only a lower-case dotted name may ever be inlined.
    expect(s).toMatch(/GUC_NAME_RX = \/\^\[a-z_\]\[a-z0-9_\]\*\(\\\.\[a-z_\]\[a-z0-9_\]\*\)\+\$\//);
  });

  it("the prime is read for NAMES only", () => {
    const s = server();
    const probe = s.slice(s.indexOf("export async function readPrimeShape"), s.indexOf("/** What is recorded and reported."));
    expect(probe).toContain("select 'vault' as store, name from vault.secrets");
    expect(probe).not.toMatch(/decrypted_secret/);
    expect(probe).not.toMatch(/value/);
  });

  it("the value never reaches an event row or a log line", () => {
    const s = server();
    const event = s
      .slice(s.indexOf("async function recordEvent"), s.indexOf("export type OwnedSecretsReconcileResult"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(event).not.toMatch(/\bvalues?\b/i);
    for (const line of s.split("\n").filter((l) => /console\.(error|warn|log)/.test(l))) {
      expect(line).not.toMatch(/\.value|values|plan\.writes/);
    }
    const outcome = s.slice(s.indexOf("export type OwnedSecretsOutcome"), s.indexOf("export type EnsureOwnedSecretsResult"));
    expect(outcome).not.toMatch(/value/);
  });

  it("the reconcile hook is scheduled by a migration that also records key delivery", () => {
    const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    const sources = files.map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"));
    expect(sources.some((s) => s.includes("'clone-secrets-reconcile'"))).toBe(true);
    expect(sources.some((s) => /delivered_project_ref/.test(s) && /delivered_env_at/.test(s))).toBe(true);
  });
});
