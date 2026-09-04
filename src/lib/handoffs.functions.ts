// E1 — Handoff state machine + event log.
// E2, E4, E5, E7, E8 record scaffolding lives here as thin CRUD; the actual
// compute (parity diff, snapshot capture, secret rotation execution, cost
// export generation) is wired in round 2 alongside gap resolution.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import type { Json, TablesUpdate } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";

/** jsonb columns come back as `Json`; spreading needs a real object. */
function metaRecord(value: unknown): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, Json>) }
    : {};
}

const STATE_ORDER = [
  "draft",
  "dry_run_ready",
  "awaiting_client_consent",
  "snapshot_pending",
  "snapshot_ready",
  "twin_provisioning",
  "twin_ready",
  "data_syncing",
  "cutover_scheduled",
  "cutover_in_progress",
  "complete",
] as const;
const TERMINAL_STATES = new Set(["complete", "rolled_back", "failed", "canceled"]);
const ALL_STATES = [...STATE_ORDER, "rolled_back", "failed", "canceled"] as const;

const createSchema = z.object({
  clone_id: z.string().uuid(),
  backend_id: z.string().uuid().nullable().optional(),
  client_account_id: z.string().uuid().nullable().optional(),
  policy_id: z.string().uuid().nullable().optional(),
  path: z.enum(["rebuild_twin", "enterprise_transfer"]).default("rebuild_twin"),
  target_region: z.string().nullable().optional(),
  target_plan_tier: z.string().nullable().optional(),
  metadata: z.record(z.any()).optional(),
});

export const listHandoffs = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("clone_handoffs")
      .select("*, clones(id, name, slug)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });

export const getHandoff = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const [handoff, events, snapshots, parity, rotations, contracts, exports_, storageReps] =
      await Promise.all([
        context.supabase
          .from("clone_handoffs")
          // github_owner/github_repo are read by the handoff detail page's GitHub App
          // card; without them here it rendered "the clone/repo" every time.
          .select(
            "*, clones(id, name, slug, github_owner, github_repo), client_supabase_accounts(id, owner_email, org_slug)",
          )
          .eq("id", data.id)
          .maybeSingle(),
        context.supabase
          .from("handoff_events")
          .select("*")
          .eq("handoff_id", data.id)
          .order("created_at", { ascending: false })
          .limit(200),
        context.supabase
          .from("handoff_snapshots")
          .select("*")
          .eq("handoff_id", data.id)
          .order("created_at", { ascending: false }),
        context.supabase
          .from("handoff_parity_reports")
          .select("*")
          .eq("handoff_id", data.id)
          .order("generated_at", { ascending: false })
          .limit(10),
        context.supabase
          .from("handoff_secret_rotations")
          .select("*")
          .eq("handoff_id", data.id)
          .order("created_at", { ascending: false }),
        context.supabase
          .from("handoff_contracts")
          .select("*")
          .eq("handoff_id", data.id)
          .order("created_at", { ascending: false }),
        context.supabase
          .from("handoff_cost_exports")
          .select("*")
          .eq("handoff_id", data.id)
          .order("generated_at", { ascending: false }),
        context.supabase
          .from("handoff_storage_replications")
          .select("*")
          .eq("handoff_id", data.id)
          .order("bucket_id", { ascending: true }),
      ]);
    if (handoff.error) throw handoff.error;
    return {
      handoff: handoff.data,
      events: events.data ?? [],
      snapshots: snapshots.data ?? [],
      parity_reports: parity.data ?? [],
      rotations: rotations.data ?? [],
      contracts: contracts.data ?? [],
      cost_exports: exports_.data ?? [],
      storage_replications: storageReps.data ?? [],
    };
  });

export const createHandoff = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => createSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("clone_handoffs")
      .insert({
        clone_id: data.clone_id,
        backend_id: data.backend_id ?? null,
        client_account_id: data.client_account_id ?? null,
        policy_id: data.policy_id ?? null,
        path: data.path,
        state: "draft",
        target_region: data.target_region ?? null,
        target_plan_tier: data.target_plan_tier ?? null,
        metadata: data.metadata ?? {},
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    await context.supabase.from("handoff_events").insert({
      handoff_id: row.id,
      kind: "handoff.created",
      actor_user_id: context.userId,
      details: { path: data.path },
    });
    return { ok: true as const, id: row.id };
  });

