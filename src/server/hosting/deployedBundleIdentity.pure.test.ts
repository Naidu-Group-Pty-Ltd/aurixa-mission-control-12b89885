/**
 * The rule that would have caught it.
 *
 * Every fixture below is taken from the real artefacts measured on 19 Sep
 * 2026, not invented: the prime-naming fallback pair as it appears in
 * `npc-crm-independent`'s entry chunk, and the clone-naming pair as it appears
 * in `npc-client-dashboard`'s.
 */
import { describe, expect, it } from "vitest";
import {
  bundleIdentityReading,
  entryAssetPaths,
  isWrongBackend,
  readBundleIdentity,
  shouldRequestResync,
  verdictIsAboutTheClone,
} from "./deployedBundleIdentity.pure";

const PRIME = "dduzbchuswwbefdunfct";
const CRM_CLONE = "qvuwrvwzjyigptmnijyb";
const DASHBOARD_CLONE = "plisdzywzleljorrphxv";

/** Verbatim from the deployed `index-CZeyBDYv.js`, the build that could not be logged into. */
const WRONG_BACKEND_SOURCE =
  'const Xwe="https://dduzbchuswwbefdunfct.supabase.co",Jwe="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkdXpiY2h1c3d3YmVmZHVuZmN0Iiwicm9sZSI6ImFub24ifQ.sig"';

/** Verbatim from the deployed `index-DWBj1mCq.js`, the one clone that reaches its own project. */
const OWN_BACKEND_SOURCE =
  'const Lwe="https://plisdzywzleljorrphxv.supabase.co",$we="eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiJwbGlzZHp5d3psZWxqb3JycGh4diJ9.sig"';

/** The served HTML of the clone, trimmed to the tags that matter. */
const SERVED_HTML = `<!DOCTYPE html><html><head>
    <title>Dashboard</title>
    <script type="module" crossorigin src="/assets/index-CZeyBDYv.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/vendor-utils-DMnzLHu3.js">
    <link rel="modulepreload" crossorigin href="/assets/vendor-supabase-BKPvlnuC.js">
    <link rel="stylesheet" crossorigin href="/assets/index-Bq9nT2xw.css">
  </head><body><div id="root"></div></body></html>`;

describe("entryAssetPaths", () => {
  it("takes the module entry and its preloaded chunks, and nothing else", () => {
    expect(entryAssetPaths(SERVED_HTML)).toEqual([
      "/assets/index-CZeyBDYv.js",
      "/assets/vendor-utils-DMnzLHu3.js",
      "/assets/vendor-supabase-BKPvlnuC.js",
    ]);
  });

  it("ignores a stylesheet, an off-origin script and a non-js preload", () => {
    const html =
      '<link rel="stylesheet" href="/assets/a.css">' +
      '<script src="https://cdn.example.com/x.js"></script>' +
      '<link rel="preload" href="/assets/b.js" as="script">';
    expect(entryAssetPaths(html)).toEqual([]);
  });

  it("finds nothing in a page that names nothing", () => {
    expect(entryAssetPaths("<html><body>maintenance</body></html>")).toEqual([]);
  });
});

