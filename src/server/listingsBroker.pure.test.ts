import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  brokeredUrl,
  isListingsOperation,
  LISTINGS_OPERATIONS,
  MAX_PAGE_SIZE,
  outboundHeaders,
  parseAllowlist,
  refusalHeaders,
  refuseQuery,
  resolveTable,
} from "./listingsBroker.pure";

const pureSrc = readFileSync(new URL("./listingsBroker.pure.ts", import.meta.url), "utf8");
const serverSrc = readFileSync(new URL("./listingsBroker.server.ts", import.meta.url), "utf8");
const routeSrc = readFileSync(
  new URL("../routes/api.public.listings.$operation.ts", import.meta.url),
  "utf8",
);

describe("the base is Mission Control's and the caller never names one", () => {
  it("takes the base id as a parameter, never from a query", () => {
    // Rule 1 expressed as a type: there is no overload that reads a base from
    // a request. If one is ever added, this fails.
    expect(pureSrc).toMatch(
      /export function brokeredUrl\(\s*operation: ListingsOperation,\s*baseId: string,/,
    );
  });

  it("the route never reads a base id from the caller", () => {
    expect(routeSrc).not.toMatch(/searchParams\.get\(\s*["'`](base|baseId|base_id)["'`]/i);
  });

  it("the server resolves the base from its own environment only", () => {
    expect(serverSrc).toMatch(/baseId: \(process\.env\.AIRTABLE_BASE_ID/);
    // and never from the input
    expect(serverSrc).not.toMatch(/input\.(query\.)?base/i);
  });
});

describe("the table is resolved against an allow-list, never passed through", () => {
  it("permits the default table without it appearing in its own allow-list", () => {
    const out = resolveTable(undefined, "Property Intake Master", new Set());
    expect(out).toEqual({ table: "Property Intake Master" });
  });

  it("permits an explicitly allow-listed table", () => {
    const out = resolveTable("Other", "Intake", new Set(["Other"]));
    expect(out).toEqual({ table: "Other" });
  });

  it("refuses a table that is neither the default nor allow-listed", () => {
    const out = resolveTable("Secret Base Table", "Intake", new Set(["Other"]));
    expect(out).toMatchObject({ error: "table_not_allowed" });
  });

  it("an empty allow-list NARROWS to the default and never widens", () => {
    // The opposite default is how a misconfiguration becomes an open proxy.
    expect(resolveTable("Anything", "Intake", parseAllowlist(""))).toMatchObject({
      error: "table_not_allowed",
    });
    expect(resolveTable("Anything", "Intake", parseAllowlist(undefined))).toMatchObject({
      error: "table_not_allowed",
    });
  });
});

describe("the query is a bounded allow-list of five parameters", () => {
  it("accepts what the two real callers actually send", () => {
    expect(
      refuseQuery({
        pageSize: 100,
        offset: "itrX/recY",
        sortField: "Created",
        sortDirection: "desc",
      }),
    ).toBeNull();
  });

  it("bounds pageSize at Airtable's own ceiling", () => {
    expect(refuseQuery({ pageSize: MAX_PAGE_SIZE + 1 })).toMatchObject({
      error: "invalid_page_size",
    });
    expect(refuseQuery({ pageSize: 0 })).toMatchObject({ error: "invalid_page_size" });
    expect(refuseQuery({ pageSize: 1.5 })).toMatchObject({ error: "invalid_page_size" });
  });

  it("bounds the opaque offset rather than parsing it", () => {
    expect(refuseQuery({ offset: "x".repeat(513) })).toMatchObject({ error: "invalid_offset" });
    expect(pureSrc).not.toMatch(/JSON\.parse\(\s*q\.offset/);
  });

  it("refuses a sort direction that is neither asc nor desc", () => {
    expect(refuseQuery({ sortDirection: "sideways" as never })).toMatchObject({
      error: "invalid_sort_direction",
    });
  });

  it("never admits filterByFormula anywhere", () => {
    // A query language reaching a shared table through a credential the caller
    // does not hold is an exfiltration primitive with a friendly name.
    for (const src of [pureSrc, serverSrc, routeSrc]) {
      expect(src.toLowerCase()).not.toMatch(/searchparams\.set\(\s*["'`]filterbyformula/);
    }
    const url = brokeredUrl("records", "appBASE", "Intake", {
      pageSize: 10,
      // a caller-shaped extra must not survive into the URL
      ...({ filterByFormula: "1=1" } as never),
    });
    expect(url).not.toMatch(/filterByFormula/i);
  });
});

describe("read-only by construction", () => {
  it("the server issues GET and nothing else", () => {
    const verbs = serverSrc.match(/method:\s*["'`](\w+)["'`]/g) ?? [];
    expect(verbs.length).toBeGreaterThan(0);
    for (const v of verbs) expect(v).toMatch(/["'`]GET["'`]/);
  });

  it("the route exposes GET and no mutating handler", () => {
    expect(routeSrc).toMatch(/GET:\s*async/);
    expect(routeSrc).not.toMatch(/\b(POST|PUT|PATCH|DELETE):\s*async/);
  });
});

describe("the credential", () => {
  it("is added in exactly one place and never influenced by a caller", () => {
    expect(pureSrc).toMatch(/Authorization: `Bearer \$\{token\}`/);
    expect(routeSrc).not.toMatch(/Authorization/);
  });

  it("is never AIRTABLE_API_KEY — that name means the Aurixa Waitlist base here", () => {
    // Two meanings on one name is how a token that works for one job silently
    // does the wrong thing for another.
    expect(serverSrc).not.toMatch(/process\.env\.AIRTABLE_API_KEY/);
  });
});

describe("who refused is readable from a header", () => {
  it("marks Mission Control's own refusals and nothing else", () => {
    const h = refusalHeaders("table_not_allowed") as Record<string, string>;
    expect(h["x-mission-control-refusal"]).toBe("table_not_allowed");
  });

  it("relays a vendor answer without the refusal header", () => {
    // The ABSENCE of the header is what identifies a relayed answer, so the
    // relay path must not set it.
    const relay = serverSrc.slice(serverSrc.indexOf("// Status and body only"));
    expect(relay).not.toMatch(/x-mission-control-refusal/);
  });
});

describe("the operation set", () => {
  it("is the allow-list and nothing else", () => {
    expect([...LISTINGS_OPERATIONS].sort()).toEqual(["records", "selftest", "tables"]);
    expect(isListingsOperation("records")).toBe(true);
    expect(isListingsOperation("meta/bases")).toBe(false);
    expect(isListingsOperation("../../v0/appOther/Table")).toBe(false);
  });

  it("builds the schema URL from the base id with no caller input at all", () => {
    expect(brokeredUrl("tables", "appBASE", "ignored", {})).toBe(
      "https://api.airtable.com/v0/meta/bases/appBASE/tables",
    );
  });

  it("encodes the base and table rather than interpolating them raw", () => {
    const url = brokeredUrl("records", "app/../x", "Tab le/..", {});
    expect(url).not.toMatch(/app\/\.\.\/x/);
    expect(url).toContain(encodeURIComponent("app/../x"));
  });
});

describe("outbound headers", () => {
  it("carry the credential and nothing a caller supplied", () => {
    const h = outboundHeaders("tok") as Record<string, string>;
    expect(Object.keys(h).sort()).toEqual(["Authorization", "Content-Type"]);
  });
});
