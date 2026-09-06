import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  planSigningPair,
  decideSigningPairRepair,
  MIN_SIGNING_SECRET_LENGTH,
  SIGNING_PAIR_REPAIR_COOLDOWN_MS,
  ENV_INTERNAL_EDGE_SECRET,
  VAULT_INTERNAL_EDGE_SECRET,
  type SigningPairFacts,
} from "./signingPair.pure";

const NOW = Date.parse("2026-09-06T05:00:00.000Z");
const HELD = "a".repeat(64);
const gen = () => "b".repeat(64);

const facts = (over: Partial<SigningPairFacts> = {}): SigningPairFacts => ({
  vaultInternalEdgeSecret: null,
  vaultServiceRoleKeyMatches: null,
  ...over,
});

describe("planSigningPair — one value, both sides", () => {
  it("reuses a usable vault value and re-asserts the environment with it", () => {
    // The vault is the only side that can be read, so it decides. A repair
    // must never rotate a pair that already agrees.
    const plan = planSigningPair(facts({ vaultInternalEdgeSecret: HELD }), gen);
    expect(plan.value).toBe(HELD);
    expect(plan.source).toBe("vault");
    expect(plan.writeVaultSecret).toBe(false);
    expect(plan.writeEnv).toBe(true);
  });

  it("mints when the vault holds nothing, and writes the vault", () => {
    const plan = planSigningPair(facts(), gen);
    expect(plan.value).toBe("b".repeat(64));
    expect(plan.source).toBe("minted");
    expect(plan.writeVaultSecret).toBe(true);
    expect(plan.writeEnv).toBe(true);
  });

  it("treats a vault value below the verifier's floor as absent", () => {
    // `auth_v2.ts` ignores a key shorter than 16 and the signer raises on one:
    // reusing it would write a pair that both sides refuse.
    const short = "x".repeat(MIN_SIGNING_SECRET_LENGTH - 1);
    const plan = planSigningPair(facts({ vaultInternalEdgeSecret: short }), gen);
    expect(plan.source).toBe("minted");
    expect(plan.writeVaultSecret).toBe(true);
    expect(plan.value).not.toBe(short);
  });

  it("accepts a vault value exactly at the floor", () => {
    const atFloor = "y".repeat(MIN_SIGNING_SECRET_LENGTH);
    const plan = planSigningPair(facts({ vaultInternalEdgeSecret: atFloor }), gen);
    expect(plan.source).toBe("vault");
    expect(plan.value).toBe(atFloor);
  });

  it("refuses a generator that cannot meet the floor", () => {
    // Writing a too-short pair and stamping the ledger `set` is worse than
    // writing nothing.
    expect(() => planSigningPair(facts(), () => "short")).toThrow(/at least 16/);
  });

  it("writes the service-role key unless the vault already holds the same one", () => {
    expect(planSigningPair(facts({ vaultServiceRoleKeyMatches: true }), gen).writeVaultServiceKey).toBe(false);
    expect(planSigningPair(facts({ vaultServiceRoleKeyMatches: false }), gen).writeVaultServiceKey).toBe(true);
    expect(planSigningPair(facts({ vaultServiceRoleKeyMatches: null }), gen).writeVaultServiceKey).toBe(true);
  });

  it("never puts the value in the reason line", () => {
    for (const f of [facts(), facts({ vaultInternalEdgeSecret: HELD })]) {
      const plan = planSigningPair(f, gen);
      expect(plan.why).not.toContain(plan.value);
      expect(plan.why).not.toContain(HELD);
    }
  });
});

describe("decideSigningPairRepair", () => {
  const base = { projectRef: "plisdzywzleljorrphxv", ledgerStatus: null, lastError: null, updatedAt: null, now: NOW };

  it("skips a clone with no backend rather than treating it as broken", () => {
    expect(decideSigningPairRepair({ ...base, projectRef: null })).toEqual({ act: false, reason: "no_backend" });
  });

  it("STILL acts on a ledger that says set", () => {
    // `set` was being written by the generic generator for a value the vault
    // never received, so on the fleet as it stands `set` is exactly the state
    // that needs repairing. The pair step is what makes this cheap: one vault
    // read, no write when both halves already agree.
    expect(decideSigningPairRepair({ ...base, ledgerStatus: "set" }).act).toBe(true);
  });

  it("cools off after a failed attempt, then retries", () => {
    const recent = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(
      decideSigningPairRepair({ ...base, ledgerStatus: "failed", lastError: "x", updatedAt: recent }),
    ).toEqual({ act: false, reason: "cooling_off" });
    const old = new Date(NOW - SIGNING_PAIR_REPAIR_COOLDOWN_MS - 1000).toISOString();
    expect(
      decideSigningPairRepair({ ...base, ledgerStatus: "failed", lastError: "x", updatedAt: old }).act,
    ).toBe(true);
  });

  it("does not let a stale error on a non-failed row block the repair", () => {
    // Only a `failed` row starts a cool-off; an error stamped beside a `set`
    // row is history, not a standing refusal.
    const recent = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(
      decideSigningPairRepair({ ...base, ledgerStatus: "set", lastError: "x", updatedAt: recent }).act,
    ).toBe(true);
  });
});

