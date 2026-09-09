import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSubmissions } from "@/server/migrationQueue.pure";

/*
  THE MIGRATION CORPUS IS JUDGED BY THE RULE THE QUEUE ENFORCES.

  `migrationQueue.pure.test.ts` proves the rule with fixtures. This proves the
  repository against it — because the outage that added transaction control to
  that rule was not a rule anybody had got wrong, it was a file nobody had
  measured.

  ## What happened

  `aurixa.drain_schema_migrations()` applies each migration with `EXECUTE`
  inside a PL/pgSQL function, so a migration that opens its own transaction
  raises `0A000 EXECUTE of transaction commands is not implemented`. A failed
  migration HALTS the queue — migrations are ordered, and applying N+1 over a
  failed N is how a schema silently diverges.

  `20260908040000_brokered_usage_is_billable` did exactly that at 04:38 on
  8 September 2026. Every migration merged after it stopped applying: eight of
  them, across three pull requests, over two days. Each merge's workflow
  reported only that its OWN files were "still queued" — true, unhelpful, and
  never once naming the failed row holding the line. Mission Control's database
  stopped moving and nothing said so.

  ## Why the six are frozen rather than fixed

  A version already on the queue is HISTORY. `enqueue` deliberately refuses to
  overwrite the SQL of a version it already holds — rewriting a queued
  migration from a later merge is how the thing that ran and the thing in the
  repository stop being the same thing. So these six cannot be repaired in
  place, and editing them here would fix nothing in the database.

  The remedy is the one the workflow prints: clear the failed row, and carry
  any effect it still owes in a NEW migration. That is an operator act against
  a database this repository cannot reach (Lovable Cloud: no service-role key,
  no direct database URL, Management API 403 — see
  `docs/MIGRATION_AUTOMATION_OPTIONS.md`).

  This is therefore a RATCHET, not a ban, in the shape this repository already
  uses for `edge-missing-names.txt` and `derivedFigureDefinitions.spec.ts`: the
  six are named, the list may only shrink, and a seventh fails the build.
*/

const DIR = "supabase/migrations";

/**
 * The six that carry `BEGIN; … COMMIT;` and were already queued before the
 * rule existed. Remove a name when its row is resolved and its effect is
 * carried by a new version — never add one.
 */
const FROZEN_TRANSACTION_CONTROL: ReadonlySet<string> = new Set([
  "20260908040000_brokered_usage_is_billable.sql",
  "20260908040100_per_operation_vendor_rates.sql",
  "20260908040300_rerate_brokered_usage_backlog.sql",
  "20260908110000_absorbed_vendor_cost.sql",
  "20260908110100_didit_absorbed_and_token_priced.sql",
  "20260908110200_rerate_absorbed_didit_backlog.sql",
]);

type Entry = { version: string; name: string; sql: string };

function corpus(): Entry[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      // The 14-digit prefix IS the version; a file whose name does not carry
      // one is already refused by `check-migration-pipeline`, and passing the
      // raw name through keeps that rejection legible here rather than turning
      // every file into a version complaint.
      version: name.slice(0, 14),
      name,
      sql: readFileSync(join(DIR, name), "utf-8"),
    }));
}

/** The queue's own verdict, one file at a time so a rejection names its file. */
function rejectionFor(entry: Entry): string | null {
  const { rejected } = validateSubmissions([entry]);
  return rejected.length > 0 ? rejected[0].reason : null;
}

describe("every migration in the repository is one the drain can actually run", () => {
  const files = corpus();

  it("reads a corpus at all — an empty glob would pass every assertion below", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("refuses anything the queue would refuse, except the frozen six", () => {
    const offenders = files
      .map((f) => ({ name: f.name, reason: rejectionFor(f) }))
      .filter((r) => r.reason !== null && !FROZEN_TRANSACTION_CONTROL.has(r.name));

    expect(
      offenders,
      "A migration the drain cannot run halts the WHOLE queue, not just itself — " +
        "every migration merged after it stops applying, silently. Take the " +
        "transaction control out: the drain already runs each migration in a " +
        "transaction, so a migration that opens one is asking for something it has.",
    ).toEqual([]);
  });

  it("the frozen list may only shrink — every name on it is still present and still offending", () => {
    /*
      A name that no longer offends (or no longer exists) is one somebody fixed
      in place, which cannot have reached the database — the queue holds the
      SQL it was given. Failing here is the prompt to remove the name and carry
      the effect in a new version instead.
    */
    for (const name of FROZEN_TRANSACTION_CONTROL) {
      const entry = files.find((f) => f.name === name);
      expect(entry, `${name} is on the frozen list but not in ${DIR}`).toBeDefined();
      expect(
        rejectionFor(entry!),
        `${name} no longer offends. Editing a queued migration does not change what the ` +
          `queue holds — remove it from FROZEN_TRANSACTION_CONTROL and carry any effect it ` +
          `still owes in a NEW version.`,
      ).not.toBeNull();
    }
  });

  it("names transaction control specifically, so the reason sends the reader to the right fix", () => {
    const one = files.find((f) => f.name === "20260908040000_brokered_usage_is_billable.sql");
    expect(one).toBeDefined();
    expect(rejectionFor(one!)).toMatch(/BEGIN|COMMIT/);
  });

  it("does not fire on PL/pgSQL bodies, which open a block with a bare BEGIN", () => {
    /*
      `stripSqlComments` deliberately does not understand dollar-quoting, so a
      rule matching a bare `BEGIN` would refuse every function and DO block in
      the corpus. The semicolon is what separates transaction control from a
      block opener — and the queue's own bootstrap migration is the proof,
      because it carries `DO $schedule$ BEGIN … END $schedule$;`.
    */
    const bootstrap = files.find((f) => f.name.endsWith("_schema_migration_queue.sql"));
    expect(bootstrap, "the queue's bootstrap migration should be in the corpus").toBeDefined();
    expect(bootstrap!.sql).toMatch(/BEGIN/);
    expect(rejectionFor(bootstrap!)).toBeNull();
  });
});
