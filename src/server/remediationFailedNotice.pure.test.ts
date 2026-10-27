import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import {
  decideRemediationFailedNotice,
  describeRemediationFailure,
  FINGERPRINT_ERROR_CHARS,
  normaliseRemediationError,
  remediationFailedUrl,
  remediationFailureFingerprint,
} from "./remediationFailedNotice.pure";

const DEPLOY = "edge_function_deploy";

/*
  The bodies production wrote, verbatim from `notifications` on 27 Oct 2026.
  `\\n` is the two characters the Management API's JSON carried, not a newline.
*/
const OVERSIZE_1 =
  'all 1 function deploys failed: Deploy failed for ai-dashboard-agent: 413 — {"message":"request entity too large"}';
const OVERSIZE_2 =
  'all 2 function deploys failed: Deploy failed for ai-dashboard-agent: 413 — {"message":"request entity too large"}';
const OVER_5MB =
  'all 1 function deploys failed: Deploy failed for generate-investment-report: 413 — {"message":"Function source code exceeds the maximum deployment size (5 MB). Reduce the size of your function and try again."}';
const NOT_FOUND_1 =
  "all 1 function deploys failed: Not Found - https://docs.github.com/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow";
const NOT_FOUND_2 =
  "all 2 function deploys failed: Not Found - https://docs.github.com/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow";
const ESM_TIMEOUT =
  "all 1 function deploys failed: Deploy failed for manage-agent-models: 400 — " +
  '{"message":"Failed to bundle the function (reason: Fetch \'https://esm.sh/@supabase/supabase-js@2.45.0\' timed out after 10s\\n' +
  '    at file:///tmp/user_fn_umrtusxohxjxzodxorim_4e275d45-b6fc-4f83-aea8-9c6761abd27a_4220/source/manage-agent-models/index.ts:9:30)."}';

/** Every `remediation_failed` notice from 11 to 26 Oct 2026, per clone, oldest first. */
const PRODUCTION: Record<string, Array<[body: string, times: number]>> = {
  "NPC Client Dashboard": [
    [OVERSIZE_1, 1],
    [OVERSIZE_2, 28],
    [NOT_FOUND_2, 1],
  ],
  "NPC CRM Independent": [
    [OVER_5MB, 26],
    [NOT_FOUND_1, 1],
  ],
  "NPC Test": [
    [ESM_TIMEOUT, 1],
    [OVERSIZE_1, 1],
    [OVERSIZE_2, 26],
    [NOT_FOUND_2, 1],
  ],
  "Preflight Property Group": [
    [OVERSIZE_1, 1],
    [OVERSIZE_2, 28],
    [NOT_FOUND_2, 1],
  ],
};

/**
 * The server's loop, without the server: a notice stands until it is read, and
 * one is filed only when the rule says so. Nobody read any of the 116.
 */
function replay(
  failures: Array<{ clone: string; error: string }>,
  opts: { readAfterEach?: boolean } = {},
): number {
  const standing = new Set<string>();
  let filed = 0;
  for (const f of failures) {
    const key = `${f.clone}|${remediationFailureFingerprint({ actionType: DEPLOY, error: f.error })}`;
    const decision = decideRemediationFailedNotice({ ok: true, standing: standing.has(key) });
    if (!decision.file) continue;
    filed += 1;
    if (!opts.readAfterEach) standing.add(key);
  }
  return filed;
}

function productionFailures(): Array<{ clone: string; error: string }> {
  const out: Array<{ clone: string; error: string }> = [];
  for (const [clone, bodies] of Object.entries(PRODUCTION)) {
    for (const [error, times] of bodies) {
      for (let i = 0; i < times; i++) out.push({ clone, error });
    }
  }
  return out;
}

describe("remediation_failed speaks once per standing fault", () => {
  it("replayed over the 116 notices production filed, files 9", () => {
    const failures = productionFailures();
    expect(failures).toHaveLength(116);
    // One per fault per clone: the oversize bundle and the Not Found on three
    // clones, the 5 MB bundle and the Not Found on the CRM line, and NPC
    // Test's bundler timeout besides.
    expect(replay(failures)).toBe(9);
  });

  it("a notice somebody has read no longer holds the next one back", () => {
    // Reading is the acknowledgement. A fault that outlives it speaks again,
    // so the rule can never silence a failure for good.
    const same = Array.from({ length: 5 }, () => ({ clone: "NPC Test", error: OVERSIZE_2 }));
    expect(replay(same, { readAfterEach: true })).toBe(5);
    expect(replay(same)).toBe(1);
  });

  it("the batch count would have kept three duplicates alive on its own", () => {
    // Raw equality reads `all 1` and `all 2` over the same 413 on the same
    // function as two faults, on each of the three clones that drew both.
    const raw = new Set(productionFailures().map((f) => `${f.clone}|${f.error}`));
    expect(raw.size).toBe(12);
    expect(normaliseRemediationError(OVERSIZE_1)).toBe(normaliseRemediationError(OVERSIZE_2));
  });
});

