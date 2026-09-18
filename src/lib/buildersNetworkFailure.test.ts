/**
 * What an operator reads when the Builders Network console cannot act.
 *
 * The defect these pin: a live deployment told an operator the network could
 * not be read because `operate_switch_off`, named a remedy in prose ("mint a
 * NULL-clone key"), and offered no way to reach it — while the page that
 * performs it could not even be linked to.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MINT_OPERATE_KEY_REMEDY,
  readNetworkFailure,
  type NetworkFailureReading,
} from "./buildersNetworkFailure.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Every code either surface can hand the reader. */
const MISSION_CONTROL_CODES = [
  "operate_switch_off",
  "status_unreadable",
  "read_failed",
  "signing_key_missing",
  "network_url_unconfigured",
];
const NETWORK_CODES = ["network_unreachable", "unauthorised", "federation_unconfigured"];

describe("the switched-off console", () => {
  it("names the act, and the act is reachable", () => {
    const reading = readNetworkFailure("operate_switch_off");
    expect(reading.blocking).toBe("mission_control");
    expect(reading.remedy).not.toBeNull();
    expect(reading.remedy?.to).toBe("/settings/billing");
    expect(reading.remedy?.search).toEqual({ tab: "keys" });
  });

  it("reads as switched off rather than broken", () => {
    // An operator told a working control "failed" goes hunting for a fault
    // that does not exist. The key row IS the switch; its absence is a state.
    const { sentence } = readNetworkFailure("operate_switch_off");
    expect(sentence).toMatch(/switched off/i);
    expect(sentence).not.toMatch(/\b(failed|error|broken)\b/i);
  });

  it("never shows the operator the transport's own word", () => {
    for (const code of [...MISSION_CONTROL_CODES, ...NETWORK_CODES]) {
      expect(readNetworkFailure(code).sentence).not.toContain(code);
    }
  });
});

describe('"we could not check" is never "you do not have it"', () => {
  it("an unreadable status offers no remedy and claims no state", () => {
    const reading = readNetworkFailure("status_unreadable");
    // Offering "Mint the operate key" here asks an operator to fix something
    // nobody established was broken, and a mint is not free to undo.
    expect(reading.remedy).toBeNull();
    expect(reading.sentence).toMatch(/unknown/i);
    expect(reading.sentence).toMatch(/not a statement that the console is switched off/i);
  });

  it("the cards render it rather than falling through to switched off", () => {
    // `gate?.enabled` is undefined when the status query fails, which is
    // falsy — so every card used to assert its unhappy state on no evidence.
    const source = read("src/routes/builders-network.tsx");
    // All three precondition cards read the status, so all three must say
    // "unknown" rather than their unhappy state when it did not load.
    const rendered = source.match(/readNetworkFailure\("status_unreadable"\)/g) ?? [];
    expect(rendered.length).toBe(3);
  });
});

describe("a remedy is offered only where one can be performed", () => {
  it("the two environment faults name the variable and link nowhere", () => {
    for (const code of ["signing_key_missing", "network_url_unconfigured"]) {
      const reading = readNetworkFailure(code);
      // A link to a page that cannot set an environment variable is a dead
      // control, and a dead control is worse than no control.
      expect(reading.remedy).toBeNull();
      expect(reading.blocking).toBe("mission_control");
    }
    expect(readNetworkFailure("signing_key_missing").sentence).toContain(
      "ANTHROPIC_FEDERATION_PRIVATE_KEY",
    );
    expect(readNetworkFailure("network_url_unconfigured").sentence).toContain(
      "BUILDERS_NETWORK_ADMIN_URL",
    );
  });

  it("a fault on the network's side never sends an operator to our settings", () => {
    for (const code of NETWORK_CODES) {
      const reading = readNetworkFailure(code);
      expect(reading.blocking).toBe("network");
      expect(reading.remedy).toBeNull();
    }
  });

  it("an unexplained HTTP status is the network's, not ours", () => {
    expect(readNetworkFailure("http_502").blocking).toBe("network");
    expect(readNetworkFailure("http_502").remedy).toBeNull();
  });
});

describe("an unrecognised code is humanised, never paraphrased", () => {
  it("unslugs the network's sentence-shaped codes faithfully", () => {
    // The network answers with an open vocabulary. Inventing a friendly
    // meaning would state something nobody measured.
    expect(readNetworkFailure("only_a_suspended_organisation_reinstates").sentence).toBe(
      "Only a suspended organisation reinstates.",
    );
    expect(readNetworkFailure("organisation_not_found").sentence).toBe("Organisation not found.");
  });

  it("keeps the raw code for a technical reader", () => {
    expect(readNetworkFailure("some_new_code").code).toBe("some_new_code");
  });

  it("answers an absent code without inventing a cause", () => {
    for (const empty of [null, undefined, "", "   "]) {
      const reading = readNetworkFailure(empty);
      expect(reading.sentence.length).toBeGreaterThan(0);
      expect(reading.remedy).toBeNull();
      expect(reading.blocking).toBe("unknown");
    }
  });

  it("never returns an empty sentence, or one in transport vocabulary", () => {
    // SCREAMING_SNAKE is allowed and deliberate: an environment variable's
    // name is the thing an operator types, not database vocabulary. What may
    // never appear is a lowercase snake_cased identifier — `operate_switch_off`
    // is the defect this module exists to end.
    const cases = [...MISSION_CONTROL_CODES, ...NETWORK_CODES, "x", "a_b_c", "http_500", "___"];
    for (const code of cases) {
      const reading: NetworkFailureReading = readNetworkFailure(code);
      expect(reading.sentence.trim().length).toBeGreaterThan(0);
      expect(reading.sentence).not.toMatch(/\b[a-z0-9]+_[a-z0-9_]+\b/);
    }
  });
});

