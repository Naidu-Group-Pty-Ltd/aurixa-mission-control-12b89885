import { describe, expect, it } from "vitest";
import {
  ACT_POLICY,
  MAX_ACTS_PER_TICK,
  MAX_ROWS_PER_ACT,
  decideRetarget,
  mayCustodianAct,
} from "./custodian.pure";
import { BLOCKAGE_POLICY, type BlockageClass } from "./blockageTaxonomy.pure";

const blockage = (cls: BlockageClass) => ({
  cls,
  owner: BLOCKAGE_POLICY[cls].owner,
  selfHeals: BLOCKAGE_POLICY[cls].selfHeals,
});

describe("the custodian may re-run work; it may never change a verdict", () => {
  /*
    The rule the whole design turns on. A proposal going red because prime
    shipped something the clone's checks refuse is the gate working, and no
    amount of retrying substitutes for somebody changing the code.
  */
  it("refuses ci_red outright, and says why in words about the gate", () => {
    const v = mayCustodianAct(blockage("ci_red"));
    expect(v.may).toBe(false);
    expect(v.may === false && v.reportOnly).toBe(false);
    expect(v.may === false && v.why).toMatch(/gate working/i);
  });

  it("refuses everything a person owns", () => {
    for (const cls of Object.keys(BLOCKAGE_POLICY) as BlockageClass[]) {
      if (BLOCKAGE_POLICY[cls].owner === "machinery") continue;
      const v = mayCustodianAct(blockage(cls));
      expect(v.may, `${cls} is owned by a person and must never be acted on`).toBe(false);
      expect(v.may === false && v.reportOnly, `${cls} must not even be reported as pending`).toBe(false);
    }
  });

  it("refuses a blockage recorded as one that does not clear by re-running", () => {
    const v = mayCustodianAct({ cls: "repo_retargeted", owner: "machinery", selfHeals: false });
    expect(v.may).toBe(false);
  });

  /*
    The row carries `owner` and `self_heals` because an act is audited against
    what was true when it was taken. A row whose stamp disagrees with today's
    policy is one nobody could defend later, so it is not acted on either way.
  */
  it("refuses when the row's stamp and today's policy disagree", () => {
    const v = mayCustodianAct({ cls: "ci_red", owner: "machinery", selfHeals: true });
    expect(v.may).toBe(false);
  });

  it("refuses an undeclared class rather than guessing", () => {
    const v = mayCustodianAct({
      cls: "something_invented_later" as BlockageClass,
      owner: "machinery",
      selfHeals: true,
    });
    expect(v.may).toBe(false);
    expect(v.may === false && v.reportOnly).toBe(false);
  });
});

describe("three states, not two", () => {
  /*
    A machinery blockage is not automatically the custodian's. A claim stuck
    past the stall window is `reclaimStalled`'s and a cut pass is the pass
    ledger's; building a second actor for either is how two things repairing
    one condition come to disagree.
  */
  it("declines what something else already repairs, naming who", () => {
    for (const cls of ["event_stuck_running", "invocation_cut", "consecutive_failures"] as BlockageClass[]) {
      const policy = ACT_POLICY[cls];
      expect(policy.kind, cls).toBe("owned_elsewhere");
      expect(policy.kind === "owned_elsewhere" && policy.by.length, cls).toBeGreaterThan(3);
      expect(mayCustodianAct(blockage(cls)).may, cls).toBe(false);
    }
  });

  it("every blockage class has a declared policy", () => {
    for (const cls of Object.keys(BLOCKAGE_POLICY) as BlockageClass[]) {
      expect(ACT_POLICY[cls], `${cls} has no act policy`).toBeDefined();
    }
    expect(Object.keys(ACT_POLICY).sort()).toEqual(Object.keys(BLOCKAGE_POLICY).sort());
  });

  /*
    Every act the custodian claims must be for a class the taxonomy says is
    machinery. An act declared for a person-owned class would be a permission
    granted in the wrong file.
  */
  it("declares no act for anything a person owns", () => {
    for (const [cls, policy] of Object.entries(ACT_POLICY)) {
      if (policy.kind !== "act") continue;
      expect(BLOCKAGE_POLICY[cls as BlockageClass].owner, `${cls} declares an act`).toBe("machinery");
      expect(BLOCKAGE_POLICY[cls as BlockageClass].selfHeals, `${cls} declares an act`).toBe(true);
    }
  });
});

