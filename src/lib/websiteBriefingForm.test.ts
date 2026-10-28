import { describe, expect, it } from "vitest";
import {
  exploreLabelFor,
  factsFromForm,
  formFromRow,
  formsEqual,
  payloadFromForm,
} from "./websiteBriefingForm";
import { publishProblems, type BriefingFacts } from "./websiteBriefings.pure";

const row: BriefingFacts & { sort_order: number } = {
  slug: "compliance-passport",
  status: "published",
  title: "Inside the Compliance Passport",
  kicker: "One property, six professionals, and a client who no longer has to be the messenger.",
  summary:
    "One property, six professionals and the same documents requested again and again. The AML/CTF Compliance Passport keeps identity verification together.",
  series: "compliance",
  artwork: "/brand/layer-05-enterprise-governance.webp",
  artwork_position: null,
  takeaways: ["One.", "Two.", "Three."],
  explore_label: "Open the Compliance Passport",
  explore_to: "/compliance-passport",
  orientation: "portrait",
  disclaimer: "Your business remains responsible for its AML/CTF obligations.",
  transcript: ["First paragraph.", "Second paragraph."],
  chapters: [
    { at: 0, label: "One client, six professionals" },
    { at: 65, label: "Consent" },
  ],
  media_version: "v1",
  media_hls: "videos/compliance-passport/v1/master.m3u8",
  media_mp4: "videos/compliance-passport/v1/fallback-720p.mp4",
  media_poster: "videos/compliance-passport/v1/poster.jpg",
  media_card: "videos/compliance-passport/v1/card.jpg",
  media_captions: null,
  duration_seconds: 118,
  published_on: "2026-10-28",
  sort_order: 20,
};

describe("the editor form", () => {
  it("round-trips a listing without changing it", () => {
    const form = formFromRow(row);
    expect(form.chapters).toEqual([
      { time: "0:00", label: "One client, six professionals" },
      { time: "1:05", label: "Consent" },
    ]);
    expect(form.transcript).toBe("First paragraph.\n\nSecond paragraph.");
    const built = payloadFromForm(form);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.copy.chapters).toEqual(row.chapters);
    expect(built.payload.copy.transcript).toEqual(row.transcript);
    expect(built.payload.copy.disclaimer).toBe(row.disclaimer);
    expect(publishProblems(factsFromForm(row, form))).toEqual([]);
  });

  it("drops empty chapter rows and blank takeaways, and refuses an unreadable time", () => {
    const form = formFromRow(row);
    form.chapters.push({ time: "", label: "" });
    form.takeaways.push("  ");
    const built = payloadFromForm(form);
    expect(built.ok && built.payload.copy.chapters).toHaveLength(2);
    expect(built.ok && built.payload.copy.takeaways).toHaveLength(3);
    form.chapters.push({ time: "soon", label: "Later" });
    expect(payloadFromForm(form)).toEqual({
      ok: false,
      errors: ["Chapter 3: write the time as m:ss."],
    });
  });

  it("an empty disclaimer or artwork position is stored as none", () => {
    const form = { ...formFromRow(row), disclaimer: " ", artworkPosition: "" };
    const built = payloadFromForm(form);
    expect(built.ok && built.payload.copy.disclaimer).toBeNull();
    expect(built.ok && built.payload.copy.artwork_position).toBeNull();
  });

  it("the problems beside Publish are the problems of what Save would write", () => {
    const form = { ...formFromRow(row), summary: "Too short." };
    expect(publishProblems(factsFromForm(row, form)).join()).toMatch(/70 to 320/);
  });

  it("suggests the explore label for a page, and notices edits", () => {
    expect(exploreLabelFor("/platform#serviceability")).toBe("See the serviceability engine");
    const form = formFromRow(row);
    expect(formsEqual(form, formFromRow(row))).toBe(true);
    expect(formsEqual(form, { ...form, title: "Changed" })).toBe(false);
  });
});
