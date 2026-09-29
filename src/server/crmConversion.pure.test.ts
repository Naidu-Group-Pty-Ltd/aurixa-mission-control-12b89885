import { describe, expect, it } from "vitest";
import { CRM_MODE_COPY } from "@/lib/crmMode.pure";
import type { CrmParent, CrmParentJudgement } from "./crmLineage.pure";
import type { DeletionPlan } from "./cascade/deletionPropagation.pure";
import { planDeletions } from "./cascade/deletionPropagation.pure";
import { ENGINE_COMMIT_PREFIX } from "./cascade/proposalRepair.pure";
import { LATERAL_BRANCH_PREFIX } from "./cascade/lateralExchange.pure";
import { CASCADE_BRANCH_PREFIX } from "./cascadeMergeDrain.server";
import {
  conversionWithoutDelivery,
  deployHoldsConversion,
  settleWithoutProposal,
  CONVERSION_BRANCH_PREFIX,
  CRM_ROUTING_FILES,
  conversionExclusions,
  routingHoldsToRetire,
  CONVERSION_STATUSES,
  MAX_CONVERSION_DELETIONS,
  OPEN_CONVERSION_STATUSES,
  STALLED_PROPOSAL_MS,
  conversionBranchName,
  conversionCommitSubject,
  conversionLead,
  conversionTitle,
  decideConversionDeletion,
  decideConversionStep,
  describeConversion,
  describeConversionDeletions,
  describeRetiredFunctions,
  finalisedCloneFields,
  frozenOnHead,
  functionsRetiredByConversion,
  functionsToUndeploy,
  isConversionBranch,
  isOpenConversionStatus,
  judgeConversion,
  judgeTargetFreshness,
  FROZEN_PATHS_LISTED,
  retiredFunctionsKept,
  type ConversionCloneRow,
  type ConversionWording,
  type JudgeConversionInput,
  type LeavingTree,
} from "./crmConversion.pure";

const CD_ID = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const CRM_ID = "e97f18ab-a3e3-4350-a0c9-d3f8584d6243";
const NT_ID = "7e2c004d-5a56-4d9f-bdae-09d28885d234";
const PRIME_SHA = "a".repeat(40);
const CRM_HEAD_SHA = "b".repeat(40);

const CRM_HEAD: CrmParent = {
  id: CRM_ID,
  name: "NPC CRM Independent",
  githubOwner: "Naidu-Group-Pty-Ltd",
  githubRepo: "npc-crm-independent-6505dc",
  defaultBranch: "main",
  lastSyncedSha: PRIME_SHA,
  mode: "independent",
};

const CD_HEAD: CrmParent = {
  id: CD_ID,
  name: "NPC Client Dashboard",
  githubOwner: "Naidu-Group-Pty-Ltd",
  githubRepo: "npc-client-dashboard",
  defaultBranch: "main",
  lastSyncedSha: PRIME_SHA,
  mode: "dependent",
};

function clone(overrides: Partial<ConversionCloneRow> = {}): ConversionCloneRow {
  return {
    id: NT_ID,
    name: "NPC Test",
    github_owner: "Naidu-Group-Pty-Ltd",
    github_repo: "npc-test-76b3b3",
    default_branch: "main",
    crm_mode: "dependent",
    sync_scope: "mirror",
    parent_clone_id: CD_ID,
    last_synced_sha: PRIME_SHA,
    ...overrides,
  };
}

/** NPC Test, a dependent child of the Client Dashboard, asking to go independent. */
function input(overrides: Partial<JudgeConversionInput> = {}): JudgeConversionInput {
  return {
    clone: clone(),
    toMode: "independent",
    readFailure: null,
    lineHeads: { dependent: CD_ID, independent: CRM_ID },
    childCount: 0,
    target: { ok: true, parent: CRM_HEAD },
    targetScope: "modules",
    leaving: {
      kind: "parent",
      name: "NPC Client Dashboard",
      github_owner: "Naidu-Group-Pty-Ltd",
      github_repo: "npc-client-dashboard",
      default_branch: "main",
    },
    openConversion: null,
    openCascadePr: null,
    ...overrides,
  };
}

function refusalOf(i: JudgeConversionInput): string {
  const j = judgeConversion(i);
  if (j.ok) throw new Error("expected a refusal");
  return j.kind;
}

