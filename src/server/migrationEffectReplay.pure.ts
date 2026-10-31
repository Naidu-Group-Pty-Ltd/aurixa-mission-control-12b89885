/**
 * Which of the prime's owner-approved privilege and policy files a clone is
 * missing the effect of, how each is dry-run and replayed there, and what the
 * run says about it.
 *
 * ## The gap
 *
 * A clone is built from the prime's catalogue, and its migration ledger is
 * then stamped with every version the prime records. A catalogue copy carries
 * no table privileges (Supabase's defaults give the browser roles every
 * privilege on a new table), no policy a file restated for the clones and no
 * seeded row, so a file that takes a privilege back reaches only the clones
 * that existed when it ran — and the ledger of a clone built later says it ran
 * there too. Measured 30 Oct 2026 on Orrimere, built on 29 Oct: its ledger
 * listed 20270204090000 and the D9 files, none of their `-- @effect:` probes
 * returned a row, and the publishable key could write `api_usage_log`. It was
 * repaired by hand, each file run after a rolled-back dry run.
 *
 * ## The decision this carries out
 *
 * The owner, 30 Oct 2026: provisioning runs every prime effect probe on a new
 * clone and replays only the owner-approved privilege and policy files whose
 * effect is missing, after a dry run. The approval is the prime's
 * `supabase/migrations/MIGRATION_EFFECT_REPLAYS.json`, which sits beside
 * `MIGRATION_WITHDRAWN.json` and is held to its kinds by the prime's own gate
 * (`scripts/security/check-migration-effect-replays.mjs`, through
 * `scripts/ops/migrationEffectReplays.pure.mjs`). Every other probe is only
 * reported. The wider table-privilege surplus is taken back by the privilege
 * sweep, on the clones the owner's decision of 31 Oct 2026 reaches
 * (`tableGrantEnforcement.pure.ts`).
 *
 * ## For each listed file
 *
 *   1. its probe is evaluated on the clone, read-only
 *      (`migrationEffectProbe.pure.ts`); a row means the effect is there and
 *      nothing is run;
 *   2. otherwise ONE statement executes the file, evaluates the probe and
 *      raises an exception carrying the answer, so everything it did rolls
 *      back (`dryRunStatement`);
 *   3. only when that answer is that the probe now returns a row is the file
 *      run for real (`applyStatement`), never writing the migration ledger,
 *      which already lists the version; the statement that runs it evaluates
 *      the probe again before it may commit;
 *   4. the probe is evaluated once more, by a separate read, and the file's
 *      outcome is what that read says.
 *
 * ## Reading the manifest
 *
 * Mission Control needs each entry's `file` and `kind`; the version is the
 * file name's fourteen-digit prefix and is never restated. A manifest that
 * cannot be read is reported and replays nothing; it is never an empty list.
 * The structural rules of the prime's `parseEffectReplays` and
 * `validateEffectReplays` are mirrored entry by entry: an object; a versioned
 * migration file name; no key beyond `file`, `kind`, `decided`, `reason`;
 * listed once and in file order; a `kind` of `privilege` or `policy`; a
 * `decided` date as YYYY-MM-DD; a `reason`. An entry that breaks one is
 * refused by name and the rest are still read, because each entry is its own
 * approval of one file and refusing one changes what no other approves. Two
 * of the prime's rules are not restated here: how long a reason must be,
 * which is a reviewer's rule, and what each kind's SQL may say, which needs
 * the prime's shape reader and is what its gate is for.
 *
 * Pure: no network, no database. The caller hands over what it read.
 */
import {
  effectProbeIn,
  probeIsReadOnly,
  dollarTag,
  assertLockTimeout,
} from "./migrationEffectProbe.pure";
import type { ProbeAnswer } from "./migrationEffectProbe.pure";
import {
  hazardsIn,
  isRollbackScript,
  isSafeToDryRun,
  readSqlFailure,
  scanSqlStatements,
  sqlstateWords,
} from "./primeMigrationDiagnosis.pure";

/** Where the prime keeps the approvals. Named once; the corpus reader uses it. */
export const EFFECT_REPLAYS_PATH = "supabase/migrations/MIGRATION_EFFECT_REPLAYS.json";

/** What a listed file may be (the prime's `REPLAY_KINDS`). */
export const REPLAY_KINDS = ["privilege", "policy"] as const;
export type ReplayKind = (typeof REPLAY_KINDS)[number];

/** The audit action every per-clone record of this stage is written under. */
export const EFFECT_REPLAY_AUDIT_ACTION = "clone_backend.migration_effects";

/** The prime's `ENTRY_KEYS`. */
const ENTRY_KEYS: readonly string[] = ["file", "kind", "decided", "reason"];
/** The prime's `VERSIONED`. */
const VERSIONED = /^\d{14}_.+\.sql$/;
/** The prime's `DAY`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type EffectReplayEntry = {
  file: string;
  kind: ReplayKind;
  decided: string;
  reason: string;
};

/** An entry Mission Control will not act on, and why. `file` is null where it names none. */
export type RefusedReplayEntry = { index: number; file: string | null; why: string };

