import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideJwtSecretRepair,
  JWT_REPAIR_COOLDOWN_MS,
  type JwtRepairFacts,
} from "./cloneSecretRepair.pure";

const NOW = Date.parse("2026-08-30T04:00:00.000Z");

const facts = (over: Partial<JwtRepairFacts> = {}): JwtRepairFacts => ({
  projectRef: "plisdzywzleljorrphxv",
  ledgerStatus: "missing",
  lastError: null,
  updatedAt: null,
  now: NOW,
  ...over,
});

describe("decideJwtSecretRepair", () => {
  it("repairs a clone whose ledger says the key is missing", () => {
    expect(decideJwtSecretRepair(facts())).toEqual({ act: true, why: "ledger says missing" });
  });

  it("repairs a clone with no ledger row at all", () => {
    // The fleet as it stands. Provisioning tracked `SUPABASE_JWT_SECRET`, a
    // name the secrets API refuses outright, so clones predating the fix have
    // no row under the settable spelling — absent is as repairable as missing.
    expect(decideJwtSecretRepair(facts({ ledgerStatus: null }))).toEqual({
      act: true,
      why: "no ledger row yet",
    });
  });

  it("skips a clone with no backend rather than treating it as broken", () => {
    // A clone mid-provisioning reaches this legitimately.
    expect(decideJwtSecretRepair(facts({ projectRef: null }))).toEqual({
      act: false,
      reason: "no_backend",
    });
  });

  it("stops once the ledger says set", () => {
    expect(decideJwtSecretRepair(facts({ ledgerStatus: "set" }))).toEqual({
      act: false,
      reason: "already_set",
    });
  });

  it("does NOT treat `inherited` as settled", () => {
    // `inherited` cannot legitimately happen for a tenant-scoped name: it is
    // the status of a value COPIED FROM THE PRIME, which for a signing key is
    // the cross-tenant defect the class exists to stop. Reading it as "already
    // done" would leave that row standing and silent.
    expect(decideJwtSecretRepair(facts({ ledgerStatus: "inherited" }))).toEqual({
      act: true,
      why: "ledger says inherited",
    });
  });

  it("holds a failed repair for the cooling-off window", () => {
    const v = decideJwtSecretRepair(
      facts({
        ledgerStatus: "failed",
        lastError: "secrets API 403",
        updatedAt: new Date(NOW - 60_000).toISOString(),
      }),
    );
    expect(v).toEqual({ act: false, reason: "cooling_off" });
  });

  it("retries once the window has passed", () => {
    const v = decideJwtSecretRepair(
      facts({
        ledgerStatus: "failed",
        lastError: "secrets API 403",
        updatedAt: new Date(NOW - JWT_REPAIR_COOLDOWN_MS - 1).toISOString(),
      }),
    );
    expect(v).toEqual({ act: true, why: "ledger says failed" });
  });

  it("does not cool off on a status that carries no error", () => {
    // `missing` with a stale `updated_at` and no error is the ordinary state of
    // a clone nobody has repaired yet, not a recent failure.
    expect(
      decideJwtSecretRepair(
        facts({ lastError: null, updatedAt: new Date(NOW - 1000).toISOString() }),
      ),
    ).toEqual({ act: true, why: "ledger says missing" });
  });

  it("acts rather than cools off on an unparseable timestamp", () => {
    // A cooling-off window computed from a date nobody can read would hold the
    // repair forever. Acting is the recoverable side.
    expect(
      decideJwtSecretRepair(
        facts({ ledgerStatus: "failed", lastError: "boom", updatedAt: "not a date" }),
      ),
    ).toEqual({ act: true, why: "ledger says failed" });
  });

  it("acts rather than cools off on a timestamp in the future", () => {
    expect(
      decideJwtSecretRepair(
        facts({
          ledgerStatus: "failed",
          lastError: "boom",
          updatedAt: new Date(NOW + 60_000).toISOString(),
        }),
      ),
    ).toEqual({ act: true, why: "ledger says failed" });
  });
});

// ─── Source contract ─────────────────────────────────────────────────
//
// The rules below cannot be exercised by calling the function: the damage they
// prevent needs a live Management API token, which is exactly the thing a test
// must not hold. So they are asserted against the source.