describe("enabled is separate from permitted", () => {
  /*
    Step 5 ships the catalogue reporting and writing nothing; step 6 enables
    one act. A permitted-but-disabled act is reported in full and performed not
    at all, which is what makes the difference observable before it is trusted.
  */
  it("reports a permitted act that is not switched on, rather than refusing it", () => {
    const v = mayCustodianAct(blockage("policy_unseeded"));
    expect(v.may).toBe(false);
    expect(v.may === false && v.reportOnly).toBe(true);
  });

  it("enables exactly one act today, and it is the retarget", () => {
    const enabled = Object.entries(ACT_POLICY)
      .filter(([, p]) => p.kind === "act" && p.enabled)
      .map(([cls]) => cls);
    expect(enabled).toEqual(["repo_retargeted"]);
  });

  it("permits the enabled act", () => {
    const v = mayCustodianAct(blockage("repo_retargeted"));
    expect(v.may).toBe(true);
    expect(v.may === true && v.act).toBe("retarget_proposal_urls");
  });

  it("is bounded per tick and per act", () => {
    expect(MAX_ACTS_PER_TICK).toBeGreaterThan(0);
    expect(MAX_ACTS_PER_TICK).toBeLessThanOrEqual(10);
    expect(MAX_ROWS_PER_ACT).toBeGreaterThan(0);
    expect(MAX_ROWS_PER_ACT).toBeLessThanOrEqual(200);
  });
});

describe("decideRetarget", () => {
  const CLONE = "Naidu-Group-Pty-Ltd/npc-client-dashboard";

  /*
    The live fault. The repository was TRANSFERRED — same name, new owner —
    which GitHub performs without renumbering, and pull request 27 is still the
    cascade this platform opened, merged on 26 August 2026.
  */
  it("repoints an owner transfer and keeps the number", () => {
    const d = decideRetarget({
      prUrl: "https://github.com/lavan96/npc-client-dashboard/pull/27",
      currentRepo: CLONE,
    });
    expect(d).toEqual({
      retarget: true,
      from: "https://github.com/lavan96/npc-client-dashboard/pull/27",
      to: "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/27",
      prNumber: 27,
      repo: CLONE,
    });
  });

  /*
    THE RULE THAT KEEPS THIS A REPAIR RATHER THAN A GUESS.

    A transfer keeps the name and the numbering. A rename does not, and neither
    does an unrelated repository in the same account — so pointing a record at
    a number inside one would replace a wrong record with a more convincing
    one.
  */
  it("refuses when the repository NAME differs, not only the owner", () => {
    const d = decideRetarget({
      prUrl: "https://github.com/lavan96/some-other-repo/pull/27",
      currentRepo: CLONE,
    });
    expect(d.retarget).toBe(false);
    expect(d.retarget === false && d.why).toMatch(/different repository/i);
  });

  it("does nothing when the record already names this clone's repository", () => {
    const d = decideRetarget({
      prUrl: `https://github.com/${CLONE}/pull/27`,
      currentRepo: CLONE,
    });
    expect(d.retarget).toBe(false);
    expect(d.retarget === false && d.why).toMatch(/already names/i);
  });

  it("is case-insensitive about the owner and the name", () => {
    const d = decideRetarget({
      prUrl: "https://github.com/naidu-group-pty-ltd/NPC-Client-Dashboard/pull/9",
      currentRepo: CLONE,
    });
    expect(d.retarget).toBe(false);
  });

  it("refuses anything it cannot read, rather than guessing a number", () => {
    for (const prUrl of [
      null,
      "",
      "not a url",
      "https://github.com/owner/repo/issues/27",
      "https://github.com/owner/repo/pull/",
      "https://gitlab.com/owner/repo/pull/27",
      "https://github.com/owner/repo/pull/27/files",
    ]) {
      expect(decideRetarget({ prUrl, currentRepo: CLONE }).retarget, String(prUrl)).toBe(false);
    }
  });

  it("refuses when the clone's own repository is unrecorded", () => {
    const d = decideRetarget({
      prUrl: "https://github.com/lavan96/npc-client-dashboard/pull/27",
      currentRepo: null,
    });
    expect(d.retarget).toBe(false);
  });

  it("refuses a malformed clone repository rather than building half a URL", () => {
    for (const currentRepo of ["justaname", "a/b/c", "/", "owner/"]) {
      const d = decideRetarget({
        prUrl: "https://github.com/lavan96/npc-client-dashboard/pull/27",
        currentRepo,
      });
      expect(d.retarget, currentRepo).toBe(false);
    }
  });

  /*
    A trailing slash is the same record. Refusing it would leave rows behind
    for a reason that is not about the repository at all.
  */
  it("reads a trailing slash and whitespace as the same record", () => {
    const d = decideRetarget({
      prUrl: "  https://github.com/lavan96/npc-client-dashboard/pull/44/  ",
      currentRepo: CLONE,
    });
    expect(d.retarget && d.prNumber).toBe(44);
  });
});
