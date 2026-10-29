import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A failed backend has a way back from its own page.
 *
 * Every terminal verdict the backend drain writes tells the operator to
 * "retry from the clone page". Measured 29 Oct 2026 on
 * `tutorial-demo-orrimere-c158c7`, failed with "Worker stalled — attempts
 * exhausted": the page had no retry. `retryBackendProvisioning` existed on the
 * server and nothing called it, and the backend card's one button — "Apply 945
 * pending migrations" — answered "Backend is not ready (status: failed)". The
 * remedy the message named could not be performed, so the clone could neither
 * be used nor repaired from Mission Control.
 */
const card = () => readFileSync("src/components/clone-backend-card.tsx", "utf8");
const drain = () => readFileSync("src/routes/hooks.backend-provisioning-drain.tsx", "utf8");

describe("a failed backend can be retried from the clone page", () => {
  it("the remedy the drain names is one the card performs", () => {
    // If the drain stops naming it, this pin has nothing to hold the card to.
    expect(drain()).toMatch(/retry from the clone page/);
    const src = card();
    expect(src).toMatch(
      /import \{[^}]*\bretryBackendProvisioning\b[^}]*\} from "@\/lib\/backend-provisioning\.functions"/,
    );
    expect(src).toMatch(/useServerFn\(retryBackendProvisioning\)/);
  });

  it("offers it on a failed backend, with the seed admin's credential the failed run cleared", () => {
    const src = card();
    const formAt = src.indexOf('backend.status === "failed" && (');
    expect(formAt).toBeGreaterThan(-1);
    const form = src.slice(formAt, src.indexOf("</form>", formAt));
    expect(form).toMatch(/type="email"/);
    expect(form).toMatch(/type="password"/);
    // The server refuses a password under eight characters; the button says so first.
    expect(form).toMatch(/retryPassword\.length < 8/);
    expect(src).toMatch(/adminPassword: retryPassword/);
  });

  it("offers the migration sync only where the sync accepts it", () => {
    // `syncCloneMigrations` refuses anything but a ready backend. Offering it
    // elsewhere made the card's one button an error message.
    expect(readFileSync("src/server/migration-sync.functions.ts", "utf8")).toMatch(
      /backend\.status !== "ready"/,
    );
    expect(card()).toMatch(/hasPending && backend\.status === "ready" && \(/);
  });

  it("keeps showing the pipeline while it refreshes, rather than a spinner in its place", () => {
    // The card re-reads every five seconds in flight; the skeleton is for the
    // first read alone, or an operator watching a provision sees no stage.
    expect(card()).toMatch(/if \(loading && !backend\) \{/);
  });
});
