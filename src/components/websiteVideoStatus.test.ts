// How Website → Videos says what happened to a rebuild: what was asked of
// Vercel, and — the proof — when a production build last read the listings.
import { describe, expect, it } from "vitest";
import { rebuildLine } from "./website-video-status";

const AT = "2026-10-29T04:48:48.000Z";
const BUILT = { at: "2026-10-29T04:49:13.000Z", build: "dpl_3BgjqP16QD7" };

describe("rebuildLine", () => {
  it("names the secret while rebuilds are not connected", () => {
    expect(rebuildLine({ configured: false, last: null })).toMatch(/WEBSITE_DEPLOY_HOOK_URL/);
  });

  it("does not call a rebuild Vercel did not confirm a failure, and shows the build that read the listings", () => {
    const line = rebuildLine({
      configured: true,
      last: { at: AT, reason: "Requested from Website → Videos", outcome: "unconfirmed" },
      built: BUILT,
    });
    expect(line).toMatch(/Rebuild requested .*; Vercel did not confirm it in time\./);
    expect(line).toMatch(/The live website last rebuilt .* — its build read the listings\./);
    expect(line).not.toMatch(/fail/i);
  });

  it("says a confirmed request with its reason", () => {
    expect(
      rebuildLine({
        configured: true,
        last: { at: AT, reason: '"Client Reporting" draft → published', outcome: "requested" },
        built: null,
      }),
    ).toMatch(/^Last rebuild requested .* — "Client Reporting" draft → published\.$/);
  });
});