export const transitionHandoff = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        to_state: z.enum(ALL_STATES),
        note: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: current, error: readErr } = await context.supabase
      .from("clone_handoffs")
      .select("state")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!current) return { ok: false as const, error: "not_found" };
    if (TERMINAL_STATES.has(current.state) && current.state !== data.to_state) {
      return { ok: false as const, error: "terminal_state" };
    }
    // G14 — block `complete` until every queued rotation is rotated/skipped.
    if (data.to_state === "complete") {
      const { data: outstanding } = await context.supabase
        .from("handoff_secret_rotations")
        .select("id, target, key_ref, status")
        .eq("handoff_id", data.id)
        .not("status", "in", "(rotated,skipped)");
      if (outstanding && outstanding.length > 0) {
        return {
          ok: false as const,
          error: "rotations_incomplete",
          outstanding,
        };
      }
    }
    // G19 — block `dry_run_ready` unless a recent parity report has no
    // blocking issues. This is the last line of defence in case the parity
    // engine hasn't been re-run since the target project drifted.
    if (data.to_state === "dry_run_ready") {
      // The column is `generated_at`; `computed_at` does not exist on this
      // table. PostgREST answered 42703, the error was discarded, `parity` came
      // back null — so this gate reported `parity_missing` for every handoff,
      // including ones whose parity report had just been written.
      const { data: parity, error: parityErr } = await context.supabase
        .from("handoff_parity_reports")
        .select("id, blocking_issues, generated_at, risk_level")
        .eq("handoff_id", data.id)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      // A read that FAILED is not a report that is ABSENT: the first is worth
      // retrying, the second is a real blocker on the transition.
      if (parityErr) {
        return { ok: false as const, error: "parity_read_failed", detail: parityErr.message };
      }
      if (!parity) {
        return { ok: false as const, error: "parity_missing" };
      }
      const ageMs = Date.now() - new Date(parity.generated_at).getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        return {
          ok: false as const,
          error: "parity_stale",
          parity_id: parity.id,
          computed_at: parity.generated_at,
        };
      }
      const blocking = (parity.blocking_issues as any[]) ?? [];
      if (blocking.length > 0) {
        return {
          ok: false as const,
          error: "parity_blocking",
          parity_id: parity.id,
          blocking_count: blocking.length,
          risk_level: parity.risk_level,
        };
      }
    }

    const patch: TablesUpdate<"clone_handoffs"> = { state: data.to_state };

    if (data.to_state === "twin_provisioning" || data.to_state === "snapshot_pending") {
      patch.initiated_at = new Date().toISOString();
    }
    if (
      data.to_state === "complete" ||
      data.to_state === "rolled_back" ||
      data.to_state === "failed" ||
      data.to_state === "canceled"
    ) {
      patch.completed_at = new Date().toISOString();
    }
    if (data.error) patch.error = data.error;
    const { error: updErr } = await context.supabase
      .from("clone_handoffs")
      .update(patch)
      .eq("id", data.id);
    if (updErr) throw updErr;
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.id,
      kind: "handoff.transitioned",
      actor_user_id: context.userId,
      details: {
        from: current.state,
        to: data.to_state,
        note: data.note ?? null,
        error: data.error ?? null,
      },
    });
    return { ok: true as const, from: current.state, to: data.to_state };
  });

export const logHandoffEvent = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        kind: z.string().min(1),
        details: z.record(z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: data.kind,
      actor_user_id: context.userId,
      details: data.details ?? {},
    });
    if (error) throw error;
    return { ok: true as const };
  });

// E4 — record a snapshot intent (physical capture is round 2).
export const recordHandoffSnapshot = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        kind: z.enum(["pitr_pin", "pg_dump", "storage_export", "auth_export"]),
        storage_path: z.string().nullable().optional(),
        retention_days: z.number().int().positive().max(365).default(30),
        metadata: z.record(z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const expires = new Date(Date.now() + data.retention_days * 86_400_000).toISOString();
    const { data: row, error } = await context.supabase
      .from("handoff_snapshots")
      .insert({
        handoff_id: data.handoff_id,
        kind: data.kind,
        storage_path: data.storage_path ?? null,
        retention_expires_at: expires,
        status: "pending",
        metadata: data.metadata ?? {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true as const, id: row.id };
  });

// E5 — enqueue a secret rotation row (executor lives in round 2).
export const recordSecretRotation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        target: z.enum([
          "clone_repo",
          "cloudflare",
          "stripe_endpoint",
          "github_webhook",
          "webhook_consumer",
          "edge_function_env",
          "other",
        ]),
        key_ref: z.string().min(1),
        metadata: z.record(z.any()).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_secret_rotations")
      .insert({
        handoff_id: data.handoff_id,
        target: data.target,
        key_ref: data.key_ref,
        status: "pending",
        metadata: data.metadata ?? {},
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true as const, id: row.id };
  });

// E7 — record a signed DPA/contract. PDF generation + storage upload are
// round-2 work; here we accept an already-hashed terms body.
export const recordHandoffContract = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        version: z.string().min(1),
        terms_hash: z.string().min(1),
        signed_by_name: z.string().min(1),
        signed_by_email: z.string().email(),
        signed_at: z.string().datetime().optional(),
        ip_address: z.string().nullable().optional(),
        user_agent: z.string().nullable().optional(),
        pdf_storage_path: z.string().nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_contracts")
      .insert({
        handoff_id: data.handoff_id,
        version: data.version,
        terms_hash: data.terms_hash,
        signed_by_name: data.signed_by_name,
        signed_by_email: data.signed_by_email,
        signed_at: data.signed_at ?? new Date().toISOString(),
        ip_address: data.ip_address ?? null,
        user_agent: data.user_agent ?? null,
        pdf_storage_path: data.pdf_storage_path ?? null,
      })
      .select("id")
      .single();
    if (error) throw error;
    await context.supabase
      .from("clone_handoffs")
      .update({
        consent_signed_at: new Date().toISOString(),
        consent_terms_version: data.version,
      })
      .eq("id", data.handoff_id);
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.consent_signed",
      actor_user_id: context.userId,
      details: { version: data.version, signer: data.signed_by_email },
    });
    return { ok: true as const, id: row.id };
  });

// E8 — request a usage-history export for the client. Actual CSV generation
// runs asynchronously in round 2; this row is the promise + audit surface.
export const requestCostExport = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        handoff_id: z.string().uuid(),
        period_start: z.string().datetime(),
        period_end: z.string().datetime(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_cost_exports")
      .insert({
        handoff_id: data.handoff_id,
        period_start: data.period_start,
        period_end: data.period_end,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw error;
    return { ok: true as const, id: row.id };
  });

// G22 — Fulfill a pending cost-export row: aggregate report_jobs + ledger +
// seat entitlements for the period, upload a CSV to handoff-contracts, and
// flip the row to `ready` with totals.
export const fulfillCostExportFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ export_id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { fulfillCostExport } = await import("@/server/handoff-cost-exports.server");
    return fulfillCostExport(data.export_id);
  });