describe("conversion vocabulary", () => {
  it("names five statuses, two of them open", () => {
    expect(CONVERSION_STATUSES).toEqual(["proposed", "merged", "completed", "cancelled", "failed"]);
    expect(OPEN_CONVERSION_STATUSES).toEqual(["proposed", "merged"]);
    for (const s of CONVERSION_STATUSES) {
      expect(isOpenConversionStatus(s)).toBe(
        (OPEN_CONVERSION_STATUSES as readonly string[]).includes(s),
      );
    }
    expect(isOpenConversionStatus(null)).toBe(false);
    expect(isOpenConversionStatus(undefined)).toBe(false);
    expect(isOpenConversionStatus("Proposed")).toBe(false);
  });

  it("names its branch so that no cascade machinery recognises it", () => {
    const branch = conversionBranchName("independent", CRM_HEAD_SHA, 1_700_000_000_000);
    expect(branch.startsWith(CONVERSION_BRANCH_PREFIX)).toBe(true);
    expect(branch).toContain("independent");
    expect(branch).toContain(CRM_HEAD_SHA.slice(0, 7));
    expect(isConversionBranch(branch)).toBe(true);

    // The engine's open-proposal lookup, the merge drain and the conflict
    // resolver all key on the cascade prefix; the lateral lane has its own.
    expect(branch.startsWith(CASCADE_BRANCH_PREFIX)).toBe(false);
    expect(branch.startsWith("aurixa/cascade-")).toBe(false);
    expect(branch.startsWith(LATERAL_BRANCH_PREFIX)).toBe(false);
    expect(isConversionBranch(`${CASCADE_BRANCH_PREFIX}abc`)).toBe(false);
    expect(isConversionBranch(null)).toBe(false);
    expect(isConversionBranch(undefined)).toBe(false);
  });

  it("gives two proposals from the same head different branches", () => {
    const a = conversionBranchName("dependent", PRIME_SHA, 1);
    const b = conversionBranchName("dependent", PRIME_SHA, 2);
    expect(a).not.toBe(b);
  });

  it("caps removals well above a cascade's and below a misread tree", () => {
    expect(MAX_CONVERSION_DELETIONS).toBeGreaterThan(25);
    expect(MAX_CONVERSION_DELETIONS).toBeLessThanOrEqual(500);
    expect(STALLED_PROPOSAL_MS).toBe(15 * 60 * 1000);
  });
});

describe("judgeConversion — the clone that may move", () => {
  it("accepts a dependent child moving to the independent line, and names what leaves", () => {
    const j = judgeConversion(input());
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.fromMode).toBe("dependent");
    expect(j.toMode).toBe("independent");
    expect(j.target).toEqual(CRM_HEAD);
    expect(j.leaving).toEqual({
      owner: "Naidu-Group-Pty-Ltd",
      repo: "npc-client-dashboard",
      branch: "main",
      label: "NPC Client Dashboard",
    });
    // Module-scoped head: the caution names that the tree is partial.
    expect(j.cautions.some((c) => c.includes("module-scoped"))).toBe(true);
    // Records are never moved, and it says what the target needs.
    const records = j.cautions.find((c) => c.startsWith("Records are not moved."));
    expect(records).toBeDefined();
    expect(records).toContain(CRM_MODE_COPY.dependent.provider);
    expect(records).toContain(CRM_MODE_COPY.independent.provider);
    expect(records).toContain(CRM_MODE_COPY.independent.consequence);
  });

  it("accepts an independent clone moving to the dependent line, with no scope caution for a mirror head", () => {
    const j = judgeConversion(
      input({
        clone: clone({ crm_mode: "independent", parent_clone_id: CRM_ID }),
        toMode: "dependent",
        target: { ok: true, parent: CD_HEAD },
        targetScope: "mirror",
        leaving: {
          kind: "parent",
          name: "NPC CRM Independent",
          github_owner: "Naidu-Group-Pty-Ltd",
          github_repo: "npc-crm-independent-6505dc",
          default_branch: "main",
        },
      }),
    );
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.fromMode).toBe("independent");
    expect(j.toMode).toBe("dependent");
    expect(j.cautions.some((c) => c.includes("module-scoped"))).toBe(false);
    expect(j.cautions).toHaveLength(1);
  });

  it("labels the prime as the source for a clone that reads the prime directly", () => {
    const j = judgeConversion(
      input({
        clone: clone({ parent_clone_id: null }),
        leaving: {
          kind: "prime",
          name: "Prime",
          github_owner: "Naidu-Group-Pty-Ltd",
          github_repo: "npc-property-dashbord",
          default_branch: "main",
        },
      }),
    );
    expect(j.ok && j.leaving.label).toBe("prime");
  });

  it("falls back to owner/repo when the leaving parent has no name", () => {
    const j = judgeConversion(
      input({
        leaving: {
          kind: "parent",
          name: "  ",
          github_owner: "Naidu-Group-Pty-Ltd",
          github_repo: "npc-client-dashboard",
          default_branch: "main",
        },
      }),
    );
    expect(j.ok && j.leaving.label).toBe("Naidu-Group-Pty-Ltd/npc-client-dashboard");
  });

  it("says so when the clone already reads the target head", () => {
    const j = judgeConversion(input({ clone: clone({ parent_clone_id: CRM_ID }) }));
    expect(j.ok).toBe(true);
    if (!j.ok) return;
    expect(j.cautions.some((c) => c.includes("already receives its tree from"))).toBe(true);
  });
});

