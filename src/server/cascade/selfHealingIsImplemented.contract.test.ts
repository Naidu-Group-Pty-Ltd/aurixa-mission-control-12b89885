import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ACT_POLICY } from "./custodian.pure";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";
import type { BlockageClass } from "./blockageTaxonomy.pure";
import { stripComments } from "../sourceComments.pure";

const custodian = readFileSync(new URL("../custodian.server.ts", import.meta.url), "utf8");

/** Does the dispatcher actually branch on this act, or would it fall to the else? */
const dispatched = (act: string) =>
  new RegExp(`verdict\\.act\\s*===\\s*(["'\`])${act}\\1`).test(stripComments(custodian));

/**
 * An act that is switched on must be an act that exists.
 *
 * `runCustodian` dispatches on `verdict.act` and every unmatched act falls to
 * an else returning *"'<act>' is enabled and has no implementation in this
 * build."* That branch is honest — it reports rather than skipping silently —
 * but it means enabling an act is one edit away from putting a dead control in
 * front of an operator who has been told the condition is repairable.
 *
 * `requeue_dropped_clone` is why this test exists. It was catalogued with the
 * policy text *"Queue this clone's part again as a NEW scoped delivery, never
 * by reviving a settled one"*, and nothing implemented it — so the one thing
 * that could re-offer a clone dropped from a partial delivery would have
 * answered "no implementation in this build" had anybody switched it on.
 * Fifteen partial events across three clones were rescued by coincidence
 * instead: a later, unrelated full-tree cascade happening to carry the same
 * paths, which stops working exactly when deliveries stop.
 *
 * What this deliberately does NOT assert is that every `selfHeals: true` class
 * has an implemented act. That field answers a different question — its own
 * documentation is *"May a custodian re-run the work that clears this, without
 * any new decision being taken?"* — so it is a statement about whether a
 * re-run would be a judgement, not a promise that anything re-runs. Four
 * classes are legitimately stamped `true` with acts nobody has built yet
 * (`policy_unseeded`, `unreconciled_proposal`, `attempts_exhausted`,
 * `deferred_far_future`); that is a backlog, not a lie, and a test that failed
 * on it would be asserting a rule this codebase does not hold.
 */
describe("an enabled custodial act has an implementation", () => {
  const acts = (Object.keys(ACT_POLICY) as BlockageClass[])
    .map((cls) => ({ cls, policy: ACT_POLICY[cls] }))
    .filter((e) => e.policy.kind === "act");

  const enabled = acts.filter((e) => e.policy.kind === "act" && e.policy.enabled);

  it("finds at least one enabled act, so this is not vacuous", () => {
    expect(enabled.length).toBeGreaterThan(0);
  });

  it.each(enabled.map((e) => [e.cls, e.policy.kind === "act" ? e.policy.act : ""]))(
    "%s is enabled, so %s must have a dispatch branch",
    (cls, act) => {
      expect(
        dispatched(act),
        `${cls} enables '${act}' and nothing in custodian.server.ts dispatches it — ` +
          `it would answer "no implementation in this build" on every tick.`,
      ).toBe(true);
    },
  );
});

describe("the dropped-clone repair exists, and is deliberately off", () => {
  it("is dispatched rather than falling to the no-implementation branch", () => {
    // Pinned specifically, because this is the act this change built. Without
    // it the class is back where it was: a condition the ledger raises, an act
    // the catalogue names, and nothing anywhere that performs it.
    expect(dispatched("requeue_dropped_clone")).toBe(true);
  });

  it("is still disabled, which is an operator's decision and not this change's", () => {
    // Built and off are different states. Pushing a tenant's code is
    // outward-facing; `retarget_proposal_urls` was turned on by a deliberate
    // step and this one is owed the same. What changed is that the flip is now
    // against a real act.
    const policy = ACT_POLICY.partial_clone_dropped;
    expect(policy.kind).toBe("act");
    if (policy.kind !== "act") return;
    expect(policy.act).toBe("requeue_dropped_clone");
    expect(policy.enabled).toBe(false);
  });

  it("the class it repairs still means what it meant", () => {
    // The repair must not have quietly changed what the condition SAYS. Read
    // from the policy rather than asserted from memory — the first draft of
    // this test guessed `conditionedOnDivergence: false` and the table says
    // true, which is right: a drop stops being a blockage the moment a later
    // delivery carries the same paths, and that is exactly the incidental
    // recovery this act exists to stop depending on.
    const p = BLOCKAGE_POLICY.partial_clone_dropped;
    expect(p.owner, "the machinery's to repair, not an operator's").toBe("machinery");
    expect(p.selfHeals, "re-running a dropped delivery takes no new decision").toBe(true);
    expect(p.conditionedOnDivergence).toBe(true);
  });
});
