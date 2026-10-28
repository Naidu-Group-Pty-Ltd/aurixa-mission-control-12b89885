import { describe, expect, it } from "vitest";
import {
  NOTICE_SIGNAL_EVENT,
  NOTICE_SIGNAL_TOPIC,
  broadcastRequestOf,
  nextChangeAtFor,
  signalSentence,
  supabaseProjectUrlOf,
  supabaseUrlForRef,
  workspacesToSignal,
} from "./workspaceSignal.pure";
import { PRIME_WORKSPACE_ID, type AnnouncementFacts } from "./cloneAnnouncements.pure";

const SCALE = { id: "c-scale", planSlug: "scale" };
const LAUNCH = { id: "c-launch", planSlug: "launch" };
const PRIME = { id: PRIME_WORKSPACE_ID, planSlug: null };
const ROSTER = [PRIME, SCALE, LAUNCH];

const NOW = new Date("2026-10-28T10:00:00.000Z");

const row = (extra: Partial<AnnouncementFacts> = {}): AnnouncementFacts => ({
  id: "a1",
  title: "Going live",
  body: "Body",
  link_url: null,
  link_label: null,
  severity: "info",
  display: "modal",
  dismissible: true,
  audience_plan_slugs: null,
  audience_clone_ids: null,
  audience_match: "all",
  replies_enabled: false,
  starts_at: null,
  ends_at: null,
  revision: 1,
  published_at: "2026-10-28T09:00:00.000Z",
  archived_at: null,
  ...extra,
});

describe("where a signal may be sent", () => {
  it("accepts only a Supabase project URL, normalised", () => {
    expect(supabaseProjectUrlOf("https://dduzbchuswwbefdunfct.supabase.co/")).toBe(
      "https://dduzbchuswwbefdunfct.supabase.co",
    );
    expect(supabaseProjectUrlOf("https://evil.example.com")).toBeNull();
    expect(supabaseProjectUrlOf("http://dduzbchuswwbefdunfct.supabase.co")).toBeNull();
    expect(supabaseProjectUrlOf("https://dduzbchuswwbefdunfct.supabase.co.evil.com")).toBeNull();
    expect(supabaseProjectUrlOf(null)).toBeNull();
  });

  it("builds a project URL from a ref, and refuses anything else", () => {
    expect(supabaseUrlForRef("dduzbchuswwbefdunfct")).toBe(
      "https://dduzbchuswwbefdunfct.supabase.co",
    );
    expect(supabaseUrlForRef("not a ref")).toBeNull();
    expect(supabaseUrlForRef(null)).toBeNull();
  });
});

describe("the signal carries nothing", () => {
  it("posts one public broadcast whose payload is only a time", () => {
    const req = broadcastRequestOf(
      { supabaseUrl: "https://dduzbchuswwbefdunfct.supabase.co", anonKey: "anon" },
      NOW,
    );
    expect(req.url).toBe("https://dduzbchuswwbefdunfct.supabase.co/realtime/v1/api/broadcast");
    expect(req.method).toBe("POST");
    expect(req.headers.apikey).toBe("anon");
    const body = JSON.parse(req.body);
    expect(body).toEqual({
      messages: [
        {
          topic: NOTICE_SIGNAL_TOPIC,
          event: NOTICE_SIGNAL_EVENT,
          payload: { at: NOW.toISOString() },
          private: false,
        },
      ],
    });
  });
});

describe("who is told about a change", () => {
  it("tells every workspace, the prime included, about a message to all", () => {
    expect(workspacesToSignal([row()], ROSTER).sort()).toEqual(
      [PRIME_WORKSPACE_ID, "c-launch", "c-scale"].sort(),
    );
  });

  it("never tells anyone about a draft", () => {
    expect(workspacesToSignal([row({ published_at: null })], ROSTER)).toEqual([]);
  });

  it("tells a plan's workspaces only, and never the prime, which has no plan", () => {
    expect(workspacesToSignal([row({ audience_plan_slugs: ["scale"] })], ROSTER)).toEqual([
      "c-scale",
    ]);
  });

  it("tells the workspace an edit takes the message away from", () => {
    const before = row({ audience_clone_ids: ["c-scale", "c-launch"] });
    const after = row({ audience_clone_ids: ["c-scale"] });
    expect(workspacesToSignal([before, after], ROSTER).sort()).toEqual(["c-launch", "c-scale"]);
  });

  it("tells the workspaces of an archived or scheduled message too", () => {
    expect(
      workspacesToSignal(
        [row({ archived_at: NOW.toISOString(), audience_clone_ids: ["c-scale"] })],
        ROSTER,
      ),
    ).toEqual(["c-scale"]);
    expect(
      workspacesToSignal(
        [row({ starts_at: "2026-10-29T00:00:00.000Z", audience_clone_ids: [PRIME_WORKSPACE_ID] })],
        ROSTER,
      ),
    ).toEqual([PRIME_WORKSPACE_ID]);
  });
});

describe("when a workspace's notices next change by themselves", () => {
  it("is a scheduled message's start", () => {
    expect(nextChangeAtFor([row({ starts_at: "2026-10-28T11:30:00.000Z" })], PRIME, NOW)).toBe(
      "2026-10-28T11:30:00.000Z",
    );
  });

  it("is a live message's end", () => {
    expect(nextChangeAtFor([row({ ends_at: "2026-10-28T12:00:00.000Z" })], PRIME, NOW)).toBe(
      "2026-10-28T12:00:00.000Z",
    );
  });

  it("is the earliest of them", () => {
    expect(
      nextChangeAtFor(
        [
          row({ id: "a", ends_at: "2026-10-28T12:00:00.000Z" }),
          row({ id: "b", starts_at: "2026-10-28T10:05:00.000Z" }),
        ],
        PRIME,
        NOW,
      ),
    ).toBe("2026-10-28T10:05:00.000Z");
  });

  it("ignores what does not reach the workspace, what is archived, and what is past", () => {
    expect(
      nextChangeAtFor(
        [
          row({ id: "a", starts_at: "2026-10-28T10:05:00.000Z", audience_plan_slugs: ["scale"] }),
          row({ id: "b", starts_at: "2026-10-28T10:06:00.000Z", archived_at: NOW.toISOString() }),
          row({ id: "c", ends_at: "2026-10-28T09:59:00.000Z" }),
        ],
        PRIME,
        NOW,
      ),
    ).toBeNull();
  });

  it("is nothing when nothing is pending", () => {
    expect(nextChangeAtFor([row()], PRIME, NOW)).toBeNull();
  });
});

describe("what the operator is told", () => {
  it("says nothing where nobody was reached", () => {
    expect(signalSentence(null)).toBeNull();
    expect(signalSentence({ reached: 0, signalled: 0, failed: 0 })).toBeNull();
  });

  it("says every workspace was signalled", () => {
    expect(signalSentence({ reached: 5, signalled: 5, failed: 0 })).toMatch(
      /^Signalled all 5 workspaces/,
    );
    expect(signalSentence({ reached: 1, signalled: 1, failed: 0 })).toMatch(
      /^Signalled the workspace/,
    );
  });

  it("says how many were not, and that they still hear on their next check", () => {
    expect(signalSentence({ reached: 5, signalled: 4, failed: 1 })).toMatch(
      /4 of 5 workspaces.*within a few minutes/,
    );
    expect(signalSentence({ reached: 2, signalled: 0, failed: 2 })).toMatch(
      /No workspace could be signalled/,
    );
  });
});