describe("the error is normalised, and only its volatile parts are", () => {
  const fp = (error: string, actionType = DEPLOY) =>
    remediationFailureFingerprint({ actionType, error });

  it("a bundler timeout in a new scratch directory is the same timeout", () => {
    const again = ESM_TIMEOUT.replace(
      "4e275d45-b6fc-4f83-aea8-9c6761abd27a_4220",
      "0b9c1f2e-77aa-4c1d-9e3f-1234567890ab_118",
    );
    expect(fp(again)).toBe(fp(ESM_TIMEOUT));
    // The project ref in the path is the clone's own and stays: it is not volatile.
    expect(normaliseRemediationError(ESM_TIMEOUT)).toContain("user_fn_umrtusxohxjxzodxorim_<id>/");
  });

  it("ignores the instant, the epoch and the time of day", () => {
    const a = "rate limit window closed at 2026-10-21T07:32:25.702Z (reset 1761031945)";
    const b = "rate limit window closed at 2026-10-24 19:02:11+00 (reset 1761332531000)";
    expect(fp(a)).toBe(fp(b));
    expect(fp("Retry-After: Mon, 27 Oct 2026 08:21:00 GMT")).toBe(
      fp("Retry-After: Tue, 28 Oct 2026 14:05:59 GMT"),
    );
    expect(fp("stalled since 08:21:00")).toBe(fp("stalled since 23:59:59.123"));
  });

  it("ignores run ids, job ids, digests and attempt counters", () => {
    expect(fp("workflow run 18734512345 failed")).toBe(fp("workflow run 18734599999 failed"));
    expect(fp("see /actions/runs/18734512345/jobs/53311102233")).toBe(
      fp("see /actions/runs/1/jobs/2"),
    );
    expect(fp("blob 3f1c0a9e2b7d4c6f8e0a1b2c3d4e5f6a7b8c9d0e is missing")).toBe(
      fp("blob 9ae0c4d1 is missing"),
    );
    expect(fp("gave up after 4 attempts")).toBe(fp("gave up after 30 attempts"));
    expect(fp("attempt 3 of 30 failed")).toBe(fp("attempt 29/30 failed"));
    expect(fp("attempts: 7 — still refused")).toBe(fp("attempts: 8 — still refused"));
  });

  it("keeps what tells two faults apart", () => {
    // A status is not volatile: a 400 is a bundling failure, a 413 a size one.
    expect(fp(OVERSIZE_2)).not.toBe(fp(OVERSIZE_2.replace(": 413 —", ": 400 —")));
    // A second function failing is a second fault.
    expect(fp(OVERSIZE_2)).not.toBe(
      fp(OVERSIZE_2.replace("ai-dashboard-agent", "generate-investment-report")),
    );
    // The same words from a different lane are a different action failing.
    expect(fp(OVERSIZE_2)).not.toBe(fp(OVERSIZE_2, "sql_migration"));
    // A migration version names WHICH migration, and the lane stops at the
    // first one that fails, so a new version failing means the first got
    // through. It is never mistaken for an epoch or an id.
    expect(fp("migration 20261018090000 failed: permission denied", "sql_migration")).not.toBe(
      fp("migration 20261019120000 failed: permission denied", "sql_migration"),
    );
    // Nor is a slug or a clone's repository suffix mistaken for a digest.
    expect(normaliseRemediationError("npc-crm-independent-6505dc: ai-dashboard-agent")).toBe(
      "npc-crm-independent-6505dc: ai-dashboard-agent",
    );
    // The docs URL GitHub returns names an anchor, not an id.
    expect(normaliseRemediationError(NOT_FOUND_2)).toContain(
      "workflow-runs#list-workflow-runs-for-a-workflow",
    );
  });

  it("collapses whitespace and is bounded, so it can travel in a filter", () => {
    expect(normaliseRemediationError("  a \n\t  b  ")).toBe("a b");
    expect(normaliseRemediationError("x".repeat(5000))).toHaveLength(FINGERPRINT_ERROR_CHARS);
  });
});