describe("judgeConversion — every refusal, by name", () => {
  it("refuses on a failed read before anything else, even a missing clone", () => {
    expect(refusalOf(input({ readFailure: "timeout" }))).toBe("unreadable");
    expect(refusalOf(input({ readFailure: "timeout", clone: null }))).toBe("unreadable");
    const j = judgeConversion(input({ readFailure: "connection reset" }));
    expect(!j.ok && j.reason).toContain("connection reset");
  });

  it("refuses a clone that does not exist", () => {
    expect(refusalOf(input({ clone: null }))).toBe("missing");
  });

  it("refuses a mode that is not a line", () => {
    for (const bad of ["", "ghl", "Independent", null, undefined, 3]) {
      expect(refusalOf(input({ toMode: bad }))).toBe("bad_mode");
    }
  });

  it("refuses a clone whose CRM was never recorded, rather than assuming dependent", () => {
    expect(refusalOf(input({ clone: clone({ crm_mode: null }) }))).toBe("unrecorded");
    expect(refusalOf(input({ clone: clone({ crm_mode: "ghl" }) }))).toBe("unrecorded");
  });

  it("refuses to convert a clone to the line it already runs", () => {
    expect(refusalOf(input({ toMode: "dependent" }))).toBe("same_mode");
  });

  it("refuses either line's head", () => {
    expect(refusalOf(input({ clone: clone({ id: CD_ID, parent_clone_id: null }) }))).toBe(
      "line_head",
    );
    expect(
      refusalOf(
        input({
          clone: clone({ id: CRM_ID, crm_mode: "independent", parent_clone_id: null }),
          toMode: "dependent",
          target: { ok: true, parent: CD_HEAD },
        }),
      ),
    ).toBe("line_head");
  });

  it("refuses a head before it counts that head's children", () => {
    expect(
      refusalOf(input({ clone: clone({ id: CD_ID, parent_clone_id: null }), childCount: 2 })),
    ).toBe("line_head");
  });

  it("refuses a clone other clones receive their tree through", () => {
    const j = judgeConversion(input({ childCount: 3 }));
    expect(!j.ok && j.kind).toBe("has_children");
    expect(!j.ok && j.reason).toContain("3 clone(s)");
  });

  it("refuses a module-scoped clone, and one with no recorded scope", () => {
    expect(refusalOf(input({ clone: clone({ sync_scope: "modules" }) }))).toBe("not_mirror");
    expect(refusalOf(input({ clone: clone({ sync_scope: null }) }))).toBe("not_mirror");
  });

  it("refuses a clone with no repository or branch", () => {
    expect(refusalOf(input({ clone: clone({ github_repo: null }) }))).toBe("no_repository");
    expect(refusalOf(input({ clone: clone({ github_owner: "  " }) }))).toBe("no_repository");
    const j = judgeConversion(input({ clone: clone({ default_branch: "" }) }));
    expect(!j.ok && j.kind).toBe("no_repository");
    expect(!j.ok && j.reason).toContain("no repository branch");
  });

  it("refuses a second conversion while one is open", () => {
    const j = judgeConversion(input({ openConversion: { id: "c1", status: "proposed" } }));
    expect(!j.ok && j.kind).toBe("already_open");
    expect(!j.ok && j.reason).toContain("proposed");
  });

  it("refuses while a cascade proposal is open on the clone", () => {
    const j = judgeConversion(
      input({ openCascadePr: { number: 161, url: "https://github.com/x/y/pull/161" } }),
    );
    expect(!j.ok && j.kind).toBe("cascade_open");
    expect(!j.ok && j.reason).toContain("#161");
    expect(!j.ok && j.reason).toContain("https://github.com/x/y/pull/161");
  });

  it("carries the target line's own refusal through unchanged", () => {
    const target: CrmParentJudgement = { ok: false, kind: "unset", reason: "No parent recorded." };
    const j = judgeConversion(input({ target }));
    expect(!j.ok && j.kind).toBe("target_parent");
    expect(!j.ok && j.reason).toBe("No parent recorded.");
  });

  it("refuses a target head that has never recorded which prime commit it carries", () => {
    expect(
      refusalOf(input({ target: { ok: true, parent: { ...CRM_HEAD, lastSyncedSha: null } } })),
    ).toBe("target_unsynced");
  });

  it("refuses when the tree the clone is leaving cannot be named", () => {
    const missing = judgeConversion(input({ leaving: null }));
    expect(!missing.ok && missing.kind).toBe("leaving_unknown");
    expect(!missing.ok && missing.reason).toContain(CD_ID);
    expect(
      refusalOf(
        input({
          leaving: {
            kind: "parent",
            name: "x",
            github_owner: "o",
            github_repo: "r",
            default_branch: null,
          },
        }),
      ),
    ).toBe("leaving_unknown");
  });
});

