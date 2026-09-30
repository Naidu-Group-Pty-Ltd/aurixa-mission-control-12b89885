import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  BLOCKED_NOTICE_PAGE,
  MAX_UNREAD_BLOCKED_NOTICES,
  readUnreadBlockedNotices,
  type BlockedNoticeRow,
} from "./blockedNoticeRead.server";

type Row = BlockedNoticeRow & { kind: string; read_at: string | null };

const pad = (n: number) => `n${String(n).padStart(6, "0")}`;
const notice = (n: number, over: Partial<Row> = {}): Row => ({
  id: pad(n),
  clone_id: "c1",
  title: `Cascade blocked · X · PR #${n}`,
  body: "",
  created_at: "2026-09-27T00:00:00Z",
  url: `https://github.com/o/r/pull/${n}`,
  kind: "cascade_blocked",
  read_at: null,
  ...over,
});

/**
 * A PostgREST stand-in: applies the filters it is handed, orders by `id`, and
 * truncates at `cap` without saying so — the behaviour that makes an unpaged
 * read unsound.
 */
function fakeServer(
  rows: Row[],
  opts: {
    cap?: number;
    beforeCall?: (call: number) => void;
    failOn?: number;
    /** A server that drops the keyset filter, and so answers every page with the first. */
    ignoreKeyset?: boolean;
  } = {},
) {
  let calls = 0;
  const client = {
    from(table: string) {
      expect(table).toBe("notifications");
      const filters: Array<(r: Row) => boolean> = [];
      let limit = Number.POSITIVE_INFINITY;
      const builder = {
        select: () => builder,
        eq: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        is: (col: keyof Row, val: unknown) => (filters.push((r) => r[col] === val), builder),
        in: (col: keyof Row, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), builder),
        gt: (col: keyof Row, val: string) => {
          if (!opts.ignoreKeyset) filters.push((r) => String(r[col]) > val);
          return builder;
        },
        order: () => builder,
        limit: (n: number) => ((limit = n), builder),
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          calls += 1;
          opts.beforeCall?.(calls);
          if (opts.failOn === calls) {
            return Promise.resolve({ data: null, error: { message: "boom" } }).then(resolve, reject);
          }
          const data = rows
            .filter((r) => filters.every((f) => f(r)))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            .slice(0, Math.min(limit, opts.cap ?? Number.POSITIVE_INFINITY));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls: () => calls };
}

describe("readUnreadBlockedNotices", () => {
  it("returns every notice when the server caps a response below the page", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => notice(i));
    const { client } = fakeServer(rows, { cap: 100 });
    const got = await readUnreadBlockedNotices(client, ["c1"]);
    expect(got).toHaveLength(1234);
    expect(new Set(got.map((r) => r.id)).size).toBe(1234);
  });

  it("returns only unread cascade_blocked notices of the clones named", async () => {
    const rows = [
      notice(1),
      notice(2, { read_at: "2026-09-27T01:00:00Z" }),
      notice(3, { kind: "cascade_failed" }),
      notice(4, { clone_id: "c9" }),
      notice(5, { clone_id: "c2" }),
    ];
    const { client } = fakeServer(rows);
    const got = await readUnreadBlockedNotices(client, ["c1", "c2"]);
    expect(got.map((r) => r.id)).toEqual([pad(1), pad(5)]);
  });

  /*
    What an offset would get wrong: once a notice from the first page is
    marked read, every later row moves up one place, and the row that stood
    first on the second page is skipped. A key does not move.
  */
  it("a notice marked read between pages never pushes another past the boundary", async () => {
    const rows = Array.from({ length: BLOCKED_NOTICE_PAGE * 2 + 50 }, (_, i) => notice(i));
    const { client } = fakeServer(rows, {
      beforeCall: (call) => {
        if (call === 2) rows[5].read_at = "2026-09-27T01:00:00Z";
      },
    });
    const got = await readUnreadBlockedNotices(client, ["c1"]);
    expect(got.map((r) => r.id)).toContain(pad(BLOCKED_NOTICE_PAGE));
    expect(got).toHaveLength(rows.length);
  });

  it("an unreadable page fails the read rather than shortening it", async () => {
    const rows = Array.from({ length: BLOCKED_NOTICE_PAGE + 20 }, (_, i) => notice(i));
    const { client } = fakeServer(rows, { failOn: 2 });
    await expect(readUnreadBlockedNotices(client, ["c1"])).rejects.toThrow(
      "Could not read blocked notices: boom",
    );
  });

  /*
    The ceiling is a count of notices, so a backlog at it is read in full
    however the server pages it. Codex found the request-count ceiling this
    replaced refusing both of these: at 500 a page the 40th request came back
    full and the empty page that proves the end was one request past it, and
    a server cap of 100 turned 40 requests into 4,000 notices.
  */
  it("a backlog exactly at the ceiling is read in full, one empty page after the last", async () => {
    const rows = Array.from({ length: MAX_UNREAD_BLOCKED_NOTICES }, (_, i) => notice(i));
    const { client, calls } = fakeServer(rows);
    const got = await readUnreadBlockedNotices(client, ["c1"]);
    expect(got).toHaveLength(MAX_UNREAD_BLOCKED_NOTICES);
    expect(calls()).toBe(MAX_UNREAD_BLOCKED_NOTICES / BLOCKED_NOTICE_PAGE + 1);
  });

  it("a backlog at the ceiling behind a server cap below the page is read in full", async () => {
    const rows = Array.from({ length: MAX_UNREAD_BLOCKED_NOTICES }, (_, i) => notice(i));
    const { client, calls } = fakeServer(rows, { cap: 100 });
    const got = await readUnreadBlockedNotices(client, ["c1"]);
    expect(new Set(got.map((r) => r.id)).size).toBe(MAX_UNREAD_BLOCKED_NOTICES);
    expect(calls()).toBe(MAX_UNREAD_BLOCKED_NOTICES / 100 + 1);
  });

  it("one notice past the ceiling fails closed", async () => {
    const rows = Array.from({ length: MAX_UNREAD_BLOCKED_NOTICES + 1 }, (_, i) => notice(i));
    const { client } = fakeServer(rows);
    await expect(readUnreadBlockedNotices(client, ["c1"])).rejects.toThrow(
      "which is a backlog to clear rather than a list to classify",
    );
  });

  /*
    With no request ceiling, what ends the walk is that every page must
    advance it. A server that ignored the key would answer every page with the
    first; that is refused on the second page rather than read for ever.
  */
  it("a page that repeats a notice fails the read rather than looping", async () => {
    const rows = Array.from({ length: BLOCKED_NOTICE_PAGE + 20 }, (_, i) => notice(i));
    const { client, calls } = fakeServer(rows, { ignoreKeyset: true });
    await expect(readUnreadBlockedNotices(client, ["c1"])).rejects.toThrow(
      `notice ${pad(0)} came back twice`,
    );
    expect(calls()).toBe(2);
  });

  it("nothing unread is one request and an empty list", async () => {
    const { client, calls } = fakeServer([]);
    expect(await readUnreadBlockedNotices(client, ["c1"])).toEqual([]);
    expect(calls()).toBe(1);
  });
});
