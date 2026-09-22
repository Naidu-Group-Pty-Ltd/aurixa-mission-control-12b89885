import { describe, expect, it } from "vitest";
import {
  QUESTIONNAIRE_LABELS,
  QUESTIONNAIRE_SECTIONS,
  humaniseKey,
  renderAnswer,
  stage2Sections,
  summariseStage2,
} from "./leadQuestionnaire.pure";

describe("the vocabulary itself", () => {
  it("labels every key a section names — database vocabulary never reaches the operator", () => {
    const unlabelled = QUESTIONNAIRE_SECTIONS.flatMap((s) => s.keys).filter(
      (k) => !QUESTIONNAIRE_LABELS[k],
    );
    expect(unlabelled).toEqual([]);
  });

  it("names each key in exactly one section", () => {
    // A key listed twice resolves to whichever section comes first and the
    // other silently loses it — the defect the planning registers already paid
    // for once.
    const keys = QUESTIONNAIRE_SECTIONS.flatMap((s) => s.keys);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe("renderAnswer", () => {
  it("is null for what the record does not hold, so a row can be omitted", () => {
    for (const absent of [undefined, null, "", "   ", []]) {
      expect(renderAnswer(absent)).toBeNull();
    }
  });

  it("keeps `false` and `0` — 'no' and 'none' are things an applicant said", () => {
    expect(renderAnswer(false)).toEqual({ text: "no", list: null });
    expect(renderAnswer(0)).toEqual({ text: "0", list: null });
  });

  it("carries a multi-select as both a line and its parts", () => {
    expect(renderAnswer(["NSW", "VIC"])).toEqual({ text: "NSW; VIC", list: ["NSW", "VIC"] });
  });
});

describe("humaniseKey", () => {
  it("renders an unlabelled key as words rather than as an identifier", () => {
    expect(humaniseKey("customSystemApi")).toBe("Custom system api");
    expect(humaniseKey("migration_records")).toBe("Migration records");
  });
});

describe("stage2Sections", () => {
  it("draws a section only where something in it was answered", () => {
    const sections = stage2Sections({ userCount: "11 - 25", capabilities: ["Voice"] });
    expect(sections.map((s) => s.heading)).toEqual(["ORGANISATION", "WANTED"]);
  });

  it("keeps the free-text answer that no dropdown fitted", () => {
    // Measured before this list was shared: `roleOther`, `authorityOther`,
    // `informationManagementOther` and `customSystemOwner` were written by the
    // mirror and named by no section, so the most informative answer a
    // questionnaire collects reached no summary, no email and no page.
    const sections = stage2Sections({
      roleOther: "Principal & licensee",
      authorityOther: "Jointly with my business partner",
      informationManagementOther: "A shared drive",
      customSystemOwner: "Our own developer",
    });
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toEqual([
      "Role (in their words)",
      "Purchase authority (in their words)",
      "Information managed by (in their words)",
      "Who maintains the custom system",
    ]);
    expect(sections.map((s) => s.heading)).not.toContain("OTHER ANSWERS");
  });

  it("buckets a key the vocabulary has not caught up with rather than dropping it", () => {
    const sections = stage2Sections({ somethingAskedLater: "we bill in trust" });
    expect(sections).toEqual([
      {
        heading: "OTHER ANSWERS",
        items: [
          {
            key: "somethingAskedLater",
            label: "Something asked later",
            text: "we bill in trust",
            list: null,
          },
        ],
      },
    ]);
  });

  it("is empty for an empty answer set, not a page of headings", () => {
    expect(stage2Sections({})).toEqual([]);
    expect(summariseStage2({})).toBeNull();
  });
});

describe("summariseStage2", () => {
  it("is the sections, rendered — one implementation, so page and email agree", () => {
    const answers = { userCount: "11 - 25", nextStep: "Strategic review" };
    const fromSections = stage2Sections(answers)
      .map((s) => `${s.heading}\n${s.items.map((i) => `${i.label}: ${i.text}`).join("\n")}`)
      .join("\n\n");
    expect(summariseStage2(answers)).toBe(fromSections);
  });
});
