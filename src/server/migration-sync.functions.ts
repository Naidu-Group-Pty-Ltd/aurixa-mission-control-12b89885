import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { getAppOctokit } from "./github-app.server";
import {
  fetchPrimeMigrationList,
  resolvePrimeBackendRef,
  resolvePrimeSource,
} from "./prime-backend.server";
import { applyPrimeMigrations } from "./backend-provisioning.server";
import { openScopedPrimeCorpus } from "./fleet-migration.server";

/**
 * Migration sync — prime-repo driven.
 *
 * The source of truth for clone schemas is the prime repo's
 * supabase/migrations directory on GitHub (not a hand-maintained registry).
 * Each clone backend keeps its own aurixa.schema_migrations ledger, so
 * replays are idempotent: anything already applied is skipped.
 */

/** Legacy version markers written by the pre-replication pipeline. */
function normalizeVersion(version: string | null): string | null {
  if (!version || !/^\d+$/.test(version)) return null;
  return version;
}

/**
 * Get migration registry info — the prime repo's migration list.
 * Every prime migration is clone-applicable by construction: a clone
 * backend is a structural replica of the prime.
 */
export const getMigrationRegistry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const empty = {
      totalMigrations: 0,
      cloneApplicable: 0,
      latestCloneVersion: "none",
      migrations: [] as { id: string; description: string; cloneApplicable: boolean }[],
    };
    const source = await resolvePrimeSource(context.supabase);
    if (!source) return { ...empty, error: "Prime not configured" };

    try {
      const { migrations, sourceSha } = await fetchPrimeMigrationList(getAppOctokit(), source);
      return {
        totalMigrations: migrations.length,
        cloneApplicable: migrations.length,
        latestCloneVersion: migrations[migrations.length - 1]?.id ?? "none",
        migrations: migrations.map((m) => ({
          id: m.id,
          description: m.name,
          cloneApplicable: true,
        })),
        sourceRepo: `${source.owner}/${source.repo}`,
        sourceSha,
      };
    } catch (e) {
      return { ...empty, error: e instanceof Error ? e.message : "Failed to read prime repo" };
    }
  });

/**
 * Get migration status for a specific clone backend, measured against the
 * prime repo's current migration list.
 */
export const getCloneMigrationStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: backend } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, migration_version, status")
      .eq("clone_id", data.cloneId)
      .maybeSingle();

    if (!backend) {
      return { hasBackend: false as const };
    }

    const currentVersion = normalizeVersion(backend.migration_version);

    let pending: { id: string; description: string }[] = [];
    let latestVersion = "none";
    try {
      const source = await resolvePrimeSource(supabase);
      if (source) {
        // The SCOPED list, for the same reason the sync applies the scoped
        // list: a repo version the prime's database never ran is not pending
        // work, it is a file the prime deliberately never took. Counting the
        // raw repo here is what showed hundreds "pending" and invited the
        // click that replayed the repo's 2025 tail at a tenant backend.
        const scoped = await openScopedPrimeCorpus(supabase, source);
        if (scoped.ok) {
          latestVersion = scoped.runnable[scoped.runnable.length - 1]?.id ?? "none";
          pending = scoped.runnable
            .filter((m) => !currentVersion || m.id > currentVersion)
            .map((m) => ({ id: m.id, description: m.name }));
        }
      }
    } catch {
      // Prime unreadable (GitHub App down/unconfigured, ledger unreachable) —
      // show no pending rather than failing the whole clone page.
    }

    return {
      hasBackend: true as const,
      backendStatus: backend.status,
      currentVersion: backend.migration_version,
      latestVersion,
      pendingCount: pending.length,
      pendingMigrations: pending,
      isUpToDate: pending.length === 0,
    };
  });

/**
 * Apply the prime repo's pending migrations to a specific clone backend.
 */
