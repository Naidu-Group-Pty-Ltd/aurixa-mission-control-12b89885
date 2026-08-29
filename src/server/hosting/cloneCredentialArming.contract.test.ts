/**
 * A per-clone credential that only future clones receive is not a feature the
 * fleet has — and one that not even future clones receive is a feature nobody
 * has.
 *
 * Both halves of a clone's own identity are minted during `syncing_env`: the
 * Turnstile widget, because Vite inlines `VITE_*` at BUILD time and a site key
 * that arrives later is a site key the bundle does not carry; and the Resend
 * sending domain, because its DNS has to propagate before the domain can
 * verify, so starting it while the build runs is what lets
 * `email-identity-drain` mint the key without anybody waiting on a click.
 *
 * The email half is the one that has to be asserted rather than assumed. The
 * drain that finishes it deliberately ADVANCES identities and never STARTS
 * one, so if this call goes away nothing else in the platform ever begins a
 * sending identity — and the failure is silent: clones deploy perfectly and
 * simply cannot send mail, which is the exact outage this whole feature was
 * built to end.
 *
 * A source contract rather than a behavioural test because the fault is an
 * ABSENCE, and the drain still advances its state machine correctly with the
 * call deleted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(__dirname, "..", "..", "routes", "hooks.deployment-drain.tsx"),
  "utf8",
);

/** The body of the `syncing_env` case, where both credentials are minted. */
function syncingEnvCase(): string {
  const start = SOURCE.indexOf('case "syncing_env": {');
  expect(start, "the syncing_env case must exist").toBeGreaterThan(-1);
  const end = SOURCE.indexOf('case "deploying": {', start);
  expect(end, "the deploying case must follow it").toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("provisioning arms a clone's own credentials", () => {
  it("mints the clone's Turnstile widget", () => {
    expect(syncingEnvCase()).toContain("provisionTurnstileIdentity");
  });

  it("starts the clone's Resend sending identity", () => {
    expect(
      syncingEnvCase(),
      "nothing else in the platform starts one — the drain only advances",
    ).toContain("advanceEmailIdentity");
  });

  it("starts it in provision mode, the only mode that registers a domain", () => {
    // `refresh` polls and creates nothing, so it would leave every new clone
    // with no identity at all while looking like it had been wired up.
    const body = syncingEnvCase();
    const call = body.slice(body.indexOf("advanceEmailIdentity(admin"));
    expect(call.slice(0, 200)).toContain('mode: "provision"');
  });

  it("refuses rather than guesses when the master key is absent", () => {
    expect(syncingEnvCase()).toContain("isResendConfigured");
  });

  it("never lets either credential fail the deployment", () => {
    // Both are best-effort: a clone that cannot get a widget or a sending
    // domain must still reach production and say so on its own panel.
    const body = syncingEnvCase();
    expect(body).toContain("turnstileNote");
    expect(body).toContain("emailNote");
    // Each note is surfaced in the step's result rather than swallowed.
    expect(body).toMatch(/turnstile:\s*turnstileNote/);
    expect(body).toMatch(/email:\s*emailNote/);
  });
});
