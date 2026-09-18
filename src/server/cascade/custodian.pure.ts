/**
 * The custodian may re-run work. It may never change a verdict.
 *
 * ## What that sentence is doing
 *
 * It is the whole reconciliation between "the fleet stays in sync no matter
 * what" and "this must not compromise on genuine breakages". Every permission
 * below is a consequence of it, and every refusal is too.
 *
 * Re-running is not a judgement: a spent rate-limit window, a stale URL, an
 * unseeded policy and a retired event are all facts about the MACHINERY, and
 * repeating the pass that failed on them takes no new decision. Clearing a
 * `ci_red` is a judgement — prime shipped something the clone's checks refuse,
 * the gate is doing its job, and no amount of retrying substitutes for
 * somebody changing the code. The line between those is `owner`, which
 * `blockageTaxonomy.pure.ts` declares once and this reads.
 *
 * ## Three states, not two
 *
 * A machinery blockage is not automatically the custodian's. Some are already
 * somebody's: a claim stuck past the stall window is `reclaimStalled`'s, and a
 * pass cut off mid-flight is the pass ledger's. Building a second actor for
 * either would be two things repairing one condition, which is how they come
 * to disagree — so the catalogue distinguishes an act it owns from an act
 * somebody else owns from something nobody may do.
 *
 * ## Enabled is separate from permitted
 *
 * Step 5 of `CASCADE_PIPELINE_HEALTH.md` ships the whole catalogue REPORTING
 * and writing nothing; step 6 enables one act. `enabled` is that gate, and it
 * is deliberately not the same field as `permitted`: an act can be entirely
 * within the custodian's authority and still be switched off because nobody
 * has watched it run yet.
 *
 * Client-safe: pure, and its only import is the taxonomy whose `owner` field
 * is the permission it enforces.
 */
import { BLOCKAGE_POLICY, type BlockageClass, type BlockageOwner } from "./blockageTaxonomy.pure";

/** What the custodian does about one class of blockage. */
export type ActPolicy =
  | {
      kind: "act";
      act: CustodialActName;
      /**
       * Whether this act may WRITE yet. An act that is permitted and not
       * enabled is reported in full and performed not at all.
       */
      enabled: boolean;
      what: string;
    }
  | {
      /** Already repaired by something else. A second actor would disagree. */
      kind: "owned_elsewhere";
      by: string;
      why: string;
    }
  | { kind: "never"; why: string };

export type CustodialActName =
  | "retarget_proposal_urls"
  | "seed_exclusion_policy"
  | "requeue_dropped_clone"
  | "revive_retired_event"
  | "rearm_deferral"
  | "redrain_proposal";

export const ACT_POLICY: Record<BlockageClass, ActPolicy> = {
  /*
    THE ONE ACT STEP 6 ENABLES.

    It rewrites a URL from a value already in the clone's own record. It
    touches no repository, spends no write on GitHub, and hands the rows back
    to the merge drain's reconciler rather than settling them itself — which
    is the property that makes it the safest first write this design can make.
  */
  repo_retargeted: {
    kind: "act",
    act: "retarget_proposal_urls",
    enabled: true,
    what: "Point proposal records at the repository this clone actually has, so the reconciler can reach them.",
  },
  policy_unseeded: {
    kind: "act",
    act: "seed_exclusion_policy",
    enabled: false,
    what: "Seed the exclusion policy every cascade into this clone is being refused for want of.",
  },
  partial_clone_dropped: {
    kind: "act",
    act: "requeue_dropped_clone",
    enabled: false,
    what: "Queue this clone's part again as a NEW scoped delivery, never by reviving a settled one.",
  },
  attempts_exhausted: {
    kind: "act",
    act: "revive_retired_event",
    enabled: false,
    what: "Offer a retired delivery to the queue again, once the condition that retired it is observably gone.",
  },
  deferred_far_future: {
    kind: "act",
    act: "rearm_deferral",
    enabled: false,
    what: "Bring a delivery parked past any provider reset back to the front of the queue.",
  },
  unreconciled_proposal: {
    kind: "act",
    act: "redrain_proposal",
    enabled: false,
    what: "Point the existing reconciler at a proposal record it has not caught up with.",
  },

  /*
    MACHINERY, AND NOT THE CUSTODIAN'S.

    Both of these are repaired by something that already runs. A second actor
    for either would be two things repairing one condition on two clocks.
  */
  event_stuck_running: {
    kind: "owned_elsewhere",
    by: "the drain's stall reclaim",
    why: "`reclaimStalled` already returns a claim held past the stall window, every minute. A custodial act here would be a second reclaim racing the first.",
  },
  invocation_cut: {
    kind: "owned_elsewhere",
    by: "the pass ledger",
    why: "A pass cut off keeps its prepared blobs and its probe answers, and the next tick continues from them. Re-running it from the custodian would discard that and re-buy the evidence.",
  },
  consecutive_failures: {
    kind: "owned_elsewhere",
    by: "whatever caused them",
    why: "A run of failures is a symptom and never a cause; the cause has its own class and its own act. Acting on the count would be acting on the thermometer.",
  },

  /*
    NEVER. Each of these needs somebody to decide something, and retrying is
    not a substitute for a decision.
  */
  ci_red: {
    kind: "never",
    why: "The clone's own checks refuse this delivery. That is the gate working, and nothing here retries it, rebuilds it hoping for a different answer, or merges it.",
  },
  approval_pending: {
    kind: "never",
    why: "A second operator's approval is the control. A custodian that supplied it would be the gate approving itself.",
  },
  unclassified: {
    kind: "never",
    why: "Nothing here can say what is wrong, so nothing here may act on it. Guessing at a repair for an unrecognised condition is how an unknown fault becomes a known one somewhere else.",
  },
};

