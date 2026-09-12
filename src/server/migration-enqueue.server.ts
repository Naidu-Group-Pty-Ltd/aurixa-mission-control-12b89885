/**
 * Putting a merged migration on the queue, and reporting where it got to.
 *
 * ## The target is not configurable, and that is the point
 *
 * The path this replaces sent migration SQL to the Supabase Management API
 * under a `PROJECT_REF` read from a repository variable. That token reaches
 * every project in the organisation, so a wrong ref did not fail -- it applied
 * Mission Control's admin schema to somebody's tenant. `.github/scripts/
 * apply-migrations.mjs` grew a behavioural identity check and a `FORBIDDEN_REFS`
 * list to defend against its own configuration.
 *
 * Here there is no ref. This runs inside Mission Control and writes through
 * Mission Control's own service-role client, so the target is *whatever
 * database this deployment is connected to* -- which is the only database the
 * answer could ever be. The entire class of "wrong project" bug is gone rather
 * than guarded.
 *
 * ## Append-only, from this side too
 *
 * `service_role` holds `SELECT, INSERT` on the queue and nothing else, so
 * nothing in this module can mark a migration applied, retry one, or delete
 * the evidence that it failed. Every status transition belongs to the
 * `postgres`-owned drain. That asymmetry is deliberate: the credential that
 * SUBMITS work must not be able to report on it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  validateSubmissions,
  judgeBatch,
  type MigrationSubmission,
  type Rejection,
  type QueueRow,
  type BatchVerdict,
} from "./migrationQueue.pure";

type Db = SupabaseClient<Database>;

export type EnqueueResult = {
  /** Versions written to the queue by this call. */
  readonly enqueued: string[];
  /** Versions already on the queue; re-posting a merge is a no-op. */
  readonly alreadyQueued: string[];
  /**
   * Versions this queue has already settled, so never re-enqueued.
   *
   * Both terminal successes, because the question this answers is "is there
   * anything left to do for this version" and for both the answer is no. Which
   * of the two it was is in the verdict, where it carries information.
   */
  readonly alreadyApplied: string[];
  readonly rejected: Rejection[];
  /** Where every submitted version stands right now. */
  readonly verdict: BatchVerdict;
};

/** Digest of the SQL as submitted, so what RAN can be compared to the repo. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readRows(db: Db, versions: readonly string[]): Promise<QueueRow[]> {
  if (versions.length === 0) return [];
  const { data, error } = await db
    .from("schema_migration_queue")
    .select("version, name, status, attempts, error")
    .in("version", versions as string[]);
  // A read that FAILED is not a queue that is EMPTY. Reporting the two the same
  // way would let a transient fault read as "nothing was enqueued", and the
  // caller's remedy for those is opposite.
  if (error) throw new Error(`Could not read schema_migration_queue: ${error.message}`);
  return (data ?? []) as QueueRow[];
}

/**
 * The ledger is deliberately NOT consulted here.
 *
 * `supabase_migrations.schema_migrations` lives outside the two schemas
 * PostgREST exposes, so it cannot be read from this side at all -- and even if
 * it could, it is the wrong authority. Measured 12 Sep 2026 across the whole
 * corpus: 194 ledger rows against 268 repo files, 102 ledger rows matching no
 * repo file, and of the 141 Lovable-authored migrations only **36** appear
 * under their own version while **138** have a row within ten seconds. Lovable
 * stamps when it BEGINS applying and names the file when it WRITES it, so the
 * skew runs -7s to +7s and by no constant amount. The ledger records that
 * something ran; it cannot say which file.
 *
 * What makes a repeat submission a no-op is the queue's own UNIQUE constraint
 * on `version`, and the drain skips a ledger stamp that already exists.
 * `alreadyApplied` therefore means "this queue settled it", which is a fact
 * this side can actually establish.
 *
 * The separate `MigrationSubmission.alreadyApplied` FLAG is the other half of
 * that: the submitter declares an out-of-band apply because the ledger cannot
 * be asked, and `20260912150000`'s header carries the full measurement.
 */
export type EnqueueOptions = {
  /** Recorded on the row: which workflow run or operator submitted it. */
  readonly enqueuedBy?: string;
};

