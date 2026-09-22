/**
 * The rule that would have caught it.
 *
 * Every fixture below is taken from the real artefacts measured on 19 Sep
 * 2026, not invented: the prime-naming fallback pair as it appears in
 * `npc-crm-independent`'s entry chunk, and the clone-naming pair as it appears
 * in `npc-client-dashboard`'s.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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

  // `VITE_AURIXA_BILLING_UID` is inlined at BUILD time, so "published to the
  // hosting project" and "in the artefact the customer downloaded" are
  // different claims — and only the second decides where a purchase goes.
  describe("the billing identity", () => {
    const UID = "preflight-property-group";

    it("is OWN when the artefact carries this clone's own identity", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const b="${UID}"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: UID,
      });
      expect(r.billingUid).toBe("own");
    });

    // The one that matters. This is not "we could not find it" — it is "we
    // found the built-in instead", which means the chunk carrying the identity
    // WAS read and the identity in it is the prime's.
    it("is FALLBACK when the built-in is there and the clone's own is not", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const b="npc-prime"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: UID,
      });
      expect(r.billingUid).toBe("fallback");
      // And it says nothing about the backend, because they fail apart: this
      // clone is serving its own database and crediting the prime.
      expect(r.verdict).toBe("carries_own");
    });

    // The built-in is compiled into EVERY build as the fallback constant, so a
    // correctly configured clone's artefact contains both. Reading "the
    // prime's is present" as the fault would condemn every healthy clone —
    // the same trap `carries_both` records for the backend ref.
    it("is OWN even though the built-in is in the same artefact", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const f="npc-prime",b="${UID}"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: UID,
      });
      expect(r.billingUid).toBe("own");
    });

    it("is NOT_SCANNED — a statement about the scan — when neither is in what we read", () => {
      const r = readBundleIdentity({
        source: OWN_BACKEND_SOURCE,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: UID,
      });
      expect(r.billingUid).toBe("not_scanned");
    });

    it("is NONE when the clone has no identity recorded", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const f="npc-prime"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: null,
      });
      expect(r.billingUid).toBe("none");
    });

    it("the prime's own build reads OWN rather than condemning itself", () => {
      const r = readBundleIdentity({
        source: `${OWN_BACKEND_SOURCE};const b="npc-prime"`,
        scanned,
        ownRef: DASHBOARD_CLONE,
        primeRef: PRIME,
        billingUid: "npc-prime",
      });
      expect(r.billingUid).toBe("own");
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

describe("the artefact a re-sync is keyed on must survive a rebuild", () => {
  /*
    The guard `shouldRequestResync` relies on is "the artefact I last requested
    a rebuild for came back unchanged" — which reads as "I tried that and it
    did not help". That only works if an unchanged FAULT yields an unchanged
    artefact.

    It did not, on the declared path. The artefact was `build:<buildId>` from
    `version.json`, and a build id is different on every deployment by
    construction. So each corrective rebuild minted a new id, the next probe
    read a new artefact, the guard never fired, and the sweep queued another
    rebuild — indefinitely, spending a deployment every time.

    Raised by an automated review on this branch before it merged. Asserted
    here as the PROPERTY rather than as the expression, because the expression
    is what was wrong.
  */
  it("a rebuild that does not fix the fault stops after one attempt", () => {
    const fault = "declared:env:dduzbchuswwbefdunfct";
    const first = shouldRequestResync({
      verdict: "carries_prime",
      artefact: fault,
      lastResyncArtefact: null,
    });
    expect(first.resync, "the first look asks for the rebuild").toBe(true);

    // The rebuild happened. A NEW build was published and it declares the same
    // wrong ref — so the artefact is the same, and the guard fires.
    const second = shouldRequestResync({
      verdict: "carries_prime",
      artefact: fault,
      lastResyncArtefact: fault,
    });
    expect(second.resync, "and the second look does not ask again").toBe(false);
  });

  it("a build id would have made that guard unreachable", () => {
    // The shape of the defect, kept as an executable statement of it: two
    // readings of the SAME unfixed fault carrying two build ids are two
    // different artefacts, so the guard is asked a question it can only
    // answer "no" to.
    const a = shouldRequestResync({
      verdict: "carries_prime",
      artefact: "build:abc123",
      lastResyncArtefact: "build:def456",
    });
    expect(a.resync, "which is exactly the loop").toBe(true);
  });

  it("a build wrong in a DIFFERENT way earns one more attempt", () => {
    // Not a loop: a different declared ref is a different fault, and the one
    // remedy this has may genuinely fix it.
    const d = shouldRequestResync({
      verdict: "carries_prime",
      artefact: "declared:env:otherref",
      lastResyncArtefact: "declared:env:dduzbchuswwbefdunfct",
    });
    expect(d.resync).toBe(true);
  });
});

describe("a bundle carrying the prime's billing identity is its own reason to rebuild", () => {
  const artefact = "own:dduzbchuswwbefdunfct";

  it("re-syncs on a HEALTHY backend whose artefact falls back to the prime's uid", () => {
    // They fail apart. A clone can serve its own database perfectly while
    // every purchase made on it credits the prime.
    const d = shouldRequestResync({
      verdict: "carries_own",
      billingUid: "fallback",
      artefact,
      lastResyncArtefact: null,
    });
    expect(d.resync).toBe(true);
    expect(d.reason).toMatch(/credit the prime/);
  });

  it("does not re-sync on own, not_scanned or none", () => {
    for (const billingUid of ["own", "not_scanned", "none"] as const) {
      expect(
        shouldRequestResync({
          verdict: "carries_own",
          billingUid,
          artefact,
          lastResyncArtefact: null,
        }).resync,
      ).toBe(false);
    }
  });

  it("obeys the same once-per-artefact guard", () => {
    // A rebuild that produced the same artefact did not help, and grinding at
    // it is what the guard exists to stop — whichever fault drove it.
    const d = shouldRequestResync({
      verdict: "carries_own",
      billingUid: "fallback",
      artefact,
      lastResyncArtefact: artefact,
    });
    expect(d.resync).toBe(false);
  });

  it("a caller that did not read it is unchanged", () => {
    expect(
      shouldRequestResync({ verdict: "carries_own", artefact, lastResyncArtefact: null }).resync,
    ).toBe(false);
    expect(
      shouldRequestResync({ verdict: "carries_prime", artefact, lastResyncArtefact: null }).resync,
    ).toBe(true);
  });
});

describe("the server keys the declared path on the fault, not the build", () => {
  const source = readFileSync(
    new URL("./deployedBundleIdentity.server.ts", import.meta.url),
    "utf8",
  );
  const bare = source.replace(/\/\/[^\n]*/g, " ");

  it("no artefact is derived from version.json's buildId", () => {
    // Line comments only: this file's own prose names `buildId`, and a
    // block-comment strip on a source carrying `/**` inside a line comment
    // deletes real code (measured elsewhere in this repo at 13,438 chars).
    expect(bare).not.toMatch(/artefact:\s*buildIdOf\(/);
    expect(bare).toMatch(/artefact:\s*declaredFaultOf\(/);
  });
});
