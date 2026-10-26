import { describe, expect, it } from "vitest";
import {
  CI_DB_URL_SECRET,
  CI_ENVIRONMENT,
  CI_SERVICE_ROLE_SECRET,
  SESSION_POOLER_PORT,
  composeSessionPoolerUrl,
  decidePasswordSet,
  describeCredentialSweep,
  emptyCredentialSweep,
  judgeServiceRoleKey,
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

  it("uses the session port on the shared pooler, whatever its default mode", () => {
    // What Supabase reports for every clone (26 Oct 2026): the shared pooler
    // host, with the TRANSACTION port because that is the default mode. The
    // same host serves session mode on 5432, and that is what is composed.
    const r = composeSessionPoolerUrl({
      projectRef: REF,
      password: "s3cret",
      pooler: { ...POOLER, port: 6543 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new URL(r.url).port).toBe("5432");
    expect(r.url).not.toContain("6543");
  });

  it("refuses a non-session port anywhere but the shared pooler", () => {
    const r = composeSessionPoolerUrl({
      projectRef: REF,
      password: "s3cret",
      pooler: { ...POOLER, host: `db.${REF}.supabase.co`, port: 6543 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("6543");
    expect(r.reason).toContain("not the shared pooler");
  });

  it("does not take a look-alike host for the shared pooler", () => {
    for (const host of ["pooler.supabase.com.evil.example", "aws-1.pooler.supabase.com.example"]) {
      const r = composeSessionPoolerUrl({
        projectRef: REF,
        password: "s3cret",
        pooler: { ...POOLER, host, port: 6543 },
      });
      expect(r.ok).toBe(false);
    }
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

/** A JWT with these claims. Unsigned: only the claims are read here. */
const jwt = (claims: Record<string, unknown>): string => {
  const part = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.signature`;
};

describe("the service-role key a clone is given", () => {
  it("is its own, as a JWT naming its own project", () => {
    const key = jwt({ iss: "supabase", ref: REF, role: "service_role" });
    expect(judgeServiceRoleKey({ projectRef: REF, key })).toEqual({ ok: true, key });
  });

  it("REFUSES a key for any other project, the prime's above all", () => {
    const r = judgeServiceRoleKey({
      projectRef: REF,
      key: jwt({ ref: "dduzbchuswwbefdunfct", role: "service_role" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("refusing to hand a clone another project's key");
    expect(r.reason).toContain("dduzbchuswwbefdunfct");
  });

  it("refuses the anon key, which names the project too", () => {
    const r = judgeServiceRoleKey({ projectRef: REF, key: jwt({ ref: REF, role: "anon" }) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('"anon"');
  });

  it("refuses a key that is not a JWT, which the ingest's gateway would refuse", () => {
    const r = judgeServiceRoleKey({ projectRef: REF, key: "sb_secret_abcdefghijklmnopqrstuvwxyz" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("not a JWT");
  });

  it("says when there is none, and when its claims cannot be read", () => {
    expect(judgeServiceRoleKey({ projectRef: REF, key: null }).ok).toBe(false);
    expect(judgeServiceRoleKey({ projectRef: REF, key: "  " }).ok).toBe(false);
    const garbled = judgeServiceRoleKey({ projectRef: REF, key: "a.%%%.c" });
    expect(garbled.ok).toBe(false);
    if (garbled.ok) return;
    expect(garbled.reason).toContain("could not be read");
  });

  it("is written under the name the refreshes read, in the environment they name", () => {
    expect(CI_SERVICE_ROLE_SECRET).toBe("SUPABASE_SERVICE_ROLE_KEY");
    expect(CI_ENVIRONMENT).toBe("supabase-production");
  });
});

describe("giving a clone's database a password", () => {
  const MC = { BACKEND_DEPLOYED_BY: "mission-control" };

  it("never replaces one that is stored", () => {
    expect(decidePasswordSet({ passwordStored: true, variables: MC })).toEqual({
      set: false,
      reason: null,
    });
  });

  it("sets one only where Mission Control operates the backend", () => {
    expect(decidePasswordSet({ passwordStored: false, variables: MC })).toEqual({ set: true });
  });

  it("leaves the owner's database alone when the repository does not say Mission Control", () => {
    const notMissionControl: Record<string, string>[] = [{}, { BACKEND_DEPLOYED_BY: "tenant" }];
    for (const variables of notMissionControl) {
      const d = decidePasswordSet({ passwordStored: false, variables });
      expect(d.set).toBe(false);
      if (d.set) return;
      expect(d.reason).toContain("the password is the owner's");
    }
  });

  it("does not read a failed variable listing as a declaration", () => {
    const d = decidePasswordSet({ passwordStored: false, variables: null });
    expect(d.set).toBe(false);
    if (d.set) return;
    expect(d.reason).toContain("could not be read");
  });
});

describe("the sweep", () => {
  it("settles quietly once every repository has it", () => {
    const sweep = emptyCredentialSweep();
    recordOutcome(sweep, { repo: "o/a", state: "no_backend" });
    recordOutcome(sweep, { repo: "o/b", secret: CI_DB_URL_SECRET, state: "kept" });
    recordOutcome(sweep, { repo: "o/b", secret: CI_SERVICE_ROLE_SECRET, state: "kept" });
    expect(sweepIsNoteworthy(sweep)).toBe(false);
    recordOutcome(sweep, { repo: "o/c", secret: CI_SERVICE_ROLE_SECRET, state: "distributed" });
    expect(sweepIsNoteworthy(sweep)).toBe(true);
    expect(sweep.distributed).toEqual(["o/c SUPABASE_SERVICE_ROLE_KEY"]);
  });

  it("files a password it set", () => {
    const sweep = emptyCredentialSweep();
    sweep.passwordsSet.push("o/a");
    expect(sweepIsNoteworthy(sweep)).toBe(true);
  });

  it("counts a refusal separately from a failure, and names the credential", () => {
    const sweep = emptyCredentialSweep();
    sweep.considered = 2;
    recordOutcome(sweep, {
      repo: "o/a",
      secret: CI_DB_URL_SECRET,
      state: "cannot",
      reason: "no password",
    });
    recordOutcome(sweep, {
      repo: "o/b",
      secret: CI_SERVICE_ROLE_SECRET,
      state: "failed",
      reason: "403",
    });
    expect(sweep.cannot).toEqual([
      { repo: "o/a", secret: CI_DB_URL_SECRET, reason: "no password" },
    ]);
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