export async function enqueueMigrations(
  db: Db,
  submissions: readonly MigrationSubmission[],
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const { accepted, rejected } = validateSubmissions(submissions);
  const versions = accepted.map((a) => a.version);

  const existing = await readRows(db, versions);
  const known = new Set(existing.map((r) => r.version));
  const applied = new Set(
    existing.filter((r) => r.status === "applied" || r.status === "recorded").map((r) => r.version),
  );

  const fresh = accepted.filter((a) => !known.has(a.version));

  const enqueued: string[] = [];
  if (fresh.length > 0) {
    const rows = await Promise.all(
      fresh.map(async (m) => ({
        version: m.version,
        name: m.name,
        sql: m.sql,
        sha256: await sha256Hex(m.sql),
        // Always written, never conditional. An omitted column takes the
        // table's default, which is the same value — but an explicit false is
        // the difference between "the submitter said this must run" and "the
        // submitter said nothing", and only one of those is a declaration.
        already_applied: m.alreadyApplied === true,
        ...(opts.enqueuedBy ? { enqueued_by: opts.enqueuedBy } : {}),
      })),
    );
    // `ignoreDuplicates` rather than a merge: a version already on the queue is
    // history, and overwriting its SQL from a later submission is exactly the
    // "edited an applied migration" mistake the pipeline refuses everywhere
    // else.
    const { data, error } = await db
      .from("schema_migration_queue")
      .upsert(rows, { onConflict: "version", ignoreDuplicates: true })
      .select("version");
    if (error) throw new Error(`Could not enqueue migrations: ${error.message}`);
    for (const r of (data ?? []) as { version: string }[]) enqueued.push(r.version);
  }

  const verdict = judgeBatch(versions, await readRows(db, versions));

  return {
    enqueued,
    alreadyQueued: [...known].filter((v) => !applied.has(v)),
    alreadyApplied: [...applied],
    rejected,
    verdict,
  };
}

/** One settled version, and the digest of the SQL that settled it. */
export type SettledDigest = {
  readonly version: string;
  readonly name: string;
  readonly sha256: string;
  readonly status: "applied" | "recorded";
};

/**
 * What this queue actually ran, by digest — the reader `sha256` never had.
 *
 * The column's own comment says it exists "so what RAN can be compared to the
 * repo", and from the day it was created (2026-08-27) nothing compared it.
 * Measured 12 Sep 2026, sixteen days later:
 * **2 of 55** settled rows already differ from their repository file and
 * nothing anywhere reported it.
 *
 * Read-only by construction, and that is the whole reason this is an action on
 * an endpoint rather than a credential handed to CI. `service_role` holds
 * `SELECT, INSERT` on this table and nothing else; this reads three columns of
 * what it may already read. It can answer no question the caller could not ask
 * with `action: "status"`, one version at a time.
 *
 * A row with no digest is OMITTED rather than reported with an empty one. Every
 * settled row carries one today (56 of 56), but a null is "we cannot say what
 * ran", and a comparison against an absent digest would either pass everything
 * or fail everything — both of which are answers about the reader rather than
 * about the file.
 */
export async function readSettledDigests(db: Db): Promise<SettledDigest[]> {
  const { data, error } = await db
    .from("schema_migration_queue")
    .select("version, name, sha256, status")
    .in("status", ["applied", "recorded"])
    .order("version");
  // A read that FAILED is not a queue that settled nothing. The caller writes a
  // manifest from this, and an empty array would quietly erase every entry.
  if (error) throw new Error(`Could not read settled digests: ${error.message}`);
  return (data ?? [])
    .filter(
      (r): r is { version: string; name: string; sha256: string; status: string } =>
        typeof r.sha256 === "string" && r.sha256.length > 0,
    )
    .map((r) => ({
      version: r.version,
      name: r.name,
      sha256: r.sha256,
      status: r.status === "recorded" ? ("recorded" as const) : ("applied" as const),
    }));
}

export type StatusResult = {
  readonly verdict: BatchVerdict;
  readonly rows: QueueRow[];
};

export async function readMigrationStatus(
  db: Db,
  versions: readonly string[],
): Promise<StatusResult> {
  const rows = await readRows(db, versions);
  return { verdict: judgeBatch(versions, rows), rows };
}