describe("decideConversionDeletion", () => {
  const tree = (complete: boolean): LeavingTree => ({
    shaByPath: new Map([
      ["src/pages/Conversations.tsx", "same"],
      ["supabase/functions/sync-ghl-conversations/index.ts", "theirs"],
    ]),
    complete,
    headSha: "c".repeat(40),
    label: "NPC Client Dashboard",
  });

  it("removes a file the clone holds byte-identical to the leaving line", () => {
    expect(
      decideConversionDeletion(
        { path: "src/pages/Conversations.tsx", cloneSha: "same" },
        tree(true),
      ),
    ).toEqual({ act: "delete", path: "src/pages/Conversations.tsx", deletedIn: "c".repeat(40) });
  });

  it("keeps a file edited here, and says why", () => {
    const v = decideConversionDeletion(
      { path: "supabase/functions/sync-ghl-conversations/index.ts", cloneSha: "mine" },
      tree(true),
    );
    expect(v.act).toBe("keep");
    expect(v.act === "keep" && v.reason).toBe("clone_edited");
    expect(v.act === "keep" && v.why).toContain("NPC Client Dashboard");
  });

  it("keeps a file neither line carries as the clone's own", () => {
    const v = decideConversionDeletion({ path: "scripts/mine.ts", cloneSha: "x" }, tree(true));
    expect(v.act === "keep" && v.reason).toBe("clone_owns");
  });

  it("keeps an absent path when the listing was truncated", () => {
    const v = decideConversionDeletion({ path: "scripts/mine.ts", cloneSha: "x" }, tree(false));
    expect(v.act === "keep" && v.reason).toBe("unsettled");
  });

  it("still removes a listed identical path from a truncated listing", () => {
    const v = decideConversionDeletion(
      { path: "src/pages/Conversations.tsx", cloneSha: "same" },
      tree(false),
    );
    expect(v.act).toBe("delete");
  });
});

describe("functionsRetiredByConversion", () => {
  it("retires a function whose entry point leaves and the target carries nothing of", () => {
    expect(
      functionsRetiredByConversion(
        [
          "supabase/functions/crm-send-message/index.ts",
          "supabase/functions/crm-send-message/deps.ts",
          "supabase/functions/crm-calendar/index.ts",
        ],
        ["supabase/functions/send-ghl-message/index.ts", "src/App.tsx"],
      ),
    ).toEqual(["crm-calendar", "crm-send-message"]);
  });

  it("does not retire a function the target still carries a file of", () => {
    expect(
      functionsRetiredByConversion(
        ["supabase/functions/shared-fn/index.ts"],
        ["supabase/functions/shared-fn/helpers.ts"],
      ),
    ).toEqual([]);
  });

  it("does not retire a function whose entry point stays", () => {
    expect(functionsRetiredByConversion(["supabase/functions/fn/helper.ts"], [])).toEqual([]);
  });

  it("never treats the shared tree as a function", () => {
    expect(functionsRetiredByConversion(["supabase/functions/_shared/index.ts"], [])).toEqual([]);
  });

  it("ignores paths that are not function entry points", () => {
    expect(
      functionsRetiredByConversion(["src/index.ts", "supabase/functions/index.ts"], []),
    ).toEqual([]);
  });
});

describe("retiredFunctionsKept", () => {
  it("names a retired function whose entry point the final plan kept", () => {
    const planned = new Set(["supabase/functions/a/index.ts"]);
    expect(retiredFunctionsKept(["a", "b"], planned)).toEqual(["b"]);
    expect(retiredFunctionsKept([], planned)).toEqual([]);
  });
});

