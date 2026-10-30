import { describe, it, expect } from "vitest";
import {
  grantAddon,
  isKnownAddon,
  mapStripeStatus,
  ENTITLING_STATUSES,
  type AddonStatus,
} from "./addon-purchases.server";
import { MODULES } from "@/lib/pricing/aurixa-catalog";

describe("isKnownAddon", () => {
  it("accepts every slug in the priced catalogue", () => {
    for (const m of MODULES) expect(isKnownAddon(m.slug)).toBe(true);
  });

  it("rejects anything not on the price list", () => {
    // A typo must not create an entitlement for something nobody sells.
    expect(isKnownAddon("market-update")).toBe(false);
    expect(isKnownAddon("")).toBe(false);
    expect(isKnownAddon("platform-core")).toBe(false);
  });
});

describe("ENTITLING_STATUSES", () => {
  it("keeps a past-due add-on entitled", () => {
    // A failed card should not strip features mid-period; dunning decides when
    // the row becomes cancelled, and only then does access stop.
    expect(ENTITLING_STATUSES).toContain("past_due");
    expect(ENTITLING_STATUSES).toContain("active");
  });

  it("does not entitle on cancelled or pending", () => {
    expect(ENTITLING_STATUSES).not.toContain("cancelled");
    expect(ENTITLING_STATUSES).not.toContain("pending");
  });
});

describe("mapStripeStatus", () => {
  const cases: Array<[string | undefined, AddonStatus]> = [
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "past_due"],
    ["unpaid", "past_due"],
    ["incomplete", "pending"],
    ["canceled", "cancelled"],
    ["incomplete_expired", "cancelled"],
  ];

  for (const [stripe, expected] of cases) {
    it(`maps ${stripe} to ${expected}`, () => {
      expect(mapStripeStatus(stripe)).toBe(expected);
    });
  }

  it("never entitles on an unrecognised status", () => {
    // Stripe adds statuses over time. Defaulting to anything entitling would
    // hand out code on a status we have not reasoned about.
    expect(mapStripeStatus("some_future_status")).toBe("pending");
    expect(mapStripeStatus(undefined)).toBe("pending");
    expect(ENTITLING_STATUSES).not.toContain(mapStripeStatus("some_future_status"));
  });

  it("treats a trial as entitling, since the customer has access", () => {
    expect(ENTITLING_STATUSES).toContain(mapStripeStatus("trialing"));
  });
});

describe("grantAddon", () => {
  /**
   * The reads and the write `grantAddon` makes, answered as PostgREST would for
   * a clone that holds nothing yet: no live row, no cancelled one, and an
   * insert that returns its id. The inserted row is kept to be read back.
   */
  function fakeSupabase() {
    const inserted: Record<string, unknown>[] = [];
    const empty = { data: null, error: null };
    const read = {
      select: () => read,
      eq: () => read,
      neq: () => read,
      order: () => read,
      limit: () => read,
      maybeSingle: async () => empty,
    };
    const supabase = {
      from: () => ({
        ...read,
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({ single: async () => ({ data: { id: "row-1" }, error: null }) }),
          };
        },
      }),
    } as unknown as Parameters<typeof grantAddon>[0]["supabase"];
    return { supabase, inserted };
  }

  it("grants a module whose price is undecided, and records no amount for it", async () => {
    // The owner's decision of 29 Oct 2026: until it is priced, the Accountant
    // Portal is had by grant, which charges nothing — so the A$1 placeholder
    // must not be written down as what the clone pays.
    const { supabase, inserted } = fakeSupabase();
    const res = await grantAddon({
      supabase,
      input: { cloneId: "clone-1", addonSlug: "accountant-portal" },
    });
    expect(res).toEqual({ ok: true, id: "row-1" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      addon_slug: "accountant-portal",
      status: "active",
      unit_amount_cents: null,
    });
  });

  it("records a priced module's catalogue amount, as it always has", async () => {
    const { supabase, inserted } = fakeSupabase();
    await grantAddon({ supabase, input: { cloneId: "clone-1", addonSlug: "solicitor-portal" } });
    expect(inserted[0]).toMatchObject({ unit_amount_cents: 29900 });
  });

  it("still refuses a coming-soon module and a direct-sale one", async () => {
    for (const addonSlug of ["lenders", "builder-developer-portal"]) {
      const { supabase, inserted } = fakeSupabase();
      const res = await grantAddon({ supabase, input: { cloneId: "clone-1", addonSlug } });
      expect(res.ok, addonSlug).toBe(false);
      expect(inserted, addonSlug).toHaveLength(0);
    }
  });
});
