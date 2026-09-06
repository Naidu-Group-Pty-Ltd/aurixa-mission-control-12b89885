import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { PRIME_PAIR_SPECS, ownedSecretEnvNames } from "./cloneOwnedSecrets.pure";

describe("the prime's own pairs — one module, one resolver, two names", () => {
  // Code only: the header PROSE names the clone resolver to say why it is not used.
  const source = () =>
    readFileSync("src/server/primeSecretPairs.server.ts", "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join("\n");

  it("resolves the prime through resolvePrimeBackendRef and through nothing else", () => {
    const s = source();
    expect(s).toContain("resolvePrimeBackendRef(supabase)");
    // Never the clone resolver (which refuses the prime), never a stored column,
    // never a literal.
    expect(s).not.toMatch(/resolveCloneSecretTarget/);
    expect(s).not.toMatch(/supabase_project_ref/);
    expect(s).not.toMatch(/[a-z]{20}\.supabase\.co/);
  });

  it("hands the writer PRIME_PAIR_SPECS and nothing else, with no prime shape to consult", () => {
    const s = source();
    expect(s).toMatch(/ensureOwnedSecrets\(projectRef, PRIME_PAIR_SPECS, null\)/);
    expect(s).not.toMatch(/OWNED_SECRET_SPECS/);
  });

  it("PRIME_PAIR_SPECS are exactly the two cron pairs", () => {
    expect(ownedSecretEnvNames(PRIME_PAIR_SPECS)).toEqual(["FINANCE_PORTAL_CRON_SECRET", "MARKET_INGESTION_CRON_SECRET"]);
  });

  it("the audit row carries names and reasons, never a value", () => {
    const s = source();
    const audit = s.slice(s.indexOf("await writeAuditLog("), s.indexOf("if (!res.ok) return"));
    expect(audit).not.toMatch(/res\.values|\.value\b/);
    expect(audit).toContain("names: ownedSecretEnvNames(PRIME_PAIR_SPECS)");
  });

  it("is scheduled by a migration", () => {
    const scheduled = readdirSync("supabase/migrations")
      .filter((f) => f.endsWith(".sql"))
      .some((f) => readFileSync(`supabase/migrations/${f}`, "utf8").includes("'prime-secret-pairs'"));
    expect(scheduled).toBe(true);
  });

  it("no other module hands the prime's ref to a secret writer", () => {
    // `ensureOwnedSecrets` is the generic writer; every other caller goes
    // through the clone-only target resolver.
    const callers = readdirSync("src/server")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => readFileSync(`src/server/${f}`, "utf8").includes("ensureOwnedSecrets("))
      .sort();
    expect(callers).toEqual(["cloneOwnedSecrets.server.ts", "primeSecretPairs.server.ts"]);
  });
});
