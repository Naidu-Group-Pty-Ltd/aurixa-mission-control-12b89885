import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";
import { AUDIT_CADENCE_MINUTES } from "./convergenceReading.pure";
import { BLOCKAGE_POLICY, type BlockageClass } from "./blockageTaxonomy.pure";

/**
 * Step 7 puts a reading in front of a person, and the shipping order puts it
 * last because **a card is a claim that the reading under it is true**. These
 * assert the properties that make the claim honest, by source position rather
 * than by reading the code and believing it.
 */
const panel = readFileSync("src/components/clone-convergence-panel.tsx", "utf8");
const panelCode = stripNonCode(panel);
const fn = stripNonCode(readFileSync("src/server/convergence.functions.ts", "utf8"));
const card = stripNonCode(readFileSync("src/components/clone-sync-status-card.tsx", "utf8"));
const migration = readFileSync(
  "supabase/migrations/20260918140000_convergence_observations.sql",
  "utf8",
);

describe("the reading is shown, and shown beside the pointer", () => {
  it("something renders the panel", () => {
    // A component is not shipped until something renders it. This programme's
    // sibling repository shipped an entire design language with three
    // components nobody mounted; an unused export typechecks, lints and builds.
    expect(card).toContain("<CloneConvergencePanel");
    expect(card).toContain('from "@/components/clone-convergence-panel"');
  });

  it("it is mounted INSIDE the card that draws the pointer", () => {
    // Not a sibling card. The two readings answer one question and the whole
    // value is in seeing them together — a separate card lets an operator read
    // the green pill and stop.
    const pill = card.indexOf("<StatusPill");
    const panelMount = card.indexOf("<CloneConvergencePanel");
    expect(pill).toBeGreaterThan(-1);
    expect(panelMount).toBeGreaterThan(pill);
    // Same <CardContent>: the panel sits above the latest-run block, and there
    // is exactly one CardContent in this file.
    expect(card.match(/<CardContent/g)?.length).toBe(1);
  });
});

describe("the client/server seam", () => {
  /*
    `src/server/**` is DENIED to the client environment by the build's
    import-protection plugin, and the first version of this panel imported its
    label tables from the pure module — which builds and typechecks and lints
    and then fails the bundle, on the path the router happens to reach.

    A component that may import a server module may import that module's
    dependencies, which is how a database client ends up in a browser bundle.
    So the rule is stated here rather than left to a plugin to notice: a client
    component may name a server TYPE (erased before the bundler sees it) and
    may call a `createServerFn` (rewritten into an RPC bridge). It may not
    import a server VALUE.
  */
  const valueImportFromServer = /import\s+(?!type\s)\{([^}]*)\}\s+from\s+"@\/server\/([^"]+)"/g;

  it("the panel imports no server value but the server function itself", () => {
    for (const m of panel.matchAll(valueImportFromServer)) {
      const names = m[1]
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith("type "));
      expect(names, `${m[2]} is imported for values: ${names.join(", ")}`).toEqual([
        "readCloneConvergence",
      ]);
    }
  });

  it("the words live where the client may read them", () => {
    const labels = readFileSync("src/lib/convergenceLabels.ts", "utf8");
    // Types only, or the seam moves rather than being crossed.
    for (const m of labels.matchAll(valueImportFromServer)) {
      throw new Error(`convergenceLabels imports a server value from ${m[2]}`);
    }
    expect(panel).toContain('from "@/lib/convergenceLabels"');
  });

  it("the type-only shims carry no runtime value at all", () => {
    for (const f of [
      "src/server/cascade/convergenceReading.types.ts",
      "src/server/cascade/blockageTaxonomy.types.ts",
    ]) {
      const code = stripNonCode(readFileSync(f, "utf8"));
      // `export type { … }` and nothing else. A single `export const` here
      // would put a server value one import away from the browser again.
      expect(code.replace(/export type \{[^}]*\} from "[^"]+";/g, "").trim()).toBe("");
    }
  });
});

describe("it reads through the server", () => {
  it("the panel never queries a table from the browser", () => {
    // RLS FILTERS rather than erroring, so a refused browser read returns []
    // with HTTP 200 — which is exactly the state this panel has to keep apart
    // from "nothing measured yet". Third surface in this fleet to meet that
    // trap; the rule is theirs.
    expect(panelCode).not.toContain("supabase.from(");
    expect(panelCode).not.toContain('from "@/integrations/supabase/client"');
  });

  it("the server function distinguishes a failed read from an empty one", () => {
    expect(fn).toContain("observation.error");
    expect(fn).toContain('kind: "unavailable"');
    expect(fn).toContain("blockages.error");
  });

  it("a failed blockage read is null and never an empty list", () => {
    // "Nothing is blocking this clone" is a claim, and a read that did not
    // happen cannot make it.
    expect(fn).toMatch(/blockages\.error\s*\n?\s*\?\s*null/);
  });
});

describe("it measures and never repairs", () => {
  it("the panel and its server function write nothing", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) {
      expect(fn, `server function must not ${forbidden}`).not.toContain(forbidden);
      expect(panelCode, `panel must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("it cannot reach the engine", () => {
    for (const forbidden of ["runCascade", "processClone", "getAppOctokit", "cascade_events"]) {
      expect(fn, `server function must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("what an operator is shown", () => {
  it("no blockage class name is ever rendered", () => {
    // The taxonomy already carries a sentence for each one. Rendering the key
    // is the defect a test on the partner roster already forbids.
    for (const cls of Object.keys(BLOCKAGE_POLICY) as BlockageClass[]) {
      expect(panel, `"${cls}" must not be drawn`).not.toContain(`"${cls}"`);
    }
  });

  it("the owner is translated rather than printed", () => {
    expect(panelCode).toContain("OWNER_LABEL");
    for (const owner of ["machinery", "operator", "prime_author", "account_owner"]) {
      // The key may appear once, as a key of the translation table. It must
      // never be the value.
      const asValue = new RegExp(`:\\s*"${owner}"`);
      expect(panel, `"${owner}" must not be a rendered value`).not.toMatch(asValue);
    }
  });

  it("the panel draws the taxonomy's prose, not the row's raw detail alone", () => {
    expect(panelCode).toContain("b.what");
  });
});

describe("the staleness threshold is tied to the cadence the cron actually uses", () => {
  it("matches the audit's schedule in its own migration", () => {
    // A threshold derived from a cadence nobody states is how the two come to
    // disagree. This reads the schedule rather than trusting the constant.
    const m = migration.match(/'cascade-audit',\s*'([^']+)'/);
    expect(m, "the cascade-audit schedule was not found in its migration").toBeTruthy();
    const minuteField = m![1].split(/\s+/)[0];
    const minutes = minuteField.split(",").map((n) => Number(n));
    expect(minutes.length).toBeGreaterThan(1);
    expect(minutes.every((n) => Number.isInteger(n))).toBe(true);

    const gaps = minutes.slice(1).map((n, i) => n - minutes[i]);
    // …and the wrap from the last minute of one hour to the first of the next.
    gaps.push(60 - minutes[minutes.length - 1] + minutes[0]);
    for (const g of gaps) expect(g).toBe(AUDIT_CADENCE_MINUTES);
  });
});