export type EffectReplayReading =
  /** The tree carries no manifest at this commit. Nothing is approved; that is said, not assumed. */
  | {
      state: "absent";
      entries: readonly EffectReplayEntry[];
      refused: readonly RefusedReplayEntry[];
    }
  /** Read. `entries` are the ones that may be acted on, in file order. */
  | { state: "read"; entries: readonly EffectReplayEntry[]; refused: readonly RefusedReplayEntry[] }
  /** Present and not usable, for what its text says. Replays nothing. */
  | {
      state: "unreadable";
      entries: readonly EffectReplayEntry[];
      refused: readonly RefusedReplayEntry[];
      why: string;
    }
  /** Listed in the tree and its bytes could not be fetched this time. Replays nothing; retried. */
  | {
      state: "unfetched";
      entries: readonly EffectReplayEntry[];
      refused: readonly RefusedReplayEntry[];
      why: string;
    };

const NONE: readonly never[] = [];

export function unreadableEffectReplays(why: string): EffectReplayReading {
  return { state: "unreadable", entries: NONE, refused: NONE, why };
}

export function unfetchedEffectReplays(why: string): EffectReplayReading {
  return { state: "unfetched", entries: NONE, refused: NONE, why };
}

/**
 * Parse the manifest text, or `null` when the tree carries none.
 *
 * Never throws. A document this cannot use is a reading to report, and the
 * schema version is checked before anything is read from it: a version this
 * reader does not know may mean something it cannot see.
 */
