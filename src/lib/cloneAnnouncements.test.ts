import { describe, expect, it } from "vitest";
import {
  activeAnnouncementsForClone,
  announcementReachesClone,
  announcementTone,
  audienceDraftOf,
  audienceHeadline,
  audienceModeOf,
  audienceScopeOf,
  audienceSummary,
  MAX_WIRE_ANNOUNCEMENTS,
  resolveAnnouncementState,
  toCloneWire,
  WIRE_KEYS,
  workspaceMatches,
  type AnnouncementFacts,
  type AnnouncementState,
} from "@/lib/cloneAnnouncements.pure";

const NOW = new Date("2026-09-16T12:00:00Z");

function row(overrides: Partial<AnnouncementFacts> = {}): AnnouncementFacts {
  return {
    id: "a1",
    title: "Scheduled maintenance",
    body: "The platform pauses briefly on Saturday night.",
    link_url: null,
    link_label: null,
    severity: "info",
    display: "banner",
    dismissible: true,
    audience_plan_slugs: null,
    audience_clone_ids: null,
    starts_at: null,
    ends_at: null,
    revision: 1,
    published_at: "2026-09-16T10:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

describe("resolveAnnouncementState", () => {
  it("derives the whole lifecycle from timestamps alone", () => {
    expect(resolveAnnouncementState(row({ published_at: null }), NOW)).toBe("draft");
    expect(
      resolveAnnouncementState(row({ starts_at: "2026-09-17T00:00:00Z" }), NOW),
    ).toBe("scheduled");
    expect(resolveAnnouncementState(row(), NOW)).toBe("active");
    expect(
      resolveAnnouncementState(row({ ends_at: "2026-09-16T11:00:00Z" }), NOW),
    ).toBe("expired");
    expect(
      resolveAnnouncementState(row({ archived_at: "2026-09-16T11:00:00Z" }), NOW),
    ).toBe("archived");
  });

  it("archived outranks everything, including an open window", () => {
    const archivedWhileLive = row({
      archived_at: "2026-09-16T11:30:00Z",
      starts_at: "2026-09-01T00:00:00Z",
      ends_at: "2026-12-01T00:00:00Z",
    });
    expect(resolveAnnouncementState(archivedWhileLive, NOW)).toBe("archived");
  });

  it("an end time exactly now reads expired, not active", () => {
    expect(
      resolveAnnouncementState(row({ ends_at: NOW.toISOString() }), NOW),
    ).toBe("expired");
  });
});

describe("announcementReachesClone", () => {
  const scale = { id: "c-scale", planSlug: "scale" };
  const launch = { id: "c-launch", planSlug: "launch" };
  const planless = { id: "c-none", planSlug: null };

  it("NULL audience means everyone", () => {
    expect(announcementReachesClone(row(), scale)).toBe(true);
    expect(announcementReachesClone(row(), planless)).toBe(true);
  });

  it("a plan list narrows to those plans", () => {
    const scoped = row({ audience_plan_slugs: ["scale", "growth"] });
    expect(announcementReachesClone(scoped, scale)).toBe(true);
    expect(announcementReachesClone(scoped, launch)).toBe(false);
  });

  it("a clone with no plan on record is excluded from plan-scoped notices, never guessed at", () => {
    expect(
      announcementReachesClone(row({ audience_plan_slugs: ["launch"] }), planless),
    ).toBe(false);
  });

  it("a clone list narrows to those clones", () => {
    const scoped = row({ audience_clone_ids: ["c-launch"] });
    expect(announcementReachesClone(scoped, launch)).toBe(true);
    expect(announcementReachesClone(scoped, scale)).toBe(false);
  });

  it("plan and clone lists AND together", () => {
    const scoped = row({
      audience_plan_slugs: ["scale"],
      audience_clone_ids: ["c-scale", "c-launch"],
    });
    expect(announcementReachesClone(scoped, scale)).toBe(true);
    // Named by id but on the wrong plan: excluded.
    expect(announcementReachesClone(scoped, launch)).toBe(false);
  });
});

describe("toCloneWire", () => {
  it("carries exactly WIRE_KEYS and nothing else — targeting never leaks to a clone", () => {
    const wire = toCloneWire(
      row({
        audience_plan_slugs: ["scale"],
        audience_clone_ids: ["c-secret"],
      }),
    );
    expect(Object.keys(wire).sort()).toEqual([...WIRE_KEYS].sort());
    const asRecord = wire as unknown as Record<string, unknown>;
    expect(asRecord.audience_plan_slugs).toBeUndefined();
    expect(asRecord.audience_clone_ids).toBeUndefined();
  });

  it("degrades unknown vocabulary to the mildest reading instead of throwing", () => {
    const wire = toCloneWire(row({ severity: "apocalyptic", display: "jumbotron" }));
    expect(wire.severity).toBe("info");
    expect(wire.display).toBe("banner");
  });

  it("forces a modal dismissible — an uncloseable modal is a lock screen", () => {
    const wire = toCloneWire(row({ display: "modal", dismissible: false }));
    expect(wire.dismissible).toBe(true);
  });

  it("a banner keeps its declared dismissibility", () => {
    expect(toCloneWire(row({ dismissible: false })).dismissible).toBe(false);
  });

  it("a link label exists only where a link does, and defaults to the URL", () => {
    expect(toCloneWire(row()).linkLabel).toBeNull();
    expect(
      toCloneWire(row({ link_url: "https://example.com/x" })).linkLabel,
    ).toBe("https://example.com/x");
    expect(
      toCloneWire(
        row({ link_url: "https://example.com/x", link_label: "Read more" }),
      ).linkLabel,
    ).toBe("Read more");
    // A label with no URL is not a link; it does not travel.
    expect(toCloneWire(row({ link_label: "orphan" })).linkLabel).toBeNull();
  });
});

describe("activeAnnouncementsForClone", () => {
  const clone = { id: "c1", planSlug: "scale" };

  it("serves only active, matching rows, newest first", () => {
    const rows = [
      row({ id: "old", published_at: "2026-09-10T00:00:00Z" }),
      row({ id: "draft", published_at: null }),
      row({ id: "archived", archived_at: "2026-09-15T00:00:00Z" }),
      row({ id: "wrong-plan", audience_plan_slugs: ["launch"] }),
      row({ id: "new", published_at: "2026-09-16T11:00:00Z" }),
    ];
    expect(activeAnnouncementsForClone(rows, clone, NOW).map((w) => w.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("caps the list — a dashboard is not a feed", () => {
    const rows = Array.from({ length: MAX_WIRE_ANNOUNCEMENTS + 5 }, (_, i) =>
      row({ id: `a${i}`, published_at: `2026-09-0${(i % 9) + 1}T00:00:00Z` }),
    );
    expect(activeAnnouncementsForClone(rows, clone, NOW)).toHaveLength(
      MAX_WIRE_ANNOUNCEMENTS,
    );
  });
});

describe("console helpers", () => {
  it("audienceSummary says who a notice reaches, in words", () => {
    expect(audienceSummary(row())).toBe("all clones");
    expect(audienceSummary(row({ audience_plan_slugs: ["scale", "growth"] }))).toBe(
      "plans: scale, growth",
    );
    expect(
      audienceSummary(row({ audience_clone_ids: ["abcd1234-0000-0000-0000-000000000000"] }), {
        "abcd1234-0000-0000-0000-000000000000": "NPC Test",
      }),
    ).toBe("clones: NPC Test");
  });

  it("announcementTone answers for every state", () => {
    const states: AnnouncementState[] = [
      "draft",
      "scheduled",
      "active",
      "expired",
      "archived",
    ];
    for (const s of states) {
      expect(["neutral", "success", "warning", "danger"]).toContain(
        announcementTone(s),
      );
    }
  });
});

describe("the three ways a message is addressed", () => {
  it("reads a stored scope back as the choice the console shows", () => {
    expect(audienceDraftOf(row()).mode).toBe("everyone");
    expect(audienceDraftOf(null).mode).toBe("everyone");
    expect(audienceDraftOf(row({ audience_clone_ids: ["c1"] }))).toMatchObject({
      mode: "one",
      cloneIds: ["c1"],
    });
    expect(audienceDraftOf(row({ audience_clone_ids: ["c1", "c2"] }))).toMatchObject({
      mode: "selected",
      selectedBy: "workspaces",
    });
    expect(audienceDraftOf(row({ audience_plan_slugs: ["scale"] }))).toMatchObject({
      mode: "selected",
      selectedBy: "plans",
      planSlugs: ["scale"],
    });
    // One workspace AND a plan is narrower than "one workspace" alone, so it is
    // never shown as the single-workspace choice.
    expect(
      audienceModeOf(row({ audience_clone_ids: ["c1"], audience_plan_slugs: ["scale"] })),
    ).toBe("selected");
  });

  it("stores everyone as no scope at all", () => {
    expect(
      audienceScopeOf({
        mode: "everyone",
        selectedBy: "workspaces",
        cloneIds: ["c1"],
        planSlugs: ["p"],
      }),
    ).toEqual({ ok: true, audiencePlanSlugs: null, audienceCloneIds: null });
  });

  it("never widens an empty choice to everyone", () => {
    for (const draft of [
      { mode: "one", selectedBy: "workspaces", cloneIds: [], planSlugs: [] },
      { mode: "one", selectedBy: "workspaces", cloneIds: ["c1", "c2"], planSlugs: [] },
      { mode: "selected", selectedBy: "workspaces", cloneIds: [""], planSlugs: ["p"] },
      { mode: "selected", selectedBy: "plans", cloneIds: ["c1"], planSlugs: [] },
    ] as const) {
      const scope = audienceScopeOf(draft);
      expect(scope.ok).toBe(false);
    }
  });

  it("stores exactly what was chosen, de-duplicated, and nothing from the other list", () => {
    expect(
      audienceScopeOf({
        mode: "one",
        selectedBy: "plans",
        cloneIds: ["c1", "c1"],
        planSlugs: ["p"],
      }),
    ).toEqual({ ok: true, audiencePlanSlugs: null, audienceCloneIds: ["c1"] });
    expect(
      audienceScopeOf({
        mode: "selected",
        selectedBy: "workspaces",
        cloneIds: ["c1", "c2", "c1"],
        planSlugs: ["p"],
      }),
    ).toEqual({ ok: true, audiencePlanSlugs: null, audienceCloneIds: ["c1", "c2"] });
    expect(
      audienceScopeOf({
        mode: "selected",
        selectedBy: "plans",
        cloneIds: ["c1"],
        planSlugs: ["p", "q"],
      }),
    ).toEqual({ ok: true, audiencePlanSlugs: ["p", "q"], audienceCloneIds: null });
  });

  it("a stored scope round-trips through the console unchanged", () => {
    for (const r of [
      row(),
      row({ audience_clone_ids: ["c1"] }),
      row({ audience_clone_ids: ["c1", "c2"] }),
      row({ audience_plan_slugs: ["scale", "growth"] }),
    ]) {
      const scope = audienceScopeOf(audienceDraftOf(r));
      expect(scope).toEqual({
        ok: true,
        audiencePlanSlugs: r.audience_plan_slugs,
        audienceCloneIds: r.audience_clone_ids,
      });
    }
  });

  it("names the audience in a phrase", () => {
    const names = { c1: "Acme", c2: "Birch", c3: "Cedar", c4: "Dune" };
    expect(audienceHeadline(row(), names)).toBe("All workspaces");
    expect(audienceHeadline(row({ audience_clone_ids: ["c1"] }), names)).toBe("Only Acme");
    expect(audienceHeadline(row({ audience_clone_ids: ["c1", "c2"] }), names)).toBe("Acme, Birch");
    expect(audienceHeadline(row({ audience_clone_ids: ["c1", "c2", "c3", "c4"] }), names)).toBe(
      "Acme, Birch, Cedar and 1 more",
    );
    expect(audienceHeadline(row({ audience_plan_slugs: ["scale"] }), {}, { scale: "Scale" })).toBe(
      "Plan: Scale",
    );
    expect(audienceHeadline(row({ audience_clone_ids: ["0123456789ab"] }))).toBe("Only 01234567…");
  });

  it("matches a search ignoring case and accents, every word required", () => {
    const ws = { name: "Café Réal Estate", slug: "cafe-real", planSlug: "scale" };
    expect(workspaceMatches(ws, "")).toBe(true);
    expect(workspaceMatches(ws, "CAFE")).toBe(true);
    expect(workspaceMatches(ws, "real scale")).toBe(true);
    expect(workspaceMatches(ws, "real growth")).toBe(false);
  });
});