describe("the pull request's words", () => {
  const w: ConversionWording = {
    cloneName: "NPC Test",
    fromMode: "dependent",
    toMode: "independent",
    targetLabel: "NPC CRM Independent",
    leavingLabel: "NPC Client Dashboard",
    sourceSha: CRM_HEAD_SHA,
    conversionId: "11111111-2222-3333-4444-555555555555",
  };

  it("titles the proposal as a conversion, not a cascade", () => {
    const title = conversionTitle(w, 42);
    expect(title).toContain("CRM conversion");
    expect(title).toContain("CRM dependent → CRM independent");
    expect(title).toContain(`NPC CRM Independent@${CRM_HEAD_SHA.slice(0, 7)}`);
    expect(title).toContain("42 file(s)");
    expect(title.startsWith("Aurixa cascade")).toBe(false);
  });

  it("writes a commit subject the proposal repair can never take for its own", () => {
    const subject = conversionCommitSubject(w, 42);
    expect(subject.startsWith(ENGINE_COMMIT_PREFIX)).toBe(false);
    expect(subject.startsWith("chore(aurixa): ")).toBe(true);
    expect(subject).toContain("CRM independent");
  });

  it("says merging is the conversion, closing cancels, and quotes every caution", () => {
    const lead = conversionLead(w, ["First caution.", "Second caution."]);
    expect(lead).toContain("**Merging it is the conversion.**");
    expect(lead).toContain("Mission Control never merges it");
    expect(lead).toContain("cancels the conversion");
    expect(lead).toContain("Cascades to this clone are held");
    expect(lead).toContain("> First caution.");
    expect(lead).toContain("> Second caution.");
    expect(lead).toContain(w.conversionId);
    expect(conversionLead(w, [])).not.toContain("> ");
  });

  it("describes removals in the conversion's own words", () => {
    const plan: DeletionPlan = planDeletions([
      { act: "delete", path: "src/a.ts", deletedIn: "x" },
      { act: "keep", path: "src/b.ts", reason: "clone_edited", why: "edited here" },
      { act: "keep", path: "src/c.ts", reason: "clone_owns", why: "own" },
      { act: "keep", path: "src/d.ts", reason: "still_referenced", why: "imported" },
    ]);
    const text = describeConversionDeletions(plan, "NPC Client Dashboard");
    expect(text).toContain("**Removed (1).**");
    expect(text).toContain("`src/a.ts`");
    expect(text).toContain("NPC Client Dashboard");
    expect(text).toContain("**Kept — decide by hand (2).**");
    expect(text).toContain("`src/b.ts` — edited here");
    expect(text).toContain("`src/d.ts` — imported");
    expect(text).not.toContain("`src/c.ts`");
    expect(text).toContain("1 path(s) belong to this clone alone");
    expect(text).not.toContain("Prime deleted");
  });

  it("describes a refused set as refused, not removed", () => {
    const plan = planDeletions(
      Array.from({ length: 3 }, (_, i) => ({
        act: "delete" as const,
        path: `f${i}`,
        deletedIn: "x",
      })),
      2,
    );
    const text = describeConversionDeletions(plan, "L");
    expect(text).toContain("**Removals refused.**");
    expect(text).not.toContain("**Removed");
  });

  it("lists retired functions, and says nothing when none are retired", () => {
    expect(describeRetiredFunctions([], "dependent")).toBe("");
    const text = describeRetiredFunctions(["crm-calendar", "crm-send-message"], "dependent");
    expect(text).toContain("**Edge functions retired (2).**");
    expect(text).toContain("`crm-calendar`");
    expect(text).toContain("CRM dependent");
  });
});