export const syncCloneMigrations = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(
    async ({
      data,
      context,
    }): Promise<
      | { ok: true; applied: number; newVersion: string; failures: string[] }
      | { ok: false; error: string }
    > => {
      const { supabase, userId } = context;

      const { data: backend } = await supabase
        .from("clone_backends")
        .select("supabase_project_ref, migration_version, status")
        .eq("clone_id", data.cloneId)
        .maybeSingle();

      if (!backend) {
        return { ok: false, error: "No backend provisioned for this clone" };
      }
      if (backend.status !== "ready") {
        return { ok: false, error: `Backend is not ready (status: ${backend.status})` };
      }
      if (!backend.supabase_project_ref) {
        return { ok: false, error: "Backend has no project reference" };
      }

      const source = await resolvePrimeSource(supabase);
      if (!source) {
        return { ok: false, error: "Prime not configured — set the prime repo in Settings first" };
      }

      // Update status to migrating
      await supabase
        .from("clone_backends")
        .update({
          status: "migrating" as const,
          status_detail: `Syncing migrations from ${source.owner}/${source.repo}...`,
        })
        .eq("clone_id", data.cloneId);

      try {
        // The SCOPED corpus — the same one the scheduled fleet sync replays —
        // and never the raw repo. This button used to pass `corpus.metas`
        // directly: 962 files, including two rollback scripts and 52
        // future-dated versions the prime never ran. One click replayed the
        // repo's January-2025 tail at this tenant's backend — the versions the
        // earlier incident had stamped were skipped by the ledger, and
        // `20250124140000`, a version absent from the prime's own ledger,
        // failed against the introspected schema and marked the backend
        // `failed`, which took it out of the fleet sync and blocked its
        // deployment. The rule is #71's: a clone never runs a migration the
        // prime itself has not run — and it holds for a button exactly as it
        // holds for a schedule, because the database cannot tell who asked.
        //
        // Bodies still arrive on demand inside the replay, for the versions
        // this clone turns out to be missing; materialising the whole corpus
        // here is what made this button time out at 60 s without finishing.
        const scoped = await openScopedPrimeCorpus(supabase, source);
        if (!scoped.ok) {
          await supabase
            .from("clone_backends")
            .update({
              status: "ready" as const,
              status_detail: `Migration sync refused: ${scoped.error}`,
              error_message: scoped.error,
            })
            .eq("clone_id", data.cloneId);
          return { ok: false, error: scoped.error };
        }
        const { corpus, runnable } = scoped;
        const sourceSha = scoped.sourceSha;
        const { results, latestApplied } = await applyPrimeMigrations(
          backend.supabase_project_ref,
          runnable,
          undefined,
          (m) => corpus.loadSql(m.id),
        );

        const successes = results.filter((r) => r.success && !r.skipped);
        const failures = results.filter((r) => !r.success);
        const newVersion = latestApplied ?? backend.migration_version ?? "none";

        // Update backend record
        await supabase
          .from("clone_backends")
          .update({
            migration_version: latestApplied,
            source_repo: `${source.owner}/${source.repo}`,
            source_ref: source.branch,
            source_sha: sourceSha,
            migrations_applied: results,
            status: failures.length > 0 ? ("failed" as const) : ("ready" as const),
            status_detail:
              failures.length > 0
                ? `Migration failed at ${failures[0].name}: ${failures[0].error}`
                : `Migrations up to date (${newVersion})`,
            error_message: failures.length > 0 ? failures[0].error : null,
          })
          .eq("clone_id", data.cloneId);

        // Audit log
        await supabase.from("audit_log").insert({
          action: "clone_backend.migrations_synced",
          entity_type: "clone",
          entity_id: data.cloneId,
          actor_user_id: userId,
          metadata: {
            applied: successes.length,
            failed: failures.length,
            new_version: newVersion,
            source_repo: `${source.owner}/${source.repo}`,
            source_sha: sourceSha,
            failures: failures.map((f) => ({ id: f.id, error: f.error })),
          },
        });

        return {
          ok: true,
          applied: successes.length,
          newVersion,
          failures: failures.map((f) => `${f.name}: ${f.error}`),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Migration sync failed";
        await supabase
          .from("clone_backends")
          .update({
            status: "ready" as const,
            status_detail: `Migration error: ${msg}`,
            error_message: msg,
          })
          .eq("clone_id", data.cloneId);
        return { ok: false, error: msg };
      }
    },
  );

/**
 * Re-stamp a clone's migration ledger from the prime backend.
 *
 * The repair for a clone that has a schema and no ledger. That combination is
 * what catalogue introspection leaves behind when the stamping step does not
 * run, and it is unrecoverable through the ordinary sync path: every prime
 * migration reads as pending, the replay starts at the first one, and it fails
 * on objects the introspected schema already created.
 *
 * This records the prime's applied versions against the clone WITHOUT running
 * any of them, which is exactly what introspection should have done. It is
 * `on conflict do nothing`, so running it against a healthy clone is a no-op
 * rather than a corruption — the repair is safe to offer next to the sync
 * button and safe to press twice.
 *
 * It deliberately does NOT verify that the clone's schema matches the prime's.
 * Stamping asserts "these versions are already reflected here", and only the
 * operator repairing a known-introspected clone can make that claim. A clone
 * that is genuinely behind must sync, not stamp — so the pre-flight in
 * `applyPrimeMigrations` refuses only the states stamping actually fixes, and
 * this stays an explicit operator action rather than an automatic recovery.
 */
export const restampCloneMigrationLedger = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth, requireAdmin])
  .inputValidator((d: { cloneId: string }) => {
    if (!d?.cloneId) throw new Error("cloneId is required");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: backend, error: backendErr } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, status")
      .eq("clone_id", data.cloneId)
      .maybeSingle();
    // A read that FAILED is not a backend that is ABSENT.
    if (backendErr) {
      return {
        ok: false as const,
        error: `Could not read the clone backend: ${backendErr.message}`,
      };
    }
    if (!backend?.supabase_project_ref) {
      return { ok: false as const, error: "No backend provisioned for this clone" };
    }

    try {
      const primeBackendRef = await resolvePrimeBackendRef(supabase);
      const { stampMigrationLedgerFromPrime } = await import("./schema-introspection.server");
      const { stamped } = await stampMigrationLedgerFromPrime(
        backend.supabase_project_ref,
        primeBackendRef,
      );

      const { error: auditErr } = await supabase.from("audit_log").insert({
        action: "clone_backend.ledger_restamped",
        entity_type: "clone",
        entity_id: data.cloneId,
        actor_user_id: userId,
        metadata: {
          stamped,
          prime_backend_ref: primeBackendRef,
          clone_project_ref: backend.supabase_project_ref,
        },
      });
      // The stamp already succeeded; a lost audit row must not be reported as
      // a failed repair, or an operator re-runs a repair that already worked.
      if (auditErr) {
        console.warn("[restamp] audit_log write failed:", auditErr.message);
      }

      return { ok: true as const, stamped };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Ledger re-stamp failed",
      };
    }
  });

/**
 * Fleet-wide migration sync: apply the prime's pending migrations to all
 * ready clone backends. The prime repo is snapshotted once and replayed
 * against every backend; each backend's ledger decides what it still needs.
 */
/**
 * Fleet migration sync, on an operator's request.
 *
 * A thin wrapper. The engine is `runFleetMigrationSync` in
 * `fleet-migration.server.ts`, shared with the scheduled worker at
 * `/hooks/fleet-migration-sync` — this button and that cron job were never
 * allowed to become two implementations of "sync the fleet", which is how a
 * button and a scheduler come to disagree about what a clone is owed.
 *
 * The button's own contribution is the actor: an operator pressing it is
 * recorded as having done so, and the scheduler is recorded as the scheduler.
 */
export const fleetMigrationSync = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { runFleetMigrationSync } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/fleet-migration.server"
    );
    const result = await runFleetMigrationSync(context.supabase, {
      actorUserId: context.userId,
    });
    if (result.error) return { ok: false as const, error: result.error };
    return { ok: true as const, ...result };
  });
