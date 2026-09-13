/**
 * Reads the migration queue, and ends a halt when one needs ending.
 *
 * ## Why this exists at all
 *
 * The queue is ORDERED: one row in `failed` stops every migration behind it,
 * including ones merged weeks later that are perfectly fine. Between 8 and 9
 * September 2026 that is exactly what happened, and clearing it took a person
 * with database access writing an UPDATE by hand — because `service_role` holds
 * `SELECT, INSERT` on the queue and nothing else. That asymmetry is deliberate
 * (the credential that SUBMITS work must not be able to report on it), but its
 * uncosted consequence was that nothing short of a human with `postgres` could
 * get the fleet's migrations moving again.
 *
 * Almost every halt is now ended by the drain itself: it retries on a budget
 * chosen from the SQLSTATE, and before giving up it checks whether the
 * migration's own declared effect is already present in the catalog — the
 * September row would have settled itself in one tick. What is left is the
 * genuinely ambiguous case, and this is the lever for it.
 *
 * ## It is a REPORT first
 *
 * Dispatched with no version, this prints the queue and exits 0. That is the
 * common case: somebody wants to know why their migration has not applied, and
 * the answer is almost always a row they did not write.
 *
 * ## What `record` cannot do
 *
 * `record` settles a row without running it, and Mission Control refuses it
 * unless the migration's `-- @asserts` claims are already satisfied by the live
 * catalog. So it cannot be used to wave a migration through — only to
 * acknowledge one whose work is demonstrably already done. A migration that
 * declares nothing checkable can never be recorded this way, which is the
 * conservative side of that trade and is why the assertion header is worth
 * writing.
 */
const BASE = (process.env.MISSION_CONTROL_URL || "").trim().replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET || "";
const VERSION = (process.env.VERSION || "").trim();
const RESOLUTION = (process.env.RESOLUTION || "").trim();
const REASON = (process.env.REASON || "").trim();

const fail = (title, msg) => {
  console.error(`::error title=${title}::${msg}`);
  process.exit(1);
};

if (!BASE) {
  fail(
    "Mission Control URL not set",
    "MISSION_CONTROL_URL is empty. Set the repository variable to this deployment's public " +
      "origin. It is deliberately not defaulted: a wrong origin would send this to somebody " +
      "else's deployment.",
  );
}
if (!SECRET) {
  fail(
    "CRON_SECRET not set",
    "The repository secret CRON_SECRET is empty. It must hold the same value as the " +
      "`cron_secret` entry in Mission Control's Supabase Vault.",
  );
}

const post = async (body) => {
  const res = await fetch(`${BASE}/hooks/migration-enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* a non-JSON body is reported by status alone */
  }
  return { status: res.status, json };
};

function report(queue) {
  console.log(
    `Queue: ${queue.waiting} waiting, ${queue.settled} settled, ` +
      `${queue.halted ? `HALTED at ${queue.blocking.length} row(s)` : "not halted"}.`,
  );
  for (const b of queue.blocking) {
    console.log("");
    console.log(`  ${b.version}  ${b.name}`);
    console.log(`    attempts   ${b.attempts}`);
    if (b.sqlstate) console.log(`    sqlstate   ${b.sqlstate}`);
    if (b.resolution) console.log(`    resolution ${b.resolution}`);
    console.log(`    error      ${b.error ?? "(none recorded)"}`);
  }
}

const state = await post({ action: "queue" });
if (state.status !== 200) {
  fail(
    "Could not read the queue",
    `Mission Control answered HTTP ${state.status}. ${state.json?.error ?? ""}`.trim(),
  );
}
const queue = state.json?.queue ?? { halted: false, blocking: [], waiting: 0, settled: 0 };
report(queue);

if (!VERSION) {
  // A report is the whole job. Saying nothing further is the point: this run
  // changed nothing, and a "success" line here would read as one that did.
  console.log("");
  console.log(
    queue.halted
      ? "No version given, so nothing was resolved. Re-run with the version, a resolution and " +
          "a reason to clear it."
      : "Nothing is halted. There is nothing to resolve.",
  );
  process.exit(0);
}

if (!/^\d{14}$/.test(VERSION)) {
  fail("Bad version", `"${VERSION}" is not a 14-digit migration version.`);
}
if (RESOLUTION !== "retry" && RESOLUTION !== "record") {
  fail("Bad resolution", `Resolution must be "retry" or "record"; got "${RESOLUTION}".`);
}
// Checked here as well as at the endpoint, because the two failures cost
// different amounts: this one is free and immediate, and the operator is
// standing in front of it.
if (REASON.length < 10) {
  fail(
    "No reason given",
    "A reason of at least 10 characters is required. Clearing a halt is a recorded act, and " +
      "the record is what the next person reads when the same row comes back.",
  );
}

const blocked = queue.blocking.find((b) => b.version === VERSION);
if (!blocked) {
  fail(
    "Not a halted row",
    `${VERSION} is not among the failed rows. ` +
      (queue.halted
        ? `The queue is halted at ${queue.blocking.map((b) => b.version).join(", ")}.`
        : "Nothing on the queue has failed."),
  );
}

console.log("");
console.log(`Resolving ${VERSION} (${blocked.name}) as "${RESOLUTION}".`);

const result = await post({
  action: "resolve",
  version: VERSION,
  resolution: RESOLUTION,
  reason: REASON,
});

if (result.status !== 200 || result.json?.ok !== true) {
  const detail = result.json?.detail ? `\n  Evidence: ${result.json.detail}` : "";
  fail(
    "Resolution refused",
    `${result.json?.outcome ?? result.json?.error ?? `HTTP ${result.status}`}${detail}` +
      (RESOLUTION === "record"
        ? `\n  \`record\` is refused unless the migration's own \`-- @asserts\` claims are ` +
          `already satisfied by the live schema. If they are not, the work has not been done ` +
          `and recording it would be a lie the next reader believes.`
        : ""),
  );
}

console.log(`  ${result.json.outcome}`);
console.log("");
report((await post({ action: "queue" })).json?.queue ?? queue);
