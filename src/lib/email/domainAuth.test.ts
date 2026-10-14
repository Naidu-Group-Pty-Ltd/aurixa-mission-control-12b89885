// Sending-domain authentication, judged from DNS. The first two cases are the
// records npcservices.com.au and aurixasystems.com.au actually published on
// 14 Oct 2026, as Cloudflare's DNS-over-HTTPS returned them.
import { describe, expect, it } from "vitest";
import {
  authWarnings,
  domainOf,
  dmarcTags,
  judgeDkim,
  judgeDmarc,
  judgeDomain,
  judgeMailDomain,
  judgeMx,
  judgeSpf,
  txtValue,
  worstOf,
  type DnsLookup,
} from "./domainAuth.pure";

const txt = (...values: string[]): DnsLookup => ({
  ok: true,
  rcode: 0,
  answers: values.map((data) => ({ type: 16, data })),
});
const cname = (target: string): DnsLookup => ({
  ok: true,
  rcode: 0,
  answers: [{ type: 5, data: target }],
});
const mx = (...hosts: string[]): DnsLookup => ({
  ok: true,
  rcode: 0,
  answers: hosts.map((host) => ({ type: 15, data: host })),
});
const nxdomain: DnsLookup = { ok: true, rcode: 3, answers: [] };
const empty: DnsLookup = { ok: true, rcode: 0, answers: [] };
const failed: DnsLookup = { ok: false, error: "timed out" };

const at = "2026-10-14T09:30:00.000Z";

describe("the domains as they stand", () => {
  it("passes npcservices.com.au, but warns that its DMARC record sends no reports", () => {
    const report = judgeDomain({
      domain: "npcservices.com.au",
      checkedAt: at,
      spf: txt(
        '"NETORGFT16204559.onmicrosoft.com"',
        '"v=spf1 include:spf.protection.outlook.com include:spf.leadconnectorhq.com include:mailgun.org -all"',
      ),
      dmarc: txt('"v=DMARC1; p=none;"'),
      dkim1: cname(
        "selector1-npcservices-com-au._domainkey.netorgft16204559.w-v1.dkim.mail.microsoft.",
      ),
      dkim2: cname(
        "selector2-npcservices-com-au._domainkey.netorgft16204559.w-v1.dkim.mail.microsoft.",
      ),
      mx: mx("0 npcservices-com-au.mail.protection.outlook.com."),
    });
    expect(report.findings.map((f) => [f.check, f.severity])).toEqual([
      ["spf", "ok"],
      ["dkim", "ok"],
      ["dmarc", "warn"],
      ["mx", "ok"],
    ]);
    expect(report.verdict).toBe("warn");
    expect(report.findings[2].fix).toMatch(/rua=mailto:dmarc-reports@npcservices\.com\.au/);
  });

  it("fails aurixasystems.com.au on DKIM: no selectors are published", () => {
    const report = judgeDomain({
      domain: "aurixasystems.com.au",
      checkedAt: at,
      spf: txt(
        '"MS=ms18683409"',
        '"google-site-verification=V91cGSNvk5Oh3OR6SAi7dD3MEpfr0pRLmUyy59e_DJ0"',
        '"v=spf1 include:spf.protection.outlook.com -all"',
      ),
      dmarc: txt('"v=DMARC1; p=none; rua=mailto:admin@aurixasystems.com.au"'),
      dkim1: nxdomain,
      dkim2: nxdomain,
      mx: mx("0 aurixasystems-com-au.mail.protection.outlook.com."),
    });
    expect(report.verdict).toBe("bad");
    const dkim = report.findings.find((f) => f.check === "dkim")!;
    expect(dkim).toMatchObject({ severity: "bad" });
    expect(dkim.summary).toMatch(/onmicrosoft\.com/);
    expect(dkim.fix).toMatch(/Microsoft Defender/);
    expect(report.findings.find((f) => f.check === "dmarc")?.severity).toBe("ok");
    // DMARC passes and so says nothing; DKIM is the one thing to fix.
    expect(authWarnings(report)).toEqual([expect.stringMatching(/^aurixasystems\.com\.au DKIM: /)]);
  });

  it("puts the worst problem first and leaves failed lookups out", () => {
    const report = judgeDomain({
      domain: "x.com",
      checkedAt: at,
      spf: failed,
      dmarc: txt('"v=DMARC1; p=none"'),
      dkim1: nxdomain,
      dkim2: nxdomain,
      mx: mx("0 x-com.mail.protection.outlook.com."),
    });
    expect(authWarnings(report).map((w) => w.split(":")[0])).toEqual(["x.com DKIM", "x.com DMARC"]);
  });
});

