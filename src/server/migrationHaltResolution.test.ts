import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripSqlComments } from "./migrationQueue.pure";

/*
  A HALTED QUEUE USED TO NEED A PERSON WITH `postgres`.

  The queue is ordered, so one row in `failed` stops every migration behind it.
  Between 8 and 9 September 2026 that is what happened: a single failed row held
  the line, three later merges reported truthfully that their own files were
  "still queued", and clearing it took somebody writing an UPDATE by hand —
  because `service_role` holds `SELECT, INSERT` on that table and nothing else.

  Three things close that, and this file exercises all three:

    1. The drain retries on a budget chosen from the SQLSTATE, and before giving
       up asks whether the migration's own declared effect is already present in
       the catalog. The September row satisfies that check, so it would have
       settled itself. (Proven against a real PostgreSQL 16; the SQL invariants
       that make it safe are pinned here by source.)

    2. `action: "queue"` answers about the WHOLE queue, so a blocked submitter
       can see the row that is blocking it. `status` cannot: it answers about
       the versions the caller submitted, which is the whole reason the outage
       was invisible from CI.

    3. `resolve-migration.yml` is the lever for what is genuinely ambiguous, and
       `record` — settling a row without running it — is refused unless the
       evidence is already there.

  The two scripts are EXECUTED against a stub Mission Control, never asserted
  about. `execFile` rather than `spawnSync`: a synchronous child blocks this
  process's event loop, so the stub server in the same process could never
  answer it.
*/

const REPO = resolve(__dirname, "../..");
const RESOLVE_SCRIPT = join(REPO, ".github/scripts/resolve-migration.mjs");
const ENQUEUE_SCRIPT = join(REPO, ".github/scripts/enqueue-migrations.mjs");
const MIGRATION = join(REPO, "supabase/migrations/20260913090000_a_halt_that_resolves_itself.sql");

type Call = { action: string; body: Record<string, unknown> };

/** A stub Mission Control. `reply` sees every call, so a test can sequence. */
function stub(reply: (call: Call, n: number) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const call = { action: String(body.action ?? "enqueue"), body };
      calls.push(call);
      const out = reply(call, calls.length);
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return { server, calls };
}

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

function run(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    execFile(
      process.execPath,
      [script],
      { cwd: REPO, env: { ...process.env, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0;
        res({ code, out: `${stdout}${stderr}` });
      },
    );
  });
}

const HALTED = {
  halted: true,
  waiting: 4,
  settled: 56,
  blocking: [
    {
      version: "20260908120000",
      name: "20260908120000_earlier_merge.sql",
      attempts: 3,
      error: 'relation "aurixa.nothing_here" does not exist',
      sqlstate: "42P01",
      resolution: null,
    },
  ],
};

const CLEAR = { halted: false, waiting: 0, settled: 57, blocking: [] };

describe("the queue can be read by somebody who submitted none of it", () => {
  it("reports a halt, names the blocking row, and changes nothing", async () => {
    const { server, calls } = stub(() => ({ body: { success: true, queue: HALTED } }));
    const base = await listen(server);

    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      VERSION: "",
      RESOLUTION: "retry",
      REASON: "",
    });

    expect(code).toBe(0);
    expect(out).toContain("HALTED at 1 row(s)");
    expect(out).toContain("20260908120000_earlier_merge.sql");
    expect(out).toContain("42P01");
    // The report is the whole job. A run that resolved nothing must not have
    // called anything that could.
    expect(calls.every((c) => c.action === "queue")).toBe(true);
  });

  it("says so plainly when nothing is halted", async () => {
    const { server } = stub(() => ({ body: { success: true, queue: CLEAR } }));
    const base = await listen(server);
    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      VERSION: "",
      RESOLUTION: "retry",
      REASON: "",
    });
    expect(code).toBe(0);
    expect(out).toContain("not halted");
    expect(out).toContain("nothing to resolve");
  });

  it("fails rather than reporting a healthy queue when the read fails", async () => {
    const { server } = stub(() => ({ status: 503, body: { success: false, error: "down" } }));
    const base = await listen(server);
    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      VERSION: "",
      RESOLUTION: "retry",
      REASON: "",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("Could not read the queue");
    expect(out).not.toContain("not halted");
  });
});