describe("decideConversionStep", () => {
  const base = { status: "proposed", prNumber: 7, pr: null, createdAt: 0, now: 1000 };

  it("does nothing for a conversion that has ended", () => {
    for (const status of ["completed", "cancelled", "failed", "unknown"]) {
      expect(decideConversionStep({ ...base, status })).toEqual({ act: "none" });
    }
  });

  it("resumes finalising a merged conversion whatever the pull request reads", () => {
    expect(decideConversionStep({ ...base, status: "merged" })).toEqual({ act: "finalise" });
    expect(
      decideConversionStep({ ...base, status: "merged", pr: { kind: "unreadable", why: "x" } }),
    ).toEqual({ act: "finalise" });
  });

  it("waits on a proposal still being built, and fails one that died", () => {
    expect(decideConversionStep({ ...base, prNumber: null }).act).toBe("wait");
    expect(
      decideConversionStep({ ...base, prNumber: null, now: STALLED_PROPOSAL_MS + 1 }).act,
    ).toBe("fail");
    expect(decideConversionStep({ ...base, prNumber: null, now: STALLED_PROPOSAL_MS }).act).toBe(
      "wait",
    );
  });

  it("follows the pull request", () => {
    expect(decideConversionStep({ ...base, pr: null }).act).toBe("wait");
    expect(decideConversionStep({ ...base, pr: { kind: "open" } }).act).toBe("wait");
    expect(decideConversionStep({ ...base, pr: { kind: "merged", mergeSha: "m" } })).toEqual({
      act: "finalise",
    });
    const closed = decideConversionStep({ ...base, pr: { kind: "closed" } });
    expect(closed.act).toBe("cancel");
    expect(closed.act === "cancel" && closed.why).toContain("#7");
    expect(decideConversionStep({ ...base, pr: { kind: "missing" } }).act).toBe("cancel");
  });

  it("never takes an unreadable pull request for a closed one", () => {
    const s = decideConversionStep({ ...base, pr: { kind: "unreadable", why: "502" } });
    expect(s.act).toBe("wait");
    expect(s.act === "wait" && s.why).toContain("502");
  });
});

describe("finishing", () => {
  it("moves the clone under the target with the pointer the proposal delivered", () => {
    const delivered = "d".repeat(40);
    expect(finalisedCloneFields(CRM_HEAD, "main", delivered)).toEqual({
      parent_clone_id: CRM_ID,
      sync_scope: "mirror",
      crm_mode: "independent",
      last_synced_sha: delivered,
      default_branch: "main",
    });
  });

  it("falls back to the head's pointer when none was recorded", () => {
    expect(finalisedCloneFields(CRM_HEAD, null, null)).toMatchObject({
      last_synced_sha: PRIME_SHA,
      default_branch: "main",
    });
  });

  it("undeploys only retired functions the project runs, and never a prime function", () => {
    expect(
      functionsToUndeploy({
        retired: ["crm-send-message", "crm-calendar", "shared-with-prime", "not-deployed"],
        live: ["crm-send-message", "crm-calendar", "shared-with-prime", "other"],
        primeDeclared: ["shared-with-prime"],
      }),
    ).toEqual(["crm-calendar", "crm-send-message"]);
  });

  it("attempts every retired function when the project could not be read", () => {
    expect(
      functionsToUndeploy({ retired: ["b", "a", "p"], live: null, primeDeclared: ["p"] }),
    ).toEqual(["a", "b"]);
  });
});

describe("describeConversion", () => {
  const row = { from_mode: "dependent", to_mode: "independent", pr_number: 12, error: null };

  it("describes each state in a line", () => {
    expect(describeConversion({ ...row, status: "proposed" })).toContain("merge it to convert");
    expect(describeConversion({ ...row, status: "proposed", pr_number: null })).toContain(
      "being proposed",
    );
    expect(describeConversion({ ...row, status: "merged" })).toContain("finishing");
    expect(describeConversion({ ...row, status: "completed" })).toContain("completed");
    expect(describeConversion({ ...row, status: "cancelled", error: "closed" })).toContain(
      "cancelled (pull request #12) — closed",
    );
    expect(describeConversion({ ...row, status: "failed", error: "boom" })).toContain(
      "failed — boom",
    );
    expect(describeConversion({ ...row, status: "odd" })).toContain("odd");
    expect(describeConversion({ ...row, status: "completed" })).toContain(
      "CRM dependent (GoHighLevel) → CRM independent (Native CRM)",
    );
  });
});

describe("the routing files a conversion replaces", () => {
  const rows = [
    { pattern: "src/pages/Conversations.tsx", reason: "manual_reconcile" as const, note: null },
    { pattern: "src/hooks/useGHLCalendar.tsx", reason: "protected" as const, note: null },
    { pattern: "src/pages/**", reason: "manual_reconcile" as const, note: null },
    { pattern: "src/App.tsx", reason: "manual_reconcile" as const, note: null },
    { pattern: "src/pages/ClientTracker.tsx", reason: "manual_reconcile" as const, note: null },
  ];

  it("names exactly the four files that choose the CRM", () => {
    expect([...CRM_ROUTING_FILES].sort()).toEqual([
      "src/components/clients/ClientConversationsTab.tsx",
      "src/hooks/useGHLCalendar.tsx",
      "src/pages/ClientTracker.tsx",
      "src/pages/Conversations.tsx",
    ]);
  });

  it("releases only exact manual_reconcile holds on routing files", () => {
    const out = conversionExclusions(rows);
    expect(out.released).toEqual(["src/pages/ClientTracker.tsx", "src/pages/Conversations.tsx"]);
    expect(out.exclusions.map((r) => r.pattern)).toEqual([
      "src/hooks/useGHLCalendar.tsx",
      "src/pages/**",
      "src/App.tsx",
    ]);
  });

  it("never releases a protected row, even on a routing file", () => {
    const out = conversionExclusions(rows);
    expect(out.exclusions.some((r) => r.reason === "protected")).toBe(true);
    expect(out.released).not.toContain("src/hooks/useGHLCalendar.tsx");
  });

  it("retires the routing holds only on arrival at the dependent line", () => {
    expect(routingHoldsToRetire(rows, "dependent")).toEqual([
      "src/pages/ClientTracker.tsx",
      "src/pages/Conversations.tsx",
    ]);
    expect(routingHoldsToRetire(rows, "independent")).toEqual([]);
  });
});

