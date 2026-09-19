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
import type { Assertion, Supersede } from "./migrationAssertions.pure";

export type MigrationClaims = {
  /** Migration filename, e.g. `20260828010000_client_agreements.sql`. */
  readonly migration: string;
  /** Its 14-digit version, the only identity it has in the ledger. */
  readonly version: string;
  readonly assertions: readonly Assertion[];
  /** Earlier migrations' claims this one retires. Validated at generation. */
  readonly supersedes?: readonly Supersede[];
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
    migration: "20260901090000_clone_backend_retry_after.sql",
    version: "20260901090000",
    assertions: [{ kind: "column", table: "clone_backends", column: "retry_after" }],
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
  {
    migration: "20260902080000_clone_secret_forwards.sql",
    version: "20260902080000",
    assertions: [{ kind: "table", table: "clone_secret_forwards" }],
  },
  {
    migration: "20260902081000_schedule_clone_secret_forward_reconcile.sql",
    version: "20260902081000",
    assertions: [{ kind: "cron", jobname: "clone-secret-forward-reconcile" }],
  },
  {
    migration: "20260902100000_schedule_clone_deployer_declaration_reconcile.sql",
    version: "20260902100000",
    assertions: [{ kind: "cron", jobname: "clone-deployer-declaration-reconcile" }],
  },
  {
    migration: "20260902134000_cascade_events_next_attempt_at.sql",
    version: "20260902134000",
    assertions: [{ kind: "column", table: "cascade_events", column: "next_attempt_at" }],
  },
  {
    migration: "20260902144000_cascade_results_progress.sql",
    version: "20260902144000",
    assertions: [{ kind: "column", table: "cascade_results", column: "progress" }],
  },
  {
    migration: "20260903160000_clone_backends_repair_requested_at.sql",
    version: "20260903160000",
    assertions: [{ kind: "column", table: "clone_backends", column: "repair_requested_at" }],
  },
  {
    migration: "20260904060000_prime_snapshot_scans.sql",
    version: "20260904060000",
    assertions: [{ kind: "table", table: "prime_snapshot_scans" }],
  },
  {
    migration: "20260904073000_clone_backend_secrets_authorised_no_value.sql",
    version: "20260904073000",
    assertions: [
      {
        kind: "none",
        reason: "widens a CHECK constraint. The effect is real and observable — a write of",
      },
    ],
  },
  {
    migration: "20260906030000_schedule_clone_signing_pair_reconcile.sql",
    version: "20260906030000",
    assertions: [{ kind: "cron", jobname: "clone-signing-pair-reconcile" }],
  },
  {
    migration: "20260906070000_clone_secrets_reconcile.sql",
    version: "20260906070000",
    assertions: [
      { kind: "column", table: "clone_api_keys", column: "delivered_project_ref" },
      { kind: "column", table: "clone_api_keys", column: "delivered_env_at" },
      { kind: "cron", jobname: "clone-secrets-reconcile" },
    ],
  },
  {
    migration: "20260906080000_prime_secret_pairs.sql",
    version: "20260906080000",
    assertions: [{ kind: "cron", jobname: "prime-secret-pairs" }],
  },
  {
    migration: "20260906100000_didit_fleet_forward.sql",
    version: "20260906100000",
    assertions: [
      { kind: "rows", table: "prime_secret_forwards", atLeast: 45 },
      { kind: "rows", table: "api_provider_rates", atLeast: 20 },
    ],
  },
  {
    migration: "20260906120000_requeue_stuck_domain_verification.sql",
    version: "20260906120000",
    assertions: [{ kind: "rows", table: "clone_deployments", atLeast: 3 }],
  },
  {
    migration: "20260906170000_prune_cron_run_history.sql",
    version: "20260906170000",
    assertions: [{ kind: "cron", jobname: "mc-purge-cron-history" }],
  },
  {
    migration: "20260906180000_edge_job_verify_domain_txt_action.sql",
    version: "20260906180000",
    assertions: [
      { kind: "none", reason: "widens a CHECK constraint — pg_constraint is not observable" },
    ],
  },
  {
    migration: "20260907070000_schedule_fleet_secret_forward_reconcile.sql",
    version: "20260907070000",
    assertions: [{ kind: "cron", jobname: "fleet-secret-forward-reconcile" }],
  },
  {
    migration: "20260907090000_email_campaigns.sql",
    version: "20260907090000",
    assertions: [
      { kind: "table", table: "email_campaigns" },
      { kind: "table", table: "email_lists" },
      { kind: "table", table: "email_list_contacts" },
      { kind: "table", table: "email_campaign_recipients" },
      { kind: "table", table: "email_campaign_messages" },
      { kind: "table", table: "email_campaign_quotas" },
      { kind: "table", table: "email_campaign_imports" },
      { kind: "table", table: "email_suppressions" },
      { kind: "table", table: "email_bounce_scans" },
      { kind: "rpc", fn: "email_import_list_into_campaign" },
      { kind: "table", table: "email_campaign_recipient_counts" },
    ],
  },
  {
    migration: "20260907091000_schedule_email_campaign_workers.sql",
    version: "20260907091000",
    assertions: [
      { kind: "cron", jobname: "email-campaign-dispatch-1min" },
      { kind: "cron", jobname: "email-bounce-scan-15min" },
    ],
  },
  {
    migration: "20260907100000_schedule_backend_catchup.sql",
    version: "20260907100000",
    assertions: [{ kind: "cron", jobname: "backend-catchup" }],
  },
  {
    migration: "20260907160000_clone_secret_withheld_status.sql",
    version: "20260907160000",
    assertions: [
      { kind: "check", table: "clone_backend_secrets", column: "status", value: "withheld" },
    ],
  },
  {
    migration: "20260908040000_brokered_usage_is_billable.sql",
    version: "20260908040000",
    assertions: [
      { kind: "check", table: "api_usage_events", column: "billing_reason", value: "brokered" },
    ],
  },
  {
    migration: "20260908040100_per_operation_vendor_rates.sql",
    version: "20260908040100",
    assertions: [
      { kind: "table", table: "api_provider_rate_features" },
      { kind: "rows", table: "api_provider_rate_features", atLeast: 3 },
    ],
  },
  {
    migration: "20260908040300_rerate_brokered_usage_backlog.sql",
    version: "20260908040300",
    assertions: [
      { kind: "none", reason: "re-rates existing rows and creates no object — the effect is" },
      { kind: "none", reason: "a data correction, and every assertion kind here probes for a" },
      { kind: "none", reason: "table, column, cron job or row count that would exist either way" },
    ],
  },
  {
    migration: "20260908110000_absorbed_vendor_cost.sql",
    version: "20260908110000",
    assertions: [
      { kind: "column", table: "api_provider_rates", column: "absorbed" },
      { kind: "check", table: "api_usage_events", column: "billing_reason", value: "absorbed" },
    ],
  },
  {
    migration: "20260908110100_didit_absorbed_and_token_priced.sql",
    version: "20260908110100",
    assertions: [
      { kind: "none", reason: "sets flags and prices on existing catalog rows. `rows:` counts" },
      { kind: "none", reason: "a table, and every table here already holds rows, so it would" },
      { kind: "none", reason: "pass whether or not this ran. The effect is asserted by the" },
      { kind: "none", reason: "verification block at the end, which fails the migration if" },
      { kind: "none", reason: "any of the three edits did not land." },
    ],
  },
  {
    migration: "20260908110200_rerate_absorbed_didit_backlog.sql",
    version: "20260908110200",
    assertions: [
      { kind: "none", reason: "re-rates existing rows and creates no object — the effect is" },
      { kind: "none", reason: "a data correction, and every assertion kind here probes for a" },
      { kind: "none", reason: "thing that exists. It is asserted by the block at the end," },
      { kind: "none", reason: "which fails the migration if any charged absorbed row remains." },
    ],
  },
  {
    migration: "20260908160000_migration_lane_owns_its_own_block.sql",
    version: "20260908160000",
    assertions: [
      { kind: "column", table: "clone_backends", column: "migration_blocked_at" },
      { kind: "column", table: "clone_backends", column: "migration_blocked_reason" },
    ],
  },
  {
    migration: "20260908170000_merge_drain_rotation_cursor.sql",
    version: "20260908170000",
    assertions: [{ kind: "column", table: "clones", column: "merge_drain_at" }],
  },
  {
    migration: "20260909010118_d066006a-bf90-475c-9b7f-0e5fcf9e5019.sql",
    version: "20260909010118",
    assertions: [
      { kind: "column", table: "clone_backends", column: "migration_blocked_at" },
      { kind: "column", table: "clone_backends", column: "migration_blocked_reason" },
      { kind: "column", table: "clones", column: "merge_drain_at" },
    ],
  },
  {
    migration: "20260909072756_0ed86dad-0bfc-4247-ae03-29f2e8b20bcd.sql",
    version: "20260909072756",
    assertions: [{ kind: "table", table: "schema_migration_queue_backup_20260909" }],
  },
  {
    migration: "20260909072847_e58597ac-7a62-42b4-a7a1-8ce07d3a41ac.sql",
    version: "20260909072847",
    assertions: [
      {
        kind: "none",
        reason: "revokes default grants and enables RLS on the backup table; creates no object",
      },
    ],
  },
  {
    migration: "20260909110000_two_clones_become_mirrors.sql",
    version: "20260909110000",
    assertions: [{ kind: "rows", table: "clone_sync_exclusions", atLeast: 30 }],
  },
  {
    migration: "20260911020000_minted_llm_key_status.sql",
    version: "20260911020000",
    assertions: [
      { kind: "check", table: "clone_backend_secrets", column: "status", value: "minted" },
    ],
  },
  {
    migration: "20260911060000_clone_anthropic_identity.sql",
    version: "20260911060000",
    assertions: [
      { kind: "table", table: "clone_anthropic_identity" },
      { kind: "column", table: "clone_anthropic_identity", column: "workspace_id" },
      { kind: "column", table: "clone_anthropic_identity", column: "federation_rule_id" },
    ],
  },
  {
    migration: "20260911070000_federated_anthropic_status.sql",
    version: "20260911070000",
    assertions: [
      { kind: "check", table: "clone_backend_secrets", column: "status", value: "federated" },
    ],
  },
  {
    migration: "20260911080000_anthropic_workspace_delivered_at.sql",
    version: "20260911080000",
    assertions: [{ kind: "column", table: "clone_anthropic_identity", column: "delivered_at" }],
  },
  {
    migration: "20260911090000_clear_presumed_anthropic_delivery.sql",
    version: "20260911090000",
    assertions: [
      {
        kind: "none",
        reason:
          "clears a data stamp; creates no object, and the cleared state is not stably observable",
      },
    ],
  },
  {
    migration: "20260912100000_mirror_exclusion_delta.sql",
    version: "20260912100000",
    assertions: [
      { kind: "rows", table: "clone_sync_exclusions", atLeast: 22 },
      {
        kind: "check",
        table: "clone_sync_exclusions",
        column: "pattern",
        value: "src/lib/turnstileSiteKey.ts",
      },
      {
        kind: "check",
        table: "clone_sync_exclusions",
        column: "pattern",
        value: "src/lib/__tests__/turnstileIdentity.spec.ts",
      },
      {
        kind: "check",
        table: "clone_sync_exclusions",
        column: "pattern",
        value: ".github/workflows/set-builder-stock-pdf-worker-secrets.yml",
      },
      {
        kind: "check",
        table: "clone_sync_exclusions",
        column: "pattern",
        value: ".github/workflows/set-builder-stock-link-secrets.yml",
      },
      {
        kind: "check",
        table: "clone_sync_exclusions",
        column: "pattern",
        value: ".github/workflows/rotate-internal-edge-secret.yml",
      },
    ],
  },
  {
    migration: "20260912150000_recorded_never_replayed.sql",
    version: "20260912150000",
    assertions: [
      { kind: "column", table: "schema_migration_queue", column: "already_applied" },
      { kind: "check", table: "schema_migration_queue", column: "status", value: "recorded" },
    ],
  },
  {
    migration: "20260913090000_a_halt_that_resolves_itself.sql",
    version: "20260913090000",
    assertions: [
      { kind: "rpc", fn: "migration_queue_state" },
      { kind: "column", table: "schema_migration_queue", column: "resolution" },
      { kind: "column", table: "schema_migration_queue", column: "sqlstate" },
    ],
  },
  {
    migration: "20260914120000_reserve_platform_service_slugs.sql",
    version: "20260914120000",
    assertions: [
      {
        kind: "check",
        table: "platform_hosting_config",
        column: "reserved_slugs",
        value: "builders",
      },
    ],
  },
  {
    migration: "20260914130000_builders_network_trust_anchor.sql",
    version: "20260914130000",
    assertions: [{ kind: "table", table: "builders_network_connections_shadow" }],
  },
  {
    migration: "20260916080000_cascade_path_approvals.sql",
    version: "20260916080000",
    assertions: [
      { kind: "table", table: "cascade_path_approvals" },
      { kind: "column", table: "cascade_path_approvals", column: "kind" },
      { kind: "column", table: "cascade_path_approvals", column: "expires_at" },
    ],
  },
  {
    migration: "20260916100000_seed_september_unblock_approvals.sql",
    version: "20260916100000",
    assertions: [{ kind: "rows", table: "cascade_path_approvals", atLeast: 1 }],
  },
  {
    migration: "20260916140000_aurixa_reception_line.sql",
    version: "20260916140000",
    assertions: [{ kind: "rows", table: "voice_phone_numbers", atLeast: 1 }],
  },
  {
    migration: "20260916160000_delivered_sha_on_cascade_results.sql",
    version: "20260916160000",
    assertions: [{ kind: "column", table: "cascade_results", column: "delivered_sha" }],
  },
  {
    migration: "20260916170000_rate_limit_bucket_and_public.sql",
    version: "20260916170000",
    assertions: [
      { kind: "column", table: "token_api_rate_limits", column: "bucket" },
      { kind: "rpc", fn: "check_api_rate_limit" },
      { kind: "table", table: "public_rate_limits" },
      { kind: "rpc", fn: "check_public_rate_limit" },
    ],
  },
  {
    migration: "20260916180000_didit_forward_floor_amended.sql",
    version: "20260916180000",
    assertions: [
      { kind: "rows", table: "prime_secret_forwards", atLeast: 44 },
      { kind: "check", table: "migration_assertion_checks", column: "status", value: "superseded" },
    ],
    supersedes: [
      {
        migration: "20260906100000_didit_fleet_forward.sql",
        assertion: "rows:prime_secret_forwards>=45",
      },
    ],
  },
  {
    migration: "20260916190000_settle_orphaned_cascade_rows.sql",
    version: "20260916190000",
    assertions: [
      {
        kind: "none",
        reason:
          "data repair only — terminalises the orphaned-row backlog and closes historical worker windows; the resulting row counts are not stable claims",
      },
    ],
  },
  {
    migration: "20260916200000_appointment_booked_notification.sql",
    version: "20260916200000",
    assertions: [{ kind: "enum", type: "notification_kind" }],
  },
  {
    migration: "20260916210000_clone_announcements.sql",
    version: "20260916210000",
    assertions: [
      { kind: "table", table: "clone_announcements" },
      { kind: "table", table: "clone_announcement_deliveries" },
      { kind: "column", table: "clone_announcements", column: "audience_plan_slugs" },
      { kind: "column", table: "clone_announcements", column: "revision" },
      { kind: "check", table: "clone_announcements", column: "severity", value: "critical" },
    ],
  },
  {
    migration: "20260918140000_convergence_observations.sql",
    version: "20260918140000",
    assertions: [
      { kind: "table", table: "clone_convergence_observations" },
      { kind: "column", table: "clone_convergence_observations", column: "state" },
      { kind: "column", table: "clone_convergence_observations", column: "owed_fingerprint" },
      { kind: "column", table: "clone_convergence_observations", column: "last_converged_at" },
      { kind: "column", table: "prime_config", column: "convergence_slo_minutes" },
    ],
  },
  {
    migration: "20260918160000_clone_sync_blockages.sql",
    version: "20260918160000",
    assertions: [
      { kind: "table", table: "clone_sync_blockages" },
      { kind: "column", table: "clone_sync_blockages", column: "class" },
      { kind: "column", table: "clone_sync_blockages", column: "owner" },
      { kind: "column", table: "clone_sync_blockages", column: "self_heals" },
      { kind: "column", table: "clone_sync_blockages", column: "cleared_at" },
    ],
  },
  {
    migration: "20260918180000_clone_custodial_acts.sql",
    version: "20260918180000",
    assertions: [
      { kind: "table", table: "clone_custodial_acts" },
      { kind: "column", table: "clone_custodial_acts", column: "act" },
      { kind: "column", table: "clone_custodial_acts", column: "outcome" },
      { kind: "column", table: "clone_custodial_acts", column: "reversal" },
    ],
  },
  {
    migration: "20260918200000_clone_health_history.sql",
    version: "20260918200000",
    assertions: [
      { kind: "table", table: "clone_health_history" },
      { kind: "column", table: "clone_health_history", column: "status" },
      { kind: "column", table: "clone_health_history", column: "probed_at" },
      { kind: "table", table: "clone_health_daily" },
    ],
  },
  {
    migration: "20260919060000_github_installation_metered.sql",
    version: "20260919060000",
    assertions: [{ kind: "rows", table: "api_provider_rates", atLeast: 30 }],
  },
  {
    migration: "20260919061500_clone_backend_schema_verified_at.sql",
    version: "20260919061500",
    assertions: [{ kind: "column", table: "clone_backends", column: "schema_verified_at" }],
  },
  {
    migration: "20260919110000_clone_backend_chunk_cursor.sql",
    version: "20260919110000",
    assertions: [{ kind: "column", table: "clone_backends", column: "chunk_cursor" }],
  },
  {
    migration: "20260919113000_reference_sync_cadence.sql",
    version: "20260919113000",
    assertions: [{ kind: "cron", jobname: "reference-data-sync-15min" }],
  },
  {
    migration: "20260919124500_reference_sync_notified_detail.sql",
    version: "20260919124500",
    assertions: [{ kind: "column", table: "clone_reference_syncs", column: "notified_detail" }],
  },
];
