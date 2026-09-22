import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_STOREFRONT_PRICING_URL,
  STOREFRONT_RETURN_PAGES,
  normaliseStorefrontBase,
  purchaseCredentialQuery,
  storefrontPurchaseUrl,
  storefrontReturnUrl,
  topupLinkFor,
} from "@/lib/storefront";

/*
  MISSION CONTROL IS AN INTERNAL TOOL. A CUSTOMER MUST NEVER LAND IN IT.

  A buyer who clicks Buy on the Aurixa Systems pricing page has no Mission
  Control account and never will. Three public routes sent them here anyway,
  each contradicting a rule written in its own comment one line above:

    api.public.storefront.checkout  →  "<mcOrigin>/billing/success"
    api.public.storefront.setup     →  "<mcOrigin>/billing/success"
    api.public.tokens.packs         →  "<mcOrigin>/billing/topup"   (OPERATOR
                                        sign-in — a customer cannot read it)

  All three were gated on an environment variable: the storefront got the
  redirect when `PUBLIC_PRICING_SITE_URL` was set and Mission Control got it
  otherwise. So whether a paying customer saw a page titled "Payment
  received — Mission Control" was decided by a deployment setting rather than
  by the architecture, and `storefrontPricingBase()` already answered the
  correct public URL in exactly that unset case.

  The guarantee this file holds is mechanical rather than a list: NO public
  route may build a Mission Control origin. All three defects used one of two
  mechanisms — reading `PUBLIC_APP_URL`, or reassembling the request's own
  origin — so those two are what is forbidden, over the whole `api.public.*`
  family derived from the directory rather than named here.

  What is deliberately NOT caught, because none of it reaches a customer:
    • `createFileRoute("/api/public/billing/…")` — a route DECLARATION.
    • `notifyOperators({ url: "/billing/gates" })` — a relative deep link
      rendered inside Mission Control for the team.
    • `stripe.functions.ts` — the operator purchase console (requireOperator),
      where landing on Mission Control's own receipt page is correct.
  That is why the rule is about building an ORIGIN and not about the substring
  `/billing/`.
*/

const ROUTES_DIR = resolve(process.cwd(), "src/routes");

/** Every public API route, read from the directory — never a hand-list. */
function publicApiRoutes(): { name: string; source: string }[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.startsWith("api.public.") && f.endsWith(".ts") && !f.includes(".test."))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(ROUTES_DIR, name), "utf8") }));
}

/**
 * Comment-free source. The fix's own explanatory comments name the defect
 * they removed, and a detector that reads prose would fire on the apology
 * rather than on the code.
 *
 * It is a scanner rather than two regexes because the first version was two
 * regexes and the planted-form test below caught it: `${url.protocol}//${…}`
 * carries a literal `//`, so a line-comment pattern deleted the rest of the
 * expression and the detector then found nothing to object to. That is a
 * stripper hiding the exact defect it was written to expose. Quoted and
 * template content is therefore preserved verbatim, and an unterminated
 * anything errs toward preserving rather than deleting — a false positive
 * fails loudly, a false negative ships.
 */
function code(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The two mechanisms all three defects used to name Mission Control. */
const ORIGIN_BUILDERS: { label: string; pattern: RegExp }[] = [
  { label: "PUBLIC_APP_URL", pattern: /PUBLIC_APP_URL/ },
  { label: "request origin reassembly", pattern: /\$\{[^}]*\.protocol\}\/\/\$\{[^}]*\.host\}/ },
  { label: "url.origin", pattern: /\burl\.origin\b/ },
  { label: "getRequestHost", pattern: /\bgetRequestHost\b/ },
];

