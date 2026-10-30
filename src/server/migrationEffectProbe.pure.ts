/**
 * A prime migration's `-- @effect:` probe: read from the file the way the
 * prime reads it, refused the way the prime refuses it, and run on a clone in
 * a transaction that cannot write and never commits.
 *
 * ## What a probe is
 *
 * A migration that only INSERTs rows, REVOKEs a privilege or restates a policy
 * creates no object, so nothing in a catalogue says whether it ran. The prime
 * lets such a file state the SQL that is true once it has:
 *
 *     -- @effect: select 1 from public.template_library_entries where version = 18
 *
 * A probe that returns a row is an effect that is present. The prime asks its
 * own database every night (`.github/scripts/migration-drift-facts.mjs`, which
 * runs `select (exists(<probe>))::text`); this module is how Mission Control
 * asks a clone the same question.
 *
 * ## Why a clone has to be asked
 *
 * A clone is built from the prime's catalogue and its ledger is then stamped
 * with every version the prime records. A version stamped that way never ran
 * there, so its effect is there only if the catalogue copy carried it, and for
 * a privilege, a policy restated for the clones or a seeded row it does not.
 * Measured 30 Oct 2026 on Orrimere, built the day before: its ledger listed
 * 20270204090000 and the D9 files, and 35 of the prime's 63 probes returned no
 * row, the publishable key among other things still able to write
 * `api_usage_log`. NPC Test, built and since delivered to by the fleet lane,
 * failed 12: the template refresh decisions no clone holds.
 *
 * ## Mirrored, not reinvented
 *
 * `effectProbeIn` is the prime's `effectProbeIn`
 * (`scripts/build-migration-object-index.mjs`) and `probeIsReadOnly` is the
 * prime's `probeIsReadOnly` (`scripts/ops/migrationDrift.pure.mjs`), rule for
 * rule. A probe the prime's drift report would run is the probe this runs, and
 * one it refuses is refused here, so the two can never disagree about which
 * line of a file is its probe or whether it may be sent to a database.
 *
 * ## How it is run, and why that way
 *
 * Every probe goes out inside one `DO` block per request, which:
 *
 *   1. makes the transaction read-only before anything else runs, so a probe
 *      that somehow wrote would be refused by Postgres whatever the guard said;
 *   2. evaluates each probe as `exists(<probe>)` in its own sub-block, so a
 *      probe that errors (a relation this clone does not hold) is that probe's
 *      answer and not the request's;
 *   3. ends by raising an exception that carries every answer, so the request
 *      always rolls back, and the answers come back in the one channel the
 *      Management API is known to return whole: the error message.
 *
 * The answers are words and SQLSTATE codes, with no quote or backslash in
 * them, so the JSON the Management API wraps an error in cannot change them on
 * the way back. An answer that is not in the reply is `unread`, never `false`:
 * a probe nobody heard from is not an effect that is absent.
 *
 * Pure: no network, no database.
 */
import { readSqlFailure } from "./primeMigrationDiagnosis.pure";

/**
 * The probe a migration declares about itself, or null when it declares none.
 *
 * The prime's `effectProbeIn`, rule for rule: the first `-- @effect:` line
 * anywhere in the file, the rest of that line trimmed. Nothing here requires
 * it to be the first line, because the prime does not.
 */
export function effectProbeIn(src: string | null | undefined): string | null {
  const m = String(src ?? "").match(/^\s*--\s*@effect:\s*(.+?)\s*$/im);
  return m ? m[1] : null;
}

/**
 * Whether a declared probe may be sent to a database at all.
 *
 * The prime's `probeIsReadOnly`, rule for rule: one statement, opening with
 * SELECT, no semicolon, and none of the words that change anything. A probe
 * that fails it is never executed and never quietly skipped; the caller
 * reports it by name.
 */
export function probeIsReadOnly(sql: string | null | undefined): boolean {
  const s = String(sql ?? "").trim();
  if (!s) return false;
  if (s.includes(";")) return false;
  if (!/^select\b/i.test(s)) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|do|call)\b/i.test(
    s,
  );
}

/**
 * A dollar-quote tag that occurs in none of `inside`.
 *
 * Deterministic rather than random, so a statement is the same bytes every
 * time it is built and a test can name it: `$mc_<label>$`, then
 * `$mc_<label>_1$` and so on until one is absent from every text the
 * statement will quote. A literal ends at the first occurrence of its own tag,
 * so a tag the body already contains would end the literal inside the body
 * and run what follows as SQL.
 */
export function dollarTag(label: string, inside: readonly string[]): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(label)) {
    throw new Error(
      `A dollar-quote label is a lower-case identifier, not ${JSON.stringify(label)}`,
    );
  }
  for (let n = 0; ; n += 1) {
    const tag = n === 0 ? `$mc_${label}$` : `$mc_${label}_${n}$`;
    if (!inside.some((text) => text.includes(tag))) return tag;
  }
}