// G22 — Sign a short-lived download URL for a ready cost export.
export const signCostExportUrl = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        export_id: z.string().uuid(),
        expires_in: z.number().int().min(60).max(3600).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { signCostExportDownload } = await import("@/server/handoff-cost-exports.server");
    return signCostExportDownload(data.export_id, data.expires_in ?? 600);
  });

// G1 — Compute a schema/policies/functions/extensions parity report between
// prime backend and the clone's target backend. On success writes a row to
// handoff_parity_reports; when no blocking issues are found, auto-advances
// the handoff to `dry_run_ready`.
export const runParityDryRun = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: handoff, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, state, clone_id, backend_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!handoff) return { ok: false as const, error: "not_found" };

    // Resolve target project ref via clone_backends.
    const backendBase = context.supabase
      .from("clone_backends")
      .select("supabase_project_ref, status");
    const { data: backend, error: bErr } = handoff.backend_id
      ? await backendBase.eq("id", handoff.backend_id).limit(1).maybeSingle()
      : await backendBase
          .eq("clone_id", handoff.clone_id)
          .not("supabase_project_ref", "is", null)
          .not("status", "in", "(failed,deleted,destroyed)")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
    if (bErr) throw bErr;
    if (!backend?.supabase_project_ref) {
      return { ok: false as const, error: "no_target_backend" };
    }

    // Compute parity (server-only module — imported inside the handler so it
    // never leaks into the client bundle).
    const { computeParity } = await import("@/server/handoff-parity.server");
    const { resolvePrimeBackendRef, resolvePrimeSource, fetchDeclaredEdgeFunctionSlugs } =
      await import("@/server/prime-backend.server");
    const primeRef = await resolvePrimeBackendRef(context.supabase);
    // A handoff leaves draft only on an empty `blocking_issues`, so this is
    // the caller that most needs to tell a shortfall from the prime's own
    // dead deployments. Null when it cannot be established — never partial.
    const declaredEdgeFunctions = await (async () => {
      try {
        const { getAppOctokit } = await import("@/server/github-app.server");
        const source = await resolvePrimeSource(context.supabase);
        if (!source) return null;
        return await fetchDeclaredEdgeFunctionSlugs(getAppOctokit(), source);
      } catch {
        return null;
      }
    })();
    const parity = await computeParity(primeRef, backend.supabase_project_ref, {
      declaredEdgeFunctions,
    });

    const { data: row, error: insErr } = await context.supabase
      .from("handoff_parity_reports")
      .insert({
        handoff_id: data.handoff_id,
        prime_ref: parity.prime_ref,
        target_ref: parity.target_ref,
        risk_level: parity.risk_level,
        tables_diff: asJson(parity.tables_diff),
        policies_diff: asJson(parity.policies_diff),
        functions_diff: asJson(parity.functions_diff),
        buckets_diff: asJson(parity.buckets_diff),
        cron_diff: asJson(parity.cron_diff),
        edge_functions_diff: asJson(parity.edge_functions_diff),
        secrets_diff: asJson(parity.secrets_diff),
        auth_diff: asJson(parity.auth_config_diff),
        extensions_diff: asJson(parity.extensions_diff),
        blocking_issues: asJson(parity.blocking_issues),
        summary: parity.summary,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.parity_computed",
      actor_user_id: context.userId,
      details: {
        parity_id: row.id,
        risk_level: parity.risk_level,
        blocking_count: parity.blocking_issues.length,
        summary: parity.summary,
      },
    });

    // Auto-advance draft → dry_run_ready when clean.
    let advanced = false;
    if (handoff.state === "draft" && parity.blocking_issues.length === 0) {
      const { error: updErr } = await context.supabase
        .from("clone_handoffs")
        .update({ state: "dry_run_ready" })
        .eq("id", data.handoff_id);
      if (!updErr) {
        advanced = true;
        await context.supabase.from("handoff_events").insert({
          handoff_id: data.handoff_id,
          kind: "handoff.transitioned",
          actor_user_id: context.userId,
          details: { from: "draft", to: "dry_run_ready", note: "auto: parity clean" },
        });
      }
    }

    return {
      ok: true as const,
      parity_id: row.id,
      risk_level: parity.risk_level,
      blocking_issues: parity.blocking_issues,
      advanced,
    };
  });

export const HANDOFF_STATE_ORDER = STATE_ORDER;

// ---------------------------------------------------------------------------
// G14 — Secret rotation cutover executor.
// ---------------------------------------------------------------------------

// Enqueue the default rotation plan for a handoff. Idempotent: rows are keyed
// by (handoff_id, target, key_ref).
export const planStandardRotations = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { DEFAULT_ROTATION_PLAN } = await import("@/server/handoff-rotations.server");
    const { data: existing } = await context.supabase
      .from("handoff_secret_rotations")
      .select("target, key_ref")
      .eq("handoff_id", data.handoff_id);
    const seen = new Set((existing ?? []).map((r: any) => `${r.target}::${r.key_ref}`));
    const rows = DEFAULT_ROTATION_PLAN.filter((p) => !seen.has(`${p.target}::${p.key_ref}`)).map(
      (p) => ({
        handoff_id: data.handoff_id,
        target: p.target,
        key_ref: p.key_ref,
        status: "pending" as const,
        metadata: { hint: p.hint },
      }),
    );
    if (rows.length === 0) {
      return { ok: true as const, inserted: 0, skipped: DEFAULT_ROTATION_PLAN.length };
    }
    const { error } = await context.supabase.from("handoff_secret_rotations").insert(rows);
    if (error) throw error;
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.rotations_planned",
      actor_user_id: context.userId,
      details: { inserted: rows.length },
    });
    return { ok: true as const, inserted: rows.length };
  });