describe("a status card and a body say the same thing at two lengths", () => {
  it("every authored fault has a clause short enough for a card", () => {
    for (const code of [...MISSION_CONTROL_CODES, ...NETWORK_CODES]) {
      const { short, sentence } = readNetworkFailure(code);
      expect(short.trim().length).toBeGreaterThan(0);
      // The strip draws four cards across; a four-sentence paragraph in one
      // is why this field exists.
      expect(short.length).toBeLessThanOrEqual(72);
      expect(short.length).toBeLessThan(sentence.length);
      expect(short).not.toContain(code);
    }
  });

  it("an unrecognised code is not paraphrased into a shorter claim", () => {
    // We do not know what it means, so there is one statement, not two.
    const reading = readNetworkFailure("only_a_suspended_organisation_reinstates");
    expect(reading.short).toBe(reading.sentence);
  });

  it("names an HTTP status rather than unslugging it", () => {
    // `http_502` unslugged reads "Http 502.", which is worse than saying what
    // happened. It is the shape the caller invents when the network answered
    // with a status and no body of its own.
    expect(readNetworkFailure("http_502").sentence).toBe(
      "The network answered HTTP 502 and gave no reason.",
    );
  });
});

describe("the console and the page it links to agree", () => {
  it("the remedy lands on a tab the billing route actually validates", () => {
    // This is the contract that was impossible to satisfy before: the route
    // hard-coded defaultValue="overview" and read no search param, so any
    // link to the keys tab silently opened Overview.
    const route = read("src/routes/settings.billing.tsx");
    expect(route).toContain("validateSearch");
    const tab = MINT_OPERATE_KEY_REMEDY.search?.tab;
    expect(tab).toBeTruthy();
    expect(route).toContain(`"${tab}"`);
    expect(route).toContain(`<TabsContent value="${tab}">`);
    // Controlled, or the search param cannot drive it.
    expect(route).toMatch(/<Tabs\b[^>]*\bvalue=\{/);
    expect(route).not.toMatch(/<Tabs\b[^>]*\bdefaultValue=/);
  });

  it("the module's remedy and the card's literal link cannot drift", () => {
    // The card writes `<Link to="/settings/billing" search={{ tab: "keys" }}>`
    // as literals, which TypeScript checks against the route's own search
    // schema — a probe confirms a wrong tab there fails `tsc`. The notice
    // builds its link from this module at runtime, where `to` is a string and
    // that check does not apply. Pinning the two together means the compiler's
    // guard covers both.
    const console_ = read("src/routes/builders-network.tsx");
    const tab = MINT_OPERATE_KEY_REMEDY.search?.tab;
    expect(console_).toContain(
      `<Link to="${MINT_OPERATE_KEY_REMEDY.to}" search={{ tab: "${tab}" }}>`,
    );
  });

  it("there is exactly one place the operate key is minted", () => {
    // Two mint paths is how one of them comes to be wrong. The console links
    // to the existing Keys tab; it must never grow a mint of its own.
    const console_ = read("src/routes/builders-network.tsx");
    expect(console_).not.toContain("createCloneApiKey");
  });
});

describe("the console reads failures through this module", () => {
  const source = read("src/routes/builders-network.tsx");

  it("prints no network failure code as an explanation", () => {
    // The three sites that put `operate_switch_off` on the screen were
    // `description={x.data?.error}` twice and a `${query.data.error}` once.
    //
    // `result.tenant.error` is deliberately NOT covered: it is a database
    // driver's own message from `ensureTenant`, already a sentence, carried in
    // a toast rather than offered as the reason a read failed. Running it
    // through a code reader would dress a real message as a resolved code.
    expect(source).not.toMatch(/description=\{[^}]*\.error[^}]*\}/);
    const networkCodeInterpolation = /\$\{[^}]*(?<!tenant)\.error\}/;
    expect(source).not.toMatch(networkCodeInterpolation);
  });

  it("imports the reader rather than wording failures inline", () => {
    expect(source).toContain("readNetworkFailure");
  });

  it("cards take the clause and the empty state takes the sentence", () => {
    // The status strip is four cards across. Drawing the full explanation in
    // one is the defect this split exists to prevent.
    expect(source).toMatch(/readNetworkFailure\("operate_switch_off"\)\.short/);
    expect(source).toMatch(/readNetworkFailure\("signing_key_missing"\)\.short/);
    expect(source).not.toMatch(/readNetworkFailure\("[a-z_]+"\)\.sentence/);
    // The notice has room, so it carries the whole explanation.
    expect(source).toContain("reading.sentence");
  });
});
