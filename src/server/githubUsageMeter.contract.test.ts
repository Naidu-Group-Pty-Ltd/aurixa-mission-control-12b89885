/**
 * The App installation is counted, and counted in a shape the column accepts.
 *
 * Two of these pin bugs that were caught by reading the live schema rather
 * than by running the code, and both would have failed in exactly the way
 * this codebase keeps paying for — silently, in a fire-and-forget write, with
 * the meter reporting nothing and looking from the inside like a lane that
 * simply made no calls.
 *
 *   * `billing_reason` is CHECK-constrained to nine values. The first draft
 *     wrote `platform_own_installation`, which is not one of them. Every
 *     insert would have been rejected by the column — the same shape as
 *     `reminder_type`, where the AML kinds had to be added to the constraint
 *     or "every write would have been rejected there while looking, from the
 *     function, exactly like a write nobody attempted."
 *
 *   * `period_start` is NOT NULL with NO DEFAULT. The first draft omitted it.
 *
 * The third pins the property that makes metering safe at all: this ledger
 * must never bill a tenant for Mission Control's own installation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const meter = readFileSync("src/server/githubUsageMeter.ts", "utf8");
const client = readFileSync("src/server/github-app.server.ts", "utf8");
const migration = readFileSync(
  "supabase/migrations/20260919060000_github_installation_metered.sql",
  "utf8",
);

/** Verbatim from `api_usage_events_billing_reason_check`, read 19 Sep 2026. */
const ALLOWED_BILLING_REASONS = [
  "inherited",
  "brokered",
  "absorbed",
  "byok",
  "no_key",
  "unknown_secret",
  "not_billable",
  "error_call",
  "rate_missing",
];

describe("the meter writes a row the column will accept", () => {
  it("uses a billing_reason the CHECK constraint allows", () => {
    const m = meter.match(/billing_reason: "([a-z_]+)"/);
    expect(m, "no billing_reason written").toBeTruthy();
    expect(ALLOWED_BILLING_REASONS).toContain(m![1]);
  });

  it("sets period_start, which is NOT NULL with no default", () => {
    expect(meter).toContain("period_start:");
    // And resolves it from the tenant rather than inventing one, so a row
    // lands in the billing period the rest of the ledger is keyed on.
    expect(meter).toContain("current_period_start");
  });

  it("sets every other NOT NULL column that has no default", () => {
    // tenant_id, secret_name, provider, unit, idempotency_key. The ones with
    // defaults (quantity, call_status, billable, currency, metadata) are
    // allowed to take them.
    for (const col of ["tenant_id:", "secret_name:", "provider:", "unit:", "idempotency_key:"]) {
      expect(meter, col).toContain(col);
    }
  });
});

describe("Mission Control's own installation is never billed to a tenant", () => {
  it("writes the event as non-billable and absorbed", () => {
    expect(meter).toContain("billable: false");
    expect(meter).toMatch(/billing_reason: "absorbed"/);
  });

  it("carries no clone_id", () => {
    // A cascade runs FOR a clone but is not paid for BY one. Attributing the
    // installation's spend to a tenant would invent a charge out of a
    // diagnosis.
    expect(meter).toMatch(/clone_id: null/);
  });

  it("resolves the prime tenant by reference, never by a pinned uuid", () => {
    // The row is created by provisioning rather than by a migration, so its
    // id differs per deployment; a literal would meter nothing anywhere else.
    expect(meter).toContain('like("external_ref", "prime:%")');
    expect(meter).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it("the rate row charges nothing and says why", () => {
    expect(migration).toMatch(/is_billable[\s\S]{0,80}absorbed/);
    expect(migration).toContain("0, 0, 0,");
    expect(migration).toContain("'github'");
  });
});

describe("counting cannot be forgotten, and cannot be misattributed", () => {
  it("counts at the one hook every call already passes through", () => {
    // Metering at the call SITES is metering that gets forgotten — the
    // argument API_USAGE_METERING.md makes for meteredFetch, applied here.
    expect(client).toContain("countGithubCall()");
    const wrap = client.slice(client.indexOf('octokit.hook.wrap("request"'));
    expect(wrap.slice(0, 400)).toContain("countGithubCall()");
  });

  it("flushes the previous lane before adopting a new name", () => {
    // Otherwise a cascade's spend lands under whichever lane happened to run
    // next in the same isolate, which is worse than not counting it: it is a
    // confident attribution to the wrong lane.
    const begin = meter.slice(meter.indexOf("export function beginGithubLane"));
    const body = begin.slice(0, begin.indexOf("}"));
    expect(body).toContain("flushGithubUsage()");
    expect(body.indexOf("flushGithubUsage()")).toBeLessThan(body.indexOf("lane = name"));
  });

  it("never lets its own bookkeeping fail the lane", () => {
    // A ledger that can throw into a cascade is worse than a gap in the
    // ledger.
    const flush = meter.slice(meter.indexOf("export async function flushGithubUsage"));
    expect(flush).toContain("catch");
    expect(flush).not.toMatch(/\bthrow\b/);
  });

  it("takes the count before the await, so a concurrent call cannot double-count", () => {
    const flush = meter.slice(meter.indexOf("export async function flushGithubUsage"));
    expect(flush.indexOf("pending = 0")).toBeLessThan(flush.indexOf("await"));
  });
});
