/**
 * The public application form, and the two things that could go wrong with it
 * without anybody noticing.
 *
 * This pins three properties rather than three strings:
 *
 *  1. The page is PUBLIC. A `ProtectedRoute` around it, or an auth middleware
 *     on the server function it posts to, would make the only door into the
 *     network openable solely by people already inside it — and nothing about
 *     that failure is visible from the outside, because an operator testing it
 *     is signed in.
 *
 *  2. The applicant is never told to do something only an operator can do.
 *     The console's own readings end in "edit the organisation that already
 *     holds it"; handing those to a stranger is a dead control aimed at the
 *     public.
 *
 *  3. The NETWORK's refusal vocabulary and the APPLICANT's readings stay in
 *     step. A code the network can answer with and this module does not
 *     author renders one honest apology rather than a raw identifier — which
 *     is correct, and is also how a real refusal silently stops being
 *     explained. The list is therefore pinned here so adding one to the
 *     network without adding it here is a visible omission rather than none.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APPLICATION_FAULT_SENTENCE,
  APPLICATION_STATES,
  AUTHORED_APPLICATION_REFUSALS,
  ORG_TYPE_LABEL,
  readApplicationRefusal,
} from "./builderApplication.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * Source with its comments removed.
 *
 * Every assertion below is about what the module DOES, and a comment saying
 * "no ProtectedRoute here" satisfies a naive `toContain` — which is the
 * measure-your-own-header bug this repository has hit before.
 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const ROUTE = "src/routes/apply.builder.tsx";
const SERVER = "src/server/builders-network.functions.ts";
const PANEL = "src/components/builders-network-access-requests.tsx";
const CONSOLE = "src/routes/builders-network.tsx";

/**
 * Every code the network's `submit_access_request` can answer with.
 *
 * Kept as a literal because it lives in another repository — the test cannot
 * read it, so it states it, and a code that appears there and not here is a
 * refusal the applicant meets as a generic apology.
 */
const NETWORK_REFUSALS = [
  "a_legal_name_is_required",
  "a_contact_name_is_required",
  "a_valid_email_is_required",
  "an_organisation_type_is_required",
  "org_type_is_not_recognised",
  "abn_must_be_11_digits",
  "acn_must_be_9_digits",
  "postcode_must_be_4_digits",
  "state_is_not_an_australian_state",
  "an_application_for_that_address_is_already_with_us",
  "abn_already_registered",
  "acn_already_registered",
  "legal_name_already_registered",
  "that_account_has_been_withdrawn",
];