export function readEffectReplayManifest(text: string | null): EffectReplayReading {
  if (text === null) return { state: "absent", entries: NONE, refused: NONE };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return unreadableEffectReplays(
      `it is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return unreadableEffectReplays("it is not a JSON object");
  }
  const { schema_version: version, replays } = doc as {
    schema_version?: unknown;
    replays?: unknown;
  };
  if (version !== 1) {
    return unreadableEffectReplays(
      `it declares schema_version ${JSON.stringify(version ?? null)}; this reader knows 1`,
    );
  }
  if (!Array.isArray(replays)) return unreadableEffectReplays('it has no "replays" array');

  const entries: EffectReplayEntry[] = [];
  const refused: RefusedReplayEntry[] = [];
  const seen = new Set<string>();
  let previous = "";
  for (const [index, raw] of replays.entries()) {
    const refuse = (file: string | null, why: string) => refused.push({ index, file, why });
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      refuse(null, `replays[${index}] is not an object`);
      continue;
    }
    const e = raw as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file : "";
    if (!VERSIONED.test(file)) {
      refuse(
        null,
        `replays[${index}] does not name a migration file (${JSON.stringify(e.file ?? null)})`,
      );
      continue;
    }
    // Order and duplicates are judged on every entry that names a file, the
    // refused ones included, and attributed to the entry exactly as the
    // prime's gate attributes them: the one that sorts before the entry above
    // it is the one out of order.
    const twice = seen.has(file);
    const early = file < previous;
    seen.add(file);
    previous = file;
    const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k));
    if (twice) {
      refuse(file, "it is listed twice");
      continue;
    }
    if (early) {
      refuse(
        file,
        "it is out of file order, so the manifest is not in the order its replays run in",
      );
      continue;
    }
    if (unknown.length > 0) {
      refuse(
        file,
        `it carries ${unknown.map((k) => `"${k}"`).join(", ")}, which this reader does not know`,
      );
      continue;
    }
    if (!(REPLAY_KINDS as readonly unknown[]).includes(e.kind)) {
      refuse(
        file,
        `its kind is ${JSON.stringify(e.kind ?? null)}, not ${REPLAY_KINDS.join(" or ")}`,
      );
      continue;
    }
    if (typeof e.decided !== "string" || !DAY.test(e.decided)) {
      refuse(file, 'its "decided" is not a YYYY-MM-DD date');
      continue;
    }
    if (typeof e.reason !== "string" || e.reason.trim().length === 0) {
      refuse(file, "it gives no reason");
      continue;
    }
    entries.push({ file, kind: e.kind as ReplayKind, decided: e.decided, reason: e.reason });
  }
  // Run in file order, derived from the names. A sound manifest is already in
  // it, so this changes nothing there; after a refused entry it keeps the
  // ones that remain in the order the prime's own note says they run in.
  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { state: "read", entries, refused };
}

export type ReplayStatus =
  /** The probe returned a row before anything ran. */
  | "already_in_effect"
  /** Dry-run, run for real, and the probe now returns a row. */
  | "replayed"
  /** A dry run of the route: the dry run shows the replay would work; nothing was applied. */
  | "would_replay"
  | "dry_run_failed"
  | "apply_failed"
  | "probe_unreadable"
  /** Not acted on: the entry, the file or its body is not one this may run. */
  | "refused"
  /** The pass's budget ran out before this file was reached. */
  | "not_reached";

export type ReplayOutcome = {
  file: string;
  /** The file name's prefix, as the prime's corpus reads it. Null where the entry names no file. */
  version: string | null;
  kind: ReplayKind | null;
  status: ReplayStatus;
  why?: string;
  sqlstate?: string | null;
  /**
   * A reading this pass could not take, rather than a verdict about the file:
   * its body would not fetch, or the probes did not answer. Retried next pass.
   */
  transient?: boolean;
  /** The file's SQL was committed on the clone. */
  applied?: boolean;
};

/** What the corpus says about the files a manifest names. */
export type CorpusFacts = {
  /** The corpus's file names (withdrawn files already taken out) and their versions. */
  versionOf: ReadonlyMap<string, string>;
  /** The names `MIGRATION_WITHDRAWN.json` takes out. */
  withdrawn: ReadonlySet<string>;
  withdrawalState: "absent" | "read" | "unreadable";
  /** The commit the corpus was listed at, for the refusals. */
  commit: string;
};

/**
 * Whether an entry may be acted on, from the corpus alone.
 *
 * A file the withdrawal manifest lists is never replayed, and when that
 * manifest cannot be read nothing is: the corpus then carries every withdrawn
 * file as an ordinary one, so "not withdrawn" cannot be told, and the prime's
 * own gate fails in that state for the same reason. A rollback script is
 * refused by `isRollbackScript`, which is what keeps one off every other
 * console that can run a file.
 */
export function admitEntry(
  entry: EffectReplayEntry,
  facts: CorpusFacts,
): { ok: true; version: string } | { ok: false; outcome: ReplayOutcome } {
  const refuse = (why: string, transient = false): { ok: false; outcome: ReplayOutcome } => ({
    ok: false,
    outcome: {
      file: entry.file,
      version: entry.file.slice(0, 14),
      kind: entry.kind,
      status: "refused",
      why,
      ...(transient ? { transient: true } : {}),
    },
  });
  if (facts.withdrawalState === "unreadable") {
    return refuse(
      "the prime's MIGRATION_WITHDRAWN.json could not be read, so nothing can say this file is not withdrawn",
      true,
    );
  }
  if (facts.withdrawn.has(entry.file)) {
    return refuse("MIGRATION_WITHDRAWN.json declares its effect deliberately absent");
  }
  if (isRollbackScript(entry.file))
    return refuse("it is a rollback script, which is never run from here");
  const version = facts.versionOf.get(entry.file);
  if (!version) return refuse(`it is not in the prime's tree at ${facts.commit.slice(0, 7)}`);
  return { ok: true, version };
}

/**
 * What a clone's own migration ledger says, read once per run.
 */
export type CloneLedgerReading =
  | { read: true; versions: ReadonlySet<string> }
  | { read: false; why: string };

/**
 * Whether THIS clone's ledger lists the entry's version — the precondition
 * step 3 above states and nothing used to check.
 *
 * The stage exists for files the stamp recorded as run while their effect is
 * absent, so it runs a file "never writing the migration ledger, which already
 * lists the version". But the manifest and the files are read at the prime's
 * repository head, and the stamp copies the prime's DATABASE ledger, which
 * does not hold every version the repository does. A file run here that the
 * clone's ledger does not list is sent again by the fleet migration lane once
 * the prime records it: harmless for a GRANT, and for a `create policy` with
 * no `drop` before it a refusal that blocks the clone out of the fleet sync,
 * where the block clears only when the version reaches a ledger the blocked
 * lane can no longer write. So such a file is refused, by name and with the
 * lane that does deliver it. A ledger that could not be read cannot say either
 * way, and is asked again on the next pass.
 */
export function admitForLedger(
  entry: EffectReplayEntry,
  version: string,
  ledger: CloneLedgerReading,
): { ok: true } | { ok: false; outcome: ReplayOutcome } {
  const base = { file: entry.file, version, kind: entry.kind, status: "refused" as const };
  if (!ledger.read) {
    return {
      ok: false,
      outcome: {
        ...base,
        why: `this clone's migration ledger could not be read (${ledger.why.slice(0, 160)}), so whether it lists ${version} cannot be told`,
        transient: true,
      },
    };
  }
  if (!ledger.versions.has(version)) {
    return {
      ok: false,
      outcome: {
        ...base,
        why:
          `this clone's migration ledger does not list ${version}, so the fleet migration lane ` +
          "sends it once the prime records it; running it here too would send it twice",
      },
    };
  }
  return { ok: true };
}

/**
 * Whether a listed file's body may be dry-run here, and its probe.
 *
 * The probe is the prime's (`effectProbeIn`), refused as the prime refuses it
 * (`probeIsReadOnly`). The body must be one the diagnosis console would trial
 * run (`isSafeToDryRun`): a file that manages its own transaction, or holds a
 * statement Postgres will not run inside one, cannot be trusted to roll back.
 * The wrapper refuses a COMMIT on its own as well (PL/pgSQL will not EXECUTE
 * one, and a nested one is an invalid transaction termination, both seen on
 * Postgres 16, 30 Oct 2026), so the scan is the reason given rather than the
 * only guard.
 */
export function admitBody(
  entry: EffectReplayEntry,
  version: string,
  body: string,
  opts: { maxBytes: number },
): { ok: true; probe: string } | { ok: false; outcome: ReplayOutcome } {
  const base = { file: entry.file, version, kind: entry.kind };
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > opts.maxBytes) {
    return {
      ok: false,
      outcome: {
        ...base,
        status: "refused",
        why: `it is ${bytes} bytes, past the ${opts.maxBytes} one Management API request is known to carry`,
      },
    };
  }
  const probe = effectProbeIn(body);
  if (!probe) {
    return {
      ok: false,
      outcome: {
        ...base,
        status: "probe_unreadable",
        why: "it declares no -- @effect: probe, so nothing can say whether its effect is missing or whether a replay gave it",
      },
    };
  }
  if (!probeIsReadOnly(probe)) {
    return {
      ok: false,
      outcome: {
        ...base,
        status: "probe_unreadable",
        why: "its probe is not one read-only SELECT, so it is never run",
      },
    };
  }
  const hazards = hazardsIn(scanSqlStatements(body));
  if (!isSafeToDryRun(hazards)) {
    const first = hazards[0];
    return {
      ok: false,
      outcome: {
        ...base,
        status: "refused",
        why: `${first?.note ?? "it cannot be trial run"} (line ${first?.line ?? "?"})`,
      },
    };
  }
  return { ok: true, probe };
}

