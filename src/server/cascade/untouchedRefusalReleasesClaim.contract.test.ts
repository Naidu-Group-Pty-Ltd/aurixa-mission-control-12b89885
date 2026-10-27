/**
 * A pass that refuses before it writes anything hands its claim back.
 *
 * ## What this is here to make impossible
 *
 * `executeCascade` refuses before it first writes the event when its opening
 * reads fail or a gate holds: the event read, the approval gate, the prime
 * read. The drain treated every refusal as a finished pass and stamped
 * `worker_finished_at` under its fence, which left the event `pending` with
 * both claim columns set. No pass could claim it (`worker_started_at IS
 * NULL`), neither reclaim rule could see it (one needs `worker_finished_at IS
 * NULL`, the other `status = 'running'`), retirement needs an unclaimed event,
 * and head redelivery counted it as a live delivery, so it refused every later
 * head (audit of 27 Oct 2026). A transient PostgREST error was all it took.
 *
 * Asserted on the source, comments stripped, as the drain's other contracts
 * are: the property is which refusals are marked and where the drain reads the
 * mark, which a double of the engine could only agree with.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";
import { isBlockedByApproval } from "@/server/cascade-approvals.server";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
const drain = stripComments(readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8"));

const start = engine.indexOf("export async function executeCascade(");
// Everything before the pass first writes the event.
const beforeFirstWrite = engine.slice(start, engine.indexOf("const updateEvent = async", start));

describe("the engine marks every refusal it makes before writing", () => {
  it("finds the opening of the pass", () => {
    expect(start).toBeGreaterThan(-1);
    expect(beforeFirstWrite.length).toBeGreaterThan(200);
    expect(beforeFirstWrite.length).toBeLessThan(4000);
  });

  it("marks each one untouched, except a pass over an event already settled", () => {
    const refusals = beforeFirstWrite.match(/return \{\s*ok: false,[\s\S]*?\};/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(5);
    for (const r of refusals) {
      if (r.includes("`Already ${event.status}`")) {
        expect(r).not.toContain("untouched");
      } else {
        expect(r, r).toContain("untouched: true");
      }
    }
  });

  it("tells a failed prime read from an unconfigured prime", () => {
    const readFailure = beforeFirstWrite.indexOf("if (primeRes.error)");
    const unconfigured = beforeFirstWrite.indexOf("if (!prime)");
    expect(readFailure).toBeGreaterThan(-1);
    expect(readFailure).toBeLessThan(unconfigured);
  });
});

describe("the drain releases a claim the pass never used", () => {
  const drainOne = drain.slice(
    drain.indexOf("async function drainOne("),
    drain.indexOf("export const Route"),
  );

  it("throws an untouched refusal into the catch that releases claims", () => {
    const release = drainOne.indexOf("if (!res.ok && res.untouched) throw new Error(res.error);");
    expect(release).toBeGreaterThan(-1);
    // Before anything the drain does with an answer, the finished stamp above all.
    expect(release).toBeLessThan(
      drainOne.indexOf("worker_finished_at: new Date().toISOString() })"),
    );
    expect(release).toBeLessThan(drainOne.indexOf("const refund ="));
  });

  it("and that catch hands the claim back, or fails the event at the ceiling", () => {
    const handling = drainOne.slice(drainOne.lastIndexOf("} catch (err) {"));
    expect(handling).toContain("worker_started_at: terminal ? undefined : null");
    expect(handling).toContain("worker_finished_at: terminal ? new Date().toISOString() : null");
    expect(handling).toContain('status: terminal ? "failed" : "pending"');
    expect(handling).toContain('.eq("worker_started_at", claimed.fence)');
  });
});

describe("the approval gate holds when it cannot be read", () => {
  const client = (answer: { data: unknown; error: { message: string } | null }) =>
    ({
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => answer }) }),
      }),
    }) as never;

  it("an unread gate is not an open one", async () => {
    const gate = await isBlockedByApproval(
      client({ data: null, error: { message: "canceling statement due to statement timeout" } }),
      "e1",
    );
    expect(gate).toEqual({
      blocked: true,
      reason: "The approval gate could not be read: canceling statement due to statement timeout",
    });
  });

  it("still opens for an event with no gate, and holds one awaiting its second operator", async () => {
    expect(
      await isBlockedByApproval(
        client({ data: { requires_approval: false, approved_at: null }, error: null }),
        "e1",
      ),
    ).toEqual({ blocked: false });
    expect(
      (
        await isBlockedByApproval(
          client({ data: { requires_approval: true, approved_at: null }, error: null }),
          "e1",
        )
      ).blocked,
    ).toBe(true);
    expect(
      await isBlockedByApproval(
        client({
          data: { requires_approval: true, approved_at: "2026-10-27T00:00:00Z" },
          error: null,
        }),
        "e1",
      ),
    ).toEqual({ blocked: false });
  });
});

describe("a person's retry reopens an event claimable", () => {
  // "Retry N failed" reopened the event with the last pass's claim still on
  // it, so where the inline run never started, or refused before writing, the
  // event sat `pending` with `worker_started_at` set: C3's strand, by hand.
  const page = stripComments(readFileSync("src/routes/cascades.$eventId.tsx", "utf8"));
  const start = page.indexOf("const retryFailed = async () => {");
  const retry = page.slice(start, page.indexOf("toast.info(`Retrying", start));

  it("clears the claim the drain reads, as the drain's own revive does", () => {
    expect(retry.length).toBeGreaterThan(200);
    const reopen = retry.slice(retry.indexOf('.from("cascade_events")'));
    for (const field of [
      'status: "pending"',
      "worker_started_at: null",
      "worker_finished_at: null",
      "next_attempt_at: new Date().toISOString()",
      "attempts: 0",
    ]) {
      expect(reopen, field).toContain(field);
    }
  });
});
