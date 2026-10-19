/**
 * Asks Mission Control to propose the refreshed digest manifest on Prime.
 *
 * The apply job used to regenerate `scripts/applied-migration-digests.txt`
 * and push it to `main` with its own token. `main` is protected now — nothing
 * lands except a pull request whose CI passed, and no workflow token is on the
 * bypass list — so this asks Mission Control instead, which renders the same
 * file from the same queue and opens it as a pull request through its own App,
 * on this repository (it says which, and Mission Control refuses any other),
 * armed to merge itself once CI passes
 * (src/server/applied-digests-proposal.server.ts).
 *
 * ## It never fails the run
 *
 * The migrations have applied by the time this runs. A bookkeeping step that
 * turned that run red would be worse than a stale file, so every outcome exits
 * 0 — and every outcome is reported, because a manifest that silently stopped
 * refreshing is the failure this exists to close.
 */
const BASE = (process.env.MISSION_CONTROL_URL || "").trim().replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET || "";

/** Workflow commands end at a newline; a detail with one in it would forge the next command. */
const clean = (s) =>
  String(s ?? "")
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");

const LOCAL = "Refresh it locally with `npm run migrations:digests` and open a pull request.";
const warn = (title, msg) => {
  console.log(`::warning title=${title}::${clean(msg)}`);
  process.exit(0);
};

if (!BASE || !SECRET) {
  warn(
    "Manifest not refreshed",
    `${!BASE ? "MISSION_CONTROL_URL" : "CRON_SECRET"} is empty, so Mission Control was not asked. ` +
      `The migrations applied normally. ${LOCAL}`,
  );
}

let res;
try {
  res = await fetch(`${BASE}/hooks/migration-enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      action: "propose_digests",
      repository: process.env.GITHUB_REPOSITORY || undefined,
    }),
  });
} catch (e) {
  warn(
    "Manifest not refreshed",
    `Could not reach Mission Control (${e.message}). The migrations applied normally. ${LOCAL}`,
  );
}

let body = null;
try {
  body = await res.json();
} catch {
  /* reported by status alone */
}
const proposal = body?.proposal;

if (!proposal) {
  // A deployment older than this file answers `propose_digests` the way it
  // answers any request without migrations: 400, "no migrations submitted".
  warn(
    "Manifest not refreshed",
    res.status === 400
      ? `This Mission Control deployment does not propose the manifest yet (HTTP 400: ${body?.error ?? "no proposal"}). ` +
          `The migrations applied normally. ${LOCAL}`
      : `Mission Control answered HTTP ${res.status} with no proposal (${body?.error ?? "no body"}). ` +
          `The migrations applied normally. ${LOCAL}`,
  );
}

if (proposal.state === "current") {
  console.log(`Manifest already agrees with the queue: ${proposal.detail}`);
} else if (proposal.state === "proposed" && proposal.armed) {
  console.log(
    `::notice title=Digest manifest proposed::${clean(`${proposal.detail} ${proposal.url}`)}`,
  );
} else if (proposal.state === "proposed") {
  warn("Digest manifest waits for a merge", `${proposal.detail} ${proposal.url}`);
} else {
  warn(
    "Manifest not refreshed",
    `${proposal.detail ?? "Mission Control could not propose it."} The migrations applied normally. ${LOCAL}`,
  );
}
