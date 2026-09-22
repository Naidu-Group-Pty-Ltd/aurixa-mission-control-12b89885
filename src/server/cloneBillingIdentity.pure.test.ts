import { describe, expect, it } from "vitest";
import {
  assessCloneBillingId,
  canonicaliseBillingId,
  CLONE_BILLING_ID_ENV,
  deriveCloneBillingId,
  describeBillingIdentity,
  MAX_BILLING_ID_LENGTH,
  PRIME_BUILT_IN_BILLING_ID,
  type BillingIdHolder,
} from "./cloneBillingIdentity.pure";

const CLONE = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const OTHER_CLONE = "2242c67f-fc1d-4723-84fe-6a86898136d2";

describe("deriveCloneBillingId", () => {
  it("is the slug, for every slug this fleet actually has", () => {
    // Measured 22 Sep 2026 — the four live clones.
    for (const slug of [
      "npc-client-dashboard",
      "preflight-property-group",
      "npc-test-76b3b3",
      "npc-crm-independent-6505dc",
    ]) {
      expect(deriveCloneBillingId(slug)).toBe(slug);
    }
  });

  it("canonicalises case and surrounding space", () => {
    expect(deriveCloneBillingId("  Acme-Corp  ")).toBe("acme-corp");
  });

  it("collapses what it cannot carry rather than substituting a character", () => {
    expect(deriveCloneBillingId("acme_corp")).toBe("acme-corp");
    expect(deriveCloneBillingId("acme corp ltd")).toBe("acme-corp-ltd");
    expect(deriveCloneBillingId("--acme--corp--")).toBe("acme-corp");
  });

  it("returns null rather than an id that means something else", () => {
    expect(deriveCloneBillingId(null)).toBeNull();
    expect(deriveCloneBillingId("")).toBeNull();
    expect(deriveCloneBillingId("   ")).toBeNull();
    expect(deriveCloneBillingId("_")).toBeNull();
    expect(deriveCloneBillingId("a")).toBeNull(); // below the floor
  });

  it("never emits a trailing hyphen after truncation", () => {
    const long = `${"a".repeat(MAX_BILLING_ID_LENGTH - 1)}-bbbb`;
    const derived = deriveCloneBillingId(long);
    expect(derived).not.toBeNull();
    expect(derived!.length).toBeLessThanOrEqual(MAX_BILLING_ID_LENGTH);
    expect(derived!.endsWith("-")).toBe(false);
  });
});

describe("canonicaliseBillingId", () => {
  it("changes case and space and nothing else", () => {
    expect(canonicaliseBillingId(" Acme_Corp ")).toBe("acme_corp");
    expect(canonicaliseBillingId(undefined)).toBe("");
  });
});

describe("assessCloneBillingId — shape", () => {
  it("accepts a clean id", () => {
    const v = assessCloneBillingId("acme-corp");
    expect(v.ok).toBe(true);
    expect(v.ok && v.billingId).toBe("acme-corp");
  });

  it("canonicalises before judging", () => {
    const v = assessCloneBillingId("  ACME-Corp ");
    expect(v.ok && v.billingId).toBe("acme-corp");
  });

  it("refuses blank", () => {
    expect(assessCloneBillingId(null).reason).toBe("empty");
    expect(assessCloneBillingId("   ").reason).toBe("empty");
  });

  it("refuses a character it will not silently rewrite", () => {
    expect(assessCloneBillingId("acme_corp").reason).toBe("malformed");
    expect(assessCloneBillingId("acme corp").reason).toBe("malformed");
    expect(assessCloneBillingId("-acme").reason).toBe("malformed");
    expect(assessCloneBillingId("acme-").reason).toBe("malformed");
    expect(assessCloneBillingId("acme/corp").reason).toBe("malformed");
    expect(assessCloneBillingId("a").reason).toBe("malformed");
  });

  it("refuses an id too long to be one", () => {
    const v = assessCloneBillingId("a".repeat(MAX_BILLING_ID_LENGTH + 1));
    expect(v.reason).toBe("too_long");
  });

  it("accepts exactly the ceiling", () => {
    expect(assessCloneBillingId("a".repeat(MAX_BILLING_ID_LENGTH)).ok).toBe(true);
  });
});

describe("assessCloneBillingId — the prime's own identity", () => {
  it("refuses it with no database consulted at all", () => {
    const v = assessCloneBillingId(PRIME_BUILT_IN_BILLING_ID, { forCloneId: CLONE });
    expect(v.reason).toBe("reserved");
  });

  it("refuses it however it is spelled", () => {
    expect(assessCloneBillingId("  NPC-Prime ").reason).toBe("reserved");
  });

  it("says WHY, because a refusal an operator cannot act on is a dead end", () => {
    const v = assessCloneBillingId(PRIME_BUILT_IN_BILLING_ID);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/clones before tenants/);
  });
});

