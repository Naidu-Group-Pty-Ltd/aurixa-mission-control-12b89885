// The lead stage mailer composes no filter as a string.
//
// This platform has paid for that construction once already: the AML screening
// consumer's claim predicate was a PostgREST `.or()` with a timestamp
// interpolated into it, it never parsed, and the claim had NEVER ONCE
// succeeded — while the code and its test double agreed with each other the
// whole time, because the only party that disagreed was the server.
// `fleet-migration.server.ts` refuses the same construction in as many words,
// and `workerClaims.contract.test.ts` pins it for the provisioning drain.
//
// It is pinned here because this module's sweep is the ONLY path that raises
// an applicant's acknowledgement once the grace period has elapsed — enqueue
// at t=0 deliberately writes nothing while the clock is still running. A
// filter that silently matched nothing would mean no applicant is ever
// acknowledged, reported as `queued: 0`, which reads exactly like a quiet
// week.
//
// A source scan rather than a behavioural test, for the same reason the
// original defect survived: there is no PostgREST for a unit test to ask, so
// any double would agree with whatever the code did.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const SOURCE = readFileSync(join(process.cwd(), "src/server/lead-stage-emails.server.ts"), "utf8");

/**
 * The file with comments removed. A comment may NAME the forbidden call — the
 * one above this line does, and so does the module's own — so the scan has to
 * read CODE.
 *
 * `stripComments`, never a regex of this test's own. The first version of this
 * file hand-rolled one and `oneCommentStripper.contract.test.ts` failed it on
 * sight, which is the guard working: a second stripper is a second answer to
 * "is this line code", and the two disagree on the cases nobody thought of.
 * Mine already had one — a prose line inside a block comment need not begin
 * with a `*`, so it failed on its own explanation of the rule.
 */
const code = stripComments(SOURCE);

describe("no composed PostgREST filter", () => {
  it("calls `.or(` nowhere in the mailer", () => {
    expect(code).not.toMatch(/\.or\(/);
  });

  it("interpolates no value into any filter argument", () => {
    // `.gte("col", since)` is a typed argument the builder encodes. What is
    // forbidden is a template literal carrying a value INTO the filter string.
    const interpolatedFilter = /\.(or|filter|match)\(\s*`[^`]*\$\{/;
    expect(code).not.toMatch(interpolatedFilter);
  });

  it("is not vacuous — the scan fires on the construction, planted", () => {
    // A source scan that strips too much passes for ever and says nothing.
    // These are the two real shapes, run through the SAME stripper the scan
    // uses — planting them against a second one would prove nothing about it.
    const planted = stripComments(`
      /* A comment may name .or( freely. */
      const { data } = await supabaseAdmin
        .from("waitlist_leads")
        .or(\`created_at.gte.\${since},stage3_booked_at.gte.\${since}\`);
    `);
    expect(planted).toMatch(/\.or\(/);
    expect(planted).toMatch(/\.(or|filter|match)\(\s*`[^`]*\$\{/);

    // And the stripper keeps real code rather than eating the file.
    expect(code).toContain("sweepMissingStageEmails");
    expect(code).toContain("dispatchStageEmails");
  });

  it("still asks the three windows it has to ask", () => {
    // Removing the `.or()` must not quietly remove a window. Each of the three
    // stages dates from its own column, and a sweep that lost one would stop
    // noticing that whole stage — silently, because there is nothing to fail.
    for (const column of ["created_at", "stage2_completed_at", "stage3_booked_at"]) {
      expect(code).toContain(`"${column}"`);
    }
  });
});