// Execute a queued rotation. Advances pending → in_progress → rotated/failed.
export const executeSecretRotation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error: rErr } = await context.supabase
      .from("handoff_secret_rotations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!row) return { ok: false as const, error: "not_found" };
    if (row.status === "rotated" || row.status === "skipped") {
      return { ok: true as const, idempotent: true, status: row.status };
    }
    await context.supabase
      .from("handoff_secret_rotations")
      .update({ status: "in_progress" })
      .eq("id", data.id);

    const { executeRotation } = await import("@/server/handoff-rotations.server");
    const outcome = await executeRotation(row);

    const patch: TablesUpdate<"handoff_secret_rotations"> = {
      status: outcome.status,
      metadata: asJson({
        ...metaRecord(row.metadata),
        last_execution: {
          at: new Date().toISOString(),
          actor: context.userId,
          ...outcome.audit,
        },
        // Scrub the raw secret_value once the API call succeeded — never let
        // a plaintext secret loiter in the audit row.
        ...(outcome.status === "rotated" && metaRecord(row.metadata).secret_value
          ? { secret_value: undefined }
          : {}),
      }),
      error: outcome.error ?? null,
    };
    if (outcome.status === "rotated") patch.rotated_at = new Date().toISOString();
    // If secret_value was scrubbed, delete key explicitly.
    if (outcome.status === "rotated" && metaRecord(row.metadata).secret_value) {
      const cleaned = metaRecord(row.metadata);
      delete cleaned.secret_value;
      cleaned.last_execution = metaRecord(patch.metadata).last_execution ?? null;
      patch.metadata = asJson(cleaned);
    }
    const { error: uErr } = await context.supabase
      .from("handoff_secret_rotations")
      .update(patch)
      .eq("id", data.id);
    if (uErr) throw uErr;
    await context.supabase.from("handoff_events").insert({
      handoff_id: row.handoff_id,
      kind: `handoff.rotation_${outcome.status}`,
      actor_user_id: context.userId,
      details: {
        rotation_id: data.id,
        target: row.target,
        key_ref: row.key_ref,
        error: outcome.error ?? null,
      },
    });
    return { ok: true as const, status: outcome.status, error: outcome.error ?? null };
  });

// Manual override — used when the physical rotate happened out-of-band.
export const markSecretRotation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        status: z.enum(["rotated", "skipped", "failed"]),
        evidence: z.string().min(1).max(2000).optional(),
        error: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("handoff_secret_rotations")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return { ok: false as const, error: "not_found" };
    const patch: TablesUpdate<"handoff_secret_rotations"> = {
      status: data.status,
      error: data.error ?? null,
      metadata: asJson({
        ...metaRecord(row.metadata),
        manual_ack: {
          at: new Date().toISOString(),
          actor: context.userId,
          evidence: data.evidence ?? null,
          status: data.status,
        },
      }),
    };
    if (data.status === "rotated" || data.status === "skipped") {
      patch.rotated_at = new Date().toISOString();
    }
    const { error: uErr } = await context.supabase
      .from("handoff_secret_rotations")
      .update(patch)
      .eq("id", data.id);
    if (uErr) throw uErr;
    await context.supabase.from("handoff_events").insert({
      handoff_id: row.handoff_id,
      kind: `handoff.rotation_marked_${data.status}`,
      actor_user_id: context.userId,
      details: {
        rotation_id: data.id,
        target: row.target,
        key_ref: row.key_ref,
        evidence: data.evidence ?? null,
      },
    });
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// G15 — Cutover orchestrator.
//
// Walks queued rotations in canonical order, executes each via
// `executeRotation`, and drives the handoff state machine:
//   twin_ready | data_syncing | cutover_scheduled → cutover_in_progress
//   all rotations rotated/skipped                 → complete
//   any rotation failed                           → rolled_back (if
//                                                   rollback_snapshot_id set)
//                                                   otherwise failed
// Bookkeeping targets that come back `in_progress` (awaiting operator
// evidence) are treated as soft-stops: the orchestrator halts without
// failing so the operator can supply evidence and re-run.
// ---------------------------------------------------------------------------

const ROTATION_PRIORITY: Record<string, number> = {
  stripe_endpoint: 10,
  github_webhook: 20,
  cloudflare: 30,
  clone_repo: 40,
  edge_function_env: 50,
  webhook_consumer: 60,
  other: 70,
};

