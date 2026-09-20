/**
 * The reconciliation report has a caller, a renderer and a door.
 *
 * ## The class this exists to close
 *
 * `buildPrimeLedgerReconciliation` was written, documented in three places and
 * never called. `blockageTaxonomy.pure.ts` names it in the comment defining
 * `prime_ledger_hole` — "the one function that computes object-level evidence
 * for exactly this, had ZERO call sites" — `MIGRATION_PIPELINE.md` documents
 * its verdicts, and `fleetBlockageRecord.test.ts` opens its own mounted block
 * by naming it as the repository's live instance of the defect.
 *
 * This repository has paid for that class twice: three builder-portal
 * components and twenty-eight stylesheet rules, merged, deployed and never
 * rendered. Nothing in the ordinary gate can see it — an unused export
 * typechecks, lints and builds, and a card nobody mounts renders no error.
 *
 * ## Why it is a SOURCE contract
 *
 * The fault is an ABSENCE, and the same argument `everyRouteArms` and
 * `everyGithubLaneYields` give applies: a test that exercises the report
 * cannot see that nothing reaches it. Every assertion below is pinned on the
 * DATA FLOW rather than on a mention, because a call whose result is thrown
 * away satisfies a mention just as well — which is precisely the failure being
 * caught.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

/**
 * Source with comments removed.
 *
 * A module that EXPLAINS why it has no `useEffect` contains the word, and a
 * card that says "nothing here stamps a ledger" contains "stamp". Judging
 * prose as though it were code is how a contract test comes to be satisfied
 * or broken by a sentence — `buildTimeEnvReads.spec.ts` strips for the same
 * reason.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/[^\n]*$/gm, " ");

const PURE = "src/server/primeLedgerReconciliation.pure.ts";
const BUILDER = "src/server/primeLedgerReconciliation.server.ts";
const FN = "src/server/primeLedgerReconciliation.functions.ts";
const CARD = "src/components/prime-ledger-reconciliation-card.tsx";
const PAGE = "src/routes/fleet-manager.tsx";

/** The body of `name`, from its declaration to the end of the file. */
const from = (source: string, marker: string): string => {
  const at = source.indexOf(marker);
  expect(at, `${marker} is not in this module`).toBeGreaterThan(-1);
  return source.slice(at);
};

