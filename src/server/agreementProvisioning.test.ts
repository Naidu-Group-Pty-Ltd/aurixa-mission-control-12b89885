import { describe, it, expect } from "vitest";
import {
  decideProvisionOnSignature,
  deriveCloneIdentity,
  effectiveModuleIds,
  parseConnectPayload,
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
  excluded_module_ids: [],
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
});

describe("effectiveModuleIds", () => {
  it("subtracts the named exclusions, preserving order", () => {
    expect(effectiveModuleIds(["m1", "m2", "m3"], ["m2"])).toEqual(["m1", "m3"]);
  });

  it("an exclusion outside the selection is inert", () => {
    expect(effectiveModuleIds(["m1"], ["m9"])).toEqual(["m1"]);
  });

  it("empty exclusions change nothing", () => {
    expect(effectiveModuleIds(["m1", "m2"], [])).toEqual(["m1", "m2"]);
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
