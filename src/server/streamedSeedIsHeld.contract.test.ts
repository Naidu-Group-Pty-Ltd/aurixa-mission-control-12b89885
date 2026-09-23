/**
 * A body that could not be FETCHED is not a migration a clone rejected —
 * including on the streaming half, where #216 did not reach.
 *
 * ## What happened, exactly
 *
 * #216 held a refusal out of `failed` by asking `isUpstreamRateLimit` in the
 * catch around `loadSql`. Within the hour, `npc-test-76b3b3` cleared its
 * five-day block, applied 13 migrations, and stopped on the 40 MB
 * template-library seed with `Streaming blob b92e5e8 failed: HTTP 403` — in
 * `failed`, `status_detail: Migration failed at 20261202000000_…`, named after
 * a migration it had not been sent one statement of.
 *
 * Two independent reasons the fix missed it:
 *
 *   1. The oversize body is not fetched by `loadSql` at all. It is streamed by
 *      `applyChunkedSeed`, which is CALLED FROM INSIDE that catch — so when it
 *      throws, the throw lands in the replay's generic outer catch, which has
 *      no such check and never did.
 *
 *   2. `isUpstreamRateLimit` would have declined it anyway. It requires a 429
 *      or rate-limit wording, deliberately: its own comment explains that
 *      requeuing a bare 403 for three hours would hide a permission fault
 *      behind a quota message. Measured when this fired, the installation was
 *      at ~694 calls against a 5,000/hour window with every lane flowing — so
 *      "quota" was the one reading the evidence ruled out.
 *
 * So the split is STRUCTURAL: the fetch site knows for certain that the fetch
 * is what failed, whatever the status meant. `PrimeBodyUnavailableError` says
 * that, `cloneSaidNothing` is the one predicate both halves ask, and nothing
 * anywhere classifies the 403.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cloneSaidNothing, isUpstreamRateLimit } from "./provisioningBudget";
import { OversizedMigrationError, PrimeBodyUnavailableError } from "./oversizedMigration.pure";
import { stripComments } from "./sourceComments.pure";

const replay = readFileSync("src/server/backend-provisioning.server.ts", "utf8");
const corpus = readFileSync("src/server/prime-backend.server.ts", "utf8");
const healing = readFileSync("src/server/self-healing.server.ts", "utf8");

/** Comments removed: an absence has to be asserted over code. */
const code = (src: string): string =>
  stripComments(src);

describe("the predicate separates blame from remedy", () => {
  it("holds the refusal that actually took a clone out of the fleet", () => {
    // Verbatim shape from `clone_backends.error_message`, 19 Sep 2026.
    const real = new PrimeBodyUnavailableError(
      "20261202000000_seed_template_library_v13_cash_flow_foots.sql",
      "",
      403,
    );
    expect(cloneSaidNothing(real)).toBe(true);
  });

  it("still holds a quota refusal, whatever shape it arrives in", () => {
    expect(
      cloneSaidNothing(new Error("API rate limit exceeded for installation ID 157200201")),
    ).toBe(true);
    expect(cloneSaidNothing({ status: 429 })).toBe(true);
  });

  it("does not hold a migration the clone really rejected", () => {
    // The cost of a false positive is the opposite defect: a clone that
    // genuinely refused a statement would sit in the fleet reporting a wait
    // that never ends.
    expect(cloneSaidNothing(new Error('relation "foo" does not exist'))).toBe(false);
    expect(cloneSaidNothing(new Error("syntax error at or near GRANT"))).toBe(false);
  });

  it("does not hold an oversize refusal, which is this pipeline's own decision", () => {
    // A different hold with a different remedy — carried by the chunking lane
    // rather than waited out. Collapsing them would send an operator to the
    // wrong one.
    expect(cloneSaidNothing(new OversizedMigrationError("x.sql", 40_000_000, 8_388_608))).toBe(
      false,
    );
  });

  it("leaves the narrow predicate exactly as narrow as it was", () => {
    // `isUpstreamRateLimit` answers a different question — whether an attempt
    // is handed back for free — and its narrowness is reasoned in its own
    // comment. Widening it to 403 was the obvious repair and the wrong one.
    expect(isUpstreamRateLimit(new PrimeBodyUnavailableError("x.sql", "", 403))).toBe(false);
  });
});

