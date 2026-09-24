// Test doubles for the booking paths: an in-memory stand-in for the slice of
// the PostgREST builder they use, and a Cal.com API.
//
// Both EVALUATE what they are asked rather than replaying canned answers. The
// database double applies every filter it is handed — JSON paths such as
// `metadata->calcom->>uid` included — and the Cal.com double books, lists and
// moves real bookings, and refuses a time it no longer has. A double that ignores its own filters is how a test and
// the code under it come to agree while the server disagrees; this repository
// has paid for that more than once.
import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { message: string; code?: string } | null };

export type FakeDb = {
  tables: Record<string, Row[]>;
  /** Tables whose reads answer an error. */
  failReads: Set<string>;
  /** Tables whose writes answer an error. */
  failWrites: Set<string>;
  /** Every operation that ran, in order. */
  log: Array<{ table: string; op: string; values?: unknown }>;
  from: (table: string) => QueryBuilder;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- a query builder is a fluent any-typed chain */
export type QueryBuilder = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** `col`, `col->a->b`, `col->a->>b`, as PostgREST reads them. */
export function readPath(row: Row, path: string): unknown {
  const parts = path.split(/->>?/);
  let value: unknown = row[parts[0]];
  for (const key of parts.slice(1)) {
    value = value && typeof value === "object" ? (value as Row)[key] : undefined;
  }
  if (path.includes("->>") && value !== undefined && value !== null && typeof value !== "string") {
    return JSON.stringify(value);
  }
  return value;
}

/** Timestamps compare as instants, whatever offset spelling each side used. */
function comparable(value: unknown): unknown {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return value;
}

function compare(a: unknown, b: unknown): number {
  const x = comparable(a) as number | string;
  const y = comparable(b) as number | string;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const db: FakeDb = {
    tables: Object.fromEntries(
      Object.entries(seed).map(([t, rows]) => [t, rows.map((r) => ({ ...r }))]),
    ),
    failReads: new Set(),
    failWrites: new Set(),
    log: [],
    from: (table: string) => builder(db, table),
  };
  return db;
}

function builder(db: FakeDb, table: string): QueryBuilder {
  let op: "select" | "insert" | "update" | "upsert" = "select";
  let values: unknown = null;
  let returning = false;
  let conflict: string | null = null;
  const filters: Filter[] = [];
  let order: { column: string; ascending: boolean } | null = null;
  let limit: number | null = null;
  const rows = (): Row[] => (db.tables[table] ??= []);

  const run = (mode: "many" | "single" | "maybeSingle"): Result => {
    const failing = op === "select" ? db.failReads.has(table) : db.failWrites.has(table);
    if (failing) return { data: null, error: { message: `${table} ${op} failed`, code: "XX000" } };
    db.log.push({ table, op, values });

    let result: Row[] = [];
    if (op === "select") {
      result = rows().filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        result = [...result].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
      }
      if (limit !== null) result = result.slice(0, limit);
    } else if (op === "insert") {
      const list = (Array.isArray(values) ? values : [values]) as Row[];
      result = list.map((v) => ({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        metadata: {},
        ...v,
      }));
      rows().push(...result);
    } else if (op === "update") {
      result = rows().filter((r) => filters.every((f) => f(r)));
      for (const r of result) Object.assign(r, values as Row);
    } else {
      const list = (Array.isArray(values) ? values : [values]) as Row[];
      for (const v of list) {
        const existing = conflict ? rows().find((r) => r[conflict!] === v[conflict!]) : undefined;
        if (existing) {
          Object.assign(existing, v);
          result.push(existing);
        } else {
          const row = { id: randomUUID(), ...v };
          rows().push(row);
          result.push(row);
        }
      }
    }

    const data = op === "select" || returning ? result.map((r) => structuredClone(r)) : null;
    if (mode === "single") {
      return data && data.length === 1
        ? { data: data[0], error: null }
        : {
            data: null,
            error: {
              message: "JSON object requested, multiple (or no) rows returned",
              code: "PGRST116",
            },
          };
    }
    if (mode === "maybeSingle") {
      if (data && data.length > 1) {
        return { data: null, error: { message: "multiple rows returned", code: "PGRST116" } };
      }
      return { data: data?.[0] ?? null, error: null };
    }
    return { data, error: null };
  };

  const b: QueryBuilder = {
    select: () => {
      if (op !== "select") returning = true;
      return b;
    },
    insert: (v: unknown) => ((op = "insert"), (values = v), b),
    update: (v: unknown) => ((op = "update"), (values = v), b),
    upsert: (v: unknown, opts?: { onConflict?: string }) => (
      (op = "upsert"),
      (values = v),
      (conflict = opts?.onConflict ?? null),
      b
    ),
    eq: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) === 0), b),
    neq: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) !== 0), b),
    in: (c: string, list: unknown[]) => (filters.push((r) => list.includes(readPath(r, c))), b),
    gte: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) >= 0), b),
    lte: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) <= 0), b),
    gt: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) > 0), b),
    lt: (c: string, v: unknown) => (filters.push((r) => compare(readPath(r, c), v) < 0), b),
    is: (c: string, v: unknown) => (filters.push((r) => (readPath(r, c) ?? null) === v), b),
    not: (c: string, operator: string, v: unknown) => {
      if (operator === "is") filters.push((r) => (readPath(r, c) ?? null) !== v);
      return b;
    },
    ilike: (c: string, pattern: string) => {
      const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
      const re = new RegExp(`^${source}$`, "i");
      filters.push((r) => re.test(String(readPath(r, c) ?? "")));
      return b;
    },
    order: (c: string, opts?: { ascending?: boolean }) => (
      (order = { column: c, ascending: opts?.ascending !== false }),
      b
    ),
    limit: (n: number) => ((limit = n), b),
    maybeSingle: async () => run("maybeSingle"),
    single: async () => run("single"),
    then: (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(run("many")).then(resolve, reject),
  };
  return b;
}