export type ActVerdict =
  | { may: true; act: CustodialActName; what: string }
  | { may: false; why: string; reportOnly: boolean };

/**
 * May the custodian act on this blockage?
 *
 * `owner` and `selfHeals` are read from the ROW rather than from the policy
 * table, and then checked against the policy table as well. They are written
 * from one source, so in a healthy system they always agree — and the row is
 * what an act is audited against, so an act taken on a row whose stored
 * permission disagrees with today's policy is one nobody can defend later.
 * Both must say yes.
 */
export function mayCustodianAct(blockage: {
  cls: BlockageClass;
  owner: BlockageOwner;
  selfHeals: boolean;
}): ActVerdict {
  const policy = ACT_POLICY[blockage.cls];
  if (!policy) {
    return {
      may: false,
      reportOnly: false,
      why: `No act is declared for '${blockage.cls}', and an undeclared class is never acted on.`,
    };
  }
  if (policy.kind === "never") return { may: false, reportOnly: false, why: policy.why };
  if (policy.kind === "owned_elsewhere") {
    return { may: false, reportOnly: false, why: `Repaired by ${policy.by}. ${policy.why}` };
  }

  // The row's own stamp. An act is audited against what was true when it was
  // taken, so this is the field that has to permit it.
  if (blockage.owner !== "machinery") {
    return {
      may: false,
      reportOnly: false,
      why: `This is owned by ${blockage.owner}, and only a fact about the machinery may be re-run.`,
    };
  }
  if (!blockage.selfHeals) {
    return {
      may: false,
      reportOnly: false,
      why: "This blockage is recorded as one that does not clear by re-running.",
    };
  }
  // And today's policy, which must agree.
  const declared = BLOCKAGE_POLICY[blockage.cls];
  if (!declared || declared.owner !== "machinery" || !declared.selfHeals) {
    return {
      may: false,
      reportOnly: false,
      why: `The stored permission and the current policy disagree about '${blockage.cls}'; an act nobody can defend later is not taken.`,
    };
  }

  if (!policy.enabled) {
    return {
      may: false,
      reportOnly: true,
      why: `'${policy.act}' is permitted and not yet switched on — reporting what it would do.`,
    };
  }
  return { may: true, act: policy.act, what: policy.what };
}

/** Acts performed in one tick, across the whole fleet. */
export const MAX_ACTS_PER_TICK = 4;
/** Rows one act may rewrite in one tick. */
export const MAX_ROWS_PER_ACT = 60;

export type RetargetDecision =
  | { retarget: true; from: string; to: string; prNumber: number; repo: string }
  | { retarget: false; why: string };

/**
 * Where a proposal record should point.
 *
 * Measured 18 Sep 2026: 43 rows named `lavan96/npc-client-dashboard` while the
 * clone's own record read `Naidu-Group-Pty-Ltd/npc-client-dashboard`. The
 * repository had been TRANSFERRED — same name, new owner — which GitHub
 * performs without renumbering anything, and pull request 27 is still the
 * cascade this platform opened, merged on 26 August.
 *
 * Three rules, and the middle one is what keeps this a repair rather than a
 * guess.
 *
 * **The number is never touched.** A pull request number is the identity of a
 * proposal. Moving a record onto a different number would be inventing a
 * record rather than repairing one.
 *
 * **Only the OWNER may differ.** A transfer keeps the repository's name and
 * its numbering; a RENAME does not, and neither does an unrelated repository
 * that happens to be in the account. Where the name differs too, this refuses
 * — the record may be stale for a reason this cannot see, and pointing it at a
 * number that exists in a different repository would replace one wrong record
 * with a more convincing one.
 *
 * **Nothing here decides the record's outcome.** It produces a URL. Whether
 * the proposal merged, closed or is still open is read from GitHub by the
 * merge drain's reconciler afterwards, which is the one implementation of that
 * question.
 */
export function decideRetarget(input: {
  prUrl: string | null;
  currentRepo: string | null;
}): RetargetDecision {
  const { prUrl, currentRepo } = input;
  if (!prUrl) return { retarget: false, why: "The record names no pull request." };
  if (!currentRepo) {
    return {
      retarget: false,
      why: "This clone's own repository is not recorded, so there is nothing to point at.",
    };
  }

  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i.exec(prUrl.trim());
  if (!m) return { retarget: false, why: `'${prUrl}' is not a pull request URL this can read.` };
  const [, owner, repo, number] = m;

  const target = currentRepo.split("/");
  if (target.length !== 2 || !target[0] || !target[1]) {
    return { retarget: false, why: `'${currentRepo}' is not an owner/repository pair.` };
  }
  const [targetOwner, targetRepo] = target;

  if (
    owner.toLowerCase() === targetOwner.toLowerCase() &&
    repo.toLowerCase() === targetRepo.toLowerCase()
  ) {
    return { retarget: false, why: "The record already names this clone's repository." };
  }

  if (repo.toLowerCase() !== targetRepo.toLowerCase()) {
    return {
      retarget: false,
      why:
        `The record names repository '${repo}' and this clone's is '${targetRepo}'. Only a change of ` +
        `OWNER is a transfer that keeps its numbering; a different name is a different repository, and ` +
        `pointing a record at a number inside one would replace a wrong record with a convincing one.`,
    };
  }

  return {
    retarget: true,
    from: prUrl,
    to: `https://github.com/${targetOwner}/${targetRepo}/pull/${number}`,
    prNumber: Number(number),
    repo: `${targetOwner}/${targetRepo}`,
  };
}
