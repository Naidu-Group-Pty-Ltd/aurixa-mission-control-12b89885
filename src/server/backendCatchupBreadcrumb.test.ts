/**
 * A catch-up over a fleet that owes nothing files no breadcrumb.
 *
 * `no_backend_work` reaches each clone's outcome as its `refused`, and the hook
 * counted any refusal as worth a row, so every half-hour sweep of a healthy
 * fleet wrote one: 48 `backend_catchup_cron` rows on 27 Oct 2026, every one
 * saying four clones owed nothing. The module's own header says such a pass
 * "writes nothing at all".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The predicate is pure; the module it lives in reaches the database and
// GitHub, which no unit test may.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/server/github-app.server", () => ({ getAppOctokit: () => ({}) }));

import { catchupIsNoteworthy, type CatchupOutcome } from "./backendCatchup.server";

const owesNothing = (name: string): CatchupOutcome => ({
  cloneId: name,
  cloneName: name,
  refused: "no_backend_work",
  planned: [],
});

describe("a catch-up breadcrumb", () => {
  it("is not filed for a fleet that owes nothing", () => {
    expect(
      catchupIsNoteworthy({
        planned: 0,
        refused: null,
        outcomes: ["a", "b", "c", "d"].map(owesNothing),
      }),
    ).toBe(false);
  });

  it("is filed when a run was planned", () => {
    expect(
      catchupIsNoteworthy({
        planned: 1,
        refused: null,
        outcomes: [
          owesNothing("a"),
          {
            cloneId: "b",
            cloneName: "b",
            refused: null,
            planned: ["edge_function_deploy: queued"],
          },
        ],
      }),
    ).toBe(true);
  });

  it("is filed for any other refusal, which is a clone that could not be planned", () => {
    for (const refused of ["compare_failed", "db_error", "no_backend_project"]) {
      expect(
        catchupIsNoteworthy({
          planned: 0,
          refused: null,
          outcomes: [owesNothing("a"), { cloneId: "b", cloneName: "b", refused, planned: [] }],
        }),
        refused,
      ).toBe(true);
    }
  });

  it("is filed when the sweep itself was refused", () => {
    expect(
      catchupIsNoteworthy({
        planned: 0,
        refused: "could not read the prime's HEAD: Server Error",
        outcomes: [],
      }),
    ).toBe(true);
  });

  it("is what the hook asks", () => {
    const route = readFileSync("src/routes/hooks.backend-catchup.tsx", "utf8");
    expect(route).toContain("if (catchupIsNoteworthy(report)) {");
    expect(route).not.toMatch(/report\.outcomes\.some\(\(o\) => o\.refused\)/);
  });
});
