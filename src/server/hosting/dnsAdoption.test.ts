import { describe, expect, it } from "vitest";
import { decideDnsRecordAction, type ZoneRecord } from "./dnsAdoption.pure";

const desired = {
  type: "CNAME" as const,
  name: "npc.aurixasystems.com.au",
  content: "cname.vercel-dns.com",
  proxied: false,
};

const rec = (over: Partial<ZoneRecord> = {}): ZoneRecord => ({
  id: "rec-1",
  type: "CNAME",
  name: "npc.aurixasystems.com.au",
  content: "cname.vercel-dns.com",
  proxied: false,
  ...over,
});

describe("decideDnsRecordAction", () => {
  it("updates the record we already track, without looking at the zone", () => {
    expect(decideDnsRecordAction({ trackedRecordId: "ours", zoneRecords: [], desired })).toEqual({
      kind: "update",
      recordId: "ours",
    });
  });

  it("creates when the zone holds nothing under that name", () => {
    expect(decideDnsRecordAction({ zoneRecords: [], desired })).toEqual({ kind: "create" });
  });

  it("ADOPTS an untracked record instead of failing to create over it", () => {
    // The live fault: the record existed, we did not track it, and the create
    // branch hit "a record with that host already exists" seven times.
    expect(decideDnsRecordAction({ zoneRecords: [rec()], desired })).toEqual({
      kind: "adopt",
      recordId: "rec-1",
      needsWrite: false,
    });
  });

  it("adopts and rewrites one that points somewhere else", () => {
    const v = decideDnsRecordAction({
      zoneRecords: [rec({ content: "old.example.com" })],
      desired,
    });
    expect(v).toEqual({ kind: "adopt", recordId: "rec-1", needsWrite: true });
  });

  it("counts a proxied flag difference as needing a write", () => {
    const v = decideDnsRecordAction({ zoneRecords: [rec({ proxied: true })], desired });
    expect(v).toMatchObject({ kind: "adopt", needsWrite: true });
  });

  it("compares type and content case-insensitively", () => {
    const v = decideDnsRecordAction({
      zoneRecords: [rec({ type: "cname", content: "CNAME.VERCEL-DNS.COM" })],
      desired,
    });
    expect(v).toEqual({ kind: "adopt", recordId: "rec-1", needsWrite: false });
  });

  it("ignores a record of a non-colliding type under the same name", () => {
    // A TXT beside a CNAME is not what Cloudflare refuses, and adopting it
    // would rewrite an ownership challenge into a site record.
    expect(
      decideDnsRecordAction({
        zoneRecords: [rec({ id: "txt-1", type: "TXT", content: "verify=abc" })],
        desired,
      }),
    ).toEqual({ kind: "create" });
  });

  it("ignores records for a different host", () => {
    expect(
      decideDnsRecordAction({
        zoneRecords: [rec({ id: "other", name: "www.aurixasystems.com.au" })],
        desired,
      }),
    ).toEqual({ kind: "create" });
  });

  it("REFUSES rather than guessing when several address records share the host", () => {
    const v = decideDnsRecordAction({
      zoneRecords: [rec({ id: "a-1", type: "A", content: "1.2.3.4" }), rec({ id: "c-1" })],
      desired,
    });
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.reason).toContain("2 address records");
      expect(v.reason).toContain("npc.aurixasystems.com.au");
      expect(v.reason).toContain("A -> 1.2.3.4");
    }
  });
});
