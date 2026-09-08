import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Asking a clone whether verification actually works.
 *
 * Mission Control can prove its own half — it holds the Didit key — and that
 * is not the question. Four things sit between a clone's edge function and an
 * answer on the brokered route, and only a call made there crosses all four.
 */
const src = readFileSync(new URL("./verificationSelftest.server.ts", import.meta.url), "utf8");
const hook = readFileSync(
  new URL("../routes/hooks.verification-selftest.tsx", import.meta.url),
  "utf8",
);

describe("the self-test asks, and never decides", () => {
  it("writes nothing to the clone and nothing about the clone", () => {
    // A probe is a question asked now. Storing the answer is how a reading
    // goes stale, which is the failure this whole thing replaces.
    //
    // Judged on DATABASE writes rather than on the four words: `.update(` is
    // also how an HMAC is fed, and a guard that cannot tell those apart is
    // one somebody silences.
    const writes = src.match(/supabaseAdmin[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/g) ?? [];
    expect(writes, writes.join(" | ")).toEqual([]);
    // The reads it does make are selects, and they are the only ones.
    expect(src).toContain('.select("id, name")');
  });

  it("goes through the signed webhook, not through aml-verification", () => {
    // `aml-verification` refuses service_role outright — it serves people.
    // One hole in that for a diagnostic is how the boundary stops meaning
    // anything, which is why this asks on the channel that already exists.
    expect(src).toContain('"x-mc-signature"');
    expect(src).toContain('"verification.selftest"');
    // The only URL it posts to is the endpoint row's — never a slug this
    // module composes, which is what would let it reach any other function.
    expect(src).toContain("await fetch(endpoint.url, {");
    expect(src).not.toMatch(/functions\/v1\/[a-z-]+/);
  });

  it("sends a fresh idempotency key every time", () => {
    // A stable key would be a request to be told what the last answer was,
    // which is not the question.
    expect(src).toContain('"x-mc-idempotency-key": randomUUID()');
  });

  it("keeps the reasons a probe could not be run apart from a bad reading", () => {
    // "This clone has no Mission Control link", "its backend predates the
    // probe" and "the vendor rejected the credential" send somebody to three
    // different places. Collapsing them into one failure is how an operator
    // is sent to check Didit over a webhook endpoint that was never created.
    for (const reason of ["no_link", "no_probe_in_answer", "unreachable", "unknown_clone"]) {
      expect(src, reason).toContain(`"${reason}"`);
    }
  });

  it("never reports a failed READ as an absent clone", () => {
    expect(src).toContain('reason: "unreadable"');
  });

  it("answers 200 with the readings, so one unreachable clone hides no others", () => {
    expect(hook).toContain("success: true, results");
  });

  it("is behind the cron secret, like every other operator lever here", () => {
    expect(hook).toContain("verifyCronAuth(request)");
  });
});