/** What the dry run's exception opens with. */
export const DRY_RUN_MARKER = "DRY RUN (rolled back):";
/** What an apply whose probe still returns no row raises, so it rolls back instead of committing. */
export const APPLY_REFUSAL_MARKER = "APPLY REFUSED (rolled back):";

function wrapped(
  label: string,
  body: string,
  probe: string,
  opts: { lockTimeout: string },
  ending: string[],
): string {
  const lockTimeout = assertLockTimeout(opts.lockTimeout);
  const bodyTag = dollarTag("effect_body", [body, probe]);
  const probeTag = dollarTag("effect_probe", [body, probe, bodyTag]);
  const outer = dollarTag(label, [body, probe, bodyTag, probeTag]);
  return [
    `do ${outer}`,
    "declare",
    "  effect boolean;",
    "begin",
    // A replay must not queue a live clone's traffic behind a lock it waits on.
    `  perform set_config('lock_timeout', '${lockTimeout}', true);`,
    `  execute ${bodyTag}`,
    body,
    `${bodyTag};`,
    // The file has run; from here on nothing may write, whatever the probe says.
    "  perform set_config('transaction_read_only', 'on', true);",
    `  execute 'select exists(' || chr(10) || ${probeTag}${probe}${probeTag} || chr(10) || ')' into effect;`,
    ...ending,
    "end",
    `${outer};`,
  ].join("\n");
}

/**
 * ONE statement that runs the file, evaluates its probe, and raises the
 * answer, so nothing it did survives the request. It never ends without
 * raising: a reply that carries no marker is a dry run that did not finish.
 */
export function dryRunStatement(
  body: string,
  probe: string,
  opts: { lockTimeout: string },
): string {
  if (!probeIsReadOnly(probe))
    throw new Error("Refusing to dry-run a file whose probe is not read-only");
  return wrapped("effect_dry_run", body, probe, opts, [
    `  raise exception '${DRY_RUN_MARKER} probe=%', effect::text;`,
  ]);
}

/**
 * The statement that runs the file for real. The same execution the dry run
 * proved, and the same probe asked again inside the transaction: if it still
 * returns no row the statement raises, and nothing commits.
 */
export function applyStatement(body: string, probe: string, opts: { lockTimeout: string }): string {
  if (!probeIsReadOnly(probe))
    throw new Error("Refusing to apply a file whose probe is not read-only");
  return wrapped("effect_apply", body, probe, opts, [
    "  if not effect then",
    `    raise exception '${APPLY_REFUSAL_MARKER} probe=%', effect::text;`,
    "  end if;",
  ]);
}

export type DryRunReading =
  /** The dry run finished and rolled back; `effect` is the probe's answer after the file ran. */
  | { ran: true; effect: boolean }
  /** The file or its probe raised something else, or the request never reached the end. */
  | { ran: false; sqlstate: string | null; message: string };

/** Read the dry run's answer from whatever the request threw. */
export function readDryRun(raw: string): DryRunReading {
  const text = String(raw ?? "");
  const m = /DRY RUN \(rolled back\): probe=(true|false)(?![A-Za-z])/.exec(text);
  if (m) return { ran: true, effect: m[1] === "true" };
  const { sqlstate, message } = readSqlFailure(text);
  return { ran: false, sqlstate, message };
}

/** Read why an apply did not commit. */
export function readApplyFailure(raw: string): {
  refusedByProbe: boolean;
  sqlstate: string | null;
  message: string;
} {
  const text = String(raw ?? "");
  const { sqlstate, message } = readSqlFailure(text);
  return { refusedByProbe: text.includes(APPLY_REFUSAL_MARKER), sqlstate, message };
}