/** A row's JSON column as a plain object, for asserting on what was written. */
export function jsonOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/* --------------------------------- Cal.com --------------------------------- */

export type FakeCalcomBooking = {
  uid: string;
  id: number;
  status: string;
  start: string;
  end: string;
  meetingUrl: string;
  eventType: { id: number; slug: string };
  attendees: Array<{ name: string; email: string; timeZone: string }>;
  metadata: Record<string, string>;
};

type Answer = { status: number; body: unknown } | "timeout";

export type FakeCalcom = {
  /** Free starts, as ISO instants. */
  slots: string[];
  bookings: FakeCalcomBooking[];
  /** While set, every matching call answers this instead of doing its work. */
  answers: { slots?: Answer; create?: Answer; list?: Answer; reschedule?: Answer };
  /** When true, a create that times out still writes the booking — a lost answer. */
  timeoutStillBooks: boolean;
  requests: Array<{
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    version: string | null;
  }>;
};

export function createFakeCalcom(
  seed: Partial<Pick<FakeCalcom, "slots" | "bookings">> = {},
): FakeCalcom {
  return {
    slots: seed.slots ?? [],
    bookings: seed.bookings ?? [],
    answers: {},
    timeoutStillBooks: false,
    requests: [],
  };
}

let sequence = 0;

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

/** Whether Cal.com would take a booking at `start`: offered, and nobody holds it. */
function bookable(fake: FakeCalcom, start: string): boolean {
  return (
    fake.slots.some((s) => sameInstant(s, start)) &&
    !fake.bookings.some((b) => b.status === "accepted" && sameInstant(b.start, start))
  );
}

/** Cal.com's own words for a time it will not book. */
const SLOT_TAKEN = {
  status: "error",
  error: {
    code: "BadRequestException",
    message: "User either already has booking at this time or is not available",
  },
};

function book(fake: FakeCalcom, body: Record<string, unknown>): FakeCalcomBooking {
  sequence += 1;
  const attendee = (body.attendee ?? {}) as Record<string, string>;
  const start = new Date(String(body.start));
  const uid = `bk_${sequence}`;
  const booking: FakeCalcomBooking = {
    uid,
    id: 1000 + sequence,
    status: "accepted",
    start: start.toISOString(),
    end: new Date(start.getTime() + 30 * 60_000).toISOString(),
    meetingUrl: `https://app.cal.com/video/${uid}`,
    eventType: { id: 1, slug: String(body.eventTypeSlug ?? "") },
    attendees: [{ name: attendee.name, email: attendee.email, timeZone: attendee.timeZone }],
    metadata: (body.metadata ?? {}) as Record<string, string>,
  };
  fake.bookings.push(booking);
  // A booked time is no longer offered, as Cal.com's slots answer would say.
  fake.slots = fake.slots.filter((s) => !sameInstant(s, booking.start));
  return booking;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function answered(answer: Answer): Response {
  if (answer === "timeout") {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
  return json(answer.status, answer.body);
}

/** A `fetch` that answers Cal.com's v2 API from `fake`. Anything else is a test failure. */
export function calcomFetch(fake: FakeCalcom): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== "api.cal.com") throw new Error(`unexpected fetch to ${url.href}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const headers = new Headers(init?.headers);
    fake.requests.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      version: headers.get("cal-api-version"),
    });

    if (method === "GET" && path === "/slots") {
      if (fake.answers.slots) return answered(fake.answers.slots);
      const data: Record<string, Array<{ start: string; end: string }>> = {};
      for (const start of [...fake.slots].sort()) {
        const day = start.slice(0, 10);
        (data[day] ??= []).push({
          start,
          end: new Date(Date.parse(start) + 30 * 60_000).toISOString(),
        });
      }
      return json(200, { status: "success", data });
    }
    if (method === "POST" && path === "/bookings") {
      const answer = fake.answers.create;
      if (answer) {
        if (answer === "timeout" && fake.timeoutStillBooks && bookable(fake, String(body.start))) {
          book(fake, body);
        }
        return answered(answer);
      }
      if (!bookable(fake, String(body.start))) return json(400, SLOT_TAKEN);
      return json(201, { status: "success", data: book(fake, body) });
    }
    if (method === "GET" && path === "/bookings") {
      if (fake.answers.list) return answered(fake.answers.list);
      const email = url.searchParams.get("attendeeEmail")?.toLowerCase();
      const data = fake.bookings.filter(
        (b) =>
          b.status === "accepted" &&
          (!email || b.attendees.some((a) => a.email.toLowerCase() === email)),
      );
      return json(200, { status: "success", data, pagination: { totalItems: data.length } });
    }
    const reschedule = /^\/bookings\/([^/]+)\/reschedule$/.exec(path);
    if (method === "POST" && reschedule) {
      if (fake.answers.reschedule) return answered(fake.answers.reschedule);
      const old = fake.bookings.find((b) => b.uid === decodeURIComponent(reschedule[1]));
      if (!old) return json(404, { status: "error", error: { message: "Booking not found" } });
      if (!bookable(fake, String(body.start))) return json(400, SLOT_TAKEN);
      old.status = "cancelled";
      // The time it gave up is free again.
      fake.slots.push(old.start);
      const moved = book(fake, {
        start: body.start,
        eventTypeSlug: old.eventType.slug,
        attendee: old.attendees[0],
        metadata: old.metadata,
      });
      return json(201, { status: "success", data: moved });
    }
    throw new Error(`unexpected Cal.com call ${method} ${path}`);
  }) as typeof fetch;
}
