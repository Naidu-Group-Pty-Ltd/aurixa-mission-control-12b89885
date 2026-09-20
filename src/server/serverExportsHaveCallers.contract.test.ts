/**
 * A module is not shipped until something calls it.
 *
 * ## The rule, and what it has already cost here
 *
 * `fleetBlockageRecord.test.ts` opens its own mounted block with this rule and
 * names the price: three builder-portal components and twenty-eight
 * stylesheet rules, merged, deployed and never rendered. Nothing in the gate
 * could see any of them — an unused export typechecks, lints and builds, and
 * a component nobody mounts renders no error.
 *
 * That block then names the repository's live instance:
 * `buildPrimeLedgerReconciliation`, "sitting in it right now with zero call
 * sites" — the one function that computes object-level evidence for
 * `prime_ledger_hole`, documented in three places and reached from nowhere.
 * It has a caller now (`primeLedgerReconciliation.functions.ts`, a card and a
 * page; see `primeLedgerReconciliationMounted.test.ts`).
 *
 * ## Why a second test, when that one already pins the fix
 *
 * Because a test that names ONE orphan cannot see the next one. That is the
 * lesson this repository paid for in the drain lane a day earlier — "a
 * hand-list cannot see the call it does not mention" — and again in
 * `everyGithubLaneYields`, whose own header says the list is derived "so a new
 * lane that reaches GitHub is caught the day it is added rather than the day
 * it exhausts a window".
 *
 * So the set is DERIVED. Every exported `function` in a `*.server.ts` module
 * is asked whether anything references it, and the answer is compared against
 * a frozen list rather than against zero.
 *
 * ## What the freeze measured
 *
 * Scanned 20 Sep 2026 over the whole of `src/`: **633 exported functions
 * across the server modules, of which six have no reference anywhere**. They
 * are frozen below with what each one is, because they are not one kind of
 * thing and the remedies differ — one is a test seam nothing seams, one is a
 * fleet-wide selftest with no door, and one says in its own comment that it is
 * "for notifications and the operator UI" while neither calls it.
 *
 * ## What it deliberately cannot see
 *
 * A name inside a REGEX LITERAL still counts as a caller —
 * `expect(fn).toMatch(/await someFunction\(/)` in a source contract is
 * bookkeeping, not a call, and this scan reads it as one. Telling a regex
 * literal from a division needs a tokeniser, and a tokeniser that gets it
 * wrong invents orphans, which is the failure that gets a gate switched off.
 * The trade is deliberate and it is the same one the strip makes: missing an
 * orphan costs a name this list does not carry; inventing one costs every
 * run. Where a specific function matters that much, it gets its own mounted
 * contract — `primeLedgerReconciliationMounted.test.ts` is exactly that, and
 * it fails on twenty planted ways of unwiring the report.
 *
 * This is a RATCHET, not a ban. It fails on a NEW orphan, and it fails on a
 * frozen entry that has stopped being one — because a list that keeps names
 * it has outgrown is a list nobody trusts, and deleting a line is the right
 * size of chore for having fixed one.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Exported server functions with no reference anywhere in `src/`.
 *
 * Keyed by file and identifier rather than by line, for the reason
 * `edge-missing-names.txt` gives: a line number turns an unrelated edit into a
 * failure and turns a real regression into a rebase.
 */
const FROZEN: ReadonlyArray<string> = [
  // Declares itself "Test seam. Never called in production." — and is not
  // called in a test either, so it seams nothing.
  "src/server/anthropicFederation.server.ts:resetAnthropicAdminToken",
  // A fleet-wide Anthropic reachability sweep with no hook, no button and no
  // schedule. The per-clone half beside it IS reached.
  "src/server/anthropicSelftest.server.ts:runFleetAnthropicSelftest",
  // "Human-readable amount for notifications and the operator UI." Neither
  // the notifications nor the operator UI call it.
  "src/server/api-usage-settlement.server.ts:describeCharge",
  // The read half of the Codex scan client. The start half is reached.
  "src/server/codex-security-client.server.ts:getCodexScan",
  // `bandFor`, directly above it and doing the first half of the same job,
  // has callers. This one does not.
  "src/server/fit-analysis.server.ts:gradeFor",
  // Projects a gate row for a reader. `readGateRow` above it is reached; the
  // projection is not.
  "src/server/payment-gate.server.ts:viewOf",
];

