/**
 * The decisions behind approving library entries (D19), on rows as they are
 * read: a module is published at the commit its detection run recorded, or
 * refused by name; an entry is approved only at a commit it records; a pin
 * reports the commit it rests on and is refused on an approved entry that
 * records none.
 */
import { describe, expect, it } from "vitest";
import { isCommitSha, primeCommitLabel } from "@/lib/libraryCommit.pure";
import {
  describeDbError,
  judgeApproval,
  judgeClonePins,
  judgePinnable,
  judgePublication,
  libraryApprovalNotice,
  libraryEntryInsert,
  pinLabel,
  type DetectionRunCommit,
  type PinnedEntry,
  type PublishableModule,
} from "./libraryApproval.pure";

const COMMIT = "4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";
const RUN = "0a3c9817-0000-4000-8000-000000000001";
const OLD_RUN = "31a7e000-0000-4000-8000-000000000002";

function module(overrides: Partial<PublishableModule> = {}): PublishableModule {
  return {
    id: "m0000000-0000-4000-8000-000000000001",
    name: "AML Command Centre",
    slug: "aml",
    status: "proposed",
    description: "Screening, cases and the passport",
    routes: ["/aml", "/aml/cases"],
    route_entry_file: "src/routes/aml.tsx",
    resolved_files: ["src/routes/aml.tsx", "src/components/aml/case-list.tsx"],
    file_globs: ["src/components/aml/**"],
    backend_file_globs: ["supabase/functions/aml-screen/**"],
    detection_run_id: RUN,
    layer: "fullstack",
    cohesion_score: 0.82,
    coupling_score: 0.18,
    ai_confidence: 1,
    ai_reasoning: "Feature-first detection",
    shared_by_modules: [],
    edge_functions: ["aml-screen"],
    database_tables: ["aml_cases"],
    required_secrets: ["DIDIT_API_KEY"],
    required_migrations: [],
    storage_buckets: [],
    cron_jobs: [],
    ...overrides,
  };
}

const runs = (...list: DetectionRunCommit[]) => new Map(list.map((r) => [r.id, r]));

describe("a commit", () => {
  it("is GitHub's full 40-character SHA and nothing shorter or longer", () => {
    expect(isCommitSha(COMMIT)).toBe(true);
    expect(isCommitSha(COMMIT.slice(0, 7))).toBe(false);
    expect(isCommitSha(`${COMMIT}0`)).toBe(false);
    expect(isCommitSha(COMMIT.toUpperCase())).toBe(false);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha(null)).toBe(false);
  });

  it("is shown as prime@ and its first seven characters, and nothing else is shown as one", () => {
    expect(primeCommitLabel(COMMIT)).toBe("prime@4f1c2d3");
    expect(primeCommitLabel(null)).toBeNull();
    expect(primeCommitLabel("a1b2c3d4e5f6")).toBeNull();
  });
});

describe("publishing a module", () => {
  it("is allowed at the commit its detection run recorded", () => {
    const verdict = judgePublication(
      module(),
      runs({ id: RUN, commit_sha: COMMIT, created_at: "2026-10-28T09:00:00Z" }),
    );
    expect(verdict).toEqual({ ok: true, runId: RUN, commitSha: COMMIT });
  });

  it("is refused, by name, when its run recorded no commit", () => {
    const verdict = judgePublication(
      module({ detection_run_id: OLD_RUN }),
      runs({ id: OLD_RUN, commit_sha: null, created_at: "2026-07-31T22:24:01Z" }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain("AML Command Centre (aml)");
    expect(verdict.reason).toContain("run 31a7e000 on 31 Jul 2026, which recorded no commit");
    // A proposed module is re-detected by the next run, so nothing more is said.
    expect(verdict.reason).not.toContain("approved or archived");
  });

  it("says why detection will not re-detect an approved module's files", () => {
    const verdict = judgePublication(
      module({ detection_run_id: OLD_RUN, status: "approved" }),
      runs({ id: OLD_RUN, commit_sha: null, created_at: "2026-07-31T22:24:01Z" }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toMatch(/keeps an approved or archived module's files as they are/);
    expect(verdict.reason).toMatch(/only while it is proposed or rejected/);
  });

  it("is refused when it names no run, or a run nobody found, or a run that recorded something else", () => {
    const none = judgePublication(module({ detection_run_id: null }), runs());
    expect(none).toMatchObject({ ok: false });
    expect(!none.ok && none.reason).toMatch(/aml\) names no detection run/);

    const lost = judgePublication(module(), runs());
    expect(!lost.ok && lost.reason).toMatch(/its detection run 0a3c9817 was not found/);

    const garbage = judgePublication(
      module(),
      runs({ id: RUN, commit_sha: "main", created_at: "2026-10-28T09:00:00Z" }),
    );
    expect(!garbage.ok && garbage.reason).toMatch(/recorded "main", which is not a commit/);
  });
});

describe("the entry a publication writes", () => {
  const row = libraryEntryInsert(module(), {
    version: 2,
    runId: RUN,
    commitSha: COMMIT,
    publisherId: "admin-1",
    now: "2026-10-28T10:00:00.000Z",
    tags: ["core"],
  });

  it("is approved, by its publisher, at the commit, in the one row", () => {
    expect(row).toMatchObject({
      approval_status: "approved",
      approved_by: "admin-1",
      approved_at: "2026-10-28T10:00:00.000Z",
      published_by: "admin-1",
      published_at: "2026-10-28T10:00:00.000Z",
      source_commit_sha: COMMIT,
      source_detection_run_id: RUN,
      rejection_reason: null,
      is_latest: true,
      version: 2,
    });
  });

  it("carries the backend globs with the frontend files, as a pinned clone needs", () => {
    expect(row.file_paths).toEqual([
      "src/routes/aml.tsx",
      "src/components/aml/case-list.tsx",
      "supabase/functions/aml-screen/**",
    ]);
    expect(row.file_count).toBe(3);
    expect(row.route_path).toBe("/aml");
  });
});

describe("approving an entry already published", () => {
  it("needs the commit it records", () => {
    expect(judgeApproval({ name: "AML", version: 1, source_commit_sha: COMMIT })).toEqual({
      ok: true,
    });
    const refused = judgeApproval({ name: "AML", version: 1, source_commit_sha: null });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(
      /^AML v1 records no commit, so it cannot be approved\./,
    );
  });
});

describe("the approval notice", () => {
  it("names the entry and its commit when one was approved", () => {
    const notice = libraryApprovalNotice([
      { id: "e1", name: "AML", slug: "aml", version: 2, source_commit_sha: COMMIT },
    ]);
    expect(notice).toMatchObject({
      kind: "library_entry_approved",
      severity: "success",
      title: "Library approved · AML v2",
      body: "Approved at prime@4f1c2d3. Now available for pinning to clones.",
      url: "/modules",
      metadata: { library_entry_id: "e1", slug: "aml", version: 2, source_commit_sha: COMMIT },
    });
  });

  it("is one notice for a publication of many", () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      name: `Module ${i}`,
      slug: `m${i}`,
      version: 1,
      source_commit_sha: COMMIT,
    }));
    const notice = libraryApprovalNotice(entries);
    expect(notice?.title).toBe("Library approved · 7 entries");
    expect(notice?.body).toContain("and 2 more, approved at prime@4f1c2d3.");
    expect(libraryApprovalNotice([])).toBeNull();
  });
});

