import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A hosting provider's ownership challenge is written wherever it APPEARS.
 *
 * Vercel answered `addDomain` with no challenge for two clones on 3 September
 * 2026 and then, once their CNAMEs resolved, asked for a TXT on
 * `_vercel.<zone>`. The drain's `verifying_domain` step recorded that challenge
 * on the row every two minutes for six hours and never queued the record; both
 * deployments were then failed as "stuck" with the exact record they needed
 * sitting in `domain_verification`. Asserted against the source because the
 * drain needs a hosting credential to run.
 */
describe("the deployment drain writes a domain challenge at verification time", () => {
  const src = readFileSync(join(process.cwd(), "src/routes/hooks.deployment-drain.tsx"), "utf8");
  const start = src.indexOf('case "verifying_domain":');
  const end = src.indexOf("default:", start);
  const verifying = src.slice(start, end);

  it("finds the step at all — an empty slice would pass every check below", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(verifying).toContain("provider.getDomain(");
  });

  it("queues the provider's challenges before waiting, keyed by the challenge itself", () => {
    expect(verifying).toContain("enqueueDomainVerificationJobs(");
    expect(verifying).toContain("challenges: state.challenges");
    // The wait still carries the challenge on the row, so an operator can read it.
    expect(verifying).toContain("domain_verification: state.challenges");
  });

  it("still waits rather than advancing on an unverified domain", () => {
    expect(verifying).toContain('kind: "wait"');
    expect(verifying.indexOf("enqueueDomainVerificationJobs(")).toBeLessThan(
      verifying.indexOf('kind: "wait"'),
    );
  });
});
