/**
 * The readiness answer is mounted where the decision is made.
 *
 * `readiness.pure.ts` has carried the whole catalogue — Vercel, Cloudflare
 * (DNS *and* each clone's Turnstile widget), Resend, the GitHub App, the
 * Supabase management token — since it was written, and it was rendered in
 * exactly one place: `/health`. The New Clone wizard showed none of it, so an
 * operator picked Vercel, reserved a subdomain, provisioned, and found out
 * afterwards from a deployment row parked at `pending_platform` and a login
 * page whose CAPTCHA never appeared.
 *
 * An unused export typechecks, lints and builds. The sibling product repo has
 * already paid for exactly this — three components written, documented, merged
 * and deployed with zero call sites, and nothing in its gate could see it —
 * and answered with a mount guard. This is that guard.
 *
 * It reads source rather than rendering, because this repository's vitest runs
 * in a Node environment with no DOM and no testing-library. A mount assertion
 * that needs neither is worth more than a render test nobody can run.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const ROOT = join(__dirname, "..", "..");

/**
 * Source with its commentary removed.
 *
 * This repository documents its reasoning at length and in the negative —
 * the panel's own header explains why it says "no gaps" rather than
 * "healthy", and the wizard carries a comment naming the unfalsifiable line
 * it replaced. A test that scans raw source therefore fails on the
 * documentation of the very rule it is checking, which teaches the next
 * person to delete the comment. What these assertions are about is what the
 * component RENDERS, so that is what they read.
 */
function rendered(source: string): string {
  return stripComments(source);
}

const WIZARD_SOURCE = readFileSync(join(ROOT, "src", "routes", "clones.new.tsx"), "utf8");
const PANEL_SOURCE = readFileSync(
  join(ROOT, "src", "components", "provisioning-readiness-panel.tsx"),
  "utf8",
);
const WIZARD = rendered(WIZARD_SOURCE);
// Comment-stripped for the same reason the wizard is: these rules are about
// what the code DOES, and the prose beside them names every identifier they
// look for.
const CORE = rendered(
  readFileSync(join(ROOT, "src", "server", "clone-provisioning.server.ts"), "utf8"),
);
const PANEL = rendered(PANEL_SOURCE);

describe("the New Clone wizard renders the readiness answer", () => {
  it("mounts the panel", () => {
    expect(WIZARD).toContain("<ProvisioningReadinessPanel");
    expect(WIZARD).toContain("useProvisioningReadiness()");
  });

  /**
   * One read for the page. A `CapabilityNote` that fetched for itself would
   * fire a request per section, and the sections would be free to disagree
   * with the panel above them about the same capability.
   */
  it("reads readiness exactly once and passes it down", () => {
    expect(WIZARD.match(/useProvisioningReadiness\(\)/g) ?? []).toHaveLength(1);
    // Both consumers take the reading as a prop rather than calling for it.
    expect(PANEL).toContain("readiness: ProvisioningReadiness");
    expect(PANEL).toContain("readiness,");
  });

  /**
   * Each section that depends on a credential says so IN the section.
   *
   * These three are the ones an operator sets on this page and cannot
   * otherwise find out about: the hosting provider they pick, the subdomain
   * they reserve (which is also the clone's Turnstile widget), and the admin
   * account they create (which needs outbound mail to be reachable).
   */
  it.each(["hosting", "dns", "email"])("notes the %s capability beside its control", (key) => {
    expect(WIZARD).toContain(`capabilityKey="${key}"`);
  });

  /**
   * The copy these replaced warned that something MIGHT be true without ever
   * saying whether it was — "Dormant if no hosting token is configured",
   * "Dormant if Cloudflare isn't configured yet". A conditional hypothetical
   * beside a control an operator is about to use is not a disclosure.
   */
  it.each([
    "Dormant if no hosting token is configured",
    "Dormant if Cloudflare isn't configured yet",
  ])("no longer carries the unfalsifiable line %j", (phrase) => {
    expect(WIZARD).not.toContain(phrase);
  });

  /**
   * It discloses; `provisionClone` refuses. Two gates is how one of them
   * becomes wrong, and presence-only readiness is the wrong one to gate on —
   * a token that is set may still be revoked, and a token that is missing may
   * be about to land.
   */
  it("does not block the submit on readiness", () => {
    expect(WIZARD).not.toMatch(/disabled=\{[^}]*readiness[^}]*\}/);
    expect(WIZARD).not.toMatch(/if\s*\(\s*!?\s*readiness[^)]*\)\s*return/);
  });
});