/**
 * This file, which names every frozen orphan and is a caller of none of them.
 *
 * Excluded because it is bookkeeping ABOUT the orphans: leaving it in makes
 * the freeze list itself the reference that clears the entry, so every name
 * added here immediately reads as reached and the second assertion below
 * fails on its own contents. Found by running it.
 */
const THIS_FILE = "src/server/serverExportsHaveCallers.contract.test.ts";

/**
 * Source with comment LINES removed.
 *
 * ## Why stripping is necessary
 *
 * A comment is not a caller, and this codebase comments heavily. The orphan
 * this gate was built for is named in the prose of two modules and a test —
 * `blockageTaxonomy.pure.ts`, `MIGRATION_PIPELINE.md`, `fleetBlockageRecord`
 * — so a scan that reads comments would have reported it reached. Proved by
 * planting: with comments counted, un-wiring the report entirely leaves this
 * gate green.
 *
 * ## Why it is LINE-ORIENTED and not a regex over the file
 *
 * The obvious `/\/\*[\s\S]*?\*\//` is not safe here, and that is measured
 * rather than feared. `backend-provisioning.server.ts:1473` is
 * ``redirectSet.add(`${site}/*`)`` — a `/*` inside a template literal. A
 * file-wide strip opens a comment there and runs to the next `*&#47;`,
 * swallowing `applyAuthConfig`'s declaration and `buildAuthConfigPatch`'s own
 * call site, which then reported as an orphan. A gate that invents a failure
 * is a gate somebody turns off.
 *
 * So a line opens a block only when its first non-space characters are the
 * opener, which a `/*` inside an expression never is. That is deliberately
 * CONSERVATIVE: a trailing `// note` after code survives, so a reference
 * hiding there still counts as a caller. Erring toward missing an orphan is
 * the right direction — the cost is a name this list does not carry, against
 * a false failure on every run.
 */
function code(source: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (inBlock) {
      const close = t.indexOf("*/");
      if (close === -1) {
        out.push("");
      } else {
        inBlock = false;
        out.push(t.slice(close + 2));
      }
      continue;
    }
    if (t.startsWith("//")) {
      out.push("");
      continue;
    }
    if (t.startsWith("/*")) {
      /*
        A comment that CLOSES on its own line leaves code behind it, and this
        codebase writes exactly that shape all over:

            const { retargetCloneRepo } = await import(
              /* @vite-ignore *&#47; "@/lib/_server-shims/clone-repo-retarget.server"
            );

        Asking whether the line ENDS with the closer says no here — it ends
        with the path — so the tracker opened a block and swallowed the rest
        of the module, reporting `retargetCloneRepo` as uncalled while line
        510 calls it. Found by running it. The closer is looked for anywhere
        after the opener, and the tail is kept.
      */
      const close = t.indexOf("*/", 2);
      if (close === -1) {
        inBlock = true;
        out.push("");
      } else {
        out.push(t.slice(close + 2));
      }
      continue;
    }
    out.push(line);
  }
  /*
    And a name inside a QUOTED STRING is not a call either.

    A source contract asserting `expect(source).toContain("someFunction")` is
    bookkeeping about that function, exactly as this file's own freeze list
    is — and this repository is full of them. Measured: un-wiring the report
    entirely still left it reading as reached, on the strength of the
    assertions in `primeLedgerReconciliationMounted.test.ts`.

    Template literals are deliberately LEFT ALONE. A `${…}` holds real code,
    and stripping it would hide genuine calls — false orphans are the failure
    that gets a gate switched off, while a missed one costs a name this list
    does not carry. Measured over the whole of `src/`: stripping quoted
    strings moves the population by nothing and loses no declaration.
  */
  return out
    .join("\n")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

function allSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/\.(ts|tsx)$/.test(p) && p !== THIS_FILE) {
        out.set(p, readFileSync(p, "utf8"));
      }
    }
  };
  walk("src");
  return out;
}

