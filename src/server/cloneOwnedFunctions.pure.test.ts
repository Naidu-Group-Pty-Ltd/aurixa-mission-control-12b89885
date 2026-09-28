/**
 * What a clone owns, whether a pass deploys it, and what the pass records.
 *
 * The fleet these tests are shaped on was measured on 28 Sep 2026: the three
 * mirrors (Client Dashboard, NPC Test, Preflight) declare nothing the prime
 * does not, and the CRM-independent clone declares exactly three —
 * `crm-calendar`, `crm-inbound-message`, `crm-send-message`.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_OWNED_FUNCTIONS,
  OWNED_RECORD_HEARTBEAT_MS,
  decideOwnedDeploy,
  mergeOwnedResults,
  nextOwnedRecord,
  ownedFunctionSlugs,
  ownedFunctionsDigest,
  ownedRecordDue,
  readOwnedRecord,
  retiredOwnedSlugs,
  type CloneOwnedFunctionsRecord,
  type OwnedBundlePlan,
} from "./cloneOwnedFunctions.pure";

const CRM = ["crm-calendar", "crm-inbound-message", "crm-send-message"];
const PRIME = ["airtable-proxy", "listings-cache", "send-ghl-message"];

function plan(
  slug: string,
  files: Array<[string, string]> = [[`${slug}/index.ts`, `sha-${slug}`]],
): OwnedBundlePlan {
  return {
    slug,
    entrypointPath: `${slug}/index.ts`,
    importMapPath: null,
    verifyJwt: false,
    files: [
      ...files.map(([rel, sha]) => ({ rel, sha })),
      { rel: "_shared/crm/provider.ts", sha: "shared-1" },
    ],
  };
}

function record(over: Partial<CloneOwnedFunctionsRecord> = {}): CloneOwnedFunctionsRecord {
  return {
    slugs: [...CRM],
    source_repo: "Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc",
    source_sha: "a".repeat(40),
    digest: "digest-1",
    deployed_at: "2026-09-28T00:00:00.000Z",
    results: CRM.map((slug) => ({ slug, success: true, verifyJwt: false })),
    retired: [],
    checked_at: "2026-09-28T00:00:00.000Z",
    ...over,
  };
}

describe("ownedFunctionSlugs", () => {
  it("is what the clone declares and the prime does not, sorted and distinct", () => {
    expect(
      ownedFunctionSlugs([...PRIME, "crm-send-message", "crm-calendar", "crm-calendar"], PRIME),
    ).toEqual(["crm-calendar", "crm-send-message"]);
  });

  it("is empty for a mirror — every function it declares is the prime's", () => {
    expect(ownedFunctionSlugs(PRIME, [...PRIME, "a-function-the-clone-lacks"])).toEqual([]);
  });

  it("never claims a function the prime also declares, however the copies differ", () => {
    // `send-ghl-message` exists in both; the clone's copy is the prime's lane's.
    expect(ownedFunctionSlugs(["send-ghl-message", ...CRM], PRIME)).toEqual(CRM);
  });
});

describe("ownedFunctionsDigest", () => {
  it("is null when nothing is owned", () => {
    expect(ownedFunctionsDigest([])).toBeNull();
  });

  it("does not depend on the order the tree listing returned", () => {
    const a = [plan("crm-send-message"), plan("crm-calendar")];
    const b = [
      plan("crm-calendar"),
      { ...plan("crm-send-message"), files: [...plan("crm-send-message").files].reverse() },
    ];
    expect(ownedFunctionsDigest(a)).toBe(ownedFunctionsDigest(b));
  });

  it("changes when any file a bundle is built from changes — including a shared one", () => {
    const base = [plan("crm-send-message")];
    const shared = [
      {
        ...plan("crm-send-message"),
        files: plan("crm-send-message").files.map((f) =>
          f.rel.startsWith("_shared/") ? { ...f, sha: "shared-2" } : f,
        ),
      },
    ];
    expect(ownedFunctionsDigest(shared)).not.toBe(ownedFunctionsDigest(base));
  });

  it("changes when verify_jwt changes, which is part of what a deploy writes", () => {
    const off = [plan("crm-inbound-message")];
    const on = [{ ...plan("crm-inbound-message"), verifyJwt: true }];
    expect(ownedFunctionsDigest(on)).not.toBe(ownedFunctionsDigest(off));
  });
});

describe("readOwnedRecord", () => {
  it("is null for an absent record and for anything this lane did not write", () => {
    expect(readOwnedRecord(null)).toBeNull();
    expect(readOwnedRecord({})).toBeNull();
    expect(readOwnedRecord([])).toBeNull();
    expect(readOwnedRecord({ slugs: [1, 2] })).toBeNull();
  });

  it("reads a record back as written, dropping malformed results rather than trusting them", () => {
    const raw = {
      ...record(),
      results: [...record().results, { slug: 7, success: true }, { slug: "x" }],
    };
    expect(readOwnedRecord(raw)).toEqual(record());
  });

  it("an empty owned list is a reading, not an absence", () => {
    expect(readOwnedRecord({ slugs: [], checked_at: "t" })?.slugs).toEqual([]);
  });
});

describe("decideOwnedDeploy", () => {
  it("refuses a large owned set rather than deploying it from the clone's copy", () => {
    const owned = Array.from({ length: MAX_OWNED_FUNCTIONS + 1 }, (_, i) => `fn-${i}`);
    const d = decideOwnedDeploy({ owned, digest: "d", recorded: null, live: [] });
    expect(d.act).toBe("refuse");
    // Even a forced pass does not get past it.
    expect(
      decideOwnedDeploy({ owned, digest: "d", recorded: null, live: [], force: true }).act,
    ).toBe("refuse");
  });

  it("does nothing for a clone that owns nothing", () => {
    expect(decideOwnedDeploy({ owned: [], digest: null, recorded: null, live: null }).act).toBe(
      "none",
    );
  });

  it("deploys everything owned when there is no record", () => {
    const d = decideOwnedDeploy({ owned: CRM, digest: "digest-1", recorded: null, live: CRM });
    expect(d).toMatchObject({ act: "deploy", slugs: CRM });
  });

  it("deploys everything owned when the files it is built from changed", () => {
    const d = decideOwnedDeploy({ owned: CRM, digest: "digest-2", recorded: record(), live: CRM });
    expect(d).toMatchObject({ act: "deploy", slugs: CRM });
  });

  it("skips when the record is current and every function is live — the steady state", () => {
    const d = decideOwnedDeploy({
      owned: CRM,
      digest: "digest-1",
      recorded: record(),
      live: [...PRIME, ...CRM],
    });
    expect(d.act).toBe("skip");
  });

  it("deploys only what went missing from the project", () => {
    const d = decideOwnedDeploy({
      owned: CRM,
      digest: "digest-1",
      recorded: record(),
      live: ["crm-calendar", "crm-send-message"],
    });
    expect(d).toMatchObject({ act: "deploy", slugs: ["crm-inbound-message"] });
    expect(d.why).toMatch(/not on the project: crm-inbound-message/);
  });

  it("retries only what last failed", () => {
    const d = decideOwnedDeploy({
      owned: CRM,
      digest: "digest-1",
      recorded: record({
        results: [
          { slug: "crm-calendar", success: true },
          { slug: "crm-inbound-message", success: false, error: "413" },
          { slug: "crm-send-message", success: true },
        ],
      }),
      live: CRM,
    });
    expect(d).toMatchObject({ act: "deploy", slugs: ["crm-inbound-message"] });
    expect(d.why).toMatch(/last deploy failed/);
  });

  it("trusts a current record when the project's functions could not be read — absent is not zero", () => {
    const d = decideOwnedDeploy({ owned: CRM, digest: "digest-1", recorded: record(), live: null });
    expect(d.act).toBe("skip");
  });

  it("a forced pass deploys everything owned whatever the record says", () => {
    const d = decideOwnedDeploy({
      owned: CRM,
      digest: "digest-1",
      recorded: record(),
      live: CRM,
      force: true,
    });
    expect(d).toMatchObject({ act: "deploy", slugs: CRM });
  });

  describe("where there is nowhere to record yet", () => {
    it("does not redeploy what the project already runs, pass after pass", () => {
      // Without this, "no record" would mean "deploy everything" on every
      // half-hourly sweep until the column's migration landed.
      const d = decideOwnedDeploy({
        owned: CRM,
        digest: "digest-1",
        recorded: null,
        live: CRM,
        recordable: false,
      });
      expect(d.act).toBe("skip");
      // And the skip says what it cannot see, rather than calling it current.
      expect(d.why).toMatch(/not detected/);
    });

    it("deploys what the project does not run", () => {
      const d = decideOwnedDeploy({
        owned: CRM,
        digest: "digest-1",
        recorded: null,
        live: ["crm-calendar"],
        recordable: false,
      });
      expect(d).toMatchObject({
        act: "deploy",
        slugs: ["crm-inbound-message", "crm-send-message"],
      });
    });

    it("deploys everything owned when the project cannot be read either — a new clone must not be left without them", () => {
      const d = decideOwnedDeploy({
        owned: CRM,
        digest: "digest-1",
        recorded: null,
        live: null,
        recordable: false,
      });
      expect(d).toMatchObject({ act: "deploy", slugs: CRM });
    });

    it("still refuses a large owned set and still does nothing for a mirror", () => {
      const owned = Array.from({ length: MAX_OWNED_FUNCTIONS + 1 }, (_, i) => `fn-${i}`);
      expect(
        decideOwnedDeploy({ owned, digest: "d", recorded: null, live: [], recordable: false }).act,
      ).toBe("refuse");
      expect(
        decideOwnedDeploy({ owned: [], digest: null, recorded: null, live: [], recordable: false })
          .act,
      ).toBe("none");
    });
  });
});

describe("mergeOwnedResults", () => {
  it("keeps the latest result per owned slug and drops slugs no longer owned", () => {
    const merged = mergeOwnedResults(
      [
        { slug: "crm-calendar", success: true },
        { slug: "crm-send-message", success: false, error: "old" },
        { slug: "gone", success: true },
      ],
      [{ slug: "crm-send-message", success: true }],
      ["crm-calendar", "crm-send-message"],
    );
    expect(merged).toEqual([
      { slug: "crm-calendar", success: true },
      { slug: "crm-send-message", success: true },
    ]);
  });
});

describe("retiredOwnedSlugs", () => {
  it("names what was owned and no longer is, while the project still runs it — and never deletes", () => {
    const recorded = record();
    expect(retiredOwnedSlugs(recorded, ["crm-calendar"], [...CRM])).toEqual([
      "crm-inbound-message",
      "crm-send-message",
    ]);
  });

  it("drops a retired function the project no longer has", () => {
    expect(retiredOwnedSlugs(record({ retired: ["old-fn"] }), CRM, CRM)).toEqual([]);
  });

  it("keeps the list when the project could not be read", () => {
    expect(retiredOwnedSlugs(record({ retired: ["old-fn"] }), CRM, null)).toEqual(["old-fn"]);
  });

  it("is empty with no record", () => {
    expect(retiredOwnedSlugs(null, [], null)).toEqual([]);
  });
});

describe("nextOwnedRecord and ownedRecordDue", () => {
  const base = {
    owned: CRM,
    digest: "digest-1",
    sourceRepo: "Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc",
    sourceSha: "a".repeat(40),
    live: CRM,
  };

  it("stamps deployed_at only when this pass deployed something", () => {
    const quiet = nextOwnedRecord({
      ...base,
      recorded: record(),
      fresh: [],
      now: "2026-09-28T01:00:00.000Z",
    });
    expect(quiet.deployed_at).toBe("2026-09-28T00:00:00.000Z");
    const busy = nextOwnedRecord({
      ...base,
      recorded: record(),
      fresh: [{ slug: "crm-calendar", success: true }],
      now: "2026-09-28T01:00:00.000Z",
    });
    expect(busy.deployed_at).toBe("2026-09-28T01:00:00.000Z");
  });

  it("a current pass is not written again within the day", () => {
    const before = record();
    const after = nextOwnedRecord({
      ...base,
      recorded: before,
      fresh: [],
      now: "2026-09-28T00:30:00.000Z",
    });
    expect(ownedRecordDue(before, after, Date.parse("2026-09-28T00:30:00.000Z"))).toBe(false);
  });

  it("is re-stamped once the heartbeat has elapsed, so a live lane is visibly live", () => {
    const before = record();
    const at = Date.parse(before.checked_at) + OWNED_RECORD_HEARTBEAT_MS;
    const after = nextOwnedRecord({
      ...base,
      recorded: before,
      fresh: [],
      now: new Date(at).toISOString(),
    });
    expect(ownedRecordDue(before, after, at)).toBe(true);
  });

  it("is written whenever anything but checked_at changes", () => {
    const before = record();
    const after = nextOwnedRecord({
      ...base,
      recorded: before,
      sourceSha: "b".repeat(40),
      fresh: [],
      now: "2026-09-28T00:30:00.000Z",
    });
    expect(ownedRecordDue(before, after, Date.parse("2026-09-28T00:30:00.000Z"))).toBe(true);
  });

  it("is written the first time, even for a clone that owns nothing", () => {
    const after = nextOwnedRecord({
      ...base,
      owned: [],
      digest: null,
      recorded: null,
      fresh: [],
      now: "2026-09-28T00:30:00.000Z",
    });
    expect(after.slugs).toEqual([]);
    expect(ownedRecordDue(null, after, Date.parse("2026-09-28T00:30:00.000Z"))).toBe(true);
  });
});
