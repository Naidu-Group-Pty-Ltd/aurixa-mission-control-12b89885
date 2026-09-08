import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BROKERED_OPERATIONS,
  MAX_BROKERED_BODY_BYTES,
  brokerRefusal,
  brokeredPath,
  inboundHeaders,
  outboundHeaders,
  refusalHeaders,
  REFUSAL_HEADER,
} from "./verificationBroker.pure";

/**
 * The broker exists because a Didit key can list every session in its
 * application — name, document, and live pre-signed URLs to the customer's
 * passport portrait and selfie. Forwarding that key to every clone put it on
 * three tenant projects.
 *
 * So the single thing these tests exist to prove is that the fix cannot
 * reintroduce the fault it fixes: no input may reach a readable vendor path.
 */

const MULTIPART = "multipart/form-data; boundary=----x";

describe("the operation is an allow-list, not a path", () => {
  it("resolves exactly the three write operations of a verification sequence", () => {
    expect(Object.keys(BROKERED_OPERATIONS).sort()).toEqual([
      "face-match",
      "id-verification",
      "passive-liveness",
    ]);
  });

  it("every brokered path is a verification WRITE — nothing readable is offered", () => {
    for (const path of Object.values(BROKERED_OPERATIONS)) {
      expect(path).toMatch(/^\/v3\/[a-z-]+\/$/);
      // The endpoint the leak lives behind. If it were ever reachable the
      // broker would hand every tenant what the forwarded key did.
      expect(path).not.toMatch(/session/i);
      expect(path).not.toMatch(/application|organization/i);
    }
  });

  it("refuses anything that is not one of the three, however it is spelled", () => {
    const attempts = [
      "sessions",
      "../sessions",
      "id-verification/../../v3/sessions",
      "/v3/sessions/",
      "ID-VERIFICATION",
      "id-verification ",
      "",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ];
    for (const operation of attempts) {
      expect(brokeredPath(operation), operation).toBeNull();
      expect(
        brokerRefusal({ operation, contentType: MULTIPART, declaredBytes: 10 })?.reason,
        operation,
      ).toBe("unknown_operation");
    }
  });

  it("a prototype key cannot resolve to a path", () => {
    // `hasOwnProperty` rather than `in` or a bare lookup, so an inherited
    // member can never be mistaken for an allowed operation.
    expect(brokeredPath("__proto__")).toBeNull();
    expect(brokeredPath("valueOf")).toBeNull();
  });
});

describe("what may travel, in each direction", () => {
  it("builds the outbound headers rather than forwarding the caller's", () => {
    const h = outboundHeaders({ contentType: MULTIPART, apiKey: "k" });
    expect(Object.keys(h).sort()).toEqual(["accept", "content-type", "x-api-key"]);
    // The multipart boundary is the one caller-supplied value that must
    // survive: a body split on a boundary the server does not know is a 400
    // that reads like a malformed image.
    expect(h["content-type"]).toBe(MULTIPART);
  });

  it("returns a content type and nothing else", () => {
    // Didit's response headers can carry rate-limit and account facts about
    // the FLEET. Passing them through would tell each tenant how much of a
    // shared allowance the others had spent.
    expect(Object.keys(inboundHeaders())).toEqual(["content-type"]);
  });
});

describe("refusals", () => {
  it("takes multipart only", () => {
    for (const contentType of ["application/json", "text/plain", null, ""]) {
      expect(
        brokerRefusal({ operation: "face-match", contentType, declaredBytes: 1 })?.reason,
      ).toBe("not_multipart");
    }
  });

  it("refuses a declared body over the ceiling", () => {
    expect(
      brokerRefusal({
        operation: "id-verification",
        contentType: MULTIPART,
        declaredBytes: MAX_BROKERED_BODY_BYTES + 1,
      })?.reason,
    ).toBe("body_too_large");
  });

  it("does NOT refuse a body with no declared length", () => {
    // A chunked upload carries none, and refusing it here would break a
    // legitimate caller. The measured ceiling downstream is the one that holds.
    expect(
      brokerRefusal({ operation: "id-verification", contentType: MULTIPART, declaredBytes: null }),
    ).toBeNull();
  });

  it("passes a well-formed request", () => {
    expect(
      brokerRefusal({ operation: "passive-liveness", contentType: MULTIPART, declaredBytes: 4096 }),
    ).toBeNull();
  });
});

describe("the server half holds the rules the pure half states", () => {
  const server = readFileSync(resolve(__dirname, "verificationBroker.server.ts"), "utf8");

  it("enforces the ceiling on the MEASURED body, not the declared one", () => {
    // `content-length` is a claim by the caller.
    expect(server).toMatch(/buf\.byteLength > MAX_BROKERED_BODY_BYTES/);
  });

  it("never lets a metering fault fail a customer's verification", () => {
    // The rule `complianceReminders` already follows: a billing row that will
    // not write must not cost somebody their identity check.
    const fn = server.slice(server.indexOf("async function recordBrokeredUsage"));
    expect(fn).toContain("try {");
    expect(fn).toMatch(/catch \(e\) \{[\s\S]*console\.error/);
    expect(fn).not.toMatch(/\bthrow\b/);
  });

  it("bills a 2xx and records a refusal at zero rather than dropping it", () => {
    expect(server).toMatch(/const billed = upstream\.ok;/);
    expect(server).toMatch(/quantity: billed \? 1 : 0/);
  });

  it("builds the vendor path from the allow-list and never from the request", () => {
    expect(server).toMatch(/brokeredPath\(input\.operation\)/);
    // A template that interpolated anything else would be the open proxy.
    const fetches = [...server.matchAll(/fetch\(`([^`]*)`/g)].map((m) => m[1]);
    expect(fetches).toEqual(["${base}${path}"]);
  });

  it("says the broker is unconfigured without saying anything about the credential", () => {
    const block = server.slice(server.indexOf("broker_not_configured"));
    expect(block.slice(0, 400)).not.toMatch(/apiKey|process\.env/);
  });
});

describe("who said no is unambiguous", () => {
  it("marks a refusal Mission Control makes itself", () => {
    const h = refusalHeaders("unauthorized");
    expect(h[REFUSAL_HEADER]).toBe("unauthorized");
    // Still JSON — the marker is additive, never a replacement.
    expect(h["content-type"]).toBe("application/json");
  });

  it("leaves the relayed vendor answer unmarked", () => {
    // The vendor's own 401 and Mission Control's 401 are the same status and
    // a similar body, and they send an operator to opposite remedies. The
    // ABSENCE of this header is what identifies an answer as Didit's.
    expect(Object.keys(inboundHeaders())).not.toContain(REFUSAL_HEADER);
  });

  it("every refusal the broker makes carries it, and the relay does not", () => {
    const server = readFileSync(
      new URL("./verificationBroker.server.ts", import.meta.url),
      "utf8",
    );
    // One refusal helper, and it is the marked one.
    expect(server).toContain("headers: refusalHeaders(body.error)");
    // The relay keeps the plain headers — asserted so a later edit cannot
    // quietly mark a vendor response as ours.
    expect(server).toContain("new Response(text, { status: upstream.status, headers: inboundHeaders() })");

    const route = readFileSync(
      new URL("../routes/api.public.verification.$operation.ts", import.meta.url),
      "utf8",
    );
    expect(route).toContain("headers: refusalHeaders(error)");
    // No unmarked refusal may survive in the route.
    expect(route).not.toContain("jsonResponse({ ok: false");
  });
});
