// GENERATED FILE — do not edit by hand.
//
// Source: the `-- @asserts` comments in supabase/migrations/*.sql.
// Regenerate: `npm run migrations:assertions`.
// CI fails on drift: `npm run migrations:assertions:check`.
//
// The drift alarm runs in a Worker with no filesystem, so the claims travel
// as code. Editing this file by hand makes the alarm report on a corpus that
// does not exist — which is the failure it was built to catch, pointed the
// wrong way.
import type { Assertion } from "./migrationAssertions.pure";

export type MigrationClaims = {
  /** Migration filename, e.g. `20260828010000_client_agreements.sql`. */
  readonly migration: string;
  /** Its 14-digit version, the only identity it has in the ledger. */
  readonly version: string;
  readonly assertions: readonly Assertion[];
};

export const MIGRATION_CLAIMS: readonly MigrationClaims[] = [
  {
    migration: "20260828020000_migration_assertion_checks.sql",
    version: "20260828020000",
    assertions: [
      { kind: "table", table: "migration_assertion_checks" },
      { kind: "cron", jobname: "migration-drift-hourly" },
      { kind: "enum", type: "notification_kind" },
    ],
  },
  {
    migration: "20260828030000_schema_migration_queue.sql",
    version: "20260828030000",
    assertions: [
      { kind: "table", table: "schema_migration_queue" },
      { kind: "cron", jobname: "schema-migration-drain" },
    ],
  },
  {
    migration: "20260828040000_assertion_checks_default_grants.sql",
    version: "20260828040000",
    assertions: [
      {
        kind: "none",
        reason:
          "removes default table grants; a GRANT is not observable through PostgREST, so nothing here can be asserted by effect",
      },
    ],
  },
  {
    migration: "20260828050000_deployment_status_since.sql",
    version: "20260828050000",
    assertions: [{ kind: "column", table: "clone_deployments", column: "status_since" }],
  },
  {
    migration: "20260828060000_clone_email_identities.sql",
    version: "20260828060000",
    assertions: [{ kind: "table", table: "clone_email_identities" }],
  },
  {
    migration: "20260828070000_agreement_provisioning.sql",
    version: "20260828070000",
    assertions: [
      { kind: "column", table: "client_agreements", column: "provision_status" },
      { kind: "table", table: "docusign_connect_events" },
      { kind: "cron", jobname: "agreements-refresh" },
    ],
  },
  {
    migration: "20260828080000_contract_module_exclusions.sql",
    version: "20260828080000",
    assertions: [{ kind: "column", table: "clones", column: "contract_excluded_module_slugs" }],
  },
  {
    migration: "20260829030000_clone_turnstile_identities.sql",
    version: "20260829030000",
    assertions: [{ kind: "table", table: "clone_turnstile_identities" }],
  },
  {
    migration: "20260829040000_schedule_turnstile_reconcile.sql",
    version: "20260829040000",
    assertions: [{ kind: "cron", jobname: "turnstile-reconcile-10min" }],
  },
  {
    migration: "20260829100000_fix_agreements_refresh_cron.sql",
    version: "20260829100000",
    assertions: [
      { kind: "cron", jobname: "agreements-refresh" },
      { kind: "cron", jobname: "airtable-waitlist-sync" },
      { kind: "cron", jobname: "crm-sweep-hourly" },
    ],
  },
  {
    migration: "20260829110000_schedule_email_identity_drain.sql",
    version: "20260829110000",
    assertions: [{ kind: "cron", jobname: "email-identity-drain" }],
  },
  {
    migration: "20260830040000_schedule_clone_jwt_secret_reconcile.sql",
    version: "20260830040000",
    assertions: [{ kind: "cron", jobname: "clone-jwt-secret-reconcile" }],
  },
  {
    migration: "20260830070000_schedule_cascade_merge_drain.sql",
    version: "20260830070000",
    assertions: [{ kind: "cron", jobname: "cascade-merge-drain" }],
  },
  {
    migration: "20260830090000_schedule_held_file_drift_sweep.sql",
    version: "20260830090000",
    assertions: [{ kind: "cron", jobname: "held-file-drift" }],
  },
  {
    migration: "20260831000000_clone_payment_gates.sql",
    version: "20260831000000",
    assertions: [
      { kind: "table", table: "clone_payment_gates" },
      { kind: "table", table: "clone_payment_gate_events" },
      { kind: "column", table: "prime_config", column: "clone_gate_default_hours" },
    ],
  },
  {
    migration: "20260831080000_clone_backend_resume_stage.sql",
    version: "20260831080000",
    assertions: [{ kind: "column", table: "clone_backends", column: "resume_stage" }],
  },
  {
    migration: "20260901120000_clone_email_identity_from_address.sql",
    version: "20260901120000",
    assertions: [
      { kind: "column", table: "clone_email_identities", column: "from_address_written_at" },
    ],
  },
  {
    migration: "20260901130000_clone_email_identity_revoked_at.sql",
    version: "20260901130000",
    assertions: [{ kind: "column", table: "clone_email_identities", column: "revoked_at" }],
  },
];