describe("both fetch sites throw the structural class", () => {
  it("the streaming read does", () => {
    const fn = corpus.slice(
      corpus.indexOf("async function fetchBlobTextStream"),
      corpus.indexOf("\n}\n", corpus.indexOf("async function fetchBlobTextStream")),
    );
    expect(fn).toContain("throw new PrimeBodyUnavailableError(");
  });

  it("the batched read does, and the oversize refusals stay outside it", () => {
    const load = corpus.slice(
      corpus.indexOf("const loadSql = ("),
      corpus.indexOf("const openSqlStream ="),
    );
    expect(load).toContain("throw new PrimeBodyUnavailableError(");
    // The two size refusals are decisions this pipeline made, not failures to
    // reach the prime. Wrapping them would make the replay hold a body it had
    // read perfectly well and chosen not to send.
    const wrapped = load.slice(load.indexOf("try {"), load.indexOf("} catch (e) {"));
    expect(wrapped).not.toContain("oversized(");
  });
});

describe("the streaming half reports a refusal instead of throwing it", () => {
  const seed = replay.slice(
    replay.indexOf("async function applyChunkedSeed"),
    replay.indexOf("// ─── Module Migrations"),
  );

  it("returns the refusal rather than letting it reach the generic catch", () => {
    // The throw is the defect. Everything after it in the replay reads
    // `!success` as "the clone rejected something".
    expect(seed).toContain("upstreamRefusal:");
    const at = seed.indexOf("if (cloneSaidNothing(e))");
    expect(at, "the refusal branch is missing").toBeGreaterThan(-1);
    // Bounded by the rethrow that FOLLOWS the branch, not by a byte count: the
    // rethrow is correct and must stay, so a fixed window that reaches it is
    // measuring the wrong thing. (Two assertions in this change were already
    // rewritten for exactly that.)
    const branch = seed.slice(at, seed.indexOf("throw e;", at));
    expect(branch).toContain("return {");
    expect(branch).not.toContain("throw ");
  });

  it("keeps the cursor for what did land, and claims none when nothing did", () => {
    // A statement is sent as it arrives, so a refusal can land before the
    // first or after hundreds. Asserting "the clone is unchanged" in both
    // cases would be a claim that is sometimes false.
    const branch = seed.slice(seed.indexOf("if (cloneSaidNothing(e))"), seed.indexOf("throw e;"));
    /*
      Field by field rather than as one literal: the cursor gained the body's
      own sha (a position is only a position in the body it was taken in) and
      became multi-line, and a literal match would have read as this rule
      breaking when what changed was the line breaks.
    */
    expect(branch).toMatch(/applied > 0[\s\S]*?migrationId: m\.id/);
    expect(branch).toMatch(/applied > 0[\s\S]*?statementsDone: index/);
    expect(branch).toMatch(/applied > 0[\s\S]*?shape: shape \?\? undefined/);
    // The identity, without which this branch preserves a position the NEXT
    // pass has to refuse — the progress it exists to keep, thrown away.
    expect(branch).toMatch(/applied > 0[\s\S]*?\.\.\.identityOf\(\)/);
    // And nothing at all where no statement landed.
    expect(branch).toMatch(/\}\s*:\s*null,/);
  });

  it("a seed the chunker cannot parse is still a failure, not a hold", () => {
    // `SeedShapeError` means the body WAS read and is not the shape this can
    // send — a person has to act, and holding it would wait for ever.
    //
    // Unless the shape came off the CURSOR, which is a different event
    // entirely: the prime re-released the seed between passes, the file is
    // fine, and telling an operator to apply 41 MB by hand would be the worst
    // available answer. That branch holds and drops the cursor; every other
    // path through here still throws.
    const shape = seed.slice(seed.indexOf("if (e instanceof SeedShapeError)"));
    const window = shape.slice(0, 1_800);
    expect(window).toContain("throw new Error(");
    expect(window).toMatch(/if \(cursorShape\) \{[\s\S]{0,600}?cursor: null/);
    expect(window).toMatch(/if \(cursorShape\) \{[\s\S]{0,600}?changed on the prime/);
    // The hand-apply sentence must stay UNREACHABLE for that case — it is
    // after the cursor branch, not before it.
    expect(window.indexOf("if (cursorShape)")).toBeLessThan(
      window.indexOf("Apply it to this clone by hand"),
    );
  });

  it("the replay records it as a hold and distinguishes it from a budget pause", () => {
    const caller = replay.slice(
      replay.indexOf("const chunked = await applyChunkedSeed("),
      replay.indexOf("sentInChunks = true;"),
    );
    expect(caller).toContain("if (chunked.upstreamRefusal)");
    expect(caller).toContain("heldUpstreamLimited: true");
    // Both stop and both keep the cursor, but a pause resumes on its own while
    // a refusal may be permanent — and a permanent refusal reported as pacing
    // is a clone retrying in silence for ever.
    expect(caller.indexOf("if (chunked.upstreamRefusal)")).toBeLessThan(
      caller.indexOf("if (chunked.stoppedEarly)"),
    );
  });
});

describe("a pass whose only outcome is a hold still says so", () => {
  const fleet = readFileSync("src/server/fleet-migration.server.ts", "utf8");

  it("counts a hold as something that happened", () => {
    // `didNothing` suppresses the whole status write, so a limited-only pass
    // was silent: no `status_detail`, and the row left `failed` with whatever
    // an earlier run had said. The reading written for this case was therefore
    // unreachable in exactly this case.
    const at = fleet.indexOf("const didNothing =");
    expect(at).toBeGreaterThan(-1);
    const expr = fleet.slice(at, fleet.indexOf(";", at));
    expect(expr).toContain("limited.length === 0");
  });

  it("agrees with the up-to-date guard, which already counted it", () => {
    // The two answer the same question about the same pass — "did this
    // establish anything?" — and disagreeing is how one of them goes wrong.
    // Compared as SETS so neither is pinned to the other's order.
    const partsOf = (expr: string) =>
      new Set(
        (expr.match(/\b(successes|failures|blocked|held|limited)\.length === 0/g) ?? []).map(
          (m) => m.split(".")[0],
        ),
      );
    const upToDateAt = fleet.indexOf("out.upToDate++");
    const upToDate = partsOf(fleet.slice(fleet.lastIndexOf("if (", upToDateAt), upToDateAt));
    const nothingAt = fleet.indexOf("const didNothing =");
    const nothing = partsOf(fleet.slice(nothingAt, fleet.indexOf(";", nothingAt)));
    // A match that found nothing would make `every` trivially true, which is
    // the way this kind of assertion usually dies.
    expect(upToDate.size, "the up-to-date guard was not parsed").toBeGreaterThan(2);
    expect(nothing.size, "didNothing was not parsed").toBeGreaterThan(2);
    // `blocked` is deliberately only in `didNothing`: a clone held back behind
    // a withheld version is NOT up to date, but the pass did establish that.
    expect([...upToDate].every((p) => nothing.has(p))).toBe(true);
    expect(nothing.has("limited")).toBe(true);
  });
});

describe("the self-healing lane stops calling a hold a failure", () => {
  it("partitions the holds out of failures", () => {
    expect(code(healing)).toMatch(
      /const failed = \(results \?\? \[\]\)\.filter\(\s*\(r\) => !r\.success && !r\.heldUpstreamLimited && !r\.heldOversize,?\s*\);/,
    );
  });

  it("still throws, so the bounded free retry above it still applies", () => {
    // Reporting the run as succeeded would claim work that did not happen, and
    // `planUpstreamDeferral` reads the thrown error. Only the CLAIM changes.
    expect(healing).toContain("was not sent:");
    expect(code(healing)).toMatch(/if \(held\.length > 0\) \{\s*throw new Error\(/);
  });

  it("names an unread body as unread in the destructiveness gate", () => {
    // Fails closed either way, but an operator reading `offending` is being
    // asked to APPROVE something, and approving a 403 is not a thing anybody
    // can do.
    const gate = healing.slice(
      healing.indexOf("async function assessPendingMigrations"),
      healing.indexOf("async function executeSqlMigration"),
    );
    expect(gate).toContain("PrimeBodyUnavailableError");
    expect(gate).toContain("Approval cannot ");
  });
});

describe("nothing in the hold path decides what the 403 meant", () => {
  it("the class states where, never what", () => {
    const cls = readFileSync("src/server/oversizedMigration.pure.ts", "utf8");
    const body = code(cls.slice(cls.indexOf("export class PrimeBodyUnavailableError")));
    expect(body).not.toMatch(/rate.?limit/i);
    expect(body).not.toMatch(/\bwait\b/i);
    // And it does not claim what reached the clone, which only the caller
    // counted: a refusal on the first read sent nothing, one mid-second-pass
    // sent every statement before it.
    expect(body).not.toContain("unchanged");
  });
});