describe("settleWithoutProposal — a conversion that opened no pull request", () => {
  const base = {
    status: "skipped",
    deliveredSha: "abc",
    summary: "Already in sync",
    error: null,
    keptDeletions: [] as string[],
    deletionRefusal: null,
  };

  it("finishes only a verified no-op with nothing withheld", () => {
    expect(settleWithoutProposal(base)).toEqual({ act: "finish" });
  });

  it("refuses a skip that verified nothing", () => {
    const r = settleWithoutProposal({
      ...base,
      deliveredSha: null,
      summary: "No installed modules",
    });
    expect(r.act).toBe("refuse");
    expect(r.act === "refuse" && r.why).toContain("No installed modules");
  });

  it("refuses when files from the line being left were withheld from removal", () => {
    const kept = ["a", "b", "c", "d", "e", "f", "g"];
    const r = settleWithoutProposal({ ...base, keptDeletions: kept });
    expect(r.act).toBe("refuse");
    expect(r.act === "refuse" && r.why).toContain("7 file(s)");
    expect(r.act === "refuse" && r.why).toContain("and 2 more");
  });

  it("refuses on the bulk deletion refusal, in its own words", () => {
    expect(settleWithoutProposal({ ...base, deletionRefusal: "Over the cap" })).toEqual({
      act: "refuse",
      why: "Over the cap",
    });
  });

  it("refuses anything that was not a skip", () => {
    expect(
      settleWithoutProposal({ ...base, status: "failed", error: "Retired function kept" }),
    ).toEqual({ act: "refuse", why: "Retired function kept" });
  });
});

describe("conversionWithoutDelivery", () => {
  it("lets a conversion that withheld nothing report its skip", () => {
    expect(conversionWithoutDelivery({ refusal: null, kept: [] })).toBeNull();
  });

  it("does not count the clone's own files", () => {
    expect(
      conversionWithoutDelivery({
        refusal: null,
        kept: [{ path: "src/mine.ts", why: "own", reason: "clone_owns" }],
      }),
    ).toBeNull();
  });

  it("refuses when a leaving-line file was withheld from removal", () => {
    const why = conversionWithoutDelivery({
      refusal: null,
      kept: [{ path: "src/crm.ts", why: "edited on the clone", reason: "edited" }],
    });
    expect(why).toMatch(/src\/crm\.ts \(edited on the clone\)/);
  });

  it("carries a refusal through unchanged", () => {
    expect(conversionWithoutDelivery({ refusal: "over the cap", kept: [] })).toBe("over the cap");
  });
});

describe("deployHoldsConversion", () => {
  it("holds on a refusal and on any failed function", () => {
    expect(deployHoldsConversion({ act: "refused", why: "down", failed: [] }, true)).toMatch(
      /down/,
    );
    expect(
      deployHoldsConversion(
        { act: "deployed", why: "", failed: [{ slug: "a", error: "e" }] },
        true,
      ),
    ).toMatch(/a \(e\)/);
  });

  it("releases a settled deploy, and a clone with no project yet", () => {
    expect(deployHoldsConversion({ act: "deployed", why: "", failed: [] }, true)).toBeNull();
    expect(deployHoldsConversion({ act: "skip", why: "", failed: [] }, true)).toBeNull();
    expect(
      deployHoldsConversion({ act: "refused", why: "no project", failed: [] }, false),
    ).toBeNull();
  });
});