describe("readBundleIdentity", () => {
  const scanned = ["/assets/index-CZeyBDYv.js"];

  it("names the defect when the artefact carries the prime", () => {
    const r = readBundleIdentity({
      source: WRONG_BACKEND_SOURCE,
      scanned,
      ownRef: CRM_CLONE,
      primeRef: PRIME,
    });
    expect(r.verdict).toBe("carries_prime");
    expect(r.primeRefSeen).toBe(true);
    expect(r.ownRefSeen).toBe(false);
    expect(isWrongBackend(r.verdict)).toBe(true);
    // The sentence has to say what it costs, not just which string was found.
    expect(r.detail).toContain("another tenant's database");
  });

  it("passes the artefact that carries its own project", () => {
    const r = readBundleIdentity({
      source: OWN_BACKEND_SOURCE,
      scanned,
      ownRef: DASHBOARD_CLONE,
      primeRef: PRIME,
    });
    expect(r.verdict).toBe("carries_own");
    expect(isWrongBackend(r.verdict)).toBe(false);
  });

  it("refuses to call BOTH a pass", () => {
    const r = readBundleIdentity({
      source: `${OWN_BACKEND_SOURCE};${WRONG_BACKEND_SOURCE}`,
      scanned,
      ownRef: DASHBOARD_CLONE,
      primeRef: PRIME,
    });
    expect(r.verdict).toBe("carries_both");
    expect(isWrongBackend(r.verdict)).toBe(true);
  });

  it("says NOTHING FOUND is a fact about the scan, and is not a pass", () => {
    const r = readBundleIdentity({
      source: "const x=1;",
      scanned,
      ownRef: CRM_CLONE,
      primeRef: PRIME,
    });
    expect(r.verdict).toBe("names_neither");
    expect(isWrongBackend(r.verdict)).toBe(false);
    expect(r.verdict).not.toBe("carries_own");
    expect(r.detail).toContain("what was searched");
  });

  it("separates a probe that never arrived from one that read a broken page", () => {
    const nothing = readBundleIdentity({
      source: "",
      scanned: [],
      ownRef: CRM_CLONE,
      primeRef: PRIME,
    });
    expect(nothing.verdict).toBe("unreachable");
    expect(verdictIsAboutTheClone(nothing.verdict)).toBe(false);

    const noEntry = readBundleIdentity({
      source: "<html></html>",
      scanned: [],
      ownRef: CRM_CLONE,
      primeRef: PRIME,
    });
    expect(noEntry.verdict).toBe("unreadable");
    expect(verdictIsAboutTheClone(noEntry.verdict)).toBe(false);
  });

  it("will not search for a ref it cannot use", () => {
    const r = readBundleIdentity({
      source: WRONG_BACKEND_SOURCE,
      scanned,
      ownRef: "abc",
      primeRef: PRIME,
    });
    expect(r.verdict).toBe("names_neither");
    expect(r.ownRefSeen).toBe(false);
  });

  it("carries the scanned set so an absence can be judged against it", () => {
    const r = readBundleIdentity({
      source: "x",
      scanned: ["/assets/a.js", "/assets/b.js"],
      ownRef: CRM_CLONE,
      primeRef: PRIME,
    });
    expect(r.scanned).toEqual(["/assets/a.js", "/assets/b.js"]);
    expect(r.bytesScanned).toBe(1);
  });

  describe("the site key", () => {
    it("is PRESENT when the scanned set carries it", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const k="0x4AAAAAAE8sm7BR431nOZuj"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        siteKey: "0x4AAAAAAE8sm7BR431nOZuj",
      });
      expect(r.siteKey).toBe("present");
    });

    it("is NOT_SCANNED — never missing — when it is not in the set we read", () => {
      // Measured: the widget is imported lazily and lands in a chunk the HTML
      // does not name. Reporting "absent" from a set that could not contain it
      // is the mistake this vocabulary exists to prevent.
      const r = readBundleIdentity({
        source: OWN_BACKEND_SOURCE,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        siteKey: "0x4AAAAAAE8sm7BR431nOZuj",
      });
      expect(r.siteKey).toBe("not_scanned");
      // And it does not touch the backend verdict.
      expect(r.verdict).toBe("carries_own");
    });

    it("is NO_WIDGET when this clone was never minted one", () => {
      const r = readBundleIdentity({
        source: OWN_BACKEND_SOURCE,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        siteKey: null,
      });
      expect(r.siteKey).toBe("no_widget");
    });
  });

  it("a deployment with no prime configured still gets the own-ref check", () => {
    const r = readBundleIdentity({
      source: OWN_BACKEND_SOURCE,
      scanned,
      ownRef: DASHBOARD_CLONE,
      primeRef: null,
    });
    expect(r.verdict).toBe("carries_own");
    expect(r.primeRefSeen).toBe(false);
  });
});

describe("a build that declares what it resolved", () => {
  const scanned = ["/version.json"];

  it("is believed over any amount of text", () => {
    // The decisive case. A correctly-configured clone's bundle names BOTH its
    // own project and the prime's, because the prime's ref is compiled in as
    // the fallback constant — so the scan alone can only ever say "unproven".
    // The declaration says which one the client actually resolved.
    const r = readBundleIdentity({
      source: `${OWN_BACKEND_SOURCE};${WRONG_BACKEND_SOURCE}`,
      scanned,
      ownRef: DASHBOARD_CLONE,
      primeRef: PRIME,
      declaredRef: DASHBOARD_CLONE,
      declaredSource: "env",
    });
    expect(r.verdict).toBe("carries_own");
    expect(r.via).toBe("manifest");
    expect(isWrongBackend(r.verdict)).toBe(false);
  });

  it("and convicts on the same evidence when it declares the prime", () => {
    const r = readBundleIdentity({
      source: `${OWN_BACKEND_SOURCE};${WRONG_BACKEND_SOURCE}`,
      scanned,
      ownRef: CRM_CLONE,
      primeRef: PRIME,
      declaredRef: PRIME,
      declaredSource: "fallback",
    });
    expect(r.verdict).toBe("carries_prime");
    expect(r.via).toBe("manifest");
    // Says where the value came from, because "the fallback" and "the
    // environment" send an operator to opposite remedies.
    expect(r.detail).toContain("built-in fallback");
  });

  it("names a third project as neither, rather than guessing which", () => {
    const r = readBundleIdentity({
      source: "",
      scanned,
      ownRef: CRM_CLONE,
      primeRef: PRIME,
      declaredRef: "someotherproject0",
      declaredSource: "env",
    });
    expect(r.verdict).toBe("names_neither");
    expect(r.via).toBe("manifest");
  });

  it("falls back to the scan when the declaration is unusable", () => {
    for (const bad of [null, "", "   ", "abc", "NOT-A-REF"]) {
      const r = readBundleIdentity({
        source: WRONG_BACKEND_SOURCE,
        scanned: ["/assets/index-CZeyBDYv.js"],
        ownRef: CRM_CLONE,
        primeRef: PRIME,
        declaredRef: bad,
        declaredSource: "env",
      });
      expect(r.via).toBe("scan");
      expect(r.verdict).toBe("carries_prime");
    }
  });

  it("a scan-derived reading still says it was a scan", () => {
    const r = readBundleIdentity({
      source: OWN_BACKEND_SOURCE,
      scanned: ["/assets/index-DWBj1mCq.js"],
      ownRef: DASHBOARD_CLONE,
      primeRef: PRIME,
    });
    expect(r.via).toBe("scan");
  });
});

