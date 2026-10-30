import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parityReading } from "./parityReading.pure";

const ago = () => "3h ago";

describe("parityReading", () => {
  it("says a backend nobody compared has not been compared", () => {
    expect(parityReading(null, null, ago)).toEqual({
      text: "Not yet compared with the prime.",
      differs: false,
    });
  });

  it("reads a match, with the credentials no policy sends beside it, never in it", () => {
    const report = {
      blocking_issues: [],
      secrets_diff: { not_forwarded: ["DOCUSIGN_INTEGRATION_KEY", "STEP_UP_ENFORCED"] },
    };
    expect(parityReading("2026-10-30T15:00:00Z", report, ago)).toEqual({
      text: "Compared with the prime 3h ago: matches · 2 credentials no forward policy sends (the tenant's own to supply)",
      differs: false,
    });
  });

  it("reads a difference as the report states it", () => {
    const report = { blocking_issues: ["missing_tables:1", "missing_secrets:16"] };
    expect(parityReading("2026-10-30T15:00:00Z", report, ago)).toEqual({
      text: "Compared with the prime 3h ago: differs: missing_tables:1, missing_secrets:16",
      differs: true,
    });
  });

  it("reads a report from before the forward policy was applied without inventing a count", () => {
    expect(
      parityReading("2026-09-04T14:13:05Z", { blocking_issues: ["missing_secrets:4"] }, ago).text,
    ).toBe("Compared with the prime 3h ago: differs: missing_secrets:4");
  });

  it("is what the clone page's backend card shows for a ready backend", () => {
    const card = readFileSync("src/components/clone-backend-card.tsx", "utf8");
    expect(card).toMatch(/import \{ parityReading \} from "@\/lib\/parityReading\.pure"/);
    expect(card).toMatch(
      /backend\.status === "ready" &&[\s\S]{0,80}parityReading\(\s*backend\.parity_checked_at,\s*backend\.parity_report,/,
    );
  });
});