export const runCutoverOrchestrator = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: handoff, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, state, rollback_snapshot_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!handoff) return { ok: false as const, error: "not_found" };

    const CUTOVER_ENTRY = new Set([
      "twin_ready",
      "data_syncing",
      "cutover_scheduled",
      "cutover_in_progress",
    ]);
    if (!CUTOVER_ENTRY.has(handoff.state)) {
      return { ok: false as const, error: "wrong_state", state: handoff.state };
    }

    // Enter cutover_in_progress.
    if (handoff.state !== "cutover_in_progress") {
      await context.supabase
        .from("clone_handoffs")
        .update({ state: "cutover_in_progress", initiated_at: new Date().toISOString() })
        .eq("id", data.handoff_id);
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: "handoff.cutover_started",
        actor_user_id: context.userId,
        details: { from: handoff.state },
      });
    }

    const { data: rows, error: rErr } = await context.supabase
      .from("handoff_secret_rotations")
      .select("*")
      .eq("handoff_id", data.handoff_id);
    if (rErr) throw rErr;
    const all = rows ?? [];
    if (all.length === 0) {
      return { ok: false as const, error: "no_rotations_planned" };
    }

    const pending = all
      .filter((r: any) => r.status !== "rotated" && r.status !== "skipped")
      .sort(
        (a: any, b: any) =>
          (ROTATION_PRIORITY[a.target] ?? 99) - (ROTATION_PRIORITY[b.target] ?? 99),
      );

    const { executeRotation } = await import("@/server/handoff-rotations.server");
    const results: Array<{
      id: string;
      target: string;
      key_ref: string;
      status: string;
      error?: string | null;
    }> = [];

    for (const row of pending) {
      await context.supabase
        .from("handoff_secret_rotations")
        .update({ status: "in_progress" })
        .eq("id", row.id);
      const outcome = await executeRotation(row);
      const patch: TablesUpdate<"handoff_secret_rotations"> = {
        status: outcome.status,
        error: outcome.error ?? null,
        metadata: asJson({
          ...metaRecord(row.metadata),
          last_execution: {
            at: new Date().toISOString(),
            actor: context.userId,
            via: "orchestrator",
            ...outcome.audit,
          },
        }),
      };
      if (outcome.status === "rotated") {
        patch.rotated_at = new Date().toISOString();
        if (metaRecord(row.metadata).secret_value) {
          const cleaned = metaRecord(row.metadata);
          delete cleaned.secret_value;
          cleaned.last_execution = metaRecord(patch.metadata).last_execution ?? null;
          patch.metadata = asJson(cleaned);
        }
      }
      await context.supabase.from("handoff_secret_rotations").update(patch).eq("id", row.id);
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: `handoff.rotation_${outcome.status}`,
        actor_user_id: context.userId,
        details: {
          rotation_id: row.id,
          target: row.target,
          key_ref: row.key_ref,
          via: "orchestrator",
          error: outcome.error ?? null,
        },
      });
      results.push({
        id: row.id,
        target: row.target,
        key_ref: row.key_ref,
        status: outcome.status,
        error: outcome.error ?? null,
      });

      if (outcome.status === "failed") {
        const nextState = handoff.rollback_snapshot_id ? "rolled_back" : "failed";
        await context.supabase
          .from("clone_handoffs")
          .update({
            state: nextState,
            error: `rotation_failed:${row.target}:${row.key_ref}`,
            completed_at: new Date().toISOString(),
          })
          .eq("id", data.handoff_id);
        await context.supabase.from("handoff_events").insert({
          handoff_id: data.handoff_id,
          kind: "handoff.cutover_aborted",
          actor_user_id: context.userId,
          details: {
            reason: "rotation_failed",
            target: row.target,
            key_ref: row.key_ref,
            transitioned_to: nextState,
            rollback_snapshot_id: handoff.rollback_snapshot_id ?? null,
          },
        });
        return {
          ok: false as const,
          error: "rotation_failed",
          transitioned_to: nextState,
          results,
        };
      }
      if (outcome.status === "in_progress") {
        // Awaiting external evidence — stop orchestrator without failing.
        return {
          ok: true as const,
          halted: "awaiting_evidence" as const,
          rotation_id: row.id,
          target: row.target,
          key_ref: row.key_ref,
          results,
        };
      }
    }

    // Re-check: are ALL rotations now terminal?
    const { data: after } = await context.supabase
      .from("handoff_secret_rotations")
      .select("id, status")
      .eq("handoff_id", data.handoff_id);
    const outstanding = (after ?? []).filter(
      (r: any) => r.status !== "rotated" && r.status !== "skipped",
    );
    if (outstanding.length > 0) {
      return { ok: true as const, halted: "outstanding" as const, outstanding, results };
    }

    await context.supabase
      .from("clone_handoffs")
      .update({ state: "complete", completed_at: new Date().toISOString() })
      .eq("id", data.handoff_id);
    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.cutover_completed",
      actor_user_id: context.userId,
      details: { rotations: results.length },
    });
    return { ok: true as const, complete: true, results };
  });

// ---------------------------------------------------------------------------
// G16 — Auth users replication (twin_ready / data_syncing).
//
// Copies `auth.users` (id, email, phone, bcrypt password hash, confirmation
// timestamps, user/app metadata) from the clone's current dedicated
// Supabase project into the client-owned twin. Runs server-side; the
// heavy lifting lives in `@/server/handoff-auth-replication.server`.
//
// Idempotent by user id — repeated runs skip users that already exist on
// the target. Emits `handoff.auth_replicated` on success and
// `handoff.auth_replication_failed` when any row could not be imported.
// ---------------------------------------------------------------------------