describe("a pin", () => {
  const pin = { clone_id: "crm", slug: "aml", version: 2, library_entry_id: "e2" };
  const entry = (overrides: Partial<PinnedEntry> = {}): Map<string, PinnedEntry> =>
    new Map([
      [
        "e2",
        {
          id: "e2",
          approval_status: "approved",
          file_paths: ["src/routes/aml.tsx"],
          source_commit_sha: COMMIT,
          ...overrides,
        },
      ],
    ]);

  it("reports the commit its entry records", () => {
    const judged = judgeClonePins([pin], entry());
    expect(judged.issues).toEqual([]);
    expect(judged.pins).toEqual([
      { cloneId: "crm", slug: "aml", version: 2, libraryEntryId: "e2", commitSha: COMMIT },
    ]);
  });

  it("on an approved entry that records no commit is refused", () => {
    const judged = judgeClonePins([pin], entry({ source_commit_sha: null }));
    expect(judged.issues).toEqual([
      {
        cloneId: "crm",
        slug: "aml",
        version: 2,
        severity: "error",
        reason: "Approved entry records no commit",
      },
    ]);
    expect(judged.pins[0].commitSha).toBeNull();
  });

  it("whose entry could not be read is reported unread, never deleted", () => {
    const judged = judgeClonePins([pin], {
      unread: "canceling statement due to statement timeout",
    });
    expect(judged.issues.map((i) => i.reason)).toEqual([
      "Library entry could not be read: canceling statement due to statement timeout",
    ]);
  });

  it("keeps the old refusals: deleted, unapproved and empty entries", () => {
    expect(judgeClonePins([pin], new Map()).issues[0].reason).toBe("Library entry was deleted");
    const pending = judgeClonePins([pin], entry({ approval_status: "pending", file_paths: [] }));
    expect(pending.issues.map((i) => i.reason)).toEqual([
      "Entry is now pending",
      "Pinned entry has no file paths",
    ]);
  });

  it("may be set only on an approved entry that records its commit", () => {
    expect(judgePinnable({ approval_status: "approved", source_commit_sha: COMMIT })).toEqual({
      ok: true,
    });
    expect(judgePinnable({ approval_status: "pending", source_commit_sha: COMMIT })).toEqual({
      ok: false,
      reason: "not approved",
    });
    expect(judgePinnable({ approval_status: "approved", source_commit_sha: null })).toEqual({
      ok: false,
      reason: "records no commit",
    });
  });

  it("is named in a delivery's summary with its commit", () => {
    expect(pinLabel({ slug: "checkout", version: 3, commitSha: COMMIT })).toBe(
      "checkout@v3 (prime@4f1c2d3)",
    );
    expect(pinLabel({ slug: "checkout", version: 3, commitSha: null })).toBe(
      "checkout@v3 (no commit recorded)",
    );
  });
});

describe("a database error", () => {
  it("names the migration when a commit column is not there yet", () => {
    expect(
      describeDbError({
        message: "column module_detection_runs.commit_sha does not exist",
        code: "42703",
      }),
    ).toBe(
      "column module_detection_runs.commit_sha does not exist " +
        "(migration 20261028120000_library_entries_record_their_commit has not been applied)",
    );
    expect(
      describeDbError({ message: "canceling statement due to statement timeout", code: "57014" }),
    ).toBe("canceling statement due to statement timeout");
  });
});
