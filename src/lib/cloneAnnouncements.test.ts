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
  formatInstant,
  isNarrowingScope,
  MAX_THREAD_ON_WIRE,
  MAX_WIRE_ANNOUNCEMENTS,
  PRIME_WORKSPACE_ID,
  acknowledgeRefusal,
  replyRefusal,
  resolveAnnouncementState,
  sendTimingRefusal,
  summariseThreads,
  threadForWorkspace,
  THREAD_WIRE_KEYS,
  toCloneWire,
  WIRE_KEYS,
  workspaceMatches,
  type AnnouncementFacts,
  type AnnouncementState,
  type ReplyFacts,
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
    expect(audienceSummary(row())).toBe("all workspaces");
    expect(audienceSummary(row({ audience_plan_slugs: ["scale", "growth"] }))).toBe(
      "plans: scale, growth",
    );
    expect(
      audienceSummary(row({ audience_clone_ids: ["abcd1234-0000-0000-0000-000000000000"] }), {
        "abcd1234-0000-0000-0000-000000000000": "NPC Test",
      }),
    ).toBe("workspaces: NPC Test");
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
      cloneIds: ["c1", "c2"],
    });
    expect(audienceDraftOf(row({ audience_plan_slugs: ["scale"] }))).toMatchObject({
      mode: "selected",
      planSlugs: ["scale"],
    });
    // One workspace AND a plan is narrower than "one workspace" alone, so it is
    // never shown as the single-workspace choice.
    expect(
      audienceModeOf(row({ audience_clone_ids: ["c1"], audience_plan_slugs: ["scale"] })),
    ).toBe("selected");
  });

  it("knows the old narrowing scope from the union the console builds now", () => {
    const narrowing = audienceDraftOf(
      row({ audience_clone_ids: ["c1"], audience_plan_slugs: ["scale"] }),
    );
    expect(isNarrowingScope(narrowing)).toBe(true);
    const union = audienceDraftOf(
      row({ audience_clone_ids: ["c1"], audience_plan_slugs: ["scale"], audience_match: "any" }),
    );
    expect(isNarrowingScope(union)).toBe(false);
  });

  it("stores everyone as no scope at all", () => {
    expect(
      audienceScopeOf({ mode: "everyone", cloneIds: ["c1"], planSlugs: ["p"], match: "all" }),
    ).toEqual({ ok: true, audiencePlanSlugs: null, audienceCloneIds: null, audienceMatch: "all" });
  });

  it("never widens an empty choice to everyone", () => {
    for (const draft of [
      { mode: "one", cloneIds: [], planSlugs: [], match: "all" },
      { mode: "one", cloneIds: ["c1", "c2"], planSlugs: [], match: "all" },
      { mode: "selected", cloneIds: [""], planSlugs: [], match: "all" },
      { mode: "selected", cloneIds: [], planSlugs: [""], match: "any" },
    ] as const) {
      const scope = audienceScopeOf(draft);
      expect(scope.ok).toBe(false);
    }
  });

  it("stores exactly what was chosen, de-duplicated", () => {
    expect(
      audienceScopeOf({ mode: "one", cloneIds: ["c1", "c1"], planSlugs: ["p"], match: "all" }),
    ).toEqual({ ok: true, audiencePlanSlugs: null, audienceCloneIds: ["c1"], audienceMatch: "all" });
    expect(
      audienceScopeOf({ mode: "selected", cloneIds: ["c1", "c2", "c1"], planSlugs: [], match: "all" }),
    ).toEqual({
      ok: true,
      audiencePlanSlugs: null,
      audienceCloneIds: ["c1", "c2"],
      audienceMatch: "all",
    });
    expect(
      audienceScopeOf({ mode: "selected", cloneIds: [], planSlugs: ["p", "q"], match: "all" }),
    ).toEqual({ ok: true, audiencePlanSlugs: ["p", "q"], audienceCloneIds: null, audienceMatch: "all" });
  });

  it("plans and workspaces chosen together reach either", () => {
    const scope = audienceScopeOf({
      mode: "selected",
      cloneIds: ["c-launch"],
      planSlugs: ["scale"],
      match: "all",
    });
    expect(scope).toEqual({
      ok: true,
      audiencePlanSlugs: ["scale"],
      audienceCloneIds: ["c-launch"],
      audienceMatch: "any",
    });
    if (!scope.ok) throw new Error("unreachable");
    const stored = {
      audience_plan_slugs: scope.audiencePlanSlugs,
      audience_clone_ids: scope.audienceCloneIds,
      audience_match: scope.audienceMatch,
    };
    expect(announcementReachesClone(stored, { id: "c-scale", planSlug: "scale" })).toBe(true);
    expect(announcementReachesClone(stored, { id: "c-launch", planSlug: "launch" })).toBe(true);
    expect(announcementReachesClone(stored, { id: "c-growth", planSlug: "growth" })).toBe(false);
    expect(announcementReachesClone(stored, { id: PRIME_WORKSPACE_ID, planSlug: null })).toBe(false);
  });

  it("a stored scope round-trips through the console unchanged", () => {
    for (const r of [
      row(),
      row({ audience_clone_ids: ["c1"] }),
      row({ audience_clone_ids: ["c1", "c2"] }),
      row({ audience_plan_slugs: ["scale", "growth"] }),
      row({ audience_plan_slugs: ["scale"], audience_clone_ids: ["c1"], audience_match: "any" }),
    ]) {
      const scope = audienceScopeOf(audienceDraftOf(r));
      expect(scope).toEqual({
        ok: true,
        audiencePlanSlugs: r.audience_plan_slugs,
        audienceCloneIds: r.audience_clone_ids,
        audienceMatch: r.audience_match ?? "all",
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
    expect(
      audienceHeadline(
        row({ audience_plan_slugs: ["scale"], audience_clone_ids: ["c1"], audience_match: "any" }),
        names,
        { scale: "Scale" },
      ),
    ).toBe("Plan: Scale + Acme");
    expect(audienceHeadline(row({ audience_clone_ids: ["0123456789ab"] }))).toBe("Only 01234567…");
    expect(audienceHeadline(row({ audience_clone_ids: [PRIME_WORKSPACE_ID] }))).toBe(
      "Only the prime",
    );
  });

  it("matches a search ignoring case and accents, every word required", () => {
    const ws = { name: "Café Réal Estate", slug: "cafe-real", planSlug: "scale" };
    expect(workspaceMatches(ws, "")).toBe(true);
    expect(workspaceMatches(ws, "CAFE")).toBe(true);
    expect(workspaceMatches(ws, "real scale")).toBe(true);
    expect(workspaceMatches(ws, "real growth")).toBe(false);
  });
});

describe("the prime is a workspace", () => {
  const prime = { id: PRIME_WORKSPACE_ID, planSlug: null };

  it("is reached by a message to every workspace, and by name", () => {
    expect(announcementReachesClone(row(), prime)).toBe(true);
    expect(announcementReachesClone(row({ audience_clone_ids: [PRIME_WORKSPACE_ID] }), prime)).toBe(
      true,
    );
  });

  it("is never reached by a message scoped to a plan — it has none", () => {
    expect(announcementReachesClone(row({ audience_plan_slugs: ["scale"] }), prime)).toBe(false);
  });

  it("is not reached by a message to other workspaces", () => {
    expect(announcementReachesClone(row({ audience_clone_ids: ["c1"] }), prime)).toBe(false);
  });

  it("is served exactly what a clone in its position is", () => {
    const rows = [
      row({ id: "all" }),
      row({ id: "named", audience_clone_ids: [PRIME_WORKSPACE_ID, "c1"] }),
      row({ id: "plan", audience_plan_slugs: ["scale"] }),
      row({ id: "other", audience_clone_ids: ["c1"] }),
    ];
    expect(activeAnnouncementsForClone(rows, prime, NOW).map((w) => w.id).sort()).toEqual([
      "all",
      "named",
    ]);
  });
});

describe("replies", () => {
  const ws = { id: "c1", planSlug: "scale" };
  const reply = (o: Partial<ReplyFacts> = {}): ReplyFacts => ({
    id: "r1",
    announcement_id: "a1",
    workspace_id: "c1",
    direction: "workspace",
    body: "Thanks — noted.",
    author_name: "Rugesh Naidu",
    created_at: "2026-09-16T11:00:00Z",
    ...o,
  });

  it("an announcement carries no thread, and says replies are off", () => {
    const wire = toCloneWire(row(), [
      { id: "x", from: "workspace", authorName: "A", body: "b", createdAt: "" },
    ]);
    expect(wire.repliesEnabled).toBe(false);
    expect(wire.thread).toEqual([]);
  });

  it("a workspace is served its own thread and nobody else's", () => {
    const replies = [
      reply({ id: "mine-1", created_at: "2026-09-16T10:00:00Z" }),
      reply({ id: "theirs", workspace_id: "c2", body: "Another tenant's words" }),
      reply({ id: "other-message", announcement_id: "a2" }),
      reply({
        id: "mine-2",
        direction: "operator",
        author_name: "Some Operator",
        created_at: "2026-09-16T11:30:00Z",
      }),
    ];
    const [wire] = activeAnnouncementsForClone([row({ replies_enabled: true })], ws, NOW, replies);
    expect(wire.repliesEnabled).toBe(true);
    expect(wire.thread.map((m) => m.id)).toEqual(["mine-1", "mine-2"]);
    expect(JSON.stringify(wire)).not.toContain("Another tenant");
  });

  it("an operator's message is signed Aurixa Systems, never with the operator's name", () => {
    const [m] = threadForWorkspace(
      [reply({ direction: "operator", author_name: "Jane Operator" })],
      "a1",
      "c1",
    );
    expect(m.from).toBe("aurixa");
    expect(m.authorName).toBe("Aurixa Systems");
    expect(JSON.stringify(m)).not.toContain("Jane");
  });

  it("a thread message carries exactly THREAD_WIRE_KEYS — no email, role or refs", () => {
    const [m] = threadForWorkspace([reply()], "a1", "c1");
    expect(Object.keys(m).sort()).toEqual([...THREAD_WIRE_KEYS].sort());
  });

  it("keeps only the newest messages of a long thread, oldest first", () => {
    const many = Array.from({ length: MAX_THREAD_ON_WIRE + 3 }, (_, i) =>
      reply({ id: `r${i}`, created_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString() }),
    );
    const thread = threadForWorkspace(many, "a1", "c1");
    expect(thread).toHaveLength(MAX_THREAD_ON_WIRE);
    expect(thread[0].id).toBe("r3");
    expect(thread[thread.length - 1].id).toBe(`r${MAX_THREAD_ON_WIRE + 2}`);
  });

  it("a workspace may answer only a live message that asked for replies and reaches it", () => {
    expect(replyRefusal(null, ws, NOW)).toBe("not_found");
    expect(replyRefusal(row(), ws, NOW)).toBe("replies_disabled");
    expect(replyRefusal(row({ replies_enabled: true, published_at: null }), ws, NOW)).toBe(
      "not_live",
    );
    expect(
      replyRefusal(row({ replies_enabled: true, audience_clone_ids: ["c2"] }), ws, NOW),
    ).toBe("not_addressed");
    expect(replyRefusal(row({ replies_enabled: true }), ws, NOW)).toBeNull();
  });

  it("an acknowledgement is refused for a message the workspace could not have been shown", () => {
    expect(acknowledgeRefusal(row({ audience_plan_slugs: ["launch"] }), ws, NOW)).toBe(
      "not_addressed",
    );
    expect(acknowledgeRefusal(row({ archived_at: "2026-09-16T11:00:00Z" }), ws, NOW)).toBe(
      "not_live",
    );
    expect(acknowledgeRefusal(row(), ws, NOW)).toBeNull();
  });

  it("summarises threads per workspace, counting only unread workspace messages", () => {
    const sums = summariseThreads([
      { ...reply({ id: "1", created_at: "2026-09-16T09:00:00Z" }), operator_read_at: "x" },
      { ...reply({ id: "2", created_at: "2026-09-16T10:00:00Z" }), operator_read_at: null },
      {
        ...reply({ id: "3", direction: "operator", created_at: "2026-09-16T10:30:00Z" }),
        operator_read_at: null,
      },
      {
        ...reply({ id: "4", workspace_id: "c2", created_at: "2026-09-16T11:00:00Z" }),
        operator_read_at: null,
      },
    ]);
    expect(sums.map((t) => [t.workspaceId, t.messages, t.unread, t.lastFrom])).toEqual([
      ["c2", 1, 1, "workspace"],
      ["c1", 3, 1, "aurixa"],
    ]);
  });
});

describe("when a message goes out", () => {
  it("Send now needs no start time, and refuses an end already past", () => {
    expect(sendTimingRefusal("now", null, null, NOW)).toBeNull();
    expect(sendTimingRefusal("now", null, "2026-09-16T11:00:00Z", NOW)).toMatch(/already passed/);
    expect(sendTimingRefusal("now", null, "2026-09-17T11:00:00Z", NOW)).toBeNull();
  });

  it("Schedule needs a start time in the future", () => {
    expect(sendTimingRefusal("schedule", null, null, NOW)).toMatch(/Choose when/);
    expect(sendTimingRefusal("schedule", "2026-09-16T11:59:00Z", null, NOW)).toMatch(/Send now/);
    expect(sendTimingRefusal("schedule", "2026-09-16T13:00:00Z", null, NOW)).toBeNull();
    expect(
      sendTimingRefusal("schedule", "2026-09-16T13:00:00Z", "2026-09-16T12:30:00Z", NOW),
    ).toMatch(/after it starts/);
  });

  it("a draft may hold any window, past included", () => {
    expect(sendTimingRefusal("draft", "2026-09-01T00:00:00Z", null, NOW)).toBeNull();
    expect(sendTimingRefusal("draft", "not a date", null, NOW)).toMatch(/not a valid date/);
  });
});

describe("formatInstant", () => {
  it("names the zone it shows a time in, and never throws", () => {
    const text = formatInstant("2026-10-17T06:34:00Z", "Australia/Sydney");
    expect(text).toMatch(/17 Oct 2026/);
    expect(text).toMatch(/5:34/);
    expect(text).toMatch(/AEDT|GMT\+11/);
    expect(formatInstant(null)).toBe("—");
    expect(formatInstant("not a date")).toBe("—");
    expect(() => formatInstant("2026-10-17T06:34:00Z")).not.toThrow();
  });
});