/**
 * Every `export function` / `export async function` in a `*.server.ts`, and
 * whether anything references it.
 *
 * Deliberately narrow. Only a top-level `function` DECLARATION is judged: a
 * `const` export is routinely a value read by a name a scan cannot follow,
 * and a type is not code. Missing a real orphan costs a name this list does
 * not carry; inventing one costs a false failure on every run, which is how a
 * gate comes to be disabled.
 */
function orphanedServerExports(raw: Map<string, string> = allSources()): string[] {
  // The strip lives HERE rather than at the read, so a synthetic corpus can
  // exercise it: a scan handed pre-stripped text would pass every assertion
  // below with the strip deleted.
  const sources = new Map([...raw].map(([f, src]) => [f, code(src)]));
  const decl = /^export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/gm;
  const orphans: string[] = [];

  for (const [file, src] of sources) {
    if (!file.endsWith(".server.ts")) continue;
    for (const m of src.matchAll(decl)) {
      const name = m[1];
      const ref = new RegExp(`\\b${name}\\b`);

      // A caller is any OTHER file that names it — a route, a server
      // function, a component, a test.
      let referenced = false;
      for (const [other, otherSrc] of sources) {
        if (other === file) continue;
        if (ref.test(otherSrc)) {
          referenced = true;
          break;
        }
      }
      // Or a second mention inside its own module: a helper used by the
      // function below it is reached, it simply does not leave the file.
      if (!referenced) {
        referenced = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length > 1;
      }
      if (!referenced) orphans.push(`${file}:${name}`);
    }
  }
  return orphans.sort();
}