describe("SPF", () => {
  it("joins a long record DNS split into several strings", () => {
    expect(txtValue('"v=spf1 include:spf.protection" ".outlook.com -all"')).toBe(
      "v=spf1 include:spf.protection.outlook.com -all",
    );
  });

  it("fails a domain with no SPF, two SPF records, or one that leaves Microsoft out", () => {
    expect(judgeSpf("x.com", txt('"MS=123"')).severity).toBe("bad");
    expect(
      judgeSpf("x.com", txt('"v=spf1 include:spf.protection.outlook.com -all"', '"v=spf1 -all"'))
        .summary,
    ).toMatch(/permanent error/);
    expect(judgeSpf("x.com", txt('"v=spf1 include:_spf.google.com -all"')).summary).toMatch(
      /does not authorise Microsoft 365/,
    );
  });

  it("fails +all, warns on a neutral ending, and counts lookups past ten", () => {
    expect(
      judgeSpf("x.com", txt('"v=spf1 include:spf.protection.outlook.com +all"')).severity,
    ).toBe("bad");
    expect(
      judgeSpf("x.com", txt('"v=spf1 include:spf.protection.outlook.com ?all"')).severity,
    ).toBe("warn");
    const many = Array.from({ length: 11 }, (_, i) => `include:s${i}.example`).join(" ");
    expect(
      judgeSpf("x.com", txt(`"v=spf1 include:spf.protection.outlook.com ${many} -all"`)).summary,
    ).toMatch(/at least 12 DNS lookups/);
  });

  it("says nothing either way when the lookup failed", () => {
    expect(judgeSpf("x.com", failed).severity).toBe("unknown");
  });
});

describe("DKIM", () => {
  it("accepts both selectors in the older onmicrosoft.com form", () => {
    expect(
      judgeDkim(
        "x.com",
        cname("selector1-x-com._domainkey.contoso.onmicrosoft.com."),
        cname("selector2-x-com._domainkey.contoso.onmicrosoft.com."),
      ).severity,
    ).toBe("ok");
  });

  it("warns when only one selector is published", () => {
    expect(
      judgeDkim("x.com", cname("selector1-x._domainkey.c.onmicrosoft.com."), empty),
    ).toMatchObject({ severity: "warn" });
  });
});

describe("DMARC", () => {
  it("reads its tags", () => {
    expect(dmarcTags("v=DMARC1; p=quarantine; rua=mailto:a@x.com; pct=50")).toEqual({
      v: "DMARC1",
      p: "quarantine",
      rua: "mailto:a@x.com",
      pct: "50",
    });
  });

  it("fails a missing record, two records, or one with no valid policy", () => {
    expect(judgeDmarc("x.com", empty).severity).toBe("bad");
    expect(judgeDmarc("x.com", nxdomain).fix).toMatch(/_dmarc\.x\.com/);
    expect(judgeDmarc("x.com", txt('"v=DMARC1; p=none"', '"v=DMARC1; p=reject"')).severity).toBe(
      "bad",
    );
    expect(judgeDmarc("x.com", txt('"v=DMARC1; rua=mailto:a@x.com"')).summary).toMatch(
      /no valid policy/,
    );
  });

  it("passes an enforcing policy with reports", () => {
    expect(judgeDmarc("x.com", txt('"v=DMARC1; p=reject; rua=mailto:a@x.com"')).summary).toBe(
      "p=reject, with reports",
    );
  });
});

describe("MX", () => {
  it("fails a domain that receives no mail", () => {
    expect(judgeMx("x.com", empty).severity).toBe("bad");
    expect(judgeMx("x.com", mx("10 mail.x.com.")).summary).toBe("receives mail at mail.x.com");
  });
});

describe("whether a recipient's domain takes mail", () => {
  const address: DnsLookup = { ok: true, rcode: 0, answers: [{ type: 1, data: "203.0.113.5" }] };

  it("says yes with an MX, or with only an address record", () => {
    expect(judgeMailDomain(mx("10 mx.agency.com.au."), null).accepts).toBe("yes");
    expect(judgeMailDomain(empty, address).accepts).toBe("yes");
  });

  it("says no for a domain that does not exist, a null MX, or no mail server at all", () => {
    expect(judgeMailDomain(nxdomain, null)).toEqual({
      accepts: "no",
      detail: "the domain does not exist",
    });
    expect(judgeMailDomain(mx("0 ."), null).accepts).toBe("no");
    expect(judgeMailDomain(empty, empty).accepts).toBe("no");
  });

  it("never says no because a lookup failed", () => {
    expect(judgeMailDomain(failed, null).accepts).toBe("unknown");
    expect(judgeMailDomain(empty, failed).accepts).toBe("unknown");
    expect(judgeMailDomain({ ok: true, rcode: 2, answers: [] }, null).accepts).toBe("unknown");
  });
});

describe("helpers", () => {
  it("reads a domain off an address", () => {
    expect(domainOf(" Rugesh@NPCServices.com.au ")).toBe("npcservices.com.au");
    expect(domainOf("not an address")).toBeNull();
    expect(domainOf("a@localhost")).toBeNull();
  });

  it("ranks severities worst first", () => {
    expect(worstOf([{ severity: "ok" }, { severity: "unknown" }])).toBe("unknown");
    expect(worstOf([{ severity: "warn" }, { severity: "bad" }])).toBe("bad");
    expect(worstOf([])).toBe("ok");
  });
});