const src = readFileSync(join(process.cwd(), "src/server/cloneSecretRepair.server.ts"), "utf8");

/**
 * The same source with its comments removed.
 *
 * Every negative assertion below runs against this rather than `src`. This
 * module EXPLAINS the reserved prefix and the key it must never log, so a
 * `not.toContain` over the raw text fails on the paragraph documenting the
 * rule — a guard that reports a contradiction on correct code, which is the
 * kind people learn to silence. `check-cron-coverage.mjs` strips SQL comments
 * for exactly this reason and says so.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//"))
  .join("\n");

describe("the JWT repair's write target", () => {
  it("obtains its project ref ONLY from resolveCloneSecretTarget", () => {
    // The platform token reaches every project this organisation owns —
    // the prime's and Mission Control's own included. The ref is a return
    // value, never an argument. See cloneSecretTarget.pure.ts.
    expect(src).toContain("resolveCloneSecretTarget(supabase, cloneId)");
    expect(code).not.toMatch(/projectRef\s*:\s*string\s*[,)]/);
  });

  it("reads the key from the SAME ref it writes it to", () => {
    // If these two could differ this hands one tenant another tenant's signing
    // key — the cross-tenant defect arrived at from the other direction. One
    // const, both calls.
    expect(src).toContain("const projectRef = target.projectRef;");
    expect(src).toContain("getProjectJwtSecret(projectRef)");
    expect(src).toContain("setCloneSecretValue(projectRef, JWT_SECRET_NAME, secret)");
    // Nothing else may supply a ref to either call.
    const reads = code.match(/getProjectJwtSecret\([^)]*\)/g) ?? [];
    expect(reads).toEqual(["getProjectJwtSecret(projectRef)"]);
  });

  it("writes the settable spelling, never the reserved one", () => {
    // `SUPABASE_` is reserved by the secrets API, so a ledger row under
    // SUPABASE_JWT_SECRET could only ever read `missing`.
    expect(src).toContain('export const JWT_SECRET_NAME = "JWT_SECRET"');
    expect(code).not.toContain("SUPABASE_JWT_SECRET");
  });

  it("never puts the key in a log line, an event row or a return value", () => {
    // A signing key is authority, and a deployment_event is read by more people
    // than can read the project it came from. Not even a prefix.
    expect(code).not.toMatch(/console\.(log|error|warn)\([^)]*\bsecret\b\s*[,)]/);
    expect(code).not.toMatch(/result:\s*\{[^}]*\bsecret\s*[,}]/);
    expect(code).not.toMatch(/\bsecret\.slice\(/);
    expect(code).not.toMatch(/\breturn\b[^;]*\bsecret\b[^;]*;/);
  });

  it("decides from a BULK ledger read before doing any per-clone work", () => {
    // The schedule's comment claims a settled fleet costs two reads a pass and
    // no Management API call at all. That is only true if the sweep decides
    // from facts it already has: resolving a write target is three more
    // queries and reading the key is a Management API call, and neither is
    // worth paying for a clone the ledger already says is done.
    const sweep = code.slice(code.indexOf("export async function reconcileCloneJwtSecrets"));
    expect(sweep).toMatch(/\.in\(\s*"clone_id"/);
    const decidedAt = sweep.indexOf("decideJwtSecretRepair(");
    const repairedAt = sweep.indexOf("repairCloneJwtSecret(");
    expect(decidedAt).toBeGreaterThan(-1);
    expect(repairedAt).toBeGreaterThan(-1);
    expect(decidedAt).toBeLessThan(repairedAt);
  });

  it("throws rather than reporting an empty fleet when a read fails", () => {
    // A candidate list or a ledger that could not be READ is not a fleet that
    // is already correct — on the job whose whole purpose is noticing that it
    // is not.
    const sweep = code.slice(code.indexOf("export async function reconcileCloneJwtSecrets"));
    expect(sweep).toContain("Could not list clone backends");
    expect(sweep).toMatch(/ledgerRes\.error[\s\S]{0,200}throw new Error/);
  });

  it("records a failed read as `failed`, never leaving it `missing`", () => {
    // `missing` and "we tried and could not" are different states, and the
    // cooling-off window is keyed off the second one.
    expect(src).toContain('status: "failed"');
  });
});
