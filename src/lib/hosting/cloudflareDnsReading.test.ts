import { describe, expect, it } from "vitest";
import { readCloudflareDns, type CloudflareDnsFacts } from "./cloudflareDnsReading.pure";

const facts = (over: Partial<CloudflareDnsFacts> = {}): CloudflareDnsFacts => ({
  fqdn: "npc.aurixasystems.com.au",
  status: "active",
  zoneId: "34f9a6100c3f7074e4feda43975a9c10",
  zoneName: "aurixasystems.com.au",
  desiredType: "CNAME",
  desiredContent: "cname.vercel-dns.com",
  desiredProxied: false,
  trackedRecordId: "rec-1",
  trackedType: "CNAME",
  trackedContent: "cname.vercel-dns.com",
  trackedProxied: false,
  ...over,
});

describe("readCloudflareDns", () => {
  it("says it is serving when the record is tracked and matches", () => {
    const r = readCloudflareDns(facts());
    expect(r.tone).toBe("live");
    expect(r.headline).toContain("npc.aurixasystems.com.au");
    expect(r.record).toBe("CNAME → cname.vercel-dns.com · DNS only");
  });

  it("names UNTRACKED as its own state, not as missing", () => {
    // The live state of the fleet's one clone: Cloudflare resolving the host,
    // no row here, and a resync failing on a duplicate seven times over.
    const r = readCloudflareDns(
      facts({
        trackedRecordId: null,
        trackedType: null,
        trackedContent: null,
        trackedProxied: null,
      }),
    );
    expect(r.tone).toBe("untracked");
    expect(r.headline).toContain("not tracked here");
    expect(r.detail).toContain("refuses as a duplicate");
  });

  it("never calls an untracked-but-serving hostname unconfigured", () => {
    const r = readCloudflareDns(facts({ trackedRecordId: null }));
    expect(r.tone).not.toBe("unconfigured");
    expect(r.headline).not.toMatch(/not configured/i);
  });

  it("reports drift when the tracked record disagrees with the configuration", () => {
    const r = readCloudflareDns(facts({ trackedContent: "old.example.com" }));
    expect(r.tone).toBe("drifted");
    expect(r.detail).toContain("old.example.com");
    expect(r.detail).toContain("cname.vercel-dns.com");
  });

  it("counts a proxied difference as drift", () => {
    expect(readCloudflareDns(facts({ trackedProxied: true })).tone).toBe("drifted");
  });

  it("is pending, not untracked, before the subdomain goes active", () => {
    const r = readCloudflareDns(facts({ status: "pending", trackedRecordId: null }));
    expect(r.tone).toBe("pending");
  });

  it("is unconfigured only when there is no zone at all", () => {
    expect(readCloudflareDns(facts({ zoneId: null })).tone).toBe("unconfigured");
    expect(readCloudflareDns(null).tone).toBe("unconfigured");
  });
});
