// Phase 10 — Operator UX server functions:
// - brand version diff
// - bulk cascade approvals
// - audit log export (paginated batch fetch)
// - bulk clone ops (delete)
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ─── Brand version diff ──────────────────────────────────────────────
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

function diffJson(
  a: unknown,
  b: unknown,
  path = "",
): Array<{ path: string; before: unknown; after: unknown; kind: "added" | "removed" | "changed" }> {
  const out: Array<{
    path: string;
    before: unknown;
    after: unknown;
    kind: "added" | "removed" | "changed";
  }> = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const sub = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: sub, before: undefined, after: b[k], kind: "added" });
      else if (!(k in b)) out.push({ path: sub, before: a[k], after: undefined, kind: "removed" });
      else out.push(...diffJson(a[k], b[k], sub));
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: path || "$", before: a, after: b, kind: "changed" });
  }
  return out;
}

export const diffBrandVersions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { profileId: string; versionA: string; versionB: string }) =>
    z
      .object({
        profileId: z.string().uuid(),
        versionA: z.string().uuid(),
        versionB: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("clone_brand_versions")
      .select("id, version, brand_config, report_contact, asset_manifest, published_at")
      .eq("profile_id", data.profileId)
      .in("id", [data.versionA, data.versionB]);
    if (error) return { ok: false as const, error: error.message };
    if (!rows || rows.length !== 2)
      return { ok: false as const, error: "Could not load both versions" };
    const a = rows.find((r) => r.id === data.versionA)!;
    const b = rows.find((r) => r.id === data.versionB)!;
    const diff = [
      ...diffJson(a.brand_config as Json, b.brand_config as Json, "brand_config"),
      ...diffJson(a.report_contact as Json, b.report_contact as Json, "report_contact"),
      ...diffJson(a.asset_manifest as Json, b.asset_manifest as Json, "asset_manifest"),
    ];
    const safeDiff = diff.map((d) => ({
      path: d.path,
      kind: d.kind,
      before: d.before === undefined ? null : (JSON.stringify(d.before) ?? "null"),
      after: d.after === undefined ? null : (JSON.stringify(d.after) ?? "null"),
    }));
    return {
      ok: true as const,
      a: { id: a.id, version: a.version, published_at: a.published_at },
      b: { id: b.id, version: b.version, published_at: b.published_at },
      diff: safeDiff,
    };
  });

// ─── Pending cascade approvals (queue) ────────────────────────────────

export const listPendingApprovals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase
      .from("cascade_events")
      .select(
        "id, mode, summary, source_branch, source_sha, initiated_by, created_at, requires_approval, approved_at, scope_filter",
      )
      .eq("requires_approval", true)
      .is("approved_at", null)
      .neq("status", "failed")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { ok: false as const, error: error.message, events: [] };
    return { ok: true as const, events: data ?? [] };
  });

// ─── Bulk clone delete (admin only — RLS enforces) ────────────────────

export const bulkDeleteClones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[] }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of data.cloneIds) {
      const { error } = await supabase.from("clones").delete().eq("id", id);
      results.push({ id, ok: !error, error: error?.message });
    }
    await supabase.from("audit_log").insert({
      action: "clones.bulk_deleted",
      entity_type: "clone",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, results },
    });
    return { ok: true as const, results };
  });

// ─── Bulk pause / resume (uses sync_status enum: 'unknown' as paused proxy) ──
// We track paused state via a metadata note, since the sync_status enum has
// no dedicated value. The UI shows a "paused" pill when notes contain a tag.

const PAUSE_TAG = "[paused]";

export const bulkPauseClones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[]; pause: boolean }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(100), pause: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: clones } = await supabase
      .from("clones")
      .select("id, notes")
      .in("id", data.cloneIds);
    const updates = (clones ?? []).map(async (c) => {
      const existing = (c.notes ?? "").replace(PAUSE_TAG, "").trim();
      const next = data.pause ? `${PAUSE_TAG} ${existing}`.trim() : existing;
      await supabase
        .from("clones")
        .update({ notes: next || null })
        .eq("id", c.id);
    });
    await Promise.all(updates);
    await supabase.from("audit_log").insert({
      action: data.pause ? "clones.bulk_paused" : "clones.bulk_resumed",
      entity_type: "clone",
      actor_user_id: userId,
      metadata: { count: data.cloneIds.length, ids: data.cloneIds },
    });
    return { ok: true as const, count: data.cloneIds.length };
  });

