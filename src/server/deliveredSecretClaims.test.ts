import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DELIVERED_BUT_UNLISTED, deliveredNameCorrections } from "./deliveredSecretClaims.pure";
import { hasDeliveredLinkKey, linkKeyFactFrom, type LinkKeyFact } from "./missionControlLink.pure";

const KEY = "MISSION_CONTROL_CLONE_API_KEY";
const TURNSTILE = "TURNSTILE_SECRET_KEY";

describe("deliveredNameCorrections", () => {
  it("reads a delivered, listed name as set, whatever the stale row said", () => {
    for (const stale of ["failed", "missing", "withheld", null]) {
      expect(
        deliveredNameCorrections({
          ledger: stale ? [{ name: KEY, status: stale }] : [],
          delivered: [KEY],
          held: [KEY],
        }),
      ).toEqual([{ name: KEY, status: "set", last_error: null }]);
    }
  });

  it("leaves a row that already says set", () => {
    expect(
      deliveredNameCorrections({
        ledger: [{ name: KEY, status: "set" }],
        delivered: [KEY],
        held: [KEY],
      }),
    ).toEqual([]);
  });

  it("says missing, with the reason, when a delivered name is no longer listed", () => {
    expect(
      deliveredNameCorrections({
        ledger: [{ name: KEY, status: "set" }],
        delivered: [KEY],
        held: [],
      }),
    ).toEqual([{ name: KEY, status: "missing", last_error: DELIVERED_BUT_UNLISTED }]);
    // A row already recording the absence is not rewritten every half hour.
    expect(
      deliveredNameCorrections({
        ledger: [{ name: KEY, status: "failed" }],
        delivered: [KEY],
        held: [],
      }),
    ).toEqual([]);
  });

  it("never touches a name without a delivery record", () => {
    expect(
      deliveredNameCorrections({
        ledger: [{ name: TURNSTILE, status: "missing" }],
        delivered: [],
        held: [TURNSTILE],
      }),
    ).toEqual([]);
  });

  it("dry run on the five clones' rows as they stood on 30 Oct 2026", () => {
    // Every clone's link is delivered and listed (it is re-asserted every half
    // hour); every clone's Turnstile secret was written by Mission Control.
    const rows: Record<string, Array<{ name: string; status: string }>> = {
      "npc-client-dashboard": [
        { name: KEY, status: "failed" },
        { name: TURNSTILE, status: "missing" },
      ],
      "npc-test-76b3b3": [
        { name: KEY, status: "failed" },
        { name: TURNSTILE, status: "missing" },
      ],
      "preflight-property-group": [
        { name: KEY, status: "failed" },
        { name: TURNSTILE, status: "missing" },
      ],
      "npc-crm-independent-6505dc": [
        { name: KEY, status: "missing" },
        { name: TURNSTILE, status: "set" },
      ],
      "tutorial-demo-orrimere-c158c7": [
        { name: KEY, status: "set" },
        { name: TURNSTILE, status: "set" },
      ],
    };
    const corrected = Object.fromEntries(
      Object.entries(rows).map(([slug, ledger]) => [
        slug,
        deliveredNameCorrections({
          ledger,
          delivered: [KEY, TURNSTILE],
          held: [KEY, TURNSTILE, "RESET_TOKEN_PEPPER"],
        }).map((c) => `${c.name}:${c.status}`),
      ]),
    );
    expect(corrected).toEqual({
      "npc-client-dashboard": [`${KEY}:set`, `${TURNSTILE}:set`],
      "npc-test-76b3b3": [`${KEY}:set`, `${TURNSTILE}:set`],
      "preflight-property-group": [`${KEY}:set`, `${TURNSTILE}:set`],
      "npc-crm-independent-6505dc": [`${KEY}:set`],
      "tutorial-demo-orrimere-c158c7": [],
    });
  });
});

describe("hasDeliveredLinkKey", () => {
  const NOW = Date.parse("2026-10-30T02:00:00Z");
  const key = (over: Partial<LinkKeyFact> = {}): LinkKeyFact => ({
    id: "k",
    label: "mission-control-link",
    scopes: [],
    revokedAt: null,
    revokeAt: null,
    deliveredProjectRef: "plisdzywzleljorrphxv",
    deliveredEnvAt: "2026-09-08T02:00:00Z",
    ...over,
  });

  it("is the plan's own test: live, and delivered to this project", () => {
    expect(hasDeliveredLinkKey([key()], "plisdzywzleljorrphxv", NOW)).toBe(true);
    expect(
      hasDeliveredLinkKey([key({ deliveredProjectRef: "other" })], "plisdzywzleljorrphxv", NOW),
    ).toBe(false);
    expect(hasDeliveredLinkKey([key({ deliveredEnvAt: null })], "plisdzywzleljorrphxv", NOW)).toBe(
      false,
    );
    expect(
      hasDeliveredLinkKey(
        [key({ revokedAt: "2026-10-01T00:00:00Z" })],
        "plisdzywzleljorrphxv",
        NOW,
      ),
    ).toBe(false);
    expect(
      hasDeliveredLinkKey([key({ revokeAt: "2026-10-30T01:00:00Z" })], "plisdzywzleljorrphxv", NOW),
    ).toBe(false);
  });

  it("reads a key row the way the link pass does", () => {
    expect(
      linkKeyFactFrom({
        id: "k",
        label: "mission-control-link",
        scopes: null,
        revoked_at: null,
        revoke_at: null,
        delivered_project_ref: "p",
        delivered_env_at: "t",
      }),
    ).toEqual({
      id: "k",
      label: "mission-control-link",
      scopes: [],
      revokedAt: null,
      revokeAt: null,
      deliveredProjectRef: "p",
      deliveredEnvAt: "t",
    });
  });
});

describe("the sweep corrects delivered names against the list it already read", () => {
  const sweep = readFileSync("src/server/cloneProhibitedSecrets.server.ts", "utf8");

  it("checks them after the list is read, and reports what it corrected", () => {
    const body = sweep.slice(sweep.indexOf("export async function sweepCloneProhibitedSecrets"));
    expect(body.indexOf("const held = await readHeldSecretNames(projectRef);")).toBeLessThan(
      body.indexOf("await correctDeliveredClaims(supabase, cloneId, projectRef, held.names)"),
    );
    expect(body).toContain("const corrected = [...stale, ...delivered];");
  });

  it("answers no corrections on a failed read rather than inventing them", () => {
    const from = sweep.indexOf("async function correctDeliveredClaims");
    const fn = sweep.slice(from, sweep.indexOf("\n/**", from));
    expect(fn).toContain("if (readErr) {");
    expect(fn).toContain("return [];");
    expect(fn).toContain(".upsert(");
    expect(fn).not.toContain("last_set_at");
  });
});