describe("frozenOnHead — what a module-scoped head carries that no cascade refreshes", () => {
  // The prime at the head's recorded commit, the head, and a clone that holds
  // the prime's copies — the shape the acid run of 29 Sep 2026 measured.
  const prime = new Map([
    ["CLAUDE.md", "p-claude"],
    ["address-service/Dockerfile", "p-docker"],
    ["src/lib/crm/crmProvider.ts", "p-provider"],
    ["src/pages/Conversations.tsx", "p-conversations"],
    [".env.example", "p-env"],
    ["package.json", "p-package"],
    ["src/pages/Current.tsx", "p-current"],
    ["src/pages/Unchanged.tsx", "p-same"],
  ]);
  const head = new Map([
    ["CLAUDE.md", "h-claude-old"], // stale copy, outside the modules
    // address-service/Dockerfile: missing on the head
    ["src/lib/crm/crmProvider.ts", "h-provider"], // inside the modules: a cascade's business
    ["src/pages/Conversations.tsx", "h-conversations"], // a routing file: differs by design
    [".env.example", "h-env"], // held by an exclusion
    ["package.json", "h-package"], // a repository invariant
    ["src/pages/Current.tsx", "p-current"], // current
    ["src/pages/Unchanged.tsx", "h-same"], // stale, but the clone already holds it
    ["supabase/functions/crm-send-message/index.ts", "h-crm"], // the line's own
  ]);
  const cloneTree = new Map([
    ["CLAUDE.md", "p-claude"],
    ["address-service/Dockerfile", "p-docker"],
    ["src/lib/crm/crmProvider.ts", "p-provider"],
    ["src/pages/Conversations.tsx", "p-conversations"],
    [".env.example", "p-env"],
    ["package.json", "p-package"],
    ["src/pages/Current.tsx", "p-current"],
    ["src/pages/Unchanged.tsx", "h-same"],
  ]);
  const base = {
    primeAtHead: prime,
    head,
    clone: cloneTree,
    headInstalledGlobs: ["src/lib/crm/**"],
    invariantGlobs: ["package.json"],
    exclusions: [{ pattern: ".env.example", reason: "protected" as const }],
  };

  it("names exactly the stale and missing copies outside the head's scope", () => {
    expect(frozenOnHead(base)).toEqual(["CLAUDE.md", "address-service/Dockerfile"]);
  });

  it("is empty when the head's modules cover every path", () => {
    expect(frozenOnHead({ ...base, headInstalledGlobs: ["**"] })).toEqual([]);
  });

  it("never counts a file only the line carries", () => {
    expect(frozenOnHead(base)).not.toContain("supabase/functions/crm-send-message/index.ts");
  });

  it("an exclusion on the CLONE holds a path too", () => {
    expect(
      frozenOnHead({
        ...base,
        exclusions: [...base.exclusions, { pattern: "CLAUDE.md", reason: "protected" }],
      }),
    ).toEqual(["address-service/Dockerfile"]);
  });
});

describe("judgeTargetFreshness", () => {
  const ok = judgeConversion(input());
  it("passes a judgement through where the head is a mirror or nothing is frozen", () => {
    expect(judgeTargetFreshness(ok, { kind: "not_applicable" }, "NPC Test")).toBe(ok);
    expect(judgeTargetFreshness(ok, { kind: "measured", frozen: [] }, "NPC Test")).toBe(ok);
  });

  it("refuses a frozen head by name, listing the files and both remedies", () => {
    const frozen = Array.from(
      { length: FROZEN_PATHS_LISTED + 3 },
      (_, i) => `docs/f${String(i).padStart(2, "0")}.md`,
    );
    const j = judgeTargetFreshness(ok, { kind: "measured", frozen }, "NPC Test");
    expect(j.ok).toBe(false);
    if (j.ok) return;
    expect(j.kind).toBe("target_frozen");
    expect(j.reason).toContain("docs/f00.md");
    expect(j.reason).not.toContain(`docs/f${FROZEN_PATHS_LISTED}.md`);
    expect(j.reason).toContain("and 3 more");
    expect(j.reason).toContain("Make NPC CRM Independent a mirror");
    expect(j.reason).toContain("install modules");
  });

  it("an unreadable measurement refuses rather than reading as a current head", () => {
    const j = judgeTargetFreshness(
      ok,
      { kind: "unreadable", why: "GitHub truncated a tree listing" },
      "NPC Test",
    );
    expect(j.ok).toBe(false);
    if (!j.ok) {
      expect(j.kind).toBe("unreadable");
      expect(j.reason).toContain("truncated");
    }
  });

  it("never turns a refusal into anything else", () => {
    const refused = judgeConversion(input({ childCount: 2 }));
    expect(
      judgeTargetFreshness(refused, { kind: "measured", frozen: ["CLAUDE.md"] }, "NPC Test"),
    ).toBe(refused);
  });
});