export const replicateHandoffAuthUsers = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: handoff, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, state, clone_id, backend_id, client_account_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!handoff) return { ok: false as const, error: "not_found" };

    const ENTRY = new Set(["twin_ready", "data_syncing", "cutover_scheduled"]);
    if (!ENTRY.has(handoff.state)) {
      return { ok: false as const, error: "wrong_state", state: handoff.state };
    }
    if (!handoff.client_account_id) {
      return { ok: false as const, error: "no_client_account" };
    }

    // Resolve source project ref — the clone's currently-owned dedicated backend.
    const sourceBase = context.supabase
      .from("clone_backends")
      .select("supabase_project_ref, status");
    const { data: source, error: sErr } = handoff.backend_id
      ? await sourceBase.eq("id", handoff.backend_id).limit(1).maybeSingle()
      : await sourceBase
          .eq("clone_id", handoff.clone_id)
          .not("supabase_project_ref", "is", null)
          .not("status", "in", "(failed,deleted,destroyed)")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
    if (sErr) throw sErr;
    if (!source?.supabase_project_ref) {
      return { ok: false as const, error: "no_source_backend" };
    }

    // Resolve target project ref — most recent parity report pins it, else
    // fall back to `clone_handoffs.metadata.target_project_ref`.
    const { data: parity } = await context.supabase
      .from("handoff_parity_reports")
      .select("target_ref")
      .eq("handoff_id", data.handoff_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: handoffMeta } = await context.supabase
      .from("clone_handoffs")
      .select("metadata")
      .eq("id", data.handoff_id)
      .maybeSingle();
    const targetRef =
      parity?.target_ref ?? (handoffMeta?.metadata as any)?.target_project_ref ?? null;
    if (!targetRef) {
      return { ok: false as const, error: "no_target_ref_pinned" };
    }

    // Decrypt client PAT.
    const { data: acct, error: aErr } = await context.supabase
      .from("client_supabase_accounts")
      // `status` has never been a column here — the revocation flag is
      // `revoked_at`. PostgREST answers 42703 to the whole select, and `aErr`
      // is thrown two lines down, so this path could never reach the decrypt.
      .select("id, pat_ciphertext, revoked_at")
      .eq("id", handoff.client_account_id)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!acct?.pat_ciphertext) return { ok: false as const, error: "no_client_pat" };
    if (acct.revoked_at) return { ok: false as const, error: "client_pat_revoked" };
    const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
    const targetPat = decryptSecret(decodeBytea(acct.pat_ciphertext));

    const { replicateAuthUsers } = await import("@/server/handoff-auth-replication.server");

    let outcome;
    try {
      outcome = await replicateAuthUsers({
        sourceRef: source.supabase_project_ref,
        targetRef,
        targetPat,
      });
    } catch (e: any) {
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: "handoff.auth_replication_failed",
        actor_user_id: context.userId,
        details: { error: String(e?.message ?? e) },
      });
      return { ok: false as const, error: "replication_crashed", detail: String(e?.message ?? e) };
    }

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: outcome.ok ? "handoff.auth_replicated" : "handoff.auth_replication_partial",
      actor_user_id: context.userId,
      details: {
        source_ref: source.supabase_project_ref,
        target_ref: targetRef,
        scanned: outcome.scanned,
        imported: outcome.imported,
        skipped: outcome.skipped,
        failed: outcome.failed,
        truncated: outcome.truncated,
        error_samples: outcome.errors.slice(0, 5),
      },
    });

    // Advance twin_ready → data_syncing when at least one user landed and
    // nothing failed. Operators handle partial runs manually.
    let advanced = false;
    if (
      handoff.state === "twin_ready" &&
      outcome.ok &&
      (outcome.imported > 0 || outcome.skipped > 0)
    ) {
      const { error: updErr } = await context.supabase
        .from("clone_handoffs")
        .update({ state: "data_syncing" })
        .eq("id", data.handoff_id);
      if (!updErr) {
        advanced = true;
        await context.supabase.from("handoff_events").insert({
          handoff_id: data.handoff_id,
          kind: "handoff.transitioned",
          actor_user_id: context.userId,
          details: {
            from: "twin_ready",
            to: "data_syncing",
            note: "auto: auth users replicated",
          },
        });
      }
    }

    return {
      ok: outcome.ok,
      advanced,
      source_ref: source.supabase_project_ref,
      target_ref: targetRef,
      scanned: outcome.scanned,
      imported: outcome.imported,
      skipped: outcome.skipped,
      failed: outcome.failed,
      truncated: outcome.truncated,
      errors: outcome.errors,
    };
  });

// ---------------------------------------------------------------------------
// G17 — Storage objects replication (data_syncing).
//
// Bulk-copies every object in every storage bucket from the clone's
// current backend to the client-owned twin. Idempotent (skips objects
// already on target), resumable (per-bucket cursor persisted in
// `handoff_storage_replications`), and paced by a per-invocation budget
// so a single Worker request never runs too long. Operators re-invoke
// until every bucket reports `complete`.
// ---------------------------------------------------------------------------

