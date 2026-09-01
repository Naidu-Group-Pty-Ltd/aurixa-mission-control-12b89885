/**
 * A queue drain must be able to tell a FAULT from an EMPTY QUEUE.
 *
 * Every one of these workers claims work the same way: select candidates, then
 * a conditional UPDATE that wins or loses a race. PostgREST resolves to
 * `{ data: null, error }` on any failure — and `data: null` is *also* what an
 * empty queue and a lost race look like. A claim written as `const { data } =`
 * therefore reports a database fault as "nothing to do": the worker returns
 * success, the queue never drains, and there is no failing request to find.
 *
 * The prime records this as fault 3 of four stacked faults in
 * `docs/aml/SCREENING_EXECUTION.md` — "the claim's error was discarded, so a
 * database fault was indistinguishable from losing a race". All three workers
 * here had it. It was inert in two of them only because they had never been
 * scheduled, which stopped being true on 26 Aug.
 *
 * This is a source contract rather than a unit test because these are route
 * modules: `createFileRoute` pulls in the router and `supabaseAdmin` is bound at
 * module scope, so the cheap, honest check is to read what the file says.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = join(__dirname);
const read = (f: string) => readFileSync(join(ROUTES, f), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * The body of a named `async function`, by brace counting.
 *
 * The body brace is the one introduced by `) {` or `> {` — the latter because
 * two of these functions declare a multi-line return type
 * (`Promise<null | {\n … \n}> {`) whose own braces would otherwise be mistaken
 * for the body, and whose `}>` sits in column 0 so a scan for a line-initial
 * `}` ends at the signature.
 */