describe("every exported server function is reached by something", () => {
  it("has no orphan the freeze does not name", () => {
    const frozen = new Set(FROZEN);
    const fresh = orphanedServerExports().filter((o) => !frozen.has(o));
    expect(
      fresh,
      "A new exported server function has no caller anywhere. An unused export " +
        "typechecks, lints and builds — this is the only gate that can see it. " +
        "Wire it, or delete it, or add it to FROZEN with what it is and why.",
    ).toEqual([]);
  });

  it("names nothing that has stopped being an orphan", () => {
    const orphans = new Set(orphanedServerExports());
    const stale = FROZEN.filter((f) => !orphans.has(f));
    expect(
      stale,
      "These are in FROZEN and now have callers. Delete the lines: a ratchet " +
        "that keeps names it has outgrown stops being read.",
    ).toEqual([]);
  });

  it("the function this whole exercise was about is not among them", () => {
    // The instance `fleetBlockageRecord.test.ts` names by hand. If this ever
    // comes back, the report has been unmounted rather than merely changed.
    const orphans = orphanedServerExports();
    expect(orphans).not.toContain(
      "src/server/primeLedgerReconciliation.server.ts:buildPrimeLedgerReconciliation",
    );
  });

  it("is derived rather than listed, so it can see a name nobody wrote down", () => {
    // The guard on the guard. A scan that found nothing to judge would pass
    // every assertion above while checking nothing at all — the vacuity
    // `everyGithubLaneYields` guards against by the same means.
    const sources = allSources();
    const serverModules = [...sources.keys()].filter((f) => f.endsWith(".server.ts"));
    expect(serverModules.length).toBeGreaterThan(50);
    const declared = serverModules.flatMap((f) => [
      ...sources.get(f)!.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/gm),
    ]);
    expect(declared.length).toBeGreaterThan(400);

    // The exclusion is by PATH, so a rename would silently re-admit this file
    // and clear every frozen entry at once.
    expect(existsSync(THIS_FILE), "THIS_FILE no longer names this file").toBe(true);
    expect(sources.has(THIS_FILE), "this file is in the scanned set").toBe(false);
  });

  /*
    THE STRIP IS ASSERTED DIRECTLY, not inferred from the population.

    Today's corpus happens to give the same six orphans with prose counted and
    with it stripped, so nothing about the FLEET can show that stripping is
    load-bearing. It is, for the next orphan rather than these — the one this
    gate was built for is named in the prose of two modules and a test, and a
    scan that read comments would have called it reached.

    Both shapes below are taken verbatim from this codebase, and both broke a
    previous version of `code()`.
  */
  it("the scan itself judges code, never prose", () => {
    /*
      Asserted on the SCAN and not only on `code()`, because a scan handed
      pre-stripped text passes every strip assertion with the strip deleted.
      A synthetic corpus is the only way to watch it decide.
    */
    const onlyInAComment = new Map([
      ["src/server/x.server.ts", "export function lonely(): void {}\n"],
      ["src/server/y.server.ts", "/* lonely() is described here and called nowhere. */\n"],
    ]);
    expect(orphanedServerExports(onlyInAComment)).toEqual(["src/server/x.server.ts:lonely"]);

    const onlyInAString = new Map([
      ["src/server/x.server.ts", "export function lonely(): void {}\n"],
      ["src/server/y.spec.ts", 'expect(src).toContain("lonely");\n'],
    ]);
    expect(orphanedServerExports(onlyInAString)).toEqual(["src/server/x.server.ts:lonely"]);

    // And a real call still clears it, or the gate is just noise.
    const reallyCalled = new Map([
      ["src/server/x.server.ts", "export function lonely(): void {}\n"],
      ["src/server/y.server.ts", "import { lonely } from './x.server';\nlonely();\n"],
    ]);
    expect(orphanedServerExports(reallyCalled)).toEqual([]);
  });

  it("prose is not a caller", () => {
    const withMention = code(
      ["/*", " * See buildPrimeLedgerReconciliation for why.", " */", "const x = 1;"].join("\n"),
    );
    expect(withMention).not.toContain("buildPrimeLedgerReconciliation");
    expect(withMention).toContain("const x = 1;");

    const trailing = code(["// calls somethingImportant()", "const y = 2;"].join("\n"));
    expect(trailing).not.toContain("somethingImportant");
    expect(trailing).toContain("const y = 2;");
  });

  it("a `/*` inside a template literal opens nothing", () => {
    // `backend-provisioning.server.ts:1473`. A file-wide regex opened a
    // comment here and ran to the next closer, swallowing the declaration of
    // `applyAuthConfig` and the call site of `buildAuthConfigPatch`.
    const src = [
      "function a() {",
      "  redirectSet.add(`${site}/*`);",
      "}",
      "export function stillDeclared(): void {}",
      "const used = stillDeclared;",
    ].join("\n");
    const out = code(src);
    expect(out).toContain("export function stillDeclared");
    expect(out).toContain("const used = stillDeclared;");
  });

  it("a comment that closes mid-line keeps what follows it", () => {
    // `/* @vite-ignore */ "path"` — the import idiom used ~30 times here. A
    // tracker that asked whether the line ENDS with the closer opened a block
    // and swallowed the rest of the module, reporting `retargetCloneRepo` as
    // uncalled while a line below calls it.
    const src = [
      "const { retargetCloneRepo } = await import(",
      '  /* @vite-ignore */ "@/lib/_server-shims/clone-repo-retarget.server"',
      ");",
      "await retargetCloneRepo(a, b);",
    ].join("\n");
    const out = code(src);
    expect(out).not.toContain("@vite-ignore");
    expect(out).toContain("await retargetCloneRepo(a, b);");
  });

  it("the strip removes prose and never a declaration", () => {
    /*
      THE GUARD ON THE STRIP, because it has been wrong twice.

      A file-wide regex opened a comment at ``${site}/*`` inside a template
      literal and swallowed `applyAuthConfig`'s declaration; a line tracker
      that asked whether a line ENDS with the closer opened one at
      `/* @vite-ignore *&#47; "path"` and swallowed the rest of a module,
      reporting a function that IS called as an orphan.

      Both showed up as a scan quietly seeing less code. Counting the
      declarations either side of the strip is the cheapest thing that
      notices, and it is measured: 633 across the server modules, none lost.
    */
    const decl = /^export\s+(?:async\s+)?function\s+[A-Za-z_]\w*/gm;
    let raw = 0;
    let stripped = 0;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p);
        } else if (p.endsWith(".server.ts")) {
          const src = readFileSync(p, "utf8");
          raw += [...src.matchAll(decl)].length;
          stripped += [...code(src).matchAll(decl)].length;
        }
      }
    };
    walk("src");
    expect(raw).toBeGreaterThan(400);
    expect(stripped, "the comment strip is eating real declarations").toBe(raw);
  });
});
