import { describe, it, expect } from "vitest";
import {
  decideProvisionOnSignature,
  deriveCloneIdentity,
  effectiveModuleIds,
  parseConnectPayload,
  provisionedExclusions,
  slugifyCloneName,
  summarizeConnectPayload,
  uniqueSlug,
  type AgreementProvisionFacts,
} from "./agreementProvisioning.pure";

const agreement = (over: Partial<AgreementProvisionFacts> = {}): AgreementProvisionFacts => ({
  id: "a-1",
  status: "signed",
  provision_on_signature: true,
  provision_status: "armed",
  plan_slug: "growth",
  module_ids: ["m1", "m2", "m3"],
  addon_slugs: [],
  excluded_module_slugs: [],
  admin_email: null,
  client_email: "client@tenant.com.au",
  client_name: "Jordan Client",
  client_org: "Tenant Homes Pty Ltd",
  created_by: "u-1",
  ...over,
});

describe("parseConnectPayload", () => {
  it("reads the REST v2.1 shape", () => {
    const facts = parseConnectPayload({
      event: "envelope-completed",
      data: {
        accountId: "acc-1",
        envelopeId: "env-1",
        envelopeSummary: { status: "completed", completedDateTime: "2026-08-28T10:00:00Z" },
      },
    });
    expect(facts).toEqual({
      envelopeId: "env-1",
      event: "envelope-completed",
      status: "completed",
      completedAt: "2026-08-28T10:00:00Z",
      voidedAt: null,
      accountId: "acc-1",
    });
  });

  it("returns null rather than guessing when there is no envelope id", () => {
    expect(parseConnectPayload({ event: "envelope-completed", data: {} })).toBeNull();
    expect(parseConnectPayload("not json object")).toBeNull();
    expect(parseConnectPayload(null)).toBeNull();
  });

  it("summarises without carrying the raw payload", () => {
    const facts = parseConnectPayload({
      event: "envelope-completed",
      data: { envelopeId: "env-1", envelopeSummary: { status: "completed" } },
    })!;
    const summary = summarizeConnectPayload(facts);
    expect(summary).toEqual({
      event: "envelope-completed",
      status: "completed",
      completed_at: null,
      voided_at: null,
      account_id: null,
    });
  });
});

describe("decideProvisionOnSignature", () => {
  it("provisions an armed, signed, planned agreement", () => {
    expect(decideProvisionOnSignature(agreement())).toEqual({ action: "provision" });
  });

  it("skips when not armed — old agreements must not provision retroactively", () => {
    const d = decideProvisionOnSignature(agreement({ provision_on_signature: false }));
    expect(d).toMatchObject({ action: "skip", reason: "not_armed" });
  });

  it("skips when the envelope is not signed yet", () => {
    const d = decideProvisionOnSignature(agreement({ status: "delivered" }));
    expect(d).toMatchObject({ action: "skip", reason: "not_signed" });
  });

  it("is idempotent across retries: done and in-flight both skip", () => {
    expect(
      decideProvisionOnSignature(agreement({ provision_status: "provisioned" })),
    ).toMatchObject({ action: "skip", reason: "already_done" });
    expect(
      decideProvisionOnSignature(agreement({ provision_status: "provisioning" })),
    ).toMatchObject({ action: "skip", reason: "in_flight" });
  });

  it("a failed attempt waits for a person, never auto-retries", () => {
    const d = decideProvisionOnSignature(agreement({ provision_status: "failed" }));
    expect(d).toMatchObject({ action: "skip", reason: "failed_needs_operator" });
  });

  it("refuses without a plan and without an actor", () => {
    expect(decideProvisionOnSignature(agreement({ plan_slug: null }))).toMatchObject({
      action: "skip",
      reason: "no_plan",
    });
    expect(decideProvisionOnSignature(agreement({ created_by: null }))).toMatchObject({
      action: "skip",
      reason: "no_actor",
    });
  });

  it("provisions a signed Subscription Agreement only once its signed record is retained", () => {
    expect(
      decideProvisionOnSignature(
        agreement({ document_kind: "subscription", signed_record_path: null }),
      ),
    ).toMatchObject({ action: "skip", reason: "acceptance_not_retained" });
    expect(
      decideProvisionOnSignature(
        agreement({ document_kind: "subscription", signed_record_path: "a-1/env-1-signed.pdf" }),
      ),
    ).toEqual({ action: "provision" });
    // A Service Level Agreement never needed one, and still does not.
    expect(
      decideProvisionOnSignature(agreement({ document_kind: "sla", signed_record_path: null })),
    ).toEqual({ action: "provision" });
  });

  it("names the earlier refusals before the retention one", () => {
    expect(
      decideProvisionOnSignature(
        agreement({ document_kind: "subscription", provision_on_signature: false }),
      ),
    ).toMatchObject({ reason: "not_armed" });
    expect(
      decideProvisionOnSignature(
        agreement({ document_kind: "subscription", provision_status: "provisioned" }),
      ),
    ).toMatchObject({ reason: "already_done" });
  });
});

