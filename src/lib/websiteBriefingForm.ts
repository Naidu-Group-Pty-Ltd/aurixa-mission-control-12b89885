/**
 * The Website → Videos editor's form: a listing as text fields, and back.
 *
 * Kept apart from the page so the conversions are tested: a chapter time
 * typed as "1:05" must be 65 seconds in the row, a transcript's blank lines
 * must be its paragraph breaks, and the problems shown beside Publish must be
 * computed from exactly what Save would write.
 */
import {
  WEBSITE_EXPLORE_TARGETS,
  chaptersOf,
  formatChapterTime,
  paragraphsOf,
  parseChapterTime,
  type BriefingFacts,
} from "./websiteBriefings.pure";

export type BriefingForm = {
  slug: string;
  title: string;
  kicker: string;
  summary: string;
  series: string;
  artwork: string;
  artworkPosition: string;
  takeaways: string[];
  exploreTo: string;
  exploreLabel: string;
  orientation: string;
  disclaimer: string;
  transcript: string;
  chapters: Array<{ time: string; label: string }>;
  sortOrder: string;
};

export function formFromRow(row: BriefingFacts & { sort_order: number }): BriefingForm {
  return {
    slug: row.slug,
    title: row.title,
    kicker: row.kicker,
    summary: row.summary,
    series: row.series,
    artwork: row.artwork,
    artworkPosition: row.artwork_position ?? "",
    takeaways: row.takeaways.length ? [...row.takeaways] : ["", ""],
    exploreTo: row.explore_to,
    exploreLabel: row.explore_label,
    orientation: row.orientation,
    disclaimer: row.disclaimer ?? "",
    transcript: row.transcript.join("\n\n"),
    chapters: chaptersOf(row.chapters).map((c) => ({
      time: formatChapterTime(c.at),
      label: c.label,
    })),
    sortOrder: String(row.sort_order),
  };
}

export type SavePayload = {
  slug: string;
  copy: {
    title: string;
    kicker: string;
    summary: string;
    series: "flagship" | "platform" | "growth" | "compliance";
    artwork: string;
    artwork_position: string | null;
    takeaways: string[];
    explore_label: string;
    explore_to: string;
    orientation: "landscape" | "portrait";
    disclaimer: string | null;
    transcript: string[];
    chapters: Array<{ at: number; label: string }>;
    sort_order: number;
  };
};

/** The form as Save would write it, or the fields that stop it being written at all. */
export function payloadFromForm(
  form: BriefingForm,
): { ok: true; payload: SavePayload } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const chapters = form.chapters
    .filter((c) => c.time.trim() || c.label.trim())
    .map((c, index) => {
      const at = parseChapterTime(c.time);
      if (at === null) errors.push(`Chapter ${index + 1}: write the time as m:ss.`);
      return { at: at ?? 0, label: c.label.trim() };
    });
  const sortOrder = Number(form.sortOrder);
  if (!Number.isInteger(sortOrder) || sortOrder < 0) errors.push("The order is a whole number.");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      slug: form.slug.trim(),
      copy: {
        title: form.title.trim(),
        kicker: form.kicker.trim(),
        summary: form.summary.trim(),
        series: form.series as SavePayload["copy"]["series"],
        artwork: form.artwork,
        artwork_position: form.artworkPosition.trim() || null,
        takeaways: form.takeaways.map((t) => t.trim()).filter(Boolean),
        explore_label: form.exploreLabel.trim(),
        explore_to: form.exploreTo,
        orientation: form.orientation === "portrait" ? "portrait" : "landscape",
        disclaimer: form.disclaimer.trim() || null,
        transcript: paragraphsOf(form.transcript),
        chapters,
        sort_order: sortOrder,
      },
    },
  };
}

/** The row this form would produce, for the rules to read before it is saved. */
export function factsFromForm<T extends BriefingFacts>(row: T, form: BriefingForm): T {
  const built = payloadFromForm(form);
  if (!built.ok) return row;
  const { slug, copy } = built.payload;
  return { ...row, ...copy, slug, chapters: copy.chapters };
}

/** The suggested label for a page, so picking a page fills a label nobody has to write. */
export function exploreLabelFor(to: string): string {
  return WEBSITE_EXPLORE_TARGETS.find((t) => t.to === to)?.label ?? "Explore the platform";
}

export function formsEqual(a: BriefingForm, b: BriefingForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
