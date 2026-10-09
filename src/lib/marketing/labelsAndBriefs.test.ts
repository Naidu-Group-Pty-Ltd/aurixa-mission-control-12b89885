import { describe, expect, it } from "vitest";
import { parseBrief } from "./briefParse.pure";
import {
  changeTone,
  formatCents,
  formatComparisonValue,
  signedCount,
  statusWord,
} from "./labels.pure";

describe("marketing labels", () => {
  it("never calls a change in spend good or bad", () => {
    expect(changeTone({ change: 0.4, goodDirection: "neutral" })).toBe("neutral");
    expect(changeTone({ change: 0.4, goodDirection: "up" })).toBe("good");
    expect(changeTone({ change: 0.4, goodDirection: "down" })).toBe("bad");
    expect(changeTone({ change: null, goodDirection: "up" })).toBe("neutral");
  });

  it("writes an unmeasured figure as a dash in every unit", () => {
    for (const key of ["spend", "ctr", "watchTimeMinutes", "netFollows", "impressions"]) {
      expect(formatComparisonValue(key, null, "AUD")).toBe("—");
    }
    expect(signedCount(null)).toBe("—");
    expect(formatCents(null)).toBe("—");
  });

  it("signs a net change and keeps a zero unsigned", () => {
    expect(signedCount(12)).toBe("+12");
    expect(signedCount(-3)).toBe("−3");
    expect(signedCount(0)).toBe("0");
  });

  it("reads a platform's status word without judging it", () => {
    expect(statusWord("CAMPAIGN_STATUS_ENABLE")).toBe("Enable");
    expect(statusWord("LEAD_GENERATION")).toBe("Lead generation");
    expect(statusWord(null)).toBeNull();
  });

  it("writes CRM cents as Australian dollars", () => {
    expect(formatCents(254900)).toBe("$2,549.00");
  });
});

describe("parsing a brief", () => {
  it("splits fences, lists, headings and paragraphs, and nothing else", () => {
    const blocks = parseBrief(
      [
        ":::success",
        "A **good** month.",
        ":::",
        "",
        ":::metric",
        "Label: Cost per lead",
        "Value: $41.20",
        ":::",
        "",
        "- one",
        "- two",
        "",
        "## Next",
        "Plain words.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["fence", "fence", "list", "heading", "para"]);
    expect(blocks[1]).toEqual({
      kind: "fence",
      fence: "metric",
      lines: ["Label: Cost per lead", "Value: $41.20"],
    });
  });

  it("keeps markup a model wrote as text", () => {
    const blocks = parseBrief('<img src=x onerror="alert(1)"> **bold**');
    expect(blocks).toEqual([{ kind: "para", lines: ['<img src=x onerror="alert(1)"> **bold**'] }]);
  });

  it("survives an unclosed fence", () => {
    expect(parseBrief(":::tip\nno closing line")).toEqual([
      { kind: "fence", fence: "tip", lines: ["no closing line"] },
    ]);
  });
});
