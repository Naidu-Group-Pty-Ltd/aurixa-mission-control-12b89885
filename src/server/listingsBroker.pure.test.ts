import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A source file with its comments removed.
 *
 * Every source-level assertion here is about what the code DOES. These modules
 * carry long headers explaining why a query language must not cross the
 * boundary, and a scan that reads those headers as violations would fail on
 * its own documentation — which teaches people to delete the documentation.
 */
const codeOf = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
import {
  AIRTABLE_RECORD_ID,
  brokeredUrl,
  describeCredential,
  isListingsOperation,
  LISTINGS_OPERATIONS,
  MAX_PAGE_SIZE,
  MAX_RECORD_IDS,
  ENDPOINT_HEADER,
  LISTINGS_ENDPOINT,
  outboundHeaders,
  parseAllowlist,
  parseRecordIds,
  refusalHeaders,
  refuseQuery,
  relayHeaders,
  resolveTable,
  type ListingsQuery,
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

  it("never admits a filterByFormula the CALLER wrote", () => {
    // A query language reaching a shared table through a credential the caller
    // does not hold is an exfiltration primitive with a friendly name.
    //
    // This assertion used to be "no filterByFormula anywhere", which was the
    // right rule while no read needed one. `listing-images` does — it asks for
    // the photograph columns of the listings it has claimed — and the rule
    // that replaces it is narrower rather than looser: the formula may be
    // WRITTEN here, from checked row handles, and may never be READ from a
    // request. So the pure module composes exactly one, and neither the server
    // nor the route mentions the parameter at all.
    // Judged on CODE, not prose: these files explain the rule in their own
    // headers, and a scan that cannot tell an explanation from an instruction
    // is one people learn to work around by not writing the explanation.
    const written = codeOf(pureSrc).match(/searchParams\.set\(\s*["'`]filterByFormula/g) ?? [];
    expect(written).toHaveLength(1);
    for (const src of [serverSrc, routeSrc]) {
      expect(codeOf(src)).not.toMatch(/filterByFormula/i);
    }
    // And no source anywhere reads one off a request.
    for (const src of [pureSrc, serverSrc, routeSrc]) {
      expect(codeOf(src)).not.toMatch(/searchParams\.get\(\s*["'`]filterByFormula/i);
      expect(codeOf(src)).not.toMatch(/\bq\.filterByFormula|\bquery\.filterByFormula/);
    }
    // A caller-shaped extra must not survive into the URL: `brokeredUrl` reads
    // named fields, so anything else is dropped rather than relayed.
    const withExtra = { pageSize: 10, filterByFormula: "1=1" } as ListingsQuery;
    const url = brokeredUrl("records", "appBASE", "Intake", withExtra);
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

/**
 * `recordIds` is the one read that needs Airtable's query language, and it is
 * admitted by inverting who writes it: the caller names ROWS and Mission
 * Control composes the `filterByFormula`.
 *
 * What these pin is that inversion. `listing-images` reads the photograph
 * columns for the listings it has claimed, which is why a clone showed a
 * marketplace with no pictures on it — the read needed a formula, the broker
 * refused formulas, and the function still held a direct Airtable call it had
 * no token for. Admitting a formula outright would have reopened exactly the
 * hole the broker exists to close, so the boundary carries opaque row handles
 * and the composition happens on this side of it.
 */
const ID_A = "recAAAAAAAAAAAAAA";
const ID_B = "recBBBBBBBBBBBBBB";

describe("record ids", () => {
  it("accepts Airtable's own shape and nothing else", () => {
    expect(AIRTABLE_RECORD_ID.test(ID_A)).toBe(true);
    // Everything a formula would need to be an expression:
    for (const bad of [
      "rec'),RECORD_ID()='x",
      "recAAAAAAAAAAAAA", // thirteen
      "recAAAAAAAAAAAAAAA", // fifteen
      "tblAAAAAAAAAAAAAA", // a table, not a record
      "rec AAAAAAAAAAAAA",
      "rec-AAAAAAAAAAAAA",
      "",
    ]) {
      expect(AIRTABLE_RECORD_ID.test(bad)).toBe(false);
    }
  });

  it("refuses a query whose ids are not record ids", () => {
    expect(refuseQuery({ recordIds: [ID_A, "OR(1=1)"] })?.error).toBe("invalid_record_ids");
    expect(refuseQuery({ recordIds: [] })?.error).toBe("invalid_record_ids");
    expect(refuseQuery({ recordIds: Array(MAX_RECORD_IDS + 1).fill(ID_A) })?.error).toBe(
      "invalid_record_ids",
    );
    expect(refuseQuery({ recordIds: [ID_A, ID_B] })).toBeNull();
  });

  it("never echoes the caller's text back in the refusal", () => {
    // The message lands in operator-facing logs; a caller must not choose what
    // is written there.
    const refusal = refuseQuery({ recordIds: ["<script>bad</script>"] });
    expect(refusal?.message).not.toContain("script");
  });

  it("splits the wire form without judging it", () => {
    expect(parseRecordIds(`${ID_A}, ${ID_B} ,`)).toEqual([ID_A, ID_B]);
    expect(parseRecordIds(null)).toBeUndefined();
    // Judging is refuseQuery's job, in exactly one place.
    expect(parseRecordIds("nonsense")).toEqual(["nonsense"]);
  });

  it("composes the formula itself, from ids alone", () => {
    const url = new URL(brokeredUrl("records", "appBASE", "Tbl", { recordIds: [ID_A, ID_B] }));
    expect(url.searchParams.get("filterByFormula")).toBe(
      `OR(RECORD_ID()='${ID_A}',RECORD_ID()='${ID_B}')`,
    );
  });

  it("throws rather than composing a formula from an id it has not checked", () => {
    // Second reader of the same rule: this function is what reaches the vendor.
    expect(() => brokeredUrl("records", "appBASE", "Tbl", { recordIds: ["'"] })).toThrow();
  });

  it("puts no filter on a read that named no records", () => {
    const url = new URL(brokeredUrl("records", "appBASE", "Tbl", { pageSize: 100 }));
    expect(url.searchParams.get("filterByFormula")).toBeNull();
  });
});

/**
 * Airtable answers 401 with no detail, and from outside that one status covers
 * four different operator mistakes with four different remedies.
 *
 * Measured 8 Sep 2026: the fleet's first brokered reads returned 401 at 09:30,
 * 09:45, 10:00 and 10:15 — after a valid token had been entered — with nothing
 * anywhere able to say whether the running process had not picked the value up,
 * whether it was a retired `key…` API key, whether a base or table id had been
 * pasted into the token field, or whether the token was genuinely revoked. An
 * unfalsifiable error is one nobody can act on.
 *
 * The prefixes are Airtable's own published format markers, so naming the KIND
 * discloses nothing a glance at a settings field would not. These tests pin
 * that nothing beyond the kind ever escapes.
 */
describe("what kind of credential Mission Control is holding", () => {
  const PAT = `pat${"A".repeat(14)}.${"b".repeat(64)}`;

  it("recognises a well-formed personal access token", () => {
    const v = describeCredential(PAT);
    expect(v.shape).toBe("personal_access_token");
    expect(v.wellFormed).toBe(true);
    // The remedy for a well-formed token names both live causes: the token is
    // genuinely refused, OR the process never picked the new value up.
    expect(v.remedy).toMatch(/revoked|regenerated/);
    expect(v.remedy).toMatch(/redeployed/);
  });

  it("separates a truncated paste from a genuine token", () => {
    const v = describeCredential("patSHORT");
    expect(v.shape).toBe("personal_access_token");
    expect(v.wellFormed).toBe(false);
    expect(v.remedy).toMatch(/truncated|quotes|whitespace/);
  });

  it("names a legacy API key, which fails exactly like a bad token", () => {
    const v = describeCredential(`key${"A".repeat(14)}`);
    expect(v.shape).toBe("legacy_api_key");
    expect(v.remedy).toMatch(/February 2024/);
  });

  it("catches a base id or a table id pasted into the token field", () => {
    expect(describeCredential("appFNPL7iYiuQyHAO").shape).toBe("base_id");
    expect(describeCredential("appFNPL7iYiuQyHAO").remedy).toContain("AIRTABLE_BASE_ID");
    expect(describeCredential("tblumTIRYBn92B2ST").shape).toBe("table_id");
    expect(describeCredential("tblumTIRYBn92B2ST").remedy).toContain("AIRTABLE_TABLE_NAME");
  });

  it("says so when the name is set to something empty or foreign", () => {
    expect(describeCredential("   ").shape).toBe("unrecognised");
    expect(describeCredential("   ").remedy).toMatch(/empty/);
    expect(describeCredential("sk-live-whatever").shape).toBe("unrecognised");
  });

  it("NEVER returns any part of the credential", () => {
    // The whole safety of this feature. A diagnostic that leaks the secret it
    // diagnoses is worse than the silence it replaces.
    const secrets = [
      `pat${"Z".repeat(14)}.${"9".repeat(64)}`,
      `key${"Q".repeat(14)}`,
      "app0123456789abcd",
      "tbl0123456789abcd",
      "some-other-vendors-token-value",
    ];
    for (const secret of secrets) {
      const v = describeCredential(secret);
      const emitted = `${v.shape} ${v.remedy} ${v.wellFormed}`;
      // Nothing past the three-character public prefix may appear.
      expect(emitted).not.toContain(secret);
      expect(emitted).not.toContain(secret.slice(3));
      expect(emitted).not.toContain(secret.slice(-8));
    }
  });

  it("emits no length, no checksum and no character of the value", () => {
    const short = describeCredential(`pat${"A".repeat(14)}.${"b".repeat(64)}`);
    const long = describeCredential(`pat${"C".repeat(14)}.${"d".repeat(64)}`);
    // Two different tokens of the same kind are indistinguishable in the output.
    expect(short).toEqual(long);
  });
});

describe("a vendor refusal of Mission Control's OWN credential is Mission Control's refusal", () => {
  const serverCode = codeOf(readFileSync("src/server/listingsBroker.server.ts", "utf8"));

  it("treats 401 and 403 as ours, and nothing else", () => {
    expect(serverCode).toMatch(/upstream\.status === 401 \|\| upstream\.status === 403/);
    expect(serverCode).toContain("airtable_credential_rejected");
  });

  it("records the KIND in the usage ledger, so the diagnosis survives", () => {
    // Readable from the database by an operator with no clone key and no
    // access to the environment — which is how this one had to be diagnosed.
    expect(serverCode).toContain("credential_shape");
  });

  it("never puts the credential itself in the ledger or the response", () => {
    expect(serverCode).not.toMatch(/_metadata[\s\S]{0,300}c\.token/);
    expect(serverCode).not.toMatch(/message:[^;]{0,200}c\.token/);
  });

  it("says the calling deployment is not at fault", () => {
    // The tenant presented a valid key and can do nothing about this; telling
    // them "airtable_401" sends them to an investigation that cannot succeed.
    expect(serverCode).toMatch(/not a fault on the calling deployment/);
  });
});

describe("did the request reach Mission Control at all", () => {
  /*
   * The question `x-mission-control-refusal` cannot answer.
   *
   * It separates "we refused you" from "the vendor answered". It cannot
   * separate either of those from "you never got here" — and on 8 Sep 2026 one
   * clone spent a morning reading its own wrong MISSION_CONTROL_URL as
   * `airtable_404`, while the two beside it were served normally and nothing
   * from it ever appeared in this side's ledger.
   */
  const headerValue = (h: HeadersInit, name: string): string | undefined =>
    (h as Record<string, string>)[name];

  it("marks a relay as ours", () => {
    expect(headerValue(relayHeaders(), ENDPOINT_HEADER)).toBe(LISTINGS_ENDPOINT);
  });

  it("marks a refusal as ours too, so absence is unambiguous", () => {
    // If only ONE kind of answer carried it, absence would mean "the other
    // kind" rather than "not us", and the distinction would be worthless.
    expect(headerValue(refusalHeaders("unauthorized"), ENDPOINT_HEADER)).toBe(LISTINGS_ENDPOINT);
  });

  it("keeps the refusal header on refusals ALONE", () => {
    // The two headers answer different questions and neither replaces the
    // other: this one says the answer is ours, that one says the NO is ours.
    expect(headerValue(refusalHeaders("rate_limited"), "x-mission-control-refusal")).toBe(
      "rate_limited",
    );
    expect(headerValue(relayHeaders(), "x-mission-control-refusal")).toBeUndefined();
  });

  it("puts it on every answer the broker produces, refusal and relay", () => {
    // A relay path that forgot it would make a real vendor failure read as
    // "never arrived" — the same class of wrong answer, pointing the other way.
    const serverCode = codeOf(readFileSync("src/server/listingsBroker.server.ts", "utf8"));
    expect(serverCode).not.toMatch(/headers:\s*\{\s*"Content-Type":\s*"application\/json"\s*\}/);
    expect(serverCode).toContain("relayHeaders()");
  });

  it("does not relay Airtable's own headers", () => {
    // They describe the FLEET's standing with the vendor, not a tenant's.
    const serverCode = codeOf(readFileSync("src/server/listingsBroker.server.ts", "utf8"));
    expect(serverCode).not.toMatch(/upstream\.headers/);
  });
});