/** A SQL failure as a sentence: the plain words for its code where there are some. */
export function failureWords(sqlstate: string | null, message: string): string {
  const words = sqlstateWords(sqlstate);
  const said = message.replace(/\s+/g, " ").trim().slice(0, 240);
  return words ? `${words} (${sqlstate}: ${said})` : said || "no reason was given";
}

/** What a probe's first answer means for the file. */
export function outcomeOfProbe(
  base: { file: string; version: string; kind: ReplayKind },
  answer: ProbeAnswer,
): ReplayOutcome | "dry_run" {
  if (answer.kind === "effect")
    return answer.present ? { ...base, status: "already_in_effect" } : "dry_run";
  if (answer.kind === "error") {
    return {
      ...base,
      status: "probe_unreadable",
      sqlstate: answer.sqlstate,
      why: `its probe raised ${answer.sqlstate}${sqlstateWords(answer.sqlstate) ? ` (${sqlstateWords(answer.sqlstate)})` : ""}`,
    };
  }
  return { ...base, status: "probe_unreadable", why: answer.why, transient: true };
}

/** What the read after a replay says the file's outcome is. */
export function outcomeAfterApply(
  base: { file: string; version: string; kind: ReplayKind },
  answer: ProbeAnswer,
): ReplayOutcome {
  if (answer.kind === "effect") {
    return answer.present
      ? { ...base, status: "replayed", applied: true }
      : {
          ...base,
          status: "apply_failed",
          applied: true,
          why: "the file ran and committed, and its probe still returns no row",
        };
  }
  return {
    ...base,
    status: "probe_unreadable",
    applied: true,
    why:
      answer.kind === "error"
        ? `the file ran and committed, and the probe that should confirm it raised ${answer.sqlstate}`
        : `the file ran and committed, and the probe that should confirm it did not answer (${answer.why})`,
    ...(answer.kind === "unread" ? { transient: true } : {}),
  };
}

/**
 * Whether a run of the replay settled the clone for the stamp it answers to.
 *
 * Every listed file has reached a verdict and the manifest was read as what
 * its bytes say (absent, read, or unreadable for its text). A reading that
 * could not be TAKEN — the manifest or a body would not fetch, the probes did
 * not answer, the withdrawal manifest could not be read — or a pass the budget
 * stopped, leaves the stage owed, so the next pass asks again. Nothing else
 * does: a dry run that failed is a verdict about the file on this clone, and
 * asking it again every minute of a build would only say it again.
 */
export function replaySettled(r: {
  manifest: EffectReplayReading;
  outcomes: readonly ReplayOutcome[];
  stopped: boolean;
}): boolean {
  if (r.stopped || r.manifest.state === "unfetched") return false;
  return !r.outcomes.some((o) => o.transient || o.status === "not_reached");
}

/** One file whose probe the report could evaluate. */
export type ReportProbe = { file: string; probe: string };

/**
 * Bodies the report did not read, so whether they declare a probe is not
 * known. Past the read ceiling, or past the count one pass reads, is never
 * read by design; `failed` should have read and did not, and is asked again.
 */
export type BodiesNotRead = {
  pastCeiling: number;
  beyondFileLimit: number;
  failed: number;
  ceilingBytes: number;
};

/**
 * Every declared effect on the clone, reported and never repaired.
 *
 * Counts first, then names. The known-benign set — the template refresh
 * decisions no clone holds (NPC Test, 30 Oct 2026) — is not allow-listed: it
 * is counted with the rest, and the names say which they are.
 */
export type EffectReport =
  | {
      taken: true;
      commit: string;
      /** Files whose body was read and declares a probe. */
      probes: number;
      satisfied: number;
      /** Returned no row. */
      failing: string[];
      /** Raised: the probe names something this clone does not hold. */
      errored: Array<{ file: string; sqlstate: string }>;
      /** Not one read-only SELECT, so never run. */
      refused: string[];
      /** Asked and not heard from. */
      unanswered: string[];
      bodiesNotRead: BodiesNotRead;
    }
  | { taken: false; why: string; transient: boolean };

/** Whether the report says all it could: nothing unanswered, no body that should have read and did not. */
export function reportComplete(report: EffectReport): boolean {
  if (!report.taken) return !report.transient;
  return report.unanswered.length === 0 && report.bodiesNotRead.failed === 0;
}

/** Turn the probe answers into the report. `probes[i]` was answered by `answers[i]`. */
export function buildEffectReport(input: {
  commit: string;
  probes: readonly ReportProbe[];
  answers: readonly ProbeAnswer[];
  refused: readonly string[];
  bodiesNotRead: BodiesNotRead;
}): EffectReport {
  let satisfied = 0;
  const failing: string[] = [];
  const errored: Array<{ file: string; sqlstate: string }> = [];
  const unanswered: string[] = [];
  input.probes.forEach((p, i) => {
    const a = input.answers[i];
    if (!a || a.kind === "unread") unanswered.push(p.file);
    else if (a.kind === "error") errored.push({ file: p.file, sqlstate: a.sqlstate });
    else if (a.present) satisfied += 1;
    else failing.push(p.file);
  });
  return {
    taken: true,
    commit: input.commit,
    probes: input.probes.length + input.refused.length,
    satisfied,
    failing,
    errored,
    refused: [...input.refused],
    unanswered,
    bodiesNotRead: { ...input.bodiesNotRead },
  };
}

