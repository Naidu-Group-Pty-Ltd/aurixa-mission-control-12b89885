import { describe, expect, it } from "vitest";

import {
  blockedFingerprint,
  blockedNoticesToRecheck,
  describeBlockedProposal,
  type StandingBlockedNotice,
} from "./blockedEscalation.pure";

const REPO = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-test-76b3b3" };
const url = (n: number, repo = REPO.repo) => `https://github.com/${REPO.owner}/${repo}/pull/${n}`;
const notice = (pr: unknown, u: string | null = null): StandingBlockedNotice => {
  const m = u ? /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(u) : null;
  return {
    pr,
    urlRepo: m ? { owner: m[1], repo: m[2] } : null,
    urlPr: m ? Number(m[3]) : null,
  };
};
const none = new Set<number>();

describe("blockedFingerprint", () => {
  it("is the pull request number and the gate's verdict sentence", () => {
    expect(blockedFingerprint(115, "Not merging — 1 check(s) failing: security (failure).")).toBe(
      "115:Not merging — 1 check(s) failing: security (failure).",
    );
  });
});

describe("describeBlockedProposal", () => {
  it("names the clone and pull request in the title and leads the body with the checks", () => {
    const { title, body } = describeBlockedProposal({
      cloneLabel: "NPC Test",
      prNumber: 115,
      prUrl: url(115),
      verdictWhy: "Not merging — 1 check(s) failing: security (failure).",
      durableSummary: null,
    });
    expect(title).toBe("Cascade blocked · NPC Test · PR #115");
    expect(body.split("\n\n")[1]).toBe("Not merging — 1 check(s) failing: security (failure).");
    // Closing the proposal is offered as a remedy — which is why closing it
    // has to clear the notice too.
    expect(body).toMatch(/or close the proposal/);
  });
});

describe("blockedNoticesToRecheck — which standing alarms are worth a read", () => {
  it("returns the pull requests the notices name, as the drain stores them", () => {
    // `metadata.pr` is written as a JSON number; a string of digits reads the same.
    expect(
      blockedNoticesToRecheck([notice(115, url(115)), notice("114")], {
        ...REPO,
        workList: none,
      }),
    ).toEqual([114, 115]);
  });

  it("asks once per pull request, however many failure shapes it alarmed under", () => {
    const three = [notice(23, url(23)), notice(23, url(23)), notice(23)];
    expect(blockedNoticesToRecheck(three, { ...REPO, workList: none })).toEqual([23]);
  });

  it("leaves a pull request the work list still carries to the per-proposal handling", () => {
    expect(
      blockedNoticesToRecheck([notice(115), notice(120)], { ...REPO, workList: new Set([120]) }),
    ).toEqual([115]);
  });

  it("leaves a notice it cannot identify standing rather than guessing", () => {
    const unreadable = [notice(undefined), notice(null), notice(0), notice(-3), notice(2.5)];
    const strings = [notice(""), notice("12a"), notice("#12"), notice({ n: 12 })];
    expect(
      blockedNoticesToRecheck([...unreadable, ...strings], { ...REPO, workList: none }),
    ).toEqual([]);
  });

  it("never asks this repository about a notice raised against another one", () => {
    // `pull/42` read in the wrong repository answers about a real, unrelated
    // pull request — the re-pointed-fork hazard the drain's rows refuse too.
    const foreign = notice(42, url(42, "npc-client-dashboard"));
    expect(blockedNoticesToRecheck([foreign], { ...REPO, workList: none })).toEqual([]);
  });

  it("leaves a notice whose URL and metadata name different pull requests", () => {
    expect(blockedNoticesToRecheck([notice(12, url(13))], { ...REPO, workList: none })).toEqual([]);
  });
});