describe("resolving a halt", () => {
  const ARGS = {
    VERSION: "20260908120000",
    RESOLUTION: "retry",
    REASON: "re-queued after the extension it needed was installed",
  };

  it("re-queues on retry and shows the queue afterwards", async () => {
    const { server, calls } = stub((call, n) => {
      if (call.action === "resolve") {
        return { body: { success: true, ok: true, outcome: "re-queued; attempts reset" } };
      }
      return { body: { success: true, queue: n === 1 ? HALTED : CLEAR } };
    });
    const base = await listen(server);

    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      ...ARGS,
    });

    expect(code).toBe(0);
    expect(out).toContain("re-queued; attempts reset");
    // It re-reads, so the operator sees the state their act produced rather
    // than the one it started from.
    expect(out.lastIndexOf("not halted")).toBeGreaterThan(out.indexOf("re-queued"));
    const resolve1 = calls.find((c) => c.action === "resolve");
    expect(resolve1?.body).toMatchObject({
      version: ARGS.VERSION,
      resolution: "retry",
      reason: ARGS.REASON,
    });
  });

  it("surfaces the evidence when record is refused, and exits non-zero", async () => {
    const { server } = stub((call) =>
      call.action === "resolve"
        ? {
            status: 409,
            body: {
              success: false,
              ok: false,
              outcome: "refused: the declared effect is not present",
              detail: "column schema_migration_queue.resolution: absent",
            },
          }
        : { body: { success: true, queue: HALTED } },
    );
    const base = await listen(server);

    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      ...ARGS,
      RESOLUTION: "record",
      REASON: "believed already applied by hand on the 9th",
    });

    expect(code).not.toBe(0);
    expect(out).toContain("Resolution refused");
    expect(out).toContain("column schema_migration_queue.resolution: absent");
  });

  it.each([
    ["a version that is not 14 digits", { VERSION: "2026090812" }, "not a 14-digit"],
    ["an unknown resolution", { RESOLUTION: "skip" }, "must be"],
    ["a reason too short to be one", { REASON: "broken" }, "reason of at least"],
  ])("refuses %s before calling resolve", async (_label, override, expected) => {
    const { server, calls } = stub(() => ({ body: { success: true, queue: HALTED } }));
    const base = await listen(server);
    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      ...ARGS,
      ...override,
    });
    expect(code).not.toBe(0);
    expect(out).toContain(expected);
    expect(calls.some((c) => c.action === "resolve")).toBe(false);
  });

  it("refuses a version that is not among the failed rows", async () => {
    const { server, calls } = stub(() => ({ body: { success: true, queue: HALTED } }));
    const base = await listen(server);
    const { code, out } = await run(RESOLVE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      ...ARGS,
      VERSION: "20260913090000",
    });
    expect(code).not.toBe(0);
    expect(out).toContain("Not a halted row");
    expect(calls.some((c) => c.action === "resolve")).toBe(false);
  });
});

describe("a blocked merge is told what is blocking it", () => {
  const dir = mkdtempSync(join(tmpdir(), "halt-"));
  const file = join(dir, "20260913100000_mine.sql");
  writeFileSync(file, "select 1;\n");

  it("names the earlier merge's row rather than blaming the drain", async () => {
    const { server, calls } = stub((call) => {
      if (call.action === "queue") return { body: { success: true, queue: HALTED } };
      // Its own versions never settle, because the queue is held ahead of them.
      return {
        body: {
          success: true,
          enqueued: ["20260913100000"],
          alreadyQueued: [],
          alreadyApplied: [],
          rejected: [],
          verdict: {
            settled: false,
            applied: [],
            recorded: [],
            failed: [],
            missing: [],
            pending: ["20260913100000"],
          },
        },
      };
    });
    const base = await listen(server);

    const { code, out } = await run(ENQUEUE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      FILES: file,
      POLL_INTERVAL_MS: "60",
    });

    expect(code).not.toBe(0);
    expect(out).toContain("Migration queue is halted");
    expect(out).toContain("20260908120000");
    expect(out).toContain("an earlier merge");
    // The remedy named must be the queue's, not the drain's schedule — sending
    // an operator to `cron.job` is what the September run did, and the drain
    // was the one thing working.
    expect(out).not.toContain("schema-migration-drain");

    // And it stops at the probe rather than waiting out all thirty polls: a
    // queue halted by somebody else's row will not move however long it waits.
    const statusCalls = calls.filter((c) => c.action === "status").length;
    expect(statusCalls).toBeLessThanOrEqual(4);
  });

  it("still blames the drain when nothing has failed", async () => {
    const { server } = stub((call) => {
      if (call.action === "queue") {
        return { body: { success: true, queue: { ...CLEAR, waiting: 1, settled: 56 } } };
      }
      return {
        body: {
          success: true,
          enqueued: ["20260913100000"],
          alreadyQueued: [],
          alreadyApplied: [],
          rejected: [],
          verdict: {
            settled: false,
            applied: [],
            recorded: [],
            failed: [],
            missing: [],
            pending: ["20260913100000"],
          },
        },
      };
    });
    const base = await listen(server);

    const { code, out } = await run(ENQUEUE_SCRIPT, {
      MISSION_CONTROL_URL: base,
      CRON_SECRET: "x",
      FILES: file,
      POLL_INTERVAL_MS: "50",
    });

    expect(code).not.toBe(0);
    expect(out).toContain("Timed out waiting for the drain");
    expect(out).toContain("schema-migration-drain");
    expect(out).toContain("1 waiting");
  });
});

