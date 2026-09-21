/**
 * The re-offer reaches a pass, and it reaches it in the one order that is safe.
 *
 * ## Why this is a SOURCE contract
 *
 * The fault this module exists to prevent is an ABSENCE — a judgement that
 * typechecks, lints, builds and is called by nothing. This repository has paid
 * for that class four times (three builder-portal components, twenty-eight
 * stylesheet rules, `buildPrimeLedgerReconciliation`, and the cascade's own
 * `revoke_grant`), and no behavioural test can see it: exercising the module
 * proves the module works, never that anything asks it.
 *
 * So every assertion below is pinned on the DATA FLOW and on POSITION. A call
 * whose answer is discarded satisfies a mention just as well, and a call in
 * the wrong place is worse than no call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";

const ENGINE = "src/server/cascade-engine.server.ts";
const code = stripComments(readFileSync(ENGINE, "utf8"));

describe("the engine asks for the re-offer", () => {
  it("imports it from the server module and calls it with prime's resolved head", () => {
    expect(code).toContain('from "./cascade/carrierRefresh.server"');
    expect(code).toMatch(/const carrierRefresh = await refreshCarrierRows\(supabase, \{/);
    // The head the pass is ABOUT to deliver, never the event's provenance
    // `source_sha` — which is the push that created the carrier and is exactly
    // the stale value the whole defect turns on.
    expect(code).toMatch(/head: sourceSha,/);
    expect(code).not.toMatch(/head: event\.source_sha/);
  });

  it("acts on the answer rather than merely obtaining it", () => {
    expect(code).toMatch(/if \(carrierRefresh\.refreshed > 0\)/);
    expect(code).toMatch(/passRows = reread\.data \?\? passRows/);
  });

  it("re-reads the queued rows after re-arming them", () => {
    // Without the re-read the row goes back to `queued` and this pass still
    // works the set it read before the refresh — the clone is re-armed and
    // then not visited until the NEXT claim, which is a five-minute delay
    // bought for nothing.
    expect(code).toMatch(/\.eq\("cascade_event_id", event\.id\)\s*\n\s*\.eq\("status", "queued"\)/);
  });

  it("carries the re-offer into every summary the pass writes", () => {
    // Both writers, because a pass ends in exactly two places: handed back
    // (deferred, paused or held on lineage) or settled with a tally.
    expect([...code.matchAll(/withRefreshNote\(summary\)/g)]).toHaveLength(2);
  });
});

describe("it happens in the only order that is safe", () => {
  const at = (needle: string | RegExp): number => {
    const i = typeof needle === "string" ? code.indexOf(needle) : code.search(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it("after prime's head is resolved", () => {
    // It compares delivered heads against this one. Asking before it is read
    // would compare against undefined and re-offer everything, every pass.
    expect(at("sourceSha = br.commit.sha")).toBeLessThan(at("refreshCarrierRows("));
  });

  it("after the claim fence, because it writes result rows", () => {
    // `updateEvent` returns false when a newer claim has taken the event.
    // A zombie invocation that re-armed rows would put a live pass's finished
    // clones back into the queue underneath it.
    expect(at('if (!started) return { ok: false, error: "claim superseded')).toBeLessThan(
      at("refreshCarrierRows("),
    );
  });

  it("before the pass reads the work it will do", () => {
    expect(at("refreshCarrierRows(")).toBeLessThan(at("const queuedRows = passRows"));
  });
});

describe("nothing downstream reads the pre-refresh set", () => {
  it("the tally, the loop and the per-clone notifications all read passRows", () => {
    // Three readers asked what this pass is doing. If one still reads the
    // original query the counts describe a different set from the work —
    // which is the "1 of 3 rendered as the whole fleet" failure by another
    // route.
    expect(code).toContain("const queuedRows = passRows");
    expect(code).toContain("const totalQueued = passRows.length");
    expect(code).toContain("for (const r of passRows)");
  });

  it("queuedRes is read only to seed passRows and to answer the unarmed check", () => {
    // Two legitimate readings survive: the unarmed-event guard, which asks
    // about the ledger before any of this, and the seed itself.
    const reads = [...code.matchAll(/queuedRes\.data/g)];
    expect(reads).toHaveLength(2);
  });
});