/**
 * Re-queue selected clone backends — through the SAME enqueue every other
 * caller uses.
 *
 * ## What this used to do, and why it could not work
 *
 * It wrote `clone_backends.status = 'pending'` directly, for any row at
 * `failed` or `ready`, and reported "Re-queued N backends" every time. It was
 * the second writer of a row shape whose only writer is supposed to be
 * `enqueueCloneBackendProvisioning` — "two writers of that row shape is how
 * the queue and the worker drift" is written above that function — and the
 * drift was total:
 *
 *   * the drain's `claimOne` will not take a row whose queued admin credential
 *     is absent, and this wrote none. A terminal outcome CLEARS that column,
 *     so neither a `failed` row nor a `ready` one has one to begin with. The
 *     re-queued job was therefore unclaimable by construction, on every row,
 *     every time;
 *   * `reclaimStalled` then found it — parked, credential-less, untouched for
 *     45 minutes — and marked it **failed**: "Provisioning stranded — nothing
 *     could claim it."
 *
 * So the button did not reprovision anything. On a `failed` clone it changed a
 * message; on a READY one it destroyed the `ready` status the whole product
 * reads and left a healthy tenant's backend recorded as failed three quarters
 * of an hour later. The operator was told it had worked.
 *
 * ## What it does now
 *
 * The status decides the lever, and both go through the one enqueue:
 * a `failed` backend is retried with a freshly minted credential (exactly what
 * /hooks/backend-provisioning-retry does), and a `ready` one is REPAIRED —
 * converged onto the current engine, resuming onto its existing project, with
 * the admin identity left alone because it belongs to the tenant now.
 * Anything in flight is skipped and said, never clobbered.
 */
export const bulkReprovisionBackends = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cloneIds: string[] }) =>
    z.object({ cloneIds: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { enqueueCloneBackendProvisioning, generateSecurePassword } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/backend-provisioning.server"
    );

    const { data: rows, error: readErr } = await supabase
      .from("clone_backends")
      .select("clone_id, status, admin_email, region, queued_module_ids, supabase_project_ref")
      .in("clone_id", data.cloneIds);
    // A read that FAILED is not a selection that is EMPTY. Reporting "0
    // queued" over a database fault is the reading this whole surface was
    // built out of.
    if (readErr) return { ok: false as const, error: readErr.message };

    const { data: clones } = await supabase
      .from("clones")
      .select("id, name")
      .in("id", data.cloneIds);
    const nameOf = new Map((clones ?? []).map((c) => [c.id, c.name as string]));

    const queued: string[] = [];
    const skipped: Array<{ cloneId: string; reason: string }> = [];
    for (const row of rows ?? []) {
      const cloneName = nameOf.get(row.clone_id);
      if (!cloneName) {
        skipped.push({ cloneId: row.clone_id, reason: "no clone row" });
        continue;
      }
      const repair = row.status === "ready";
      if (!repair && row.status !== "failed") {
        // In flight. A fresh upsert here would reset its attempts and its
        // credential under a worker that is mid-run.
        skipped.push({ cloneId: row.clone_id, reason: `backend is '${row.status}'` });
        continue;
      }
      if (repair && !row.supabase_project_ref) {
        skipped.push({ cloneId: row.clone_id, reason: "ready but names no Supabase project" });
        continue;
      }
      if (!repair && !row.admin_email) {
        skipped.push({ cloneId: row.clone_id, reason: "no admin_email to seed with" });
        continue;
      }
      const enq = await enqueueCloneBackendProvisioning(supabase, userId, {
        cloneId: row.clone_id,
        cloneName,
        region: row.region ?? undefined,
        adminEmail: row.admin_email ?? "",
        // A repair seeds nobody, so it queues no credential — see the enqueue.
        adminPassword: repair ? null : generateSecurePassword(),
        repair,
        moduleIds: (row.queued_module_ids as string[] | null) ?? [],
      });
      if (enq.ok) queued.push(row.clone_id);
      else skipped.push({ cloneId: row.clone_id, reason: enq.error });
    }

    await supabase.from("audit_log").insert({
      action: "clones.bulk_reprovision_queued",
      entity_type: "clone_backend",
      actor_user_id: userId,
      // What actually happened, per clone. The old metadata recorded the
      // SELECTION — every id, with a count that was really "how many were
      // ticked" — so the audit trail agreed with the toast and neither agreed
      // with the database.
      metadata: {
        queued: queued.length,
        skipped: skipped.length,
        ids: queued,
        skipped_detail: skipped,
      },
    });

    return { ok: true as const, count: queued.length, skipped };
  });

// ─── Audit log export (CSV-friendly batch) ────────────────────────────

export const exportAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      sinceIso?: string;
      untilIso?: string;
      action?: string;
      entity?: string;
      limit?: number;
    }) =>
      z
        .object({
          sinceIso: z.string().optional(),
          untilIso: z.string().optional(),
          action: z.string().optional(),
          entity: z.string().optional(),
          limit: z.number().int().min(1).max(5000).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    let q = supabase
      .from("audit_log")
      .select("id, created_at, action, entity_type, entity_id, actor_user_id, metadata")
      .order("created_at", { ascending: false })
      .limit(Math.min(data.limit ?? 2000, 5000));
    if (data.sinceIso) q = q.gte("created_at", data.sinceIso);
    if (data.untilIso) q = q.lte("created_at", data.untilIso);
    if (data.action && data.action !== "all") q = q.eq("action", data.action);
    if (data.entity && data.entity !== "all") q = q.eq("entity_type", data.entity);
    const { data: rows, error } = await q;
    if (error) return { ok: false as const, error: error.message, rows: [] };
    return { ok: true as const, rows: rows ?? [] };
  });