/**
 * How long a probe, dry run or replay may wait for a lock, as Postgres spells
 * a duration. Checked, because it is spliced into the statement inside a
 * quoted literal, where anything but a duration would be SQL.
 */
export function assertLockTimeout(value: string): string {
  if (!/^\d+(ms|s|min)?$/.test(value)) {
    throw new Error(
      `A lock timeout is a Postgres duration like '3s', not ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** What the probe statement's exception opens with. The reader looks for exactly this. */
export const PROBE_BATCH_MARKER = "EFFECT PROBES (rolled back):";

/**
 * The most probes one request carries. The prime declares 64 (30 Oct 2026),
 * so one request answers them all; the cap bounds the exception message the
 * answers travel in should the prime declare many more.
 */
export const PROBES_PER_STATEMENT = 80;

/**
 * The expression that evaluates one probe, as PL/pgSQL builds it at run time.
 *
 * The probe sits on lines of its own because the prime's extractor keeps
 * whatever follows the SELECT on its line, a trailing `-- note` included, and
 * a closing parenthesis on the same line would be inside that comment.
 */
function existsOf(tag: string, probe: string): string {
  return `'select exists(' || chr(10) || ${tag}${probe}${tag} || chr(10) || ')'`;
}

/**
 * One statement that evaluates every probe in `probes` on a clone and raises
 * their answers, so nothing it does survives the request.
 *
 * Refuses a probe the read-only guard refuses: the caller decides what to say
 * about such a file, and this never sends one.
 */
export function probeBatchStatement(
  probes: readonly string[],
  opts: { lockTimeout: string },
): string {
  if (probes.length === 0) throw new Error("A probe statement needs at least one probe");
  if (probes.length > PROBES_PER_STATEMENT) {
    throw new Error(`A probe statement carries at most ${PROBES_PER_STATEMENT} probes`);
  }
  for (const p of probes) {
    if (!probeIsReadOnly(p)) {
      throw new Error(
        `Refusing to send a probe that is not one read-only SELECT: ${p.slice(0, 120)}`,
      );
    }
  }
  const lockTimeout = assertLockTimeout(opts.lockTimeout);
  const tags = probes.map((p, i) => dollarTag(`effect_probe_${i}`, [p]));
  const outer = dollarTag("effect_probes", [...probes, ...tags]);
  const blocks = probes.map((p, i) =>
    [
      "  begin",
      `    execute ${existsOf(tags[i], p)} into effect;`,
      `    answers := answers || ('${i}=' || effect::text);`,
      "  exception when others then",
      `    answers := answers || ('${i}=error:' || sqlstate);`,
      "  end;",
    ].join("\n"),
  );
  return [
    `do ${outer}`,
    "declare",
    "  answers text[] := array[]::text[];",
    "  effect boolean;",
    "begin",
    // Before anything else: a probe that wrote would be refused by Postgres.
    "  perform set_config('transaction_read_only', 'on', true);",
    `  perform set_config('lock_timeout', '${lockTimeout}', true);`,
    ...blocks,
    `  raise exception '${PROBE_BATCH_MARKER} %', array_to_string(answers, ' ');`,
    "end",
    `${outer};`,
  ].join("\n");
}

/** One probe's answer. `unread` is never an absence: nobody heard from it. */
export type ProbeAnswer =
  | { kind: "effect"; present: boolean }
  | { kind: "error"; sqlstate: string }
  | { kind: "unread"; why: string };

/**
 * Read the answers out of whatever the Management API said, for a statement
 * that carried `count` probes.
 *
 * `runSqlOnProject` throws with the response body appended, which carries the
 * exception's message (seen as JSON with a `message`, 27 Oct 2026). The
 * answers are read from the text after the marker up to the first character
 * an answer cannot contain, so a JSON-escaped newline or the closing quote
 * ends them. A probe whose answer is missing, or a reply with no marker at
 * all (the request failed before the block finished), is `unread`.
 */
export function readProbeBatch(raw: string, count: number): ProbeAnswer[] {
  const text = String(raw ?? "");
  const at = text.indexOf(PROBE_BATCH_MARKER);
  if (at < 0) {
    const why = `the probes did not answer (${readSqlFailure(text).message.slice(0, 300)})`;
    return Array.from({ length: count }, () => ({ kind: "unread", why }));
  }
  const rest = text.slice(at + PROBE_BATCH_MARKER.length);
  const segment = /^[0-9A-Za-z=: ]*/.exec(rest)?.[0] ?? "";
  const answers = new Map<number, ProbeAnswer>();
  for (const m of segment.matchAll(/(\d+)=(true|false|error:([0-9A-Z]{5}))(?![0-9A-Za-z])/g)) {
    const i = Number(m[1]);
    if (answers.has(i)) continue;
    answers.set(
      i,
      m[3] ? { kind: "error", sqlstate: m[3] } : { kind: "effect", present: m[2] === "true" },
    );
  }
  return Array.from(
    { length: count },
    (_, i) =>
      answers.get(i) ?? {
        kind: "unread",
        why: "the reply carried no answer for this probe",
      },
  );
}