describe("assessCloneBillingId — collisions", () => {
  const cloneHolder: BillingIdHolder = {
    kind: "clone",
    billingId: "acme-corp",
    cloneId: OTHER_CLONE,
    label: "Preflight Property Group",
  };

  it("refuses an id another clone holds", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [cloneHolder],
    });
    expect(v.reason).toBe("taken_by_clone");
    expect(v.message).toContain("Preflight Property Group");
  });

  it("lets a clone re-assert the id it already holds", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [{ kind: "clone", billingId: "acme-corp", cloneId: CLONE }],
    });
    expect(v.ok).toBe(true);
  });

  // The rule the two partial unique indexes cannot express, because they are
  // per table and `startUidCheckout` reads `clones` before `tenants`.
  it("refuses an id a FOREIGN tenant holds — the shadow", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [
        {
          kind: "tenant",
          billingId: "acme-corp",
          tenantId: "t1",
          cloneId: OTHER_CLONE,
          label: "Preflight",
        },
      ],
    });
    expect(v.reason).toBe("shadows_tenant");
  });

  it("refuses an id a tenant with NO clone holds (the prime, a builders org)", () => {
    const v = assessCloneBillingId("some-org", {
      forCloneId: CLONE,
      holders: [
        {
          kind: "tenant",
          billingId: "some-org",
          tenantId: "t1",
          cloneId: null,
          label: "Bob The Builder",
        },
      ],
    });
    expect(v.reason).toBe("shadows_tenant");
    expect(v.message).toContain("Bob The Builder");
  });

  it("allows an id held by a tenant of THIS clone — that is the backfill", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [{ kind: "tenant", billingId: "acme-corp", tenantId: "t1", cloneId: CLONE }],
    });
    expect(v.ok).toBe(true);
  });

  it("treats every holder as foreign when the clone does not exist yet", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: null,
      holders: [{ kind: "tenant", billingId: "acme-corp", tenantId: "t1", cloneId: CLONE }],
    });
    expect(v.reason).toBe("shadows_tenant");
  });

  it("reports the first refusal when a row of each kind holds it", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [
        cloneHolder,
        { kind: "tenant", billingId: "acme-corp", tenantId: "t1", cloneId: OTHER_CLONE },
      ],
    });
    expect(v.ok).toBe(false);
  });

  // The fixture defect that produced this API. A caller handing over rows it
  // read without pre-filtering used to get a refusal naming a collision that
  // does not exist.
  it("ignores a holder carrying a different id", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [
        { kind: "tenant", billingId: "npc-prime", tenantId: "t1", cloneId: null },
        { kind: "clone", billingId: "some-other", cloneId: OTHER_CLONE },
        { kind: "clone", billingId: null, cloneId: OTHER_CLONE },
      ],
    });
    expect(v.ok).toBe(true);
  });

  it("matches a holder whose id differs only by case or space", () => {
    const v = assessCloneBillingId("acme-corp", {
      forCloneId: CLONE,
      holders: [{ kind: "clone", billingId: " ACME-Corp ", cloneId: OTHER_CLONE }],
    });
    expect(v.reason).toBe("taken_by_clone");
  });

  it("accepts when nothing holds it", () => {
    expect(assessCloneBillingId("acme-corp", { forCloneId: CLONE, holders: [] }).ok).toBe(true);
    expect(assessCloneBillingId("acme-corp", { forCloneId: CLONE }).ok).toBe(true);
  });
});

describe("the live fleet, assessed against the state this work found", () => {
  // Measured 22 Sep 2026: four clones with NULL, one tenant carrying an id.
  const primeTenant: BillingIdHolder = {
    kind: "tenant",
    billingId: PRIME_BUILT_IN_BILLING_ID,
    tenantId: "aac277a5-4ed1-464f-8bb8-b16474f39d03",
    cloneId: null,
    label: "Prime",
  };

  it("every clone's derived id is acceptable", () => {
    for (const [cloneId, slug] of [
      [CLONE, "npc-client-dashboard"],
      [OTHER_CLONE, "preflight-property-group"],
      ["7e2c004d-5a56-4d9f-bdae-09d28885d234", "npc-test-76b3b3"],
      ["e97f18ab-a3e3-4350-a0c9-d3f8584d6243", "npc-crm-independent-6505dc"],
    ] as const) {
      const derived = deriveCloneBillingId(slug);
      expect(derived).toBe(slug);
      const v = assessCloneBillingId(derived, { forCloneId: cloneId, holders: [primeTenant] });
      expect(v.ok, `${slug}: ${v.ok ? "" : v.message}`).toBe(true);
    }
  });

  it("and none of them can be the prime's", () => {
    expect(
      assessCloneBillingId("npc-prime", { forCloneId: CLONE, holders: [primeTenant] }).reason,
    ).toBe("reserved");
  });
});

describe("describeBillingIdentity", () => {
  it("names the source without claiming one is better", () => {
    expect(describeBillingIdentity({ ok: true, billingId: "acme" }, "operator")).toBe(
      'Billing identity "acme" recorded as given.',
    );
    expect(describeBillingIdentity({ ok: true, billingId: "acme" }, "derived")).toContain(
      "derived from the clone's slug",
    );
  });

  it("carries the refusal's own words", () => {
    const v = assessCloneBillingId("acme_corp");
    expect(describeBillingIdentity(v, "operator")).toContain("No billing identity recorded");
    expect(describeBillingIdentity(v, "operator")).toContain("lowercase letters");
  });
});

describe("the environment name is stated once", () => {
  it("is the name the prime repo's bundle reads", () => {
    expect(CLONE_BILLING_ID_ENV).toBe("VITE_AURIXA_BILLING_UID");
  });
});