function bodyOf(source: string, fnName: string): string {
  const at = source.indexOf(`async function ${fnName}(`);
  expect(at, `${fnName} not found — if it was renamed, update this test`).toBeGreaterThan(-1);

  const opener = /[)>]\s\{/g;
  opener.lastIndex = at;
  const m = opener.exec(source);
  expect(m, `${fnName}: could not find the brace that opens its body`).not.toBeNull();
  const start = m!.index + m![0].length - 1;

  let braces = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") braces++;
    else if (source[i] === "}" && --braces === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${fnName}: unbalanced braces`);
}

/** Every `const { data… } = await` in a body, with whether it names `error`. */
function destructures(body: string): { text: string; checksError: boolean }[] {
  return [...body.matchAll(/const \{\s*data[^}]*\} = await/g)].map((m) => ({
    text: m[0],
    checksError: /\berror\b/.test(m[0]),
  }));
}

const WORKERS: Array<{ file: string; fn: string; what: string }> = [
  {
    file: "hooks.backend-provisioning-drain.tsx",
    fn: "claimOne",
    what: "the clone's own Supabase project",
  },
  { file: "hooks.cascade-drain.tsx", fn: "claimOne", what: "code into the clone's repo" },
  { file: "hooks.deployment-drain.tsx", fn: "claim", what: "the Vercel deployment" },
];

describe("a queue claim never reports a fault as an empty queue", () => {
  for (const { file, fn, what } of WORKERS) {
    it(`${file} · ${fn}() checks the error on every statement (${what})`, () => {
      const body = bodyOf(read(file), fn);
      const stmts = destructures(body);
      expect(
        stmts.length,
        "no destructured awaits found — did the claim change shape?",
      ).toBeGreaterThan(0);
      const unchecked = stmts.filter((s) => !s.checksError).map((s) => s.text);
      expect(unchecked, `discards its error: ${unchecked.join(" | ")}`).toEqual([]);
    });

    it(`${file} · ${fn}() fails loudly rather than returning nothing`, () => {
      // Silence is the one outcome that converges nowhere: the route's catch
      // turns a throw into a non-200, which is visible in net._http_response.
      expect(bodyOf(read(file), fn)).toMatch(/throw new Error\(/);
    });
  }
});

describe("a reclaim returns rows to the shape its own claim reads", () => {
  // The backend drain's reclaim wrote "Worker stalled — requeued" while
  // leaving `status` at 'provisioning' — words claimOne's
  // `.eq("status","pending")` never takes. The first engine-provisioned
  // clone (30 Aug 2026 dry run) froze exactly there: reclaimed mid
  // "Snapshotting backend architecture", then untouched for an hour by a
  // drain that runs every minute. A requeue that the claim cannot see is
  // not a requeue; each worker below is pinned to whichever shape ITS
  // claim actually reads.
  it("backend drain: reclaim resets status to pending, not just the timestamp", () => {
    const body = bodyOf(read("hooks.backend-provisioning-drain.tsx"), "reclaimStalled");
    expect(body).toMatch(/status:\s*"pending"/);
    expect(body).toMatch(/worker_started_at:\s*null/);
  });

  it("backend drain: sweeps rows the cutoff filter cannot see (null timestamp, in-flight status)", () => {
    // The pre-fix reclaim nulled `worker_started_at` and left the status
    // standing, and NULL is never `.lt(cutoff)` — so the repair has to
    // recognise those rows by shape, or every row it ever damaged stays
    // frozen after the fix ships.
    const source = read("hooks.backend-provisioning-drain.tsx");
    const body = bodyOf(source, "reclaimStalled");
    expect(body).toMatch(/\.is\("worker_started_at", null\)/);
    expect(body).toMatch(/\.in\("status", IN_FLIGHT_STATUSES\)/);
    expect(source).toMatch(/IN_FLIGHT_STATUSES = \["provisioning", "migrating", "seeding_admin"\]/);
  });

  it("backend drain: a stall on the final attempt terminates instead of queueing", () => {
    // claimOne filters `attempts < MAX_ATTEMPTS`, so requeueing an
    // exhausted row parks it at 'pending' for ever — the same lie one
    // step later. The failure path already terminates exhaustion; the
    // stall path must too.
    const body = bodyOf(read("hooks.backend-provisioning-drain.tsx"), "reclaimStalled");
    expect(body).toMatch(/\.gte\("attempts", MAX_ATTEMPTS\)/);
    expect(body).toMatch(/status:\s*"failed"/);
  });

  it("backend drain: reclaim checks every update and throws", () => {
    // A statement-position `await admin` discards PostgREST's error, and a
    // reclaim that half-happened is invisible exactly when it matters.
    const body = bodyOf(read("hooks.backend-provisioning-drain.tsx"), "reclaimStalled");
    expect(body).not.toMatch(/^\s*await admin/m);
    expect(body).toMatch(/throw new Error\(/);
  });

  it("cascade drain: reclaim keeps resetting both fields", () => {
    const body = bodyOf(read("hooks.cascade-drain.tsx"), "reclaimStalled");
    expect(body).toMatch(/status:\s*"pending"/);
    expect(body).toMatch(/worker_started_at:\s*null/);
  });

  it("backend drain: a budget pause requeues with attempts reset, and the invocation carries one deadline", () => {
    // The pipeline pauses at stage boundaries when the invocation budget is
    // due (see provisioningBudget.ts). A pause is forward progress: requeue
    // with attempts RESET, so MAX_ATTEMPTS counts only consecutive hard
    // deaths. Without the reset, a three-slice pipeline exhausts on slices.
    const src = read("hooks.backend-provisioning-drain.tsx");
    const drain = bodyOf(src, "drainOne");
    expect(drain).toMatch(/budgetPaused[\s\S]{0,120}progressed === true/);
    expect(drain).toMatch(/budgetPaused \? \{ attempts: 0 \}/);
    // One absolute deadline per invocation, handed to every job it runs.
    expect(src).toContain("INVOCATION_BUDGET_MS");
    expect(src).toMatch(/drainOne\(deadlineAt\)/);
    // A pause ends the invocation; so does an upstream quota refusal, for a
    // different reason (see provisioningBudget.isUpstreamRateLimit).
    expect(src).toMatch(/if \(r\.budgetPaused \|\| r\.upstreamLimited\) break;/);
  });

  it("backend drain: wall clock bounds the recycling that attempts no longer do", () => {
    // Attempt-neutral requeues need their own terminal condition, or a job
    // that keeps proving liveness without finishing recycles forever. Parked
    // rows only — a live invocation is never failed under its own feet.
    const body = bodyOf(read("hooks.backend-provisioning-drain.tsx"), "reclaimStalled");
    expect(body).toMatch(/CEILING_HOURS/);
    expect(body).toMatch(/\.lt\("queued_at", ceilingCutoff\)/);
    expect(body).toMatch(/Provisioning ceiling exceeded/);
    expect(body).toMatch(
      /\.is\("worker_started_at", null\)[\s\S]{0,80}\.is\("worker_finished_at", null\)/,
    );
  });

  it("backend drain: a parked row is how a HEALTHY job looks, so stranded is a CONDITION not an age", () => {
    // The shape that made the old single ceiling wrong. Every tick claims the
    // job, works ~50s, pauses at a stage boundary and requeues to
    // `status='pending'` with `worker_started_at` NULL — so for most of its
    // life a perfectly healthy provision is indistinguishable, BY THE PARKED
    // FILTERS ALONE, from one nothing is working on. Elapsed time cannot tell
    // them apart; only what makes a row unclaimable can.
    //
    // `claimOne` skips a row for exactly two reasons: its queued credential is
    // gone, or its attempts are spent (the exhaustion branch). So the first is
    // asked directly. `updated_at` rides along as a grace period only.
    const body = bodyOf(read("hooks.backend-provisioning-drain.tsx"), "reclaimStalled");
    expect(body).toMatch(/\.is\("queued_admin_password_enc", null\)/);
    expect(body).toMatch(/\.lt\("updated_at", stallCutoff\)/);
    expect(body).toMatch(/PARKED_STALL_MINUTES/);
    expect(body).toMatch(/Provisioning stranded — nothing could claim it/);
    // Parked rows only, exactly as the ceiling is: a live invocation is never
    // failed under its own feet.
    expect(body).toMatch(
      /\.is\("queued_admin_password_enc", null\)[\s\S]{0,200}\.is\("worker_started_at", null\)[\s\S]{0,80}\.is\("worker_finished_at", null\)/,
    );
  });

  it("backend drain: a job WAITING behind a longer one is not stranded", () => {
    // claimOne takes the OLDEST pending row, so a younger job waits behind a
    // long one and nothing writes to it meanwhile — it looks abandoned by
    // every staleness measure and is not. It still HOLDS its queued
    // credential, which is why the stranded rule asks for that credential's
    // ABSENCE rather than for silence: a busy queue must never fail the jobs
    // queued behind it.
    const src = read("hooks.backend-provisioning-drain.tsx");
    const body = stripComments(bodyOf(src, "reclaimStalled"));
    // The stranded update must be conditioned on the missing credential.
    const strandedStart = body.indexOf("Provisioning stranded");
    expect(strandedStart).toBeGreaterThan(-1);
    const stranded = body.slice(strandedStart, body.indexOf("strandedErr", strandedStart));
    expect(stranded).toMatch(/\.is\("queued_admin_password_enc", null\)/);
    // And a non-terminal requeue really does keep the credential, so a waiting
    // row cannot drift into the stranded shape on its own.
    expect(stripComments(bodyOf(src, "drainOne"))).toMatch(
      /queued_admin_password_enc: isTerminal \? null : claimed\.queued_admin_password_enc/,
    );
  });

  it("backend drain: the progress signal is not resume_stage, which the longest stage nulls", () => {
    // The obvious progress rule — "did the resume marker move" — is blind in
    // the one stage that needed it. The edge-function stage pauses with an
    // EMPTY marker on purpose (`functionSourceTruncated`), which is stored as
    // NULL so the next tick re-snapshots and carries the next batch. That is
    // where the 1 Sep 2026 run was killed, having already replicated the
    // prime's schema exactly.
    const drain = read("hooks.backend-provisioning-drain.tsx");
    expect(stripComments(bodyOf(drain, "reclaimStalled"))).not.toMatch(/resume_stage/);
    // And the pause path really does store an empty marker as NULL.
    const fns = read("../lib/backend-provisioning.functions.ts");
    expect(fns).toMatch(/resume_stage: e\.resumeStage \|\| null/);
  });

  it("backend drain: the two bounds answer different questions, and the backstop is not reachable by a healthy job", () => {
    // A bound a working provision can reach is not a backstop, it is a
    // deadline — which is exactly the defect. The stranded check is the fast,
    // precise one; the ceiling only bounds a pipeline that keeps pausing
    // without converging, so it must sit far above a real provision (the
    // schema alone took ~3 hours against this prime, and the edge functions
    // are carried a batch a tick after it).
    const src = read("hooks.backend-provisioning-drain.tsx");
    const stall = Number(/const PARKED_STALL_MINUTES = (\d+);/.exec(src)?.[1]);
    const ceiling = Number(/const CEILING_HOURS = (\d+);/.exec(src)?.[1]);
    expect(stall).toBeGreaterThan(0);
    // Comfortably clear of the starvation window: claimOne takes the oldest
    // pending row and an invocation ends at the first pause, so a row still
    // advances every few minutes with several provisions in flight.
    expect(stall).toBeGreaterThanOrEqual(30);
    // The schema pass alone measured ~3 hours. Anything near that is a
    // deadline on every job.
    expect(ceiling).toBeGreaterThanOrEqual(12);
    expect(ceiling * 60).toBeGreaterThan(stall * 4);
  });

  it("deployment drain: claim reads every CLAIMABLE status, which is why its reclaim may reset the timestamp alone", () => {
    // The deployment queue is a per-status state machine: claim() takes any
    // CLAIMABLE status, so nulling `worker_started_at` IS a complete
    // requeue there. If that claim ever narrows to one status, this pin
    // fails and the reclaim must move status too.
    const claim = bodyOf(read("hooks.deployment-drain.tsx"), "claim");
    expect(claim).toMatch(/\.in\("status", CLAIMABLE\)/);
    const reclaim = bodyOf(read("hooks.deployment-drain.tsx"), "reclaimStalled");
    expect(reclaim).toMatch(/worker_started_at:\s*null/);
  });
});

describe("the deployment worker's other queue reads say when they could not read", () => {
  // These two do NOT throw: the claim work above them has already succeeded and
  // is worth keeping. They name the failure in the response instead — which is
  // the whole point, because `checked: 0` and "nothing was due" are the same
  // sentence otherwise, and this sweep is the backup for a webhook that was
  // never delivered.
  //
  // Scoped to the QUEUE read specifically, not every read in the body. The
  // sweep also looks up a clone's display name for a notification, and
  // discarding THAT error is correct: it is rendered as `clone?.name ??
  // row.clone_id`, so a failed lookup costs a nicer word in a message, and
  // failing the notification over it would be worse. The rule is about a read
  // that decides whether there is work, not about every read.
  const QUEUE_OF: Record<string, string> = {
    sweepLiveBuilds: "clone_deployments",
    processTeardowns: "hosting_teardowns",
  };

  for (const [fn, table] of Object.entries(QUEUE_OF)) {
    it(`${fn}() checks the error on its ${table} read`, () => {
      const body = bodyOf(read("hooks.deployment-drain.tsx"), fn);
      const re = new RegExp(
        `const \\{\\s*data[^}]*\\} = await[\\s\\S]{0,120}?\\.from\\("${table}"\\)`,
      );
      const m = re.exec(body);
      expect(m, `${fn} no longer reads ${table} — update this test`).not.toBeNull();
      expect(m![0], `${fn} discards the error on its ${table} read`).toMatch(/\berror\b/);
    });

    it(`${fn}() returns that error rather than an empty result`, () => {
      expect(bodyOf(read("hooks.deployment-drain.tsx"), fn)).toMatch(/error: error\.message/);
    });
  }
});