describe("the pair is written by one hand, vault first, and never logged", () => {
  const provisioning = () => readFileSync("src/server/backend-provisioning.server.ts", "utf8");
  const server = () => readFileSync("src/server/cloneSigningPair.server.ts", "utf8");

  it("the generic generator honours a decided identity value instead of minting over it", () => {
    const s = provisioning();
    const at = s.indexOf('if (kind === "identity") {');
    expect(at).toBeGreaterThan(-1);
    const branch = s.slice(at, s.indexOf('if (kind === "tenant_scoped")', at));
    expect(branch).toMatch(/const decided = selfValues\?\.\[name\]/);
    // Decided first, generated only otherwise — in that order.
    expect(branch.indexOf("value: decided")).toBeLessThan(branch.indexOf("value: generate()"));
  });

  it("provisioning runs the pair step BEFORE the secrets batch and feeds it the value", () => {
    const s = provisioning();
    const pair = s.indexOf('pauseIfDue("writing the internal signing pair")');
    const batch = s.indexOf('pauseIfDue("syncing secrets")');
    expect(pair).toBeGreaterThan(-1);
    expect(batch).toBeGreaterThan(pair);
    const between = s.slice(pair, s.indexOf("// Step 7:", batch));
    expect(between).toContain("ensureCloneSigningPair(projectRef, serviceRoleKey)");
    expect(between).toMatch(/INTERNAL_EDGE_SECRET: signingPairValue/);
  });

  it("the pipeline reports the reason and never the value", () => {
    const s = provisioning();
    const at = s.indexOf('pauseIfDue("writing the internal signing pair")');
    const block = s.slice(at, s.indexOf('pauseIfDue("syncing secrets")', at));
    expect(block).toContain("signingPair.why");
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*signingPairValue/);
    expect(block).not.toMatch(/onStatusUpdate\?\.\([^)]*pair\.value/);
  });

  it("the server step writes the vault before the environment", () => {
    const s = server();
    const vault = s.indexOf("do $pair$ begin");
    const env = s.indexOf("setCloneSecretValues(projectRef, [");
    expect(vault).toBeGreaterThan(-1);
    expect(env).toBeGreaterThan(vault);
  });

  it("the server step reads and writes ONE ref, resolved through the clone-only resolver", () => {
    const s = server();
    expect(s).toContain("resolveCloneSecretTarget(supabase, cloneId)");
    expect(s).toContain("const projectRef = target.projectRef;");
    // The service-role key is read from that same project — never from a
    // stored column and never from the prime.
    expect(s).toMatch(/selectProjectKeys\(await getProjectApiKeys\(projectRef\)\)\.serviceRoleKey/);
  });

  it("the value never reaches an event row, a log line or the recorded outcome", () => {
    const s = server();
    // Code only — the comment above the insert SAYS "carries no value", which
    // is the rule, not a breach of it.
    const event = s
      .slice(s.indexOf("async function recordEvent"), s.indexOf("export type SigningPairReconcileResult"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(event).not.toMatch(/\bvalue\b/i);
    for (const line of s.split("\n").filter((l) => /console\.(error|warn|log)/.test(l))) {
      expect(line).not.toMatch(/plan\.value|res\.value|pair\.value|serviceRoleKey/);
    }
    const outcome = s.slice(s.indexOf("export type SigningPairOutcome"), s.indexOf("export type EnsureSigningPairResult"));
    expect(outcome).not.toMatch(/value: string/);
  });

  it("the names are the prime's contract, on both sides", () => {
    // `cron_signed_internal_headers` reads `internal_edge_secret`;
    // `auth_v2.ts` reads `INTERNAL_EDGE_SECRET`. Renaming either half is how
    // a working pair silently stops working.
    expect(VAULT_INTERNAL_EDGE_SECRET).toBe("internal_edge_secret");
    expect(ENV_INTERNAL_EDGE_SECRET).toBe("INTERNAL_EDGE_SECRET");
  });

  it("the reconcile hook is scheduled by a migration", () => {
    const scheduled = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .some((f) => readFileSync(`supabase/migrations/${f}`, "utf8").includes("'clone-signing-pair-reconcile'"));
    expect(scheduled).toBe(true);
  });
});