describe("what the migration itself may never stop doing", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  // Judged on the STATEMENTS, never on the prose. An assertion that fires on a
  // comment explaining the rule is one people learn to silence, and this file
  // explains `ROW(...)::record` in the very comment saying not to use it.
  const code = stripSqlComments(sql);

  it("refuses `record` unless the declared effect is actually present", () => {
    // The safety property of the whole feature. `record` settles a row WITHOUT
    // running it, so if it could be talked into doing that unconditionally it
    // would be a way to mark broken SQL as done.
    const fn = sql.slice(sql.indexOf("function aurixa.resolve_migration"));
    const body = fn.slice(0, fn.indexOf("$function$;", fn.indexOf("$function$") + 10));
    expect(body).toMatch(/migration_effect_present/);
    expect(body).toMatch(/satisfied/);
  });

  it("evaluates only claim kinds it can actually check", () => {
    // `check:` and `none:` are prose — a claim nothing can evaluate must never
    // count as evidence, because `satisfied` is what lets a row settle unrun.
    const evaluator = sql.slice(
      sql.indexOf("function aurixa.migration_effect_present"),
      sql.indexOf("function aurixa.migration_attempt_budget"),
    );
    for (const kind of ["'table'", "'column'", "'rpc'", "'enum'", "'cron'", "'rows'"]) {
      expect(evaluator).toContain(kind);
    }
    expect(evaluator).toMatch(/v_checked\s*>\s*0/);
  });

  it("closes both public functions to anon and authenticated by name", () => {
    // `pg_default_acl` in this database grants EXECUTE on every new `public`
    // function to `anon` AND `authenticated` BY NAME, and a grant made by name
    // is not removed by revoking from PUBLIC.
    const closing = sql.slice(sql.indexOf("do $close$"));
    for (const role of ["'public'", "'anon'", "'authenticated'"]) {
      expect(closing).toContain(role);
    }
    expect(closing).toMatch(/grant execute on function public\.migration_queue_state/);
    expect(closing).toMatch(/to service_role/);
  });

  it("asks the evidence check inside its own guard, and never off a bare record", () => {
    // Found by execution, not by reading. The evidence check CAN raise — an
    // over-long `rows:` number overflows bigint — and an exception there is
    // worse than the failure it was asked about: the outer transaction aborts,
    // taking the `attempts` increment with it, and the row returns to `queued`
    // to be retried for ever. A livelock says nothing; a halt at least says
    // something.
    //
    // The first guard was itself broken for a reason only Postgres reports:
    // `ROW(false, 0, '…')::record` has no NAMED fields, so reading
    // `.satisfied` off it raises inside the handler meant to make a fault
    // harmless. Scalars, therefore.
    const drain = code.slice(code.indexOf("function aurixa.drain_schema_migrations"));
    const handler = drain.slice(drain.indexOf("EXCEPTION"), drain.indexOf("END LOOP"));
    expect(handler).toMatch(/BEGIN[\s\S]*migration_effect_present[\s\S]*EXCEPTION WHEN OTHERS/);
    expect(code).not.toContain("::record");
  });

  it("bounds a row-count claim so it cannot overflow bigint", () => {
    const evaluator = code.slice(
      code.indexOf("function aurixa.migration_effect_present"),
      code.indexOf("function aurixa.migration_attempt_budget"),
    );
    // `\\d+` here is `999999999999999999999999::bigint` → 22003, raised from
    // inside the handler that is asking whether the migration succeeded.
    expect(evaluator).toContain("(\\d{1,12})$");
    expect(evaluator).not.toContain(">=\\s*(\\d+)$");
  });

  it("declares its own effect, so it could be recorded the same way", () => {
    expect(sql).toMatch(/^-- @asserts rpc:migration_queue_state$/m);
    expect(sql).toMatch(/^-- @asserts column:schema_migration_queue\.resolution$/m);
    expect(sql).toMatch(/^-- @asserts column:schema_migration_queue\.sqlstate$/m);
  });
});