describe("the report is reachable", () => {
  it("something calls the builder, and keeps what it returns", () => {
    const fn = read(FN);
    // The import, and — the half a mention cannot fake — the result used as
    // the handler's answer rather than computed and dropped.
    expect(fn).toContain("buildPrimeLedgerReconciliation");
    expect(fn).toMatch(/const report = await buildPrimeLedgerReconciliation\(/);
    expect(fn).toContain("return report;");
  });

  it("something renders the card, and the card calls the server function", () => {
    const card = read(CARD);
    expect(card).toContain("readPrimeLedgerReconciliation");
    // `useServerFn` bound AND invoked: an import alone is the defect.
    expect(card).toMatch(/useServerFn\(readPrimeLedgerReconciliation\)/);
    expect(card).toMatch(/await reconcile\(\)/);
    // And the answer is put somewhere the page draws from.
    expect(card).toContain("setReport(result)");

    const page = read(PAGE);
    expect(page).toContain('from "@/components/prime-ledger-reconciliation-card"');
    expect(page).toContain("<PrimeLedgerReconciliationCard />");
  });

  it("the condition names where the evidence is, so the door can be found", () => {
    // A report nobody knows about is the same defect one level up. The
    // blockage row is where an operator meets this condition.
    const taxonomy = read("src/server/cascade/blockageTaxonomy.pure.ts");
    const hole = from(taxonomy, "for (const hole of facts.primeLedgerHoles)");
    expect(hole).toContain("Prime Ledger Reconciliation");
  });

  it("the blockage still refuses to invite a stamp", () => {
    // The pointer is ADDED to the refusal, never in place of it. This
    // classifier reads the prime's ledger and nothing else, so it has no
    // evidence to leave the conservative side on.
    const taxonomy = read("src/server/cascade/blockageTaxonomy.pure.ts");
    const hole = from(taxonomy, "for (const hole of facts.primeLedgerHoles)");
    expect(hole).toContain("prime runs that file");
    expect(hole).toContain("stamping the prime's ledger instead would send this clone");
    // And it no longer asserts the half it cannot see. The ledger is the only
    // thing behind this row; the prime's schema is a different reading.
    expect(hole).not.toContain("has that migration in its repository and has not run it");
    expect(hole).toContain("the prime's ledger does not record that migration");
  });
});

describe("what the report costs, and when", () => {
  it("never runs on mount", () => {
    const card = code(read(CARD));
    // The sibling registry card loads on mount because its reading is one
    // tree listing. This one is up to 120 GitHub blob fetches, and a
    // `useEffect` here would spend that on every visit to the fleet page.
    expect(card).not.toMatch(/useEffect\s*\(/);
    // Started by a press, and by nothing else.
    expect(card).toMatch(/onClick=\{handleRun\}/);
  });

  it("yields BEFORE it spends, and at the measurement floor", () => {
    const fn = read(FN);
    // A scan, not an actor: `githubBudget.pure.ts` states the asymmetry — "a
    // measurement postponed costs a stale number, while an apply postponed
    // costs a clone sitting a migration behind the prime". An operator's
    // finger does not change what the spend is for.
    expect(fn).toContain('role: "scan"');
    expect(fn).not.toContain('role: "actor"');

    // Ordering, sliced to the handler so the import list cannot satisfy it.
    const handler = from(fn, "export const readPrimeLedgerReconciliation");
    const yielded = handler.indexOf("decideSpend({");
    const spent = handler.indexOf("buildPrimeLedgerReconciliation");
    expect(yielded, "the handler never consults the budget").toBeGreaterThan(-1);
    expect(spent, "the handler never reaches the builder").toBeGreaterThan(-1);
    expect(yielded).toBeLessThan(spent);

    // And the refusal returns rather than falling through.
    expect(handler).toContain("if (!spend.proceed)");
  });

  it("attributes its calls to a lane of its own, before any of them", () => {
    const handler = from(read(FN), "export const readPrimeLedgerReconciliation");
    const named = handler.indexOf("beginGithubLane(");
    expect(named).toBeGreaterThan(-1);
    // Before the allowance read, which is itself a round trip to GitHub.
    expect(named).toBeLessThan(handler.indexOf("readGitHubRemaining()"));
    expect(handler).toContain('beginGithubLane("prime-ledger-reconciliation")');
  });

  it("reads through the server, so an RLS filter cannot read as an absent prime", () => {
    // `resolvePrimeSource` returns null on no row, and RLS FILTERS rather
    // than erroring — so a declined read is indistinguishable from a prime
    // that is not configured. The same trap `useAmlV3Flags`, the builder
    // stock flag and the partner surface each paid for.
    const handler = from(read(FN), "export const readPrimeLedgerReconciliation");
    expect(handler).toContain("supabaseAdmin");
    expect(handler).toContain("buildPrimeLedgerReconciliation(supabaseAdmin");
  });

  it("is admin-gated", () => {
    expect(read(FN)).toContain("middleware([requireAdmin])");
  });
});

describe("it is evidence, and it must stay evidence", () => {
  const WRITES = /\.(insert|update|upsert|delete)\s*\(/;

  it("the builder writes nothing, anywhere", () => {
    // The pure module says this three times in its header; the doc says
    // "Nothing here stamps a ledger." Asserted rather than trusted.
    expect(read(BUILDER)).not.toMatch(WRITES);
    expect(read(FN)).not.toMatch(WRITES);
  });

  it("the builder runs no SQL that could change the prime", () => {
    const builder = read(BUILDER);
    /*
      It drives `runSqlOnProject` against the PRIME — the product's own
      database. Both reads must be reads; anything else here is a report that
      can alter the thing it reports on.

      One argument is an inline template and one is a module constant, so the
      constant is RESOLVED rather than asserted against by name: matching
      `LIVE_OBJECTS_SQL` would pass whatever that constant said.
    */
    const calls = [...builder.matchAll(/runSqlOnProject\(\s*primeRef,\s*([\s\S]*?),?\s*\)/g)];
    expect(calls.length, "the prime reads moved or changed shape").toBe(2);

    const resolve = (arg: string): string => {
      const bare = arg.trim().replace(/,$/, "");
      if (/^[A-Z][A-Z0-9_]*$/.test(bare)) {
        const decl = builder.match(new RegExp(`const ${bare} = \`([\\s\\S]*?)\`;`));
        expect(decl, `${bare} is not a template literal in this module`).toBeTruthy();
        return decl![1];
      }
      return bare;
    };

    for (const c of calls) {
      const sql = resolve(c[1]).toLowerCase();
      expect(sql).toContain("select");
      expect(sql).not.toMatch(/\b(insert|update|delete|drop|alter|grant|truncate)\b/);
      // `create` would match `c.relkind` no more than it matches prose, so it
      // is asserted as a STATEMENT rather than as a word.
      expect(sql).not.toMatch(/\bcreate\s+(table|index|view|function|type|sequence)\b/);
    }
  });

  it("the card offers no act at all beyond taking the reading", () => {
    const card = read(CARD);
    const source = code(card);
    /*
      ONE control, and it is the reading.

      A second one would make `satisfied` read as permission, which is the one
      thing the pure module refuses outright — three times in its own header.
      Asserted on the CONTROLS rather than on the word "stamp", because the
      card is required to use that word: it has to say what it does not do.
    */
    expect(source.match(/<Button/g) ?? []).toHaveLength(1);
    expect(source.match(/onClick=/g) ?? []).toHaveLength(1);
    expect(source).toContain("onClick={handleRun}");
    // Nothing on this card may reach a server function but the reading.
    expect(source.match(/useServerFn\(/g) ?? []).toHaveLength(1);
    // And it says what it is not, on the page rather than in a tooltip.
    expect(card).toContain("nothing here stamps a ledger");
  });
});

describe("a body that was never read is drawn apart from one that was", () => {
  it("the builder records WHY, and the size, where a body could not be read", () => {
    const builder = read(BUILDER);
    const c = from(builder, "} catch (e) {");
    expect(c).toContain("unread:");
    expect(c).toContain("OversizedMigrationError");
    expect(c).toContain("bytes:");
    // Still `indeterminate` — a body nobody read did not create anything this
    // module named, and a fourth verdict would have to be handled by every
    // consumer of the three.
    expect(c).toContain('verdict: "indeterminate"');
  });

  it("only the reader that failed to fetch a body may say so", () => {
    /*
      `unread` is an optional field on the shared evidence type, so anything
      importing it could set one. The pure module must not: it is HANDED the
      SQL, so a failure to fetch happened somewhere it cannot see, and a
      module claiming a failure it did not witness is the same class as a
      count standing in for a measurement.
    */
    const pure = code(read(PURE));
    expect(pure).toContain("unread?:");
    expect(pure).not.toMatch(/unread:\s*\{/);
    // The one place that writes it is the one place that caught the throw.
    expect(code(read(BUILDER))).toMatch(/unread:\s*\{/);
  });

  it("the surface draws it as its own reading, not as 'creates nothing'", () => {
    const card = read(CARD);
    /*
      Asserted on the FIELDS the page reads, each with a word boundary.

      The first version of this asserted `toContain("row.unread")`, and a
      planted defect that renamed every read to `row.unreadX` passed it — the
      broken identifier contains the whole of the intact one. A substring
      check on a prefix is satisfied by anything longer, which is the same
      shape as asserting a mention instead of a call.
    */
    expect(card).toMatch(/\brow\.unread\b/);
    // Its own badge, so it is never drawn as the verdict beside it.
    expect(card).toMatch(/if \(row\.unread\)/);
    expect(card).toContain("not read");

    /*
      Its own branch in the row body, and asserted INSIDE that branch.

      Judging the whole file let a second planted defect through: replacing
      the size's guard with `false &&` leaves `row.unread.bytes` in the
      expression it no longer reaches, so a file-wide `toMatch` still found
      it. A slice cannot be satisfied by a mention somewhere the reader never
      sees.
    */
    const opens = card.indexOf("row.unread ? (");
    expect(opens, "the unread row has no branch of its own").toBeGreaterThan(-1);
    const closes = card.indexOf(") : row.missing.length", opens);
    expect(closes, "the unread branch does not sit above the missing-objects line").toBeGreaterThan(
      opens,
    );
    const branch = card.slice(opens, closes);

    expect(branch).toMatch(/\brow\.unread\.why\b/);
    // The size, because 41.7 MB is the whole explanation and a reader who
    // sees it needs no other — drawn on the SIZE being known, never on a
    // constant.
    expect(branch).toMatch(/row\.unread\.bytes\s*!==?\s*null/);
    expect(branch).toContain("row.unread.bytes / 1_048_576");
    // Reported as a subset of indeterminate, so the three verdicts still sum
    // to the row count.
    expect(card).toMatch(/\breport\.summary\.unread\b/);
    expect(card).toContain("never read");
  });
});
