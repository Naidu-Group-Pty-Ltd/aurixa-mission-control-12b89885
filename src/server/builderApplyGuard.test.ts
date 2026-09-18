/**
 * The one endpoint an anonymous caller can make Mission Control spend on.
 *
 * `/api/public/builders/apply` creates an organisation on the network and
 * sends mail from a verified domain. These tests pin the controls that stand
 * in front of that, and — just as importantly — pin which of them are
 * BOUNDARIES and which are merely cost raisers, because a reader who mistakes
 * a honeypot for a security control stops looking for the ones that hold.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLY_FIELDS,
  APPLY_GLOBAL_PER_MINUTE,
  APPLY_PER_IP_PER_MINUTE,
  DEFAULT_APPLY_ORIGINS,
  AUTOFILL_TOKENS,
  HONEYPOT_FIELD,
  MAX_APPLY_BODY_BYTES,
  MAX_FILL_HOURS,
  MIN_FILL_SECONDS,
  allowedApplyOrigins,
  normaliseOrigin,
  originIsAllowed,
  projectApplyFields,
  readApplyHeuristics,
  turnstileRequired,
} from "./builderApplyGuard.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ROUTE = "src/routes/api.public.builders.apply.ts";

const application = () => ({
  legal_name: "Hawthorn Homes Pty Ltd",
  contact_name: "Jo Rivera",
  contact_email: "jo@example.com",
  org_type: "builder",
  elapsed_ms: 30_000,
});

describe("the boundaries", () => {
  it("refuses an origin that is not the site", () => {
    expect(originIsAllowed("https://www.aurixasystems.com.au")).toBe(true);
    for (const origin of [
      "https://aurixasystems.com.au.evil.example",
      "https://evil.example",
      "null",
      "",
    ]) {
      expect(originIsAllowed(origin), origin).toBe(false);
    }
  });

  it("refuses a request with NO origin rather than trusting it", () => {
    // Every browser sends one on a cross-origin POST. What this drops is the
    // requests that did not come from a page at all — which is exactly the
    // set a form endpoint has no reason to serve.
    for (const absent of [null, undefined, "   "]) {
      expect(originIsAllowed(absent), String(absent)).toBe(false);
    }
  });

  it("compares origins normalised, so a trailing slash is the same origin", () => {
    expect(originIsAllowed("https://aurixasystems.com.au/")).toBe(true);
    expect(normaliseOrigin("https://aurixasystems.com.au///")).toBe("https://aurixasystems.com.au");
  });

  it("extends the list from the environment without losing the defaults", () => {
    const extra = allowedApplyOrigins("https://staging.example, https://preview.example/");
    for (const origin of DEFAULT_APPLY_ORIGINS) expect(extra).toContain(origin);
    expect(extra).toContain("https://staging.example");
    expect(extra).toContain("https://preview.example");
    // A blank setting must not admit an empty origin, which is what an
    // absent `Origin` header normalises to.
    expect(allowedApplyOrigins(",, ,")).toEqual([...DEFAULT_APPLY_ORIGINS]);
    expect(allowedApplyOrigins("")).not.toContain("");
  });

  it("never answers a wildcard to an allow-listed endpoint", () => {
    // `Access-Control-Allow-Origin: *` on an endpoint with an allow-list has
    // allowed everything the list refuses.
    expect(code(ROUTE)).not.toContain('"Access-Control-Allow-Origin": "*"');
    expect(code(ROUTE)).toContain("originIsAllowed(origin");
  });

  it("caps the body by what arrived, not by what the caller claimed", () => {
    // `Content-Length` is the caller's own statement. A cap that believes it
    // is passed by lying about it.
    const source = code(ROUTE);
    expect(source).toContain("await request.text()");
    expect(source).toContain("new TextEncoder().encode(raw).length > MAX_APPLY_BODY_BYTES");
    expect(source).not.toMatch(/content-length/i);
    // Generous against the form's own longest field, mean against a payload.
    expect(MAX_APPLY_BODY_BYTES).toBeGreaterThan(4 * 1024);
    expect(MAX_APPLY_BODY_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("the cost raisers", () => {
  it("refuses a filled honeypot", () => {
    const verdict = readApplyHeuristics({ ...application(), [HONEYPOT_FIELD]: "https://spam" });
    expect(verdict.ok).toBe(false);
  });

  it("accepts an empty or absent honeypot", () => {
    expect(readApplyHeuristics(application()).ok).toBe(true);
    expect(readApplyHeuristics({ ...application(), [HONEYPOT_FIELD]: "  " }).ok).toBe(true);
  });

  it("is not named 'honeypot'", () => {
    // A bot that skips a field called `honeypot` fills one called
    // `company_website`, which is the entire value of the control.
    expect(HONEYPOT_FIELD).not.toMatch(/honey|trap|bot|spam|decoy/i);
  });

  it("is named outside the browser autofill taxonomy", () => {
    // THE DEFECT THIS EXISTS FOR. It WAS `company_website`, which is a
    // plausible name — chosen so a bot skipping `honeypot` would still fill
    // it — and a password manager filled it for a real applicant on
    // 18 Sep 2026, refusing them within thirty seconds of the page opening.
    // A plausible name is exactly what autofill fills.
    for (const token of AUTOFILL_TOKENS) {
      expect(HONEYPOT_FIELD, token).not.toContain(token);
    }
    expect(HONEYPOT_FIELD).not.toBe("company_website");
  });

  it("refuses a form submitted faster than a person could fill it", () => {
    expect(readApplyHeuristics({ ...application(), elapsed_ms: 900 }).ok).toBe(false);
    expect(readApplyHeuristics({ ...application(), elapsed_ms: 4_000 }).ok).toBe(true);
  });

  it("refuses a form left open past the day", () => {
    const stale = { ...application(), elapsed_ms: (MAX_FILL_HOURS + 1) * 3600_000 };
    expect(readApplyHeuristics(stale).ok).toBe(false);
  });

  it("measures a DURATION, never the difference between two clocks", () => {
    // The first version took an ISO `rendered_at` from the browser and
    // subtracted it from the server's `Date.now()`. A visitor's machine
    // running half a minute fast therefore failed a form that had been open
    // for twenty seconds, and there was no way past it.
    const source = code("src/server/builderApplyGuard.pure.ts");
    expect(source).toContain("body.elapsed_ms");
    expect(source).not.toContain("rendered_at");
    expect(source).not.toContain("Date.parse");
    // And the reader takes no clock of its own, so it CANNOT compare two.
    expect(source).not.toMatch(/readApplyHeuristics\([\s\S]{0,120}Date\.now\(\)/);
  });

  it("accepts a duration it cannot trust rather than refusing a person", () => {
    // A cost raiser must never refuse on data it cannot trust, and this one
    // has already refused somebody real once. Absent, negative, NaN and a
    // string all read as unknown.
    for (const elapsed of [
      undefined,
      null,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "30000",
      {},
    ]) {
      expect(
        readApplyHeuristics({ ...application(), elapsed_ms: elapsed }).ok,
        String(elapsed),
      ).toBe(true);
    }
  });

  it("answers every heuristic with the same code, telling a caller nothing", () => {
    // Naming which trap was tripped is naming what to change next time, and
    // there is no honest reader of that answer — a real applicant trips none.
    const codes = new Set(
      [
        { ...application(), [HONEYPOT_FIELD]: "x" },
        { ...application(), elapsed_ms: 10 },
        { ...application(), elapsed_ms: 864e5 },
      ].map((body) => {
        const verdict = readApplyHeuristics(body);
        expect(verdict.ok).toBe(false);
        return verdict.ok ? "" : `${verdict.error}:${verdict.status}`;
      }),
    );
    expect(codes.size).toBe(1);
  });
});

describe("the ceilings", () => {
  it("counts before anything travels", () => {
    // A limiter that runs after the work is a record of the work.
    // Read inside the HANDLER, not the file: the import sits at the top and
    // satisfies a naive `indexOf` however late the call actually happens.
    const source = code(ROUTE);
    const handler = source.slice(source.indexOf("POST: async ({ request })"));
    const limitAt = handler.indexOf("await checkPublicRateLimit(");
    const callAt = handler.indexOf('callBuilderNetworkAdmin("submit_access_request"');
    expect(limitAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(limitAt);
    // Both ceilings, not just the first one.
    expect(handler.indexOf('"builders:apply:global"')).toBeLessThan(callAt);
  });

  it("bounds one caller and every caller, which are different attacks", () => {
    const source = code(ROUTE);
    expect(source).toContain('"builders:apply:ip"');
    expect(source).toContain('"builders:apply:global"');
    // The global ceiling must be higher than one caller's, or the per-IP
    // limit can never fire and only the global one means anything.
    expect(APPLY_GLOBAL_PER_MINUTE).toBeGreaterThan(APPLY_PER_IP_PER_MINUTE);
    // And low enough to matter: a form of this kind sees single digits a
    // minute, so a three-figure ceiling would never be reached by anything
    // this is meant to stop.
    expect(APPLY_GLOBAL_PER_MINUTE).toBeLessThan(100);
  });

  it("identifies the caller from the edge, never from the body", () => {
    const source = code(ROUTE);
    expect(source).toMatch(/cf-connecting-ip|x-forwarded-for/);
    // A caller who can name its own origin defeats the network's per-origin
    // window as well as this one.
    expect(source).toMatch(/source_ip:\s*ip,/);
    expect(source).not.toMatch(/source_ip:\s*body\./);
  });

  it("fails closed on a database fault, by using the limiter that does", () => {
    // `checkPublicRateLimit` returns `{ok:false}` on error by construction.
    // What this pins is that the route uses IT rather than counting itself.
    const source = code(ROUTE);
    expect(source).toContain("checkPublicRateLimit");
    expect(source).not.toContain("public_rate_limits");
  });
});

describe("what travels, and what comes back", () => {
  it("forwards only the declared fields", () => {
    const projected = projectApplyFields({
      ...application(),
      [HONEYPOT_FIELD]: "x",
      turnstile_token: "t",
      source_ip: "1.2.3.4",
      status: "active",
      is_active: true,
      organisation_id: "x",
    });
    expect(Object.keys(projected).sort()).toEqual(
      ["contact_email", "contact_name", "legal_name", "org_type"].sort(),
    );
  });

  it("carries no lifecycle field in its allow-list at all", () => {
    for (const forbidden of ["status", "is_active", "organisation_id", "source_ip", "approved"]) {
      expect(APPLY_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it("truncates a field rather than passing a novel through", () => {
    const projected = projectApplyFields({ suburb: "x".repeat(5000), message: "y".repeat(9000) });
    expect(projected.suburb.length).toBe(200);
    expect(projected.message.length).toBe(2000);
  });

  it("drops a non-string rather than coercing it", () => {
    // `String({})` is "[object Object]", which is a value the network would
    // store as somebody's legal name.
    const projected = projectApplyFields({ legal_name: { toString: () => "x" }, abn: 123 });
    expect(projected).toEqual({});
  });

  it("never returns the invitation link", () => {
    // The link is the credential. An endpoint anybody can post to that hands
    // it back is an account-takeover primitive.
    const source = code(ROUTE);
    expect(source).not.toContain("invite_url");
    expect(source).not.toContain("invite_token");
    expect(source).not.toContain("expires_at");
  });

  it("relays the network's refusal rather than inventing one", () => {
    // The network's `readAccessRequest` is the authority on what an
    // application may say. A second field validator here is how the two come
    // to disagree.
    const source = code(ROUTE);
    expect(source).toContain("error: result.error");
    for (const rule of ["abn_must_be", "EMAIL", "legal_name.length", "ORG_TYPES"]) {
      expect(source, rule).not.toContain(rule);
    }
  });

  it("does not cache an applicant's answer", () => {
    expect(code(ROUTE)).toContain('"Cache-Control": "no-store"');
  });
});

describe("the CAPTCHA that is not there yet", () => {
  it("is switched by the SECRET, never by a site key or a flag", () => {
    // A site key is public and proves nothing. Requiring a token because one
    // happens to be published is what makes a CAPTCHA that cannot be
    // verified look like one that can.
    expect(turnstileRequired("0x4AAA")).toBe(true);
    for (const secret of ["", "   ", null, undefined]) {
      expect(turnstileRequired(secret), String(secret)).toBe(false);
    }
    const source = code(ROUTE);
    expect(source).toContain("BUILDER_APPLY_TURNSTILE_SECRET");
    expect(source).not.toContain("VITE_TURNSTILE_SITE_KEY");
  });

  it("makes no network call where no secret is held", () => {
    // A deployment with no CAPTCHA must not pay a round trip per application
    // to discover that, and must not fail when Cloudflare is unreachable.
    const source = code(ROUTE);
    const verifier = source.slice(
      source.indexOf("async function turnstilePasses"),
      source.indexOf("export const Route"),
    );
    const guardAt = verifier.indexOf("if (!turnstileRequired(secret)) return true;");
    expect(guardAt).toBeGreaterThan(-1);
    expect(verifier.indexOf("fetch(")).toBeGreaterThan(guardAt);
  });

  it("fails closed where a secret IS held", () => {
    const verifier = code(ROUTE).slice(
      code(ROUTE).indexOf("async function turnstilePasses"),
      code(ROUTE).indexOf("export const Route"),
    );
    // An unreachable verifier, a non-200, a missing token and an unexpected
    // body all answer false. A control whose whole job is to stand between a
    // public form and spending must not wave a request through because it
    // could not check it.
    expect(verifier).toMatch(/catch[\s\S]{0,120}return false/);
    expect(verifier).toContain("if (!response.ok) return false;");
    expect(verifier).toMatch(/verdict\.success === true/);
    expect(verifier).toMatch(/typeof token !== "string"[\s\S]{0,40}return false/);
  });
});
