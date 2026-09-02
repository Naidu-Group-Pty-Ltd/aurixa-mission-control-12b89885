import { describe, expect, it } from "vitest";
import {
  CI_DB_URL_SECRET,
  SESSION_POOLER_PORT,
  composeSessionPoolerUrl,
  describeCredentialSweep,
  emptyCredentialSweep,
  recordOutcome,
  sweepIsNoteworthy,
} from "./cloneCiCredential.pure";

const REF = "plisdzywzleljorrphxv";
const POOLER = {
  host: "aws-1-ap-southeast-2.pooler.supabase.com",
  user: `postgres.${REF}`,
  port: 5432,
};

describe("composing a clone's database URL", () => {
  it("uses the session port and requires TLS", () => {
    const r = composeSessionPoolerUrl({ projectRef: REF, password: "s3cret", pooler: POOLER });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe(
      `postgresql://postgres.${REF}:s3cret@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=require`,
    );
    expect(SESSION_POOLER_PORT).toBe(5432);
  });

  it("escapes a password that would otherwise break the URL", () => {
    const r = composeSessionPoolerUrl({
      projectRef: REF,
      password: "p@ss/w:rd?#&=+ ",
      pooler: POOLER,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Every reserved character is encoded, so the host is still the host.
    expect(r.url).toContain("p%40ss%2Fw%3Ard%3F%23%26%3D%2B%20@aws-1-");
    expect(new URL(r.url).hostname).toBe("aws-1-ap-southeast-2.pooler.supabase.com");
  });

  it("REFUSES a pooler user that belongs to another project", () => {
    // The one mistake that would matter: handing a tenant's CI a connection
    // string for somebody else's database.
    const r = composeSessionPoolerUrl({
      projectRef: REF,
      password: "s3cret",
      pooler: { ...POOLER, user: "postgres.dduzbchuswwbefdunfct" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("refusing to hand a clone another database");
  });

  it("refuses transaction mode", () => {
    const r = composeSessionPoolerUrl({
      projectRef: REF,
      password: "s3cret",
      pooler: { ...POOLER, port: 6543 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("6543");
  });

  it("never composes half a URL", () => {
    for (const pooler of [
      { ...POOLER, host: null },
      { ...POOLER, host: "  " },
      { ...POOLER, user: null },
    ]) {
      const r = composeSessionPoolerUrl({ projectRef: REF, password: "s3cret", pooler });
      expect(r.ok).toBe(false);
    }
    expect(composeSessionPoolerUrl({ projectRef: REF, password: null, pooler: POOLER }).ok).toBe(
      false,
    );
    expect(
      composeSessionPoolerUrl({ projectRef: "not-a-ref", password: "s3cret", pooler: POOLER }).ok,
    ).toBe(false);
  });

  it("names the secret the workflow reads", () => {
    expect(CI_DB_URL_SECRET).toBe("SUPABASE_DB_URL");
  });
});

describe("the sweep", () => {
  it("settles quietly once every repository has it", () => {
    const sweep = emptyCredentialSweep();
    recordOutcome(sweep, { repo: "o/a", state: "no_backend" });
    expect(sweepIsNoteworthy(sweep)).toBe(false);
    recordOutcome(sweep, { repo: "o/b", state: "distributed" });
    expect(sweepIsNoteworthy(sweep)).toBe(true);
  });

  it("counts a refusal separately from a failure", () => {
    const sweep = emptyCredentialSweep();
    recordOutcome(sweep, { repo: "o/a", state: "cannot", reason: "no password" });
    recordOutcome(sweep, { repo: "o/b", state: "failed", reason: "403" });
    expect(sweep.cannot).toHaveLength(1);
    expect(sweep.failed).toHaveLength(1);
    expect(describeCredentialSweep(sweep)).toBe(
      "2 considered · 1 could not be composed · 1 failed.",
    );
  });

  it("says nothing about an empty fleet beyond that it is empty", () => {
    expect(describeCredentialSweep(emptyCredentialSweep())).toBe(
      "No clone repositories to consider.",
    );
  });
});
