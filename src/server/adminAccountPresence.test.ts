/**
 * Whether a clone's project already holds its admin account, read the way a
 * re-queue lever reads it before it may mint a password (`chooseFailedRequeue`).
 *
 * Driven against a Management API double that answers as the endpoint does, so
 * what is asserted is what the lever would have decided from a real answer —
 * and, above all, that nothing it could not read becomes `absent`, the one
 * answer that lets a minted password through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAdminAccountPresence } from "./backend-provisioning.server";

const REF = "abcdefghijklmnopqrst";
const EMAIL = "Alex.Morgan@orrimere.example";

type Answer = { status?: number; body: unknown };

const AUTH_READ = /from auth\.users/i;
const CUSTOM_READ = /from public\.custom_users/i;

function endpoint(opts: { auth: Answer; custom?: Answer }) {
  const asked: string[] = [];
  const reply = (a: Answer) =>
    new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      asked.push(query);
      if (AUTH_READ.test(query)) return reply(opts.auth);
      if (CUSTOM_READ.test(query) && opts.custom) return reply(opts.custom);
      return reply({ status: 500, body: "unexpected query" });
    }),
  );
  return { asked };
}

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("readAdminAccountPresence", () => {
  it("is present when Auth holds the address, and asks nothing more", async () => {
    const api = endpoint({ auth: { body: [{ in_auth: true, has_custom_users: true }] } });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("present");
    expect(api.asked).toHaveLength(1);
    // Compared lower-cased, as the seed compares it.
    expect(api.asked[0]).toContain("'alex.morgan@orrimere.example'");
  });

  it("is present when only the product's own store holds it", async () => {
    endpoint({
      auth: { body: [{ in_auth: false, has_custom_users: true }] },
      custom: { body: [{ in_custom: true }] },
    });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("present");
  });

  it("is absent only when every store the seed writes was asked and holds nothing", async () => {
    endpoint({
      auth: { body: [{ in_auth: false, has_custom_users: true }] },
      custom: { body: [{ in_custom: false }] },
    });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("absent");
    endpoint({ auth: { body: [{ in_auth: false, has_custom_users: false }] } });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("absent");
  });

  it("is unknown, never absent, when the endpoint refuses or answers a shape it does not know", async () => {
    endpoint({ auth: { status: 500, body: "upstream timeout" } });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("unknown");
    endpoint({ auth: { body: { rows: [{ in_auth: false }] } } });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("unknown");
    endpoint({ auth: { body: [{ in_auth: "f", has_custom_users: true }] } });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("unknown");
    endpoint({
      auth: { body: [{ in_auth: false, has_custom_users: true }] },
      custom: { status: 502, body: "bad gateway" },
    });
    expect(await readAdminAccountPresence(REF, EMAIL)).toBe("unknown");
  });
});