export const replicateHandoffStorageObjects = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: handoff, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, state, clone_id, backend_id, client_account_id, metadata")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!handoff) return { ok: false as const, error: "not_found" };

    const ENTRY = new Set(["twin_ready", "data_syncing", "cutover_scheduled"]);
    if (!ENTRY.has(handoff.state)) {
      return { ok: false as const, error: "wrong_state", state: handoff.state };
    }
    if (!handoff.client_account_id) {
      return { ok: false as const, error: "no_client_account" };
    }

    // Resolve source project ref — the clone's currently-owned dedicated backend.
    const sourceBase = context.supabase
      .from("clone_backends")
      .select("supabase_project_ref, status");
    const { data: source, error: sErr } = handoff.backend_id
      ? await sourceBase.eq("id", handoff.backend_id).limit(1).maybeSingle()
      : await sourceBase
          .eq("clone_id", handoff.clone_id)
          .not("supabase_project_ref", "is", null)
          .not("status", "in", "(failed,deleted,destroyed)")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
    if (sErr) throw sErr;
    if (!source?.supabase_project_ref) {
      return { ok: false as const, error: "no_source_backend" };
    }

    // Resolve target project ref (parity report → handoff metadata).
    const { data: parity } = await context.supabase
      .from("handoff_parity_reports")
      .select("target_ref")
      .eq("handoff_id", data.handoff_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const targetRef = parity?.target_ref ?? (handoff.metadata as any)?.target_project_ref ?? null;
    if (!targetRef) {
      return { ok: false as const, error: "no_target_ref_pinned" };
    }

    // Decrypt client PAT.
    const { data: acct, error: aErr } = await context.supabase
      .from("client_supabase_accounts")
      // `status` has never been a column here — the revocation flag is
      // `revoked_at`. PostgREST answers 42703 to the whole select, and `aErr`
      // is thrown two lines down, so this path could never reach the decrypt.
      .select("id, pat_ciphertext, revoked_at")
      .eq("id", handoff.client_account_id)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!acct?.pat_ciphertext) return { ok: false as const, error: "no_client_pat" };
    if (acct.revoked_at) return { ok: false as const, error: "client_pat_revoked" };
    const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
    const targetPat = decryptSecret(decodeBytea(acct.pat_ciphertext));

    // Load prior per-bucket replication state so we can resume.
    const { data: priorStates } = await context.supabase
      .from("handoff_storage_replications")
      .select("bucket_id, status, cursor_prefix")
      .eq("handoff_id", data.handoff_id);

    const { replicateStorageObjects } = await import("@/server/handoff-storage-replication.server");

    let outcome;
    try {
      outcome = await replicateStorageObjects({
        sourceRef: source.supabase_project_ref,
        targetRef,
        targetPat,
        bucketStates: (priorStates ?? []).map((s) => ({
          bucket_id: s.bucket_id,
          status: s.status ?? "pending",
          cursor_prefix: s.cursor_prefix ?? null,
        })),
      });
    } catch (e: any) {
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: "handoff.storage_replication_failed",
        actor_user_id: context.userId,
        details: { error: String(e?.message ?? e) },
      });
      return { ok: false as const, error: "replication_crashed", detail: String(e?.message ?? e) };
    }

    // Upsert per-bucket ledger rows. Preserve counters by adding to prior
    // totals so re-runs accumulate scanned/copied numbers correctly.
    const priorByBucket = new Map((priorStates ?? []).map((s: any) => [s.bucket_id, s]));
    // Refetch counters we don't already have to avoid clobbering totals.
    const { data: priorCounts } = await context.supabase
      .from("handoff_storage_replications")
      .select(
        "bucket_id, objects_scanned, objects_copied, objects_skipped, objects_failed, bytes_copied",
      )
      .eq("handoff_id", data.handoff_id);
    const countsByBucket = new Map((priorCounts ?? []).map((c: any) => [c.bucket_id, c]));

    for (const b of outcome.buckets) {
      const prev = countsByBucket.get(b.bucket_id) ?? {
        objects_scanned: 0,
        objects_copied: 0,
        objects_skipped: 0,
        objects_failed: 0,
        bytes_copied: 0,
      };
      const row = {
        handoff_id: data.handoff_id,
        bucket_id: b.bucket_id,
        status: b.status,
        cursor_prefix: b.cursor_prefix,
        objects_scanned: (prev.objects_scanned ?? 0) + b.objects_scanned,
        objects_copied: (prev.objects_copied ?? 0) + b.objects_copied,
        objects_skipped: (prev.objects_skipped ?? 0) + b.objects_skipped,
        objects_failed: (prev.objects_failed ?? 0) + b.objects_failed,
        bytes_copied: Number(prev.bytes_copied ?? 0) + b.bytes_copied,
        last_error: b.last_error ?? null,
        last_run_at: new Date().toISOString(),
        completed_at: b.status === "complete" ? new Date().toISOString() : null,
      };
      await context.supabase
        .from("handoff_storage_replications")
        .upsert(row, { onConflict: "handoff_id,bucket_id" });
    }

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: outcome.ok
        ? outcome.incomplete
          ? "handoff.storage_replication_progressed"
          : "handoff.storage_replicated"
        : "handoff.storage_replication_partial",
      actor_user_id: context.userId,
      details: {
        source_ref: source.supabase_project_ref,
        target_ref: targetRef,
        incomplete: outcome.incomplete,
        budget_exhausted: outcome.budget_exhausted,
        buckets: outcome.buckets.map((b) => ({
          bucket_id: b.bucket_id,
          status: b.status,
          copied: b.objects_copied,
          skipped: b.objects_skipped,
          failed: b.objects_failed,
          bytes: b.bytes_copied,
        })),
      },
    });

    // Advance twin_ready → data_syncing on first successful run;
    // advance data_syncing → cutover_scheduled only when every bucket is
    // complete AND at least one object was copied or already-present.
    let advanced = false;
    if (handoff.state === "twin_ready" && outcome.ok) {
      const { error: updErr } = await context.supabase
        .from("clone_handoffs")
        .update({ state: "data_syncing" })
        .eq("id", data.handoff_id);
      if (!updErr) {
        advanced = true;
        await context.supabase.from("handoff_events").insert({
          handoff_id: data.handoff_id,
          kind: "handoff.transitioned",
          actor_user_id: context.userId,
          details: {
            from: "twin_ready",
            to: "data_syncing",
            note: "auto: storage replication started",
          },
        });
      }
    } else if (
      handoff.state === "data_syncing" &&
      outcome.ok &&
      !outcome.incomplete &&
      outcome.buckets.length > 0
    ) {
      const { error: updErr } = await context.supabase
        .from("clone_handoffs")
        .update({ state: "cutover_scheduled" })
        .eq("id", data.handoff_id);
      if (!updErr) {
        advanced = true;
        await context.supabase.from("handoff_events").insert({
          handoff_id: data.handoff_id,
          kind: "handoff.transitioned",
          actor_user_id: context.userId,
          details: {
            from: "data_syncing",
            to: "cutover_scheduled",
            note: "auto: storage replication complete",
          },
        });
      }
    }

    return {
      ok: outcome.ok,
      advanced,
      incomplete: outcome.incomplete,
      budget_exhausted: outcome.budget_exhausted,
      source_ref: source.supabase_project_ref,
      target_ref: targetRef,
      buckets: outcome.buckets,
    };
  });