describe("effectiveModuleIds", () => {
  // Library modules as the catalogue holds them: an id and a detected slug.
  const library = {
    modules: [
      { id: "id-client", slug: "client" },
      { id: "id-aml", slug: "aml" },
      { id: "id-commercial", slug: "commercial" },
      { id: "id-industrial", slug: "industrial" },
      { id: "id-market-updates", slug: "market-updates" },
      { id: "id-listings", slug: "listings" },
      { id: "id-deal-pipeline", slug: "deal-pipeline" },
    ],
  };
  const all = library.modules.map((m) => m.id);

  it("drops the picked library module an excluded price-list slug maps to", () => {
    // The selection is library ids and the exclusion is a price-list slug:
    // `aml-ctf` is what the price list calls the library's `aml`.
    expect(effectiveModuleIds(all, ["aml-ctf"], library)).toEqual(
      all.filter((id) => id !== "id-aml"),
    );
  });

  it("drops every module one priced line is built from, preserving order", () => {
    expect(
      effectiveModuleIds(
        ["id-commercial", "id-client", "id-industrial"],
        ["commercial-industrial"],
        library,
      ),
    ).toEqual(["id-client"]);
  });

  it("translates through the operator's override first", () => {
    const r = effectiveModuleIds(all, ["market-updates"], {
      ...library,
      overrides: { "module:market-updates": ["listings"] },
    });
    expect(r).toContain("id-market-updates");
    expect(r).not.toContain("id-listings");
  });

  it("drops nothing for an entitlement-only item: nothing installs for it", () => {
    expect(effectiveModuleIds(all, ["client-ai"], library)).toEqual(all);
  });

  it("an exclusion that maps to nothing picked is inert", () => {
    expect(effectiveModuleIds(["id-client"], ["finance-portal"], library)).toEqual(["id-client"]);
  });

  it("drops nothing for a slug the price list does not know, even a library one", () => {
    // `aml` read as a price-list slug names nothing.
    expect(effectiveModuleIds(all, ["aml"], library)).toEqual(all);
  });

  it("keeps a picked id the catalogue does not hold", () => {
    expect(effectiveModuleIds(["id-gone", "id-aml"], ["aml-ctf"], library)).toEqual(["id-gone"]);
  });

  it("empty exclusions change nothing", () => {
    expect(effectiveModuleIds(["m1", "m2"], [], { modules: [] })).toEqual(["m1", "m2"]);
  });
});

describe("provisionedExclusions", () => {
  it("excludes AML/CTF from a signature on an offer taken Without AML", () => {
    // Left to the operator's tick, a Without AML signature provisioned AML/CTF
    // and, since 29 Oct 2026, every partner portal it brings.
    expect(provisionedExclusions([], "without")).toEqual(["aml-ctf"]);
    expect(provisionedExclusions(["market-updates"], "without")).toEqual([
      "aml-ctf",
      "market-updates",
    ]);
    expect(provisionedExclusions(["aml-ctf"], "without")).toEqual(["aml-ctf"]);
  });

  it("adds nothing for an offer taken With AML, or for an agreement with no offer", () => {
    expect(provisionedExclusions(["market-updates"], "with")).toEqual(["market-updates"]);
    expect(provisionedExclusions([], null)).toEqual([]);
    expect(provisionedExclusions([], undefined)).toEqual([]);
  });
});

describe("clone identity", () => {
  it("prefers the organisation and slugifies it", () => {
    expect(deriveCloneIdentity({ client_org: "Tenant Homes Pty Ltd", client_name: "J C" })).toEqual(
      {
        name: "Tenant Homes Pty Ltd",
        slug: "tenant-homes-pty-ltd",
      },
    );
  });

  it("falls back to the client's own name", () => {
    expect(deriveCloneIdentity({ client_org: null, client_name: "Jordan Client" })).toEqual({
      name: "Jordan Client",
      slug: "jordan-client",
    });
  });

  it("returns null when nothing usable exists", () => {
    expect(deriveCloneIdentity({ client_org: "  ", client_name: "  " })).toBeNull();
  });

  it("never emits a reserved slug bare", () => {
    expect(slugifyCloneName("Admin")).toBe("admin-clone");
  });

  it("uniquifies against taken slugs", () => {
    const taken = new Set(["acme", "acme-2"]);
    expect(uniqueSlug("acme", taken)).toBe("acme-3");
    expect(uniqueSlug("fresh", taken)).toBe("fresh");
  });
});