describe("a read that fails files the notice", () => {
  /*
    The merge drain stands down on an unreadable dedupe for `cascade_blocked`,
    because it asks every five minutes. This asks once per exhausted run, so
    the trade is the other way: one possible duplicate against a failure
    nobody hears about.
  */
  it("files when the read failed, and says why", () => {
    const d = decideRemediationFailedNotice({ ok: false, error: "connection reset" });
    expect(d.file).toBe(true);
    expect(d.why).toContain("connection reset");
  });

  it("holds back only when a read succeeded and found one standing", () => {
    expect(decideRemediationFailedNotice({ ok: true, standing: true }).file).toBe(false);
    expect(decideRemediationFailedNotice({ ok: true, standing: false }).file).toBe(true);
  });
});

describe("the notice sends a person where the run can be seen", () => {
  const CLONE = "7e2c004d-5a56-4d9f-bdae-09d28885d234";
  const TICKET = "0fd8cac8-d1fd-46c4-b06e-5b89b52ecbdd";

  it("to the clone when there is no ticket, which was all 116", () => {
    expect(remediationFailedUrl({ cloneId: CLONE, ticketId: null })).toBe(`/clones/${CLONE}`);
  });

  it("to the support queue when a ticket stands behind the run", () => {
    expect(remediationFailedUrl({ cloneId: CLONE, ticketId: TICKET })).toBe("/support/tickets");
  });

  it("to the support queue when the run is the prime's own, with neither", () => {
    expect(remediationFailedUrl({ cloneId: null, ticketId: null })).toBe("/support/tickets");
  });

  it("carries its fingerprint, so the next failure can find it", () => {
    const n = describeRemediationFailure({
      runId: "b493c1bd-b8db-4115-ac65-ee844bfa0589",
      ticketId: null,
      cloneId: CLONE,
      actionType: DEPLOY,
      error: OVERSIZE_2,
    });
    expect(n.title).toBe("Self-healing failed · edge function deploy");
    expect(n.body).toBe(OVERSIZE_2);
    expect(n.url).toBe(`/clones/${CLONE}`);
    expect(n.metadata).toEqual({
      run_id: "b493c1bd-b8db-4115-ac65-ee844bfa0589",
      ticket_id: null,
      action_type: DEPLOY,
      fingerprint: remediationFailureFingerprint({ actionType: DEPLOY, error: OVERSIZE_2 }),
    });
    expect(n.body.length).toBeLessThanOrEqual(400);
  });
});

describe("the exhausted run files through the rule", () => {
  /*
    Shipped means used: a correct rule with no call site changes nothing, and
    the old insert would still be filing one notice per run.
  */
  const code = stripComments(readFileSync("src/server/self-healing.server.ts", "utf8"));
  const at = code.indexOf("async function raiseRemediationFailed");
  const helper = code.slice(at, code.indexOf("async function parkRun", at));

  it("is called where a run is exhausted", () => {
    expect(at).toBeGreaterThan(-1);
    expect(code).toMatch(/if \(exhausted\) await raiseRemediationFailed\(run, message\);/);
  });

  it("asks for an UNREAD notice with the same fingerprint, scoped to the clone", () => {
    expect(helper).toContain('.eq("kind", "remediation_failed")');
    expect(helper).toContain('.eq("metadata->>fingerprint", notice.metadata.fingerprint)');
    expect(helper).toContain('.is("read_at", null)');
    expect(helper).toContain('.eq("clone_id", run.clone_id)');
    // A prime-scope run has no clone, and `.eq` against null matches nothing.
    expect(helper).toContain('.is("clone_id", null)');
  });

  it("decides with the pure rule and files with the url it chose", () => {
    expect(helper).toMatch(/decideRemediationFailedNotice\(read\)/);
    expect(helper).toMatch(/if \(!decision\.file\) return;/);
    expect(helper).toContain("url: notice.url");
    expect(helper).toContain("metadata: notice.metadata");
    // Nothing in the exhausted path hard-codes the support queue any more.
    expect(helper).not.toContain('"/support/tickets"');
  });

  it("treats a thrown read as a failed one, never as none standing", () => {
    expect(helper).toMatch(/catch \(e\) \{\s*read = \{ ok: false,/);
  });
});