describe("shouldRequestResync", () => {
  const artefact = "/assets/index-CZeyBDYv.js";

  it("asks for one on a wrong-backend reading nobody has acted on", () => {
    const d = shouldRequestResync({ verdict: "carries_prime", artefact, lastResyncArtefact: null });
    expect(d.resync).toBe(true);
  });

  it("asks for one on an ambiguous reading too — unproven is not proven", () => {
    expect(
      shouldRequestResync({ verdict: "carries_both", artefact, lastResyncArtefact: null }).resync,
    ).toBe(true);
  });

  it("does NOT ask twice for the same artefact", () => {
    // A rebuild that produced the same bytes is evidence about the source, not
    // about what was published. Grinding at it spends a build per sweep for ever.
    const d = shouldRequestResync({
      verdict: "carries_prime",
      artefact,
      lastResyncArtefact: artefact,
    });
    expect(d.resync).toBe(false);
    expect(d.reason).toContain("clone's own source");
  });

  it("DOES ask again once the rebuild produced a different artefact", () => {
    const d = shouldRequestResync({
      verdict: "carries_prime",
      artefact: "/assets/index-NEWHASH.js",
      lastResyncArtefact: artefact,
    });
    expect(d.resync).toBe(true);
  });

  it("never asks on a healthy reading, or on one about our own probe", () => {
    for (const verdict of ["carries_own", "names_neither", "unreachable", "unreadable"] as const) {
      expect(shouldRequestResync({ verdict, artefact, lastResyncArtefact: null }).resync).toBe(
        false,
      );
    }
  });

  it("never asks when the reading cannot be attributed to an artefact", () => {
    expect(
      shouldRequestResync({ verdict: "carries_prime", artefact: null, lastResyncArtefact: null })
        .resync,
    ).toBe(false);
  });
});

describe("bundleIdentityReading", () => {
  it("never renders 'not yet read' as a pass", () => {
    const never = bundleIdentityReading({ verdict: null });
    expect(never.tone).not.toBe("success");
    expect(never.label).toBe("never read");
    // The distinction is the whole point: a card that draws nothing here
    // cannot be told apart from one that checked and was happy.
    expect(never.detail).toContain("not the same as having checked");
  });

  it("gives the wrong backend the strongest tone there is", () => {
    expect(bundleIdentityReading({ verdict: "carries_prime" }).tone).toBe("destructive");
  });

  it("does not colour an ambiguous or unsearchable reading as either extreme", () => {
    for (const v of ["carries_both", "names_neither"]) {
      const r = bundleIdentityReading({ verdict: v });
      expect(r.tone).toBe("warning");
    }
  });

  it("treats our own failed probe as neutral — it says nothing about the clone", () => {
    for (const v of ["unreachable", "unreadable"]) {
      expect(bundleIdentityReading({ verdict: v }).tone).toBe("neutral");
    }
  });

  it("passes only the one verdict that names the clone's own project", () => {
    expect(bundleIdentityReading({ verdict: "carries_own" }).tone).toBe("success");
  });

  it("prefers the probe's own sentence over the generic one", () => {
    const r = bundleIdentityReading({
      verdict: "carries_prime",
      detail: "The bundle names the PRIME's project (dduzbchuswwbefdunfct).",
    });
    expect(r.detail).toContain("dduzbchuswwbefdunfct");
  });

  it("every verdict the reader can produce has a reading, and none falls through to the default", () => {
    const verdicts = [
      "carries_own",
      "carries_prime",
      "carries_both",
      "names_neither",
      "unreadable",
      "unreachable",
    ] as const;
    for (const v of verdicts) {
      expect(bundleIdentityReading({ verdict: v }).label).not.toBe("never read");
    }
  });
});