describe("a public route never builds a Mission Control origin", () => {
  const routes = publicApiRoutes();

  it("reads the whole api.public.* family off disk", () => {
    // If this ever reads zero files the scan below passes vacuously.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.map((r) => r.name)).toContain("api.public.storefront.checkout.ts");
    expect(routes.map((r) => r.name)).toContain("api.public.storefront.setup.ts");
    expect(routes.map((r) => r.name)).toContain("api.public.tokens.packs.ts");
  });

  it("finds no origin builder in any of them", () => {
    const offenders: string[] = [];
    for (const { name, source } of routes) {
      const body = code(source);
      for (const { label, pattern } of ORIGIN_BUILDERS) {
        if (pattern.test(body)) offenders.push(`${name}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not vacuous — each forbidden form is caught when planted", () => {
    const planted = [
      'const base = process.env.PUBLIC_APP_URL ?? "";',
      "const o = `${url.protocol}//${url.host}`;",
      "const o = url.origin;",
      "const host = getRequestHost();",
    ];
    for (const line of planted) {
      const caught = ORIGIN_BUILDERS.some(({ pattern }) => pattern.test(code(line)));
      expect(caught, `not caught: ${line}`).toBe(true);
    }
  });

  it("still reads code once its comments are stripped", () => {
    // The stripper must not eat the statement it sits beside, or the scan
    // above would pass on a file that still names PUBLIC_APP_URL.
    const withComments = [
      "// PUBLIC_APP_URL used to be read here",
      "/* and here */",
      "const x = process.env.PUBLIC_APP_URL;",
    ].join("\n");
    expect(code(withComments)).toContain("process.env.PUBLIC_APP_URL");
    expect(code("// PUBLIC_APP_URL\nconst a = 1;")).not.toContain("PUBLIC_APP_URL");
    // A URL in code is not a line comment, and neither is the `//` inside a
    // template literal that reassembles an origin — the case that caught the
    // first version of this stripper.
    expect(code('const u = "https://x.example/a";')).toContain("https://x.example/a");
    expect(code("const o = `${url.protocol}//${url.host}`;")).toContain("${url.host}");
  });
});

describe("the purchase routes compose through the storefront", () => {
  const byName = new Map(publicApiRoutes().map((r) => [r.name, r.source]));

  it.each([
    ["api.public.storefront.checkout.ts", "storefrontReturnUrl"],
    ["api.public.storefront.setup.ts", "storefrontReturnUrl"],
    ["api.public.tokens.packs.ts", "topupLinkFor"],
  ])("%s resolves the storefront base and composes with %s", (file, composer) => {
    const source = byName.get(file);
    expect(source, `${file} is missing`).toBeTruthy();
    const body = code(source as string);
    // Both halves: the base is RESOLVED (so PUBLIC_PRICING_SITE_URL still
    // overrides) and the URL is COMPOSED by the shared module (so the page
    // vocabulary cannot be retyped per route).
    expect(body).toContain("storefrontPricingBase");
    expect(body).toContain(composer);
  });
});

describe("the composed URLs are the ones the website routes", () => {
  // aurixa-systems/src/App.tsx mounts exactly these three paths.
  it("names the storefront's own return pages", () => {
    expect(STOREFRONT_RETURN_PAGES).toEqual({
      success: "success",
      cancel: "cancel",
      cardSaved: "card-saved",
    });
  });

  it("builds the receipt URL the success page reads", () => {
    expect(
      storefrontReturnUrl(
        DEFAULT_STOREFRONT_PRICING_URL,
        "success",
        { uid: "npc-prime" },
        "session_id={CHECKOUT_SESSION_ID}",
      ),
    ).toBe(
      "https://www.aurixasystems.com.au/pricing/success?uid=npc-prime&session_id={CHECKOUT_SESSION_ID}",
    );
  });

  it("leaves Stripe's placeholder un-encoded", () => {
    // Stripe substitutes `{CHECKOUT_SESSION_ID}` literally; percent-encoding
    // the braces is how a receipt page comes back with no session to read.
    const url = storefrontReturnUrl(
      DEFAULT_STOREFRONT_PRICING_URL,
      "cardSaved",
      { h: "8a0d0e3e-0000-4000-8000-000000000000" },
      "session_id={CHECKOUT_SESSION_ID}",
    );
    expect(url).toContain("{CHECKOUT_SESSION_ID}");
    expect(url).not.toContain("%7B");
    expect(url).toContain("/pricing/card-saved?h=8a0d0e3e-0000-4000-8000-000000000000");
  });

  it("omits the trailing separator when there is no extra query", () => {
    expect(storefrontReturnUrl(DEFAULT_STOREFRONT_PRICING_URL, "cancel", { uid: "x" })).toBe(
      "https://www.aurixasystems.com.au/pricing/cancel?uid=x",
    );
  });

  it("sends a buyer to the pricing page scoped by their credential", () => {
    expect(storefrontPurchaseUrl("https://site.example/pricing/", { uid: "tenant 7" })).toBe(
      "https://site.example/pricing?uid=tenant%207",
    );
    expect(storefrontPurchaseUrl("https://site.example/pricing", { h: "tok" })).toBe(
      "https://site.example/pricing?h=tok",
    );
  });

  it("normalises a trailing slash once, for every composer", () => {
    expect(normaliseStorefrontBase("https://a.example/pricing///")).toBe(
      "https://a.example/pricing",
    );
    expect(storefrontReturnUrl("https://a.example/pricing//", "success", { uid: "u" })).toBe(
      "https://a.example/pricing/success?uid=u",
    );
  });

  it("refuses a credential that is neither, rather than emitting uid=undefined", () => {
    expect(() => purchaseCredentialQuery({ h: undefined, uid: undefined } as never)).toThrow(
      /exactly one/,
    );
  });

  it("percent-encodes the credential itself", () => {
    expect(purchaseCredentialQuery({ uid: "a/b?c&d" })).toBe("uid=a%2Fb%3Fc%26d");
  });
});

describe("the top-up CTA is never somebody else's purchase credential", () => {
  it("scopes the link where the tenant has a billing id", () => {
    expect(topupLinkFor(DEFAULT_STOREFRONT_PRICING_URL, "npc-prime")).toBe(
      "https://www.aurixasystems.com.au/pricing?uid=npc-prime",
    );
  });

  it("falls back to the pricing page BROWSE-ONLY, never to null", () => {
    // Null would let the caller's own fallback stand, and the prime's is
    // `?uid=${VITE_AURIXA_BILLING_UID}` defaulting to `npc-prime` — a
    // variable Mission Control publishes to no clone. A clone's customer
    // would then purchase against the PRIME'S tenant. Browse-only is the
    // honest reading when there is no credential to scope a purchase with.
    const link = topupLinkFor(DEFAULT_STOREFRONT_PRICING_URL, null);
    expect(link).toBe("https://www.aurixasystems.com.au/pricing");
    expect(link).not.toContain("uid=");
    expect(link).not.toContain("h=");
    expect(link).toBeTruthy();
  });

  it("never answers a Mission Control origin, on either branch", () => {
    for (const id of ["tenant-9", null]) {
      expect(topupLinkFor(DEFAULT_STOREFRONT_PRICING_URL, id)).toContain(
        "aurixasystems.com.au/pricing",
      );
      expect(topupLinkFor(DEFAULT_STOREFRONT_PRICING_URL, id)).not.toContain("/billing/");
    }
  });
});