// ---------------------------------------------------------------------------
// G18 — Cutover rollback executor.
//
// Reverses a failed cutover: iterates rotations whose status is `rotated`
// in reverse-priority order and calls `rollbackRotation` on each. Marks
// each row `rolled_back` (or `rollback_manual_required` when the
// pre-cutover value wasn't pinned). If the handoff has a
// `rollback_snapshot_id`, we stamp `restore_requested_at` on that
// snapshot so the snapshot executor picks up the PITR restore. Emits
// `handoff.rollback_started`, per-rotation `handoff.rotation_rollback_*`
// events, and a final `handoff.rollback_executed` event with a summary.
//
// Entry states: `rolled_back` (auto-set by the orchestrator when a
// rotation fails) or `failed` (manual operator recovery). Idempotent —
// rotations already flagged `rolled_back` / `rollback_manual_required`
// are skipped.
// ---------------------------------------------------------------------------

const ROTATION_PRIORITY_G18: Record<string, number> = {
  stripe_endpoint: 10,
  github_webhook: 20,
  cloudflare: 30,
  clone_repo: 40,
  edge_function_env: 50,
  webhook_consumer: 60,
  other: 70,
};

export const rollbackHandoffCutover = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ handoff_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: handoff, error: hErr } = await context.supabase
      .from("clone_handoffs")
      .select("id, state, rollback_snapshot_id")
      .eq("id", data.handoff_id)
      .maybeSingle();
    if (hErr) throw hErr;
    if (!handoff) return { ok: false as const, error: "not_found" };

    const ENTRY = new Set(["rolled_back", "failed", "cutover_in_progress"]);
    if (!ENTRY.has(handoff.state)) {
      return { ok: false as const, error: "wrong_state", state: handoff.state };
    }

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.rollback_started",
      actor_user_id: context.userId,
      details: {
        from: handoff.state,
        rollback_snapshot_id: handoff.rollback_snapshot_id ?? null,
      },
    });

    // Walk rotations in REVERSE priority order — undo the last thing we did
    // first so downstream systems see a consistent unwind.
    const { data: rows, error: rErr } = await context.supabase
      .from("handoff_secret_rotations")
      .select("*")
      .eq("handoff_id", data.handoff_id);
    if (rErr) throw rErr;
    const eligible = (rows ?? [])
      .filter((r: any) => r.status === "rotated")
      .sort(
        (a: any, b: any) =>
          (ROTATION_PRIORITY_G18[b.target] ?? 99) - (ROTATION_PRIORITY_G18[a.target] ?? 99),
      );

    const { rollbackRotation } = await import("@/server/handoff-rotations.server");
    const results: Array<{
      id: string;
      target: string;
      key_ref: string;
      status: string;
      error?: string | null;
    }> = [];
    let failed = 0;
    let manual = 0;
    let rolledBack = 0;

    for (const row of eligible) {
      const outcome = await rollbackRotation(row);
      const nextStatus =
        outcome.status === "rolled_back"
          ? "rolled_back"
          : outcome.status === "manual_required"
            ? "rollback_manual_required"
            : "rollback_failed";
      const patch: TablesUpdate<"handoff_secret_rotations"> = {
        status: nextStatus,
        error: outcome.error ?? null,
        metadata: asJson({
          ...metaRecord(row.metadata),
          last_rollback: {
            at: new Date().toISOString(),
            actor: context.userId,
            via: "orchestrator",
            ...outcome.audit,
          },
        }),
      };
      await context.supabase.from("handoff_secret_rotations").update(patch).eq("id", row.id);
      await context.supabase.from("handoff_events").insert({
        handoff_id: data.handoff_id,
        kind: `handoff.rotation_rollback_${outcome.status}`,
        actor_user_id: context.userId,
        details: {
          rotation_id: row.id,
          target: row.target,
          key_ref: row.key_ref,
          error: outcome.error ?? null,
        },
      });
      results.push({
        id: row.id,
        target: row.target,
        key_ref: row.key_ref,
        status: nextStatus,
        error: outcome.error ?? null,
      });
      if (outcome.status === "rolled_back") rolledBack += 1;
      else if (outcome.status === "manual_required") manual += 1;
      else failed += 1;
    }

    // Flag the pinned snapshot as restore-requested so the snapshot executor
    // (or an operator) can act. We use a metadata patch so we don't require a
    // schema migration.
    let snapshotFlagged = false;
    if (handoff.rollback_snapshot_id) {
      const { data: snap } = await context.supabase
        .from("handoff_snapshots")
        .select("id, metadata")
        .eq("id", handoff.rollback_snapshot_id)
        .maybeSingle();
      if (snap) {
        await context.supabase
          .from("handoff_snapshots")
          .update({
            metadata: {
              ...((snap.metadata as any) ?? {}),
              restore_requested_at: new Date().toISOString(),
              restore_requested_by: context.userId,
              restore_reason: "cutover_rollback",
            },
          })
          .eq("id", handoff.rollback_snapshot_id);
        snapshotFlagged = true;
      }
    }

    // Land handoff state. If any rotation failed to roll back we stay
    // `failed` so an admin can intervene; otherwise settle on `rolled_back`.
    const finalState = failed > 0 ? "failed" : "rolled_back";
    await context.supabase
      .from("clone_handoffs")
      .update({
        state: finalState,
        completed_at: new Date().toISOString(),
      })
      .eq("id", data.handoff_id);

    await context.supabase.from("handoff_events").insert({
      handoff_id: data.handoff_id,
      kind: "handoff.rollback_executed",
      actor_user_id: context.userId,
      details: {
        final_state: finalState,
        rotations_rolled_back: rolledBack,
        rotations_manual_required: manual,
        rotations_failed: failed,
        snapshot_restore_requested: snapshotFlagged,
        snapshot_id: handoff.rollback_snapshot_id ?? null,
      },
    });

    return {
      ok: failed === 0,
      final_state: finalState,
      rolled_back: rolledBack,
      manual_required: manual,
      failed,
      snapshot_restore_requested: snapshotFlagged,
      results,
    };
  });