/**
 * A per-clone credential that only a Vercel-built clone receives is a
 * credential most of this fleet does not have.
 *
 * Both halves of a clone's own identity are minted by the deployment drain at
 * `syncing_env` — and that case opens `if (!row.project_id) return`, so only a
 * clone Vercel is building ever reaches it. Provisioning writes
 * `not_requested` for `manual` and `none`, and `pending_platform` when no
 * Vercel token is configured; a deployment in any of those three states never
 * advances. Every clone in this fleet is served manually, so in practice
 * nothing had ever minted a Turnstile widget or started a sending identity
 * except an operator opening the clone page and clicking two buttons.
 */
describe("a clone's own credentials are armed by the act that creates it", () => {
  it("mints the Turnstile widget from the wizard, the same server function the clone page uses", () => {
    expect(WIZARD).toContain(
      'import { provisionCloneTurnstile } from "@/lib/turnstile-identity.functions"',
    );
    expect(WIZARD).toContain("useServerFn(provisionCloneTurnstile)");
  });

  /**
   * The sending identity moved OFF the browser, and that is strictly stronger
   * than what this test used to assert.
   *
   * It was a second call the wizard made after `provisionClone` had already
   * returned, so a closed tab between the two left the clone with no identity
   * — and worse, the deployment drain's own call passes no domain at all, so a
   * clone that got one later got it on a domain nobody chose. The operator's
   * typed domain now travels WITH the submit and `provisionCloneCore` starts
   * it, where no browser can lose it.
   */
  it("starts the sending identity on the server, with the domain the operator typed", () => {
    expect(WIZARD).toMatch(/sendingDomain:\s*armEmail\s*\?/);
    expect(CORE).toMatch(/await\s+advanceEmailIdentity\s*\(/);
    expect(CORE).toMatch(/sendingDomain:\s*data\.sendingDomain/);
  });

  /**
   * And the backend with it, for a blunter reason: NOTHING else in the
   * platform creates a `clone_backends` row. Not the deployment drain, not a
   * sweep. A submit interrupted after `provisionClone` returned left a clone
   * that would never have a backend, with the admin password gone and nothing
   * recording that one had been asked for.
   */
  it("enqueues the backend on the server, from the credentials the submit carried", () => {
    expect(WIZARD).toMatch(/backend:\s*dedicatedBackend/);
    expect(WIZARD).not.toContain("useServerFn(provisionBackend)");
    expect(CORE).toMatch(/await\s+enqueueCloneBackendProvisioning\s*\(/);
  });

  it("offers each as an explicit choice rather than doing it silently", () => {
    expect(WIZARD).toContain("armTurnstile");
    expect(WIZARD).toContain("armEmail");
    expect(WIZARD).toContain("dedicatedBackend");
  });

  /**
   * Non-fatal, like every other enqueue on this path. The clone exists either
   * way and the clone page can retry — failing the whole submit because
   * Cloudflare was briefly unreachable would destroy a filled form over
   * something retryable. On the server that means a try AND a notification,
   * because a console line nobody reads is not a report.
   */
  it("does not let the Turnstile mint fail the provisioning run", () => {
    const call = WIZARD.indexOf("await provisionTurnstileFn(");
    expect(call, "provisionTurnstileFn must be called").toBeGreaterThan(-1);
    expect(WIZARD.slice(Math.max(0, call - 400), call)).toContain("try {");
  });

  /**
   * The one `githubAppCapability.pure.ts` was written for, and the one its
   * header says went unfixed: "its result was DISCARDED at the call site, so
   * the only trace was a line in a log nobody reads."
   *
   * Without `BACKEND_DEPLOYED_BY` the clone's `deploy-supabase-functions`
   * workflow has no way to stand down — it requires either a deploy token the
   * clone is deliberately not given, or that variable — so the repository
   * shows a red check on every push, for ever. Measured 2 Sep 2026 on
   * `npc-client-dashboard`: 31 of 31 runs failed. Measured again 19 Sep 2026
   * on `npc-crm-independent-6505dc`: 3 of 3, including the merge that carried
   * its three CRM edge functions, which is why none of them is deployed.
   */
  it("reports a failed backend-deployer declaration instead of logging it", () => {
    const call = CORE.indexOf("declareMissionControlDeploysBackend(");
    expect(call, "the declaration must be made").toBeGreaterThan(-1);
    const after = CORE.slice(call, call + 2000);
    expect(after).toMatch(/if\s*\(!declared\.ok\)/);
    expect(after, "a console line is not a report").toContain("warnOnClone(");
  });

  it.each(["enqueueCloneBackendProvisioning", "advanceEmailIdentity"])(
    "does not let %s fail the provisioning run, and says so when it fails",
    (fn) => {
      const call = CORE.indexOf(`await ${fn}(`);
      expect(call, `${fn} must be called`).toBeGreaterThan(-1);
      const around = CORE.slice(Math.max(0, call - 600), call + 1800);
      expect(around, `${fn} must sit inside a try block`).toContain("try {");
      expect(around, `${fn}'s failure must reach an operator`).toContain("warnOnClone(");
    },
  );

  /**
   * `provision` is the only mode that CREATES. `refresh` polls and creates
   * nothing, so using it here would leave every new clone with no identity at
   * all while looking like it had been wired up.
   */
  it("does not reach for a refresh-only entry point", () => {
    expect(WIZARD).not.toContain("refreshCloneTurnstile");
    expect(WIZARD).not.toContain("checkCloneEmailIdentity");
    expect(CORE).toMatch(/mode:\s*"provision"/);
  });
});

describe("the panel keeps readiness honest", () => {
  it("scopes itself with the flag the report carries, not a local list", () => {
    expect(PANEL).toContain("onClonePath");
    // `CLONE_PATH` lives under `src/server/**`, which the import-protection
    // plugin denies to the client bundle. A component importing the VALUE
    // fails the build; one keeping its own copy drifts.
    expect(PANEL).not.toContain("CLONE_PATH");
  });

  it("renders the caveat off the report rather than writing its own", () => {
    expect(PANEL).toContain("report.caveat");
  });

  /**
   * A degraded capability must not wear a blocked capability's words.
   *
   * `consequence` is typed and documented as "What breaks while this is
   * blocked". Rendering it for every non-`ready` verdict told an operator
   * "A clone cannot get its own Supabase project. Provisioning stops before
   * anything is created." about `clone_backend` — whose required credentials
   * (`SB_MGMT_API_TOKEN`, `SB_ORG_ID`) were both PRESENT, which is precisely
   * what makes the verdict `degraded` rather than `blocked`. The only absence
   * was `SB_ORG_PROJECT_SOFT_LIMIT`, an optional override that falls back to
   * `DEFAULT_SOFT_LIMITS[planTier] ?? pro`.
   *
   * It was reported as a working pipeline having broken. Nothing had: a
   * healthy platform was being described in the words of a broken one, which
   * is the same class of error as a green light that is true about the check
   * and false about the world — this module's own header warns about the one,
   * and this is the other.
   *
   * `readiness-card.tsx` had it right from the start, for the reason it
   * states: "shown only when something is actually wrong, so a working
   * platform is not a wall of warnings."
   */
  it("shows the consequence only when a capability is blocked", () => {
    const at = PANEL.indexOf("capability.consequence");
    expect(at, "the panel must render a consequence somewhere").toBeGreaterThan(-1);
    const guard = PANEL.slice(Math.max(0, at - 260), at);
    expect(guard).toContain('capability.verdict === "blocked"');
    expect(
      guard,
      'a `!== "ready"` guard lets degraded and unknown wear the blocked text',
    ).not.toContain('capability.verdict !== "ready"');
  });

  it("says what is actually absent on a degraded capability", () => {
    // A pill reading `degraded` with nothing beside it names a state rather
    // than the thing an operator would act on.
    expect(PANEL).toContain('capability.verdict === "degraded"');
    expect(PANEL).toContain('!c.required && c.state === "missing"');
  });

  it("does not describe a defaulting credential as a failure", () => {
    const foot = PANEL.slice(PANEL.indexOf("Degraded means"));
    expect(foot.slice(0, 400)).toContain("still runs");
    expect(foot.slice(0, 400)).toContain("not a failure");
  });

  /**
   * A component nothing renders is not shipped.
   *
   * This repository's sibling product paid for that rule twice — three UI
   * components and twenty-eight CSS classes written, documented, merged and
   * deployed with zero call sites, invisible to lint, typecheck and build.
   * The mount guard above exists for the readiness panel; this is the same
   * guard for the sequence note, which is the only thing on this page that
   * explains why a freshly provisioned clone shows waiting rows.
   */
  it("mounts the sequence note that explains what happens after the button", () => {
    expect(WIZARD).toContain("<ProvisioningSequenceNote");
  });

  it("puts the sequence note where the question is asked — above the button", () => {
    const note = WIZARD.indexOf("<ProvisioningSequenceNote");
    // The BUTTON, by its own label expression — a bare "Provision clone"
    // also matches this route's `<title>`, which sits at the top of the file
    // and would make any placement pass.
    const button = WIZARD.indexOf('busy ? "Provisioning');
    expect(note).toBeGreaterThan(-1);
    expect(button, "the submit button must be found by its label expression").toBeGreaterThan(-1);
    expect(note, "an explanation below the button is read after the decision").toBeLessThan(button);
  });

  it("never calls a present credential working", () => {
    for (const word of ["healthy", "all good", "verified", "working"]) {
      expect(PANEL.toLowerCase()).not.toContain(word);
    }
  });

  /**
   * A failed read is a third answer. Collapsing it into "unconfigured" sends
   * an operator to fix something that is not broken.
   */
  it("keeps a failed read distinct from an unconfigured deployment", () => {
    expect(PANEL).toContain("Could not check");
    expect(PANEL).toContain("not the same as it being");
  });
});