/** An instant, written the one way, so two spellings of it compare equal. */
export function normaliseInstant(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Whether a record already settles this stage for this project and stamp.
 *
 * The stage is owed once per stamp: a stamp is what marks versions applied
 * that never ran, so a project re-stamped after a re-verification is owed
 * again, and a new project for the same clone is owed from the start. Only a
 * record that settled BOTH halves counts — the replay, and the report of
 * every other probe — so a pass whose report did not fit asks again on the
 * next one. The stamp is compared as an instant, because the row and the pass
 * that wrote it spell the same time differently.
 */
export function settledEarlier(
  records: ReadonlyArray<{ metadata: unknown }>,
  at: { projectRef: string; stampedAt: string | null },
): boolean {
  const stamp = normaliseInstant(at.stampedAt);
  if (!stamp) return false;
  return records.some((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return (
      m.project_ref === at.projectRef &&
      normaliseInstant(typeof m.stamped_at === "string" ? m.stamped_at : null) === stamp &&
      m.settled === true
    );
  });
}

const STATUS_WORDS: Readonly<Record<ReplayStatus, string>> = {
  already_in_effect: "already in effect",
  replayed: "replayed",
  would_replay: "would replay",
  dry_run_failed: "dry run failed",
  apply_failed: "apply failed",
  probe_unreadable: "probe unreadable",
  refused: "refused",
  not_reached: "not reached this pass",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const names = (files: readonly string[], cap = 6) =>
  files.length <= cap
    ? files.map((f) => f.slice(0, 14)).join(", ")
    : `${files
        .slice(0, cap)
        .map((f) => f.slice(0, 14))
        .join(", ")} and ${files.length - cap} more`;

/** The replay half of the status line. */
export function describeReplays(r: {
  commit: string;
  manifest: { state: EffectReplayReading["state"]; why?: string };
  outcomes: readonly ReplayOutcome[];
}): string {
  const at = r.commit.slice(0, 7);
  if (r.manifest.state === "absent") {
    return `the prime publishes no ${EFFECT_REPLAYS_PATH} at ${at}, so nothing was replayed`;
  }
  if (r.manifest.state === "unreadable" || r.manifest.state === "unfetched") {
    return `the prime's ${EFFECT_REPLAYS_PATH} at ${at} could not be ${
      r.manifest.state === "unfetched" ? "fetched" : "used"
    } (${r.manifest.why ?? "no reason was recorded"}), so nothing was replayed`;
  }
  if (r.outcomes.length === 0) {
    return `the prime's ${EFFECT_REPLAYS_PATH} at ${at} approves no file`;
  }
  const order: ReplayStatus[] = [
    "replayed",
    "would_replay",
    "already_in_effect",
    "dry_run_failed",
    "apply_failed",
    "probe_unreadable",
    "refused",
    "not_reached",
  ];
  const parts = order
    .map((s) => {
      const hit = r.outcomes.filter((o) => o.status === s);
      if (hit.length === 0) return null;
      const quiet = s === "replayed" || s === "would_replay" || s === "already_in_effect";
      return quiet
        ? `${hit.length} ${STATUS_WORDS[s]}`
        : `${hit.length} ${STATUS_WORDS[s]} (${hit
            .slice(0, 3)
            .map((o) => `${o.file.slice(0, 14)}: ${o.why ?? "no reason recorded"}`)
            .join("; ")})`;
    })
    .filter((p): p is string => p !== null);
  return `${plural(r.outcomes.length, "approved file")} at ${at}: ${parts.join(", ")}`;
}

/** The report half of the status line. */
export function describeReport(report: EffectReport): string {
  if (!report.taken) return `the other declared effects were not read (${report.why})`;
  const nr = report.bodiesNotRead;
  const notRead = nr.pastCeiling + nr.beyondFileLimit + nr.failed;
  const notReadParts = [
    nr.pastCeiling
      ? `${nr.pastCeiling} past the ${Math.round(nr.ceilingBytes / 1024)} KB read ceiling`
      : null,
    nr.beyondFileLimit ? `${nr.beyondFileLimit} past the number one pass reads` : null,
    nr.failed ? `${nr.failed} failed` : null,
  ].filter((p): p is string => p !== null);
  const parts = [
    `${report.satisfied} of ${plural(report.probes, "declared probe")} return a row`,
    report.failing.length ? `${report.failing.length} do not (${names(report.failing)})` : null,
    report.errored.length
      ? `${report.errored.length} raised (${names(report.errored.map((e) => e.file))})`
      : null,
    report.refused.length ? `${report.refused.length} refused as not read-only` : null,
    report.unanswered.length ? `${report.unanswered.length} unanswered` : null,
    notRead
      ? `${plural(notRead, "migration body", "migration bodies")} not read (${notReadParts.join(", ")}), so any probe they declare is unknown`
      : null,
  ].filter((p): p is string => p !== null);
  return `on this clone ${parts.join(", ")} — reported, never repaired`;
}

/* ────────────────────────────────────────────────────────────────────────
 * Telling a person.
 *
 * A listed file that ends any way but already in effect or replayed leaves
 * the clone without a fix the owner approved for every clone: refused, a dry
 * run or an apply that failed, a probe that could not be read, or not reached
 * when the budget ran out. So does a run that could reach no file at all. The
 * status line and the stage's row say so, and neither reaches anybody, so
 * each one is raised as an operator notification, on the path the privilege
 * sweep raises its own on (`notifyOperators`, `drift_medium`: a thing a
 * person must do).
 *
 * Told once per project and stamp, the key the stage is owed under. Repeated
 * passes that end the same way say nothing more; a pass that ends a file a
 * way not yet told says it. The key is each exposure (the file and how it
 * ended), not the stamp alone, because a stamp lasts: an existing clone keeps
 * its stamp for months while the hook brings it files approved after its
 * build, and a budget stop is resumed by a pass that may then fail the apply.
 * Keyed on the stamp alone, the first notice would silence both.
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The audit action recording each exposure notice that LANDED.
 *
 * The record a notice is checked against, as the privilege sweep keeps its
 * own: one row per notice delivered, never per pass observed, so a notice the
 * database refused is raised again rather than recorded as told. Not the
 * notifications themselves, which an operator may purge.
 */
export const EFFECT_NOTICE_AUDIT_ACTION = "clone_backend.migration_effects_notice";

/** How a run left an approved fix unconfirmed on a clone. */
export type ExposureStatus =
  | Exclude<ReplayStatus, "already_in_effect" | "replayed" | "would_replay">
  /** The manifest's text could not be used, so no listed file was reached. */
  | "manifest_unreadable"
  /** The manifest would not fetch, so no listed file was reached. */
  | "manifest_unfetched"
  /** The stage refused before the manifest was read: the clone, its project or the prime. */
  | "not_replayed";

export type EffectExposure = {
  /** The listed file, or the manifest's path where no file could be reached. */
  file: string;
  status: ExposureStatus;
  why?: string;
  /** A reading not taken rather than a verdict: asked again by the next run. */
  transient?: boolean;
};

/**
 * Every approved fix a run leaves unconfirmed. Nothing for a dry run, which is
 * somebody looking and answers them.
 */
export function effectExposures(run: {
  dryRun: boolean;
  manifest: { state: EffectReplayReading["state"]; why?: string };
  outcomes: readonly ReplayOutcome[];
}): EffectExposure[] {
  if (run.dryRun) return [];
  const out: EffectExposure[] = [];
  if (run.manifest.state === "unreadable" || run.manifest.state === "unfetched") {
    out.push({
      file: EFFECT_REPLAYS_PATH,
      status: run.manifest.state === "unreadable" ? "manifest_unreadable" : "manifest_unfetched",
      why: run.manifest.why ?? "no reason was recorded",
      ...(run.manifest.state === "unfetched" ? { transient: true } : {}),
    });
  }
  for (const o of run.outcomes) {
    if (
      o.status === "already_in_effect" ||
      o.status === "replayed" ||
      o.status === "would_replay"
    ) {
      continue;
    }
    out.push({
      file: o.file,
      status: o.status,
      ...(o.why ? { why: o.why } : {}),
      ...(o.transient || o.status === "not_reached" ? { transient: true } : {}),
    });
  }
  return out;
}

/** The exposure a stage refusal is: no listed file was reached, for this reason. */
export function notReplayed(why: string): EffectExposure {
  return { file: EFFECT_REPLAYS_PATH, status: "not_replayed", why, transient: true };
}

/** The key one exposure is told under, within one project and stamp. */
export function exposureKey(e: Pick<EffectExposure, "file" | "status">): string {
  return `${e.file}|${e.status}`;
}

/** The exposures the notice rows say were told for this project and stamp. */
export function exposuresTold(
  records: ReadonlyArray<{ metadata: unknown }>,
  at: { projectRef: string; stampedAt: string | null },
): Set<string> {
  const stamp = normaliseInstant(at.stampedAt);
  const told = new Set<string>();
  for (const r of records) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    if (m.project_ref !== at.projectRef) continue;
    if (normaliseInstant(typeof m.stamped_at === "string" ? m.stamped_at : null) !== stamp)
      continue;
    if (!Array.isArray(m.exposures)) continue;
    for (const k of m.exposures) if (typeof k === "string") told.add(k);
  }
  return told;
}

export type EffectNoticeDecision =
  /** Nothing is exposed, or everything exposed was told before for this project and stamp. */
  | { notify: false; reason: "nothing_exposed" | "told_before" }
  | {
      notify: true;
      /** `error` while any exposure is a verdict a person must change something for. */
      severity: "error" | "warning";
      /** Every exposure the run left, each named in the notice. */
      exposures: EffectExposure[];
      /** The ones not told before for this project and stamp. */
      fresh: EffectExposure[];
    };

/**
 * Whether this run's exposures are told, and how loudly.
 *
 * `told` null is a record that could not be read, and the notice is raised:
 * at worst it is said twice. The privilege sweep goes the other way, for a
 * pass every half hour over a standing state; this one runs once a stamp, or
 * when somebody asks, and what it would otherwise drop is a clone without a
 * fix.
 */
export function decideEffectNotice(input: {
  exposures: readonly EffectExposure[];
  told: ReadonlySet<string> | null;
}): EffectNoticeDecision {
  if (input.exposures.length === 0) return { notify: false, reason: "nothing_exposed" };
  const told = input.told;
  const fresh = told
    ? input.exposures.filter((e) => !told.has(exposureKey(e)))
    : [...input.exposures];
  if (fresh.length === 0) return { notify: false, reason: "told_before" };
  return {
    notify: true,
    severity: input.exposures.some((e) => !e.transient) ? "error" : "warning",
    exposures: [...input.exposures],
    fresh,
  };
}

const EXPOSURE_WORDS: Readonly<Record<ExposureStatus, string>> = {
  dry_run_failed: STATUS_WORDS.dry_run_failed,
  apply_failed: STATUS_WORDS.apply_failed,
  probe_unreadable: STATUS_WORDS.probe_unreadable,
  refused: STATUS_WORDS.refused,
  not_reached: "not reached before the budget ran out",
  manifest_unreadable: "could not be used",
  manifest_unfetched: "could not be fetched",
  not_replayed: "not replayed",
};

/** The most exposures one notice names; the rest are counted. */
const NOTICE_LINES = 12;

/** The notice's words. Names, reasons and the remedy; never a body or a probe. */
export function describeEffectNotice(input: {
  cloneName: string | null;
  projectRef: string;
  stampedAt: string | null;
  commit: string | null;
  exposures: readonly EffectExposure[];
  fresh: readonly EffectExposure[];
  /** The build's next pass resumes what this one did not reach. */
  resumes?: boolean;
}): { title: string; body: string } {
  const who = input.cloneName ?? "A clone";
  const stamp = normaliseInstant(input.stampedAt);
  const where = `project ${input.projectRef}, ${stamp ? `ledger stamped ${stamp}` : "ledger not stamped"}`;
  const at = input.commit ? ` at ${input.commit.slice(0, 7)}` : "";
  const remedy =
    "Once the cause is dealt with, `/hooks/clone-effect-replay` with this clone's id asks the clone again and replays what it may.";
  const files = input.exposures.filter((e) => e.file !== EFFECT_REPLAYS_PATH);

  if (files.length === 0) {
    const reasons = input.exposures
      .map((e) => `${EXPOSURE_WORDS[e.status]}: ${e.why ?? "no reason was recorded"}`)
      .join("; ");
    return {
      title: `${who}: the approved privilege and policy fixes were not replayed`,
      body:
        `On this clone (${where}) the files the prime's ${EFFECT_REPLAYS_PATH}${at} approves for ` +
        `every clone were not replayed (${reasons}), so it may lack every privilege and policy fix ` +
        `the owner approved. ${remedy}`,
    };
  }

  const freshKeys = new Set(input.fresh.map(exposureKey));
  const marked = input.fresh.length < input.exposures.length;
  const lines = input.exposures.slice(0, NOTICE_LINES).map((e) => {
    const isNew = marked && freshKeys.has(exposureKey(e)) ? " (new)" : "";
    return `- ${e.file}: ${EXPOSURE_WORDS[e.status]}${e.why ? ` — ${e.why}` : ""}${isNew}`;
  });
  if (input.exposures.length > NOTICE_LINES) {
    lines.push(`- and ${input.exposures.length - NOTICE_LINES} more`);
  }
  const verdicts = input.exposures.some((e) => !e.transient);
  const guidance = [
    verdicts
      ? "A refused file is corrected on the prime; a failed dry run or apply says above why the file did not take effect here."
      : "Each is a reading not taken, so the clone may hold the fix; nothing has said so yet.",
    input.resumes && input.exposures.some((e) => e.status === "not_reached")
      ? "The build's next pass resumes what this one did not reach, and tells you again only if a file then does not take effect."
      : null,
    remedy,
  ].filter((s): s is string => s !== null);
  return {
    title: `${who}: ${plural(files.length, "approved privilege or policy fix", "approved privilege or policy fixes")} not confirmed in effect`,
    body:
      `The prime's ${EFFECT_REPLAYS_PATH}${at} approves these files for every clone, and on this ` +
      `clone (${where}) none of them is confirmed in effect:\n\n${lines.join("\n")}\n\n` +
      `Until each one is, the clone may lack a privilege or policy fix the owner approved. ` +
      guidance.join(" "),
  };
}
