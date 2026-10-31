/**
 * A Management API refusal that says "come back shortly" is waited out, and a
 * lost answer is asked again only where asking again is safe.
 *
 * A 429 used to fail a provisioning pass outright: its body says "Too many
 * requests" and never "rate limit", so nothing recognised it as a quota, the
 * pass was written `failed` and an attempt spent. The API's limit is 120
 * requests a minute per endpoint per project, and the prime's query endpoint
 * is shared by every sweep that reads its catalogue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ManagementApiError,
  rateLimitWaitMs,
  runSqlOnProject,
} from "./backend-provisioning.server";
import { cloneSaidNothing, isUpstreamRateLimit, upstreamBackoffMs } from "./provisioningBudget";

const REF = "abcdefghijklmnopqrst";
const originalFetch = globalThis.fetch;
const originalToken = process.env.SB_MGMT_API_TOKEN;

let answers: Array<Response | Error> = [];
let sent = 0;

beforeEach(() => {
  vi.useFakeTimers();
  process.env.SB_MGMT_API_TOKEN = "test-token";
  answers = [];
  sent = 0;
  globalThis.fetch = (async () => {
    sent += 1;
    const next = answers.shift() ?? new Response("[]", { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SB_MGMT_API_TOKEN;
  else process.env.SB_MGMT_API_TOKEN = originalToken;
});

const tooMany = (reset = "1") =>
  new Response('{"message":"Too many requests"}', {
    status: 429,
    headers: { "X-RateLimit-Reset": reset },
  });

/** Run with the fake clock advanced until the call settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 50 && !done; i++) await vi.advanceTimersByTimeAsync(5_000);
  return p;
}

describe("runSqlOnProject", () => {
  it("waits a 429 out and sends again, for any statement", async () => {
    answers = [tooMany(), new Response('[{"n":1}]', { status: 200 })];
    await expect(settle(runSqlOnProject(REF, "insert into t values (1)"))).resolves.toEqual([
      { n: 1 },
    ]);
    expect(sent).toBe(2);
  });

  it("a 429 that outlasts the retries is thrown with its status, and reads as a quota", async () => {
    answers = [tooMany(), tooMany(), tooMany("30")];
    const err = await settle(runSqlOnProject(REF, "select 1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).status).toBe(429);
    expect((err as ManagementApiError).retryAfterMs).toBe(15_000);
    // The exact sentence every reader of this error already parses.
    expect((err as Error).message).toBe(
      `SQL execution failed on ${REF}: 429 — {"message":"Too many requests"}`,
    );
    expect(isUpstreamRateLimit(err)).toBe(true);
    expect(sent).toBe(3);
  });

  it("retries a gateway error only where the statement is safe to repeat", async () => {
    answers = [new Response("bad gateway", { status: 502 }), new Response("[]", { status: 200 })];
    await expect(settle(runSqlOnProject(REF, "select 1", { idempotent: true }))).resolves.toEqual(
      [],
    );
    expect(sent).toBe(2);

    answers = [new Response("bad gateway", { status: 502 })];
    sent = 0;
    await expect(settle(runSqlOnProject(REF, "alter table t add column c int"))).rejects.toThrow(
      `SQL execution failed on ${REF}: 502 — bad gateway`,
    );
    expect(sent).toBe(1);
  });

  it("retries a dropped connection only where the statement is safe to repeat", async () => {
    answers = [new TypeError("fetch failed"), new Response("[]", { status: 200 })];
    await expect(settle(runSqlOnProject(REF, "select 1", { idempotent: true }))).resolves.toEqual(
      [],
    );

    answers = [new TypeError("fetch failed")];
    await expect(settle(runSqlOnProject(REF, "insert into t values (1)"))).rejects.toThrow(
      "fetch failed",
    );
  });

  it("never retries what the database refused", async () => {
    answers = [new Response('{"message":"relation x already exists"}', { status: 400 })];
    await expect(settle(runSqlOnProject(REF, "select 1", { idempotent: true }))).rejects.toThrow(
      /: 400 — /,
    );
    expect(sent).toBe(1);
  });
});

describe("rateLimitWaitMs", () => {
  it("reads the reset, bounded, and falls back to Retry-After", () => {
    expect(rateLimitWaitMs(new Headers({ "X-RateLimit-Reset": "3" }))).toBe(3_250);
    expect(rateLimitWaitMs(new Headers({ "X-RateLimit-Reset": "0" }))).toBe(1_000);
    expect(rateLimitWaitMs(new Headers({ "X-RateLimit-Reset": "120" }))).toBe(15_000);
    expect(rateLimitWaitMs(new Headers({ "Retry-After": "5" }))).toBe(5_250);
    expect(rateLimitWaitMs(new Headers())).toBe(2_250);
  });
});

describe("upstreamBackoffMs", () => {
  const QUARTER_HOUR = 15 * 60 * 1000;
  it("holds a hinted refusal for at least a tick and never past the fallback", () => {
    expect(upstreamBackoffMs(15_000, QUARTER_HOUR)).toBe(60_000);
    expect(upstreamBackoffMs(5 * 60_000, QUARTER_HOUR)).toBe(5 * 60_000);
    expect(upstreamBackoffMs(60 * 60_000, QUARTER_HOUR)).toBe(QUARTER_HOUR);
  });
  it("a refusal that gave no word keeps the fallback", () => {
    expect(upstreamBackoffMs(null, QUARTER_HOUR)).toBe(QUARTER_HOUR);
    expect(upstreamBackoffMs(undefined, QUARTER_HOUR)).toBe(QUARTER_HOUR);
    expect(upstreamBackoffMs(0, QUARTER_HOUR)).toBe(QUARTER_HOUR);
  });
});

describe("a quota refusal during a migration is not the clone refusing it", () => {
  // `applyPrimeMigrations` asks `cloneSaidNothing` of every failed apply, and a
  // migration the clone REFUSED blocks the clone out of the fleet sync until an
  // operator repairs it. The thrown error used to carry no status and its body
  // never says "rate limit", so a 429 read as a refusal.
  const body = '{"message":"Too many requests"}';
  const message = `SQL execution failed on ${REF}: 429 — ${body}`;

  it("the error runSqlOnProject throws for a 429 says the clone said nothing", () => {
    expect(cloneSaidNothing(new ManagementApiError(message, 429, 15_000))).toBe(true);
  });

  it("which the bare message alone never did", () => {
    expect(cloneSaidNothing(new Error(message))).toBe(false);
  });

  it("a refusal the database gave stays a refusal", () => {
    const refused = new ManagementApiError(
      `SQL execution failed on ${REF}: 400 — {"message":"relation x already exists"}`,
      400,
    );
    expect(cloneSaidNothing(refused)).toBe(false);
  });
});