describe("the application page is public", () => {
  it("does not wrap itself in ProtectedRoute", () => {
    // The whole point: an applicant has no account. This is `join.$token`'s
    // shape, and it is the only shape that works.
    expect(code(ROUTE)).not.toContain("ProtectedRoute");
  });

  it("posts to a server function with no auth middleware", () => {
    const source = read(SERVER);
    const start = source.indexOf("export const submitBuilderAccessRequest");
    expect(start).toBeGreaterThan(-1);
    // Everything up to the handler: the middleware chain, if any, is here.
    const declaration = source.slice(start, source.indexOf(".handler(", start));
    expect(declaration).not.toContain("requireSupabaseAuth");
    expect(declaration).not.toContain("requireAdmin");
    expect(declaration).not.toContain(".middleware(");
  });

  it("keeps every OTHER network server function admin-gated", () => {
    // The public one is a deliberate hole of exactly one operation. This
    // fails if a second export ever loses its middleware, which is the way a
    // one-operation hole becomes a console anybody can drive.
    const source = read(SERVER);
    const exports = [...source.matchAll(/export const (\w+) = createServerFn\(/g)];
    expect(exports.length).toBeGreaterThan(10);
    const ungated = exports
      .map(([, name]) => name)
      .filter((name) => {
        const start = source.indexOf(`export const ${name} = createServerFn(`);
        const end = source.indexOf(".handler(", start);
        return !source.slice(start, end).includes("requireSupabaseAuth");
      });
    expect(ungated).toEqual(["submitBuilderAccessRequest"]);
  });

  it("never returns the invitation link to whoever posted the form", () => {
    // The link is the credential. A public endpoint that hands it back is an
    // account-takeover primitive, whatever address was typed on the form.
    const source = read(SERVER);
    const start = source.indexOf("export const submitBuilderAccessRequest");
    const body = source.slice(start, source.indexOf("export const listNetworkAccessRequests"));
    expect(body).not.toContain("invite_url");
    expect(body).not.toContain("invite_token");
  });

  it("reads the client from the request headers, never from the body", () => {
    const source = read(SERVER);
    const start = source.indexOf("export const submitBuilderAccessRequest");
    const body = source.slice(start, source.indexOf("export const listNetworkAccessRequests"));
    expect(body).toContain("getRequest()");
    expect(body).toContain("clientIpFrom");
    // A caller who can name its own IP has erased the evidence trail, so
    // neither field may be copied out of what was posted.
    expect(body).not.toMatch(/payload\.source_ip\s*=\s*input\b/);
    expect(body).not.toMatch(/payload\.user_agent\s*=\s*input\b/);
  });
});

describe("what the applicant is told", () => {
  it("authors every refusal the network can answer with", () => {
    const missing = NETWORK_REFUSALS.filter(
      (code) => !AUTHORED_APPLICATION_REFUSALS.includes(code),
    );
    expect(missing).toEqual([]);
  });

  it("never names an act only an operator could perform", () => {
    // The console's readings say "edit the organisation that already holds
    // it" and name routes and environment variables. None of that can reach
    // a stranger, so this scans the prose rather than trusting it.
    const forbidden = [
      /\bconsole\b/i,
      /\bedit the organisation\b/i,
      /\bmint\b/i,
      /\boperator\b/i,
      /\bMission Control\b/i,
      /\bsettings\b/i,
      /_[a-z]+_/, // a snake_cased identifier is database vocabulary
      /https?:\/\//,
    ];
    for (const refusal of AUTHORED_APPLICATION_REFUSALS) {
      const { sentence } = readApplicationRefusal(refusal);
      for (const pattern of forbidden) {
        // The SENTENCE alone — the code itself is snake_cased by definition.
        expect(sentence, refusal).not.toMatch(pattern);
      }
    }
  });

  it("classifies a collision as the application's, not a typo", () => {
    // A field refusal points at a box and says fix it. A collision points at
    // the same box and cannot be fixed by retyping, so the two are different
    // kinds and the page words them differently.
    expect(readApplicationRefusal("abn_must_be_11_digits").kind).toBe("field");
    expect(readApplicationRefusal("abn_already_registered").kind).toBe("application");
  });

  it("says nothing about which organisation holds a colliding number", () => {
    // This page is unauthenticated. One that confirms whose ABN is registered
    // is a lookup service for other people's businesses.
    for (const code of ["abn_already_registered", "acn_already_registered"]) {
      const { sentence } = readApplicationRefusal(code);
      expect(sentence).not.toMatch(/another organisation/i);
      expect(sentence).not.toMatch(/registered (to|by|as) /i);
    }
  });

  it("names the field to focus wherever one can be pointed at", () => {
    for (const code of AUTHORED_APPLICATION_REFUSALS) {
      const reading = readApplicationRefusal(code);
      if (reading.kind === "ours") continue;
      expect(reading.field, code).toBeTruthy();
    }
  });

  it("apologises for a code it does not author rather than unslugging it", () => {
    // `readNetworkFailure` humanises an unknown code because its reader is
    // technical. "Owner not created." tells an applicant nothing and alarms
    // them, so this falls through to one sentence that is true of every fault.
    for (const code of ["owner_not_created", "invite_not_issued", "", null, undefined]) {
      const reading = readApplicationRefusal(code);
      expect(reading.sentence).toBe(APPLICATION_FAULT_SENTENCE);
      expect(reading.kind).toBe("ours");
      expect(reading.field).toBeNull();
    }
  });

  it("the page renders no refusal prose of its own", () => {
    // Two lists is how the form comes to say something the table does not.
    const source = read(ROUTE);
    expect(source).toContain("readApplicationRefusal");
    expect(source).toContain("refusal.sentence");
    for (const code of AUTHORED_APPLICATION_REFUSALS) {
      expect(source).not.toContain(code);
    }
  });

  it("focuses the field a refusal names", () => {
    // `refusal.field` is an answer the page already holds. Rendering the
    // sentence above thirteen boxes and leaving the reader to find which one
    // would be withholding it.
    const source = read(ROUTE);
    expect(source).toMatch(/querySelector<HTMLElement>\(`\[name="\$\{reading\.field\}"\]`\)/);
    expect(source).toContain("el?.focus()");
  });
});

describe("the form offers what the network stores", () => {
  it("offers the four organisation kinds and no others", () => {
    expect(Object.keys(ORG_TYPE_LABEL).sort()).toEqual([
      "builder",
      "builder_developer",
      "developer",
      "sales_representative",
    ]);
  });

  it("offers the eight Australian state and territory codes", () => {
    expect([...APPLICATION_STATES].sort()).toEqual([
      "ACT",
      "NSW",
      "NT",
      "QLD",
      "SA",
      "TAS",
      "VIC",
      "WA",
    ]);
  });

  it("gives every organisation kind a label rather than a raw value", () => {
    for (const [value, label] of Object.entries(ORG_TYPE_LABEL)) {
      expect(label).not.toContain("_");
      expect(label).not.toBe(value);
    }
  });

  it("is the one list, shared with the console's own form", () => {
    // The console used to carry a private copy. Two copies is how the form
    // and the console come to offer different kinds of business.
    const dialogs = read("src/components/builders-network-organisation-dialogs.tsx");
    expect(dialogs).toContain('from "@/lib/builderApplication.pure"');
    expect(dialogs).not.toMatch(/const ORG_TYPE_LABEL[^=]*=\s*\{/);
  });

  it("names every required box as required", () => {
    // Four are mandatory because the network's columns are NOT NULL. A box
    // the server refuses and the form does not mark is a form that fails on
    // submit for a reason it could have said up front.
    const source = read(ROUTE);
    for (const field of ["legal_name", "contact_name", "contact_email", "org_type"]) {
      const label = new RegExp(`htmlFor="apply-${field}"[^>]*>[^<]*\\(required\\)`);
      expect(source, field).toMatch(label);
    }
  });

  it("gives every posted field a name attribute the refusal can find", () => {
    // `refuse()` focuses by `[name=...]`, so a control with no `name` is a
    // refusal that points at nothing.
    const source = read(ROUTE);
    const posted = [
      "legal_name",
      "trading_name",
      "org_type",
      "abn",
      "acn",
      "contact_name",
      "contact_email",
      "contact_phone",
      "website",
      "suburb",
      "state",
      "postcode",
      "message",
    ];
    for (const field of posted) {
      expect(source, field).toContain(`name="${field}"`);
    }
  });

  it("posts exactly the fields the network reads", () => {
    const source = read(SERVER);
    const block = source.slice(
      source.indexOf("export const APPLICATION_FIELDS"),
      source.indexOf("export const submitBuilderAccessRequest"),
    );
    for (const field of ["legal_name", "org_type", "contact_email", "message"]) {
      expect(block).toContain(`"${field}"`);
    }
    // Nothing lifecycle-shaped may travel from a public form.
    for (const field of ["status", "is_active", "approved", "organisation_id"]) {
      expect(block).not.toContain(`"${field}"`);
    }
  });
});

describe("the console can see what the pipeline did", () => {
  it("mounts the applications panel", () => {
    // A component nothing renders is not shipped, and this one is the ONLY
    // report of an unattended pipeline's outcomes.
    expect(read(CONSOLE)).toMatch(/<AccessRequestsPanel(?![A-Za-z0-9_])/);
    expect(read(CONSOLE)).toContain("listNetworkAccessRequests");
  });

  it("leads with an applicant who was set up and never written to", () => {
    // Refused is visible from its badge and nothing happened. Provisioned
    // with no email is the dangerous one: the organisation exists and its
    // owner is waiting for a message that will never arrive.
    const source = read(PANEL);
    expect(source).toMatch(/status === "provisioned" && !request\.invite_sent/);
    expect(source).toContain("undelivered.length > 0");
  });

  it("renders the network's own codes through the operator reading", () => {
    const source = read(PANEL);
    expect(source).toContain("readNetworkFailure(request.outcome_detail)");
  });

  it("offers no act of its own", () => {
    // Everything an application could do it already did. A second Approve
    // here is how two surfaces come to disagree about what a case is.
    const source = read(PANEL);
    for (const act of ["approveNetworkOrganisation", "suspendNetwork", "inviteNetwork"]) {
      expect(source).not.toContain(act);
    }
  });

  it("names the public path in one place", () => {
    const source = read(PANEL);
    expect(source).toContain('export const APPLICATION_PATH = "/apply/builder"');
    // The route file is the other end of that literal; if they disagree the
    // console links an operator to a page that does not exist.
    expect(read(ROUTE)).toContain('createFileRoute("/apply/builder")');
  });
});
