// Server functions for recorded per-path cascade approvals.
//
// Two of the engine's refusals end in "a person has to decide", and this is
// where the decision is recorded so the engine can read it back:
//
//   * `bulk_deletion` — a refused deletion set above the cap is delivered
//     only when EVERY path in it is approved (`planDeletions`); a path still
//     has to earn its delete verdict from prime's own history first.
//   * `overwrite` — one held `manual_reconcile` path on one clone may take
//     prime's copy (`decideHoldRelease`); `protected` paths are refused by
//     the engine whatever this table says.
//
// Approvals expire (14 days, the table default) and are revoked rather than
// deleted, so the register keeps its history. Writes go through the caller's
// own client: RLS holds inserts to operators approving as themselves.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isSafeRepoPath } from "@/lib/module-globs";

export type PathApprovalKind = "overwrite" | "bulk_deletion";

export type CascadePathApproval = {
  id: string;
  clone_id: string;
  kind: string;
  path: string;
  reason: string;
  approved_by: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

/**
 * The most paths one approval call will record. Sized above the largest real
 * retirement measured on this fleet (95 files, builder-portal decommission,
 * September 2026) with room for the deletion debt behind it, and far below
 * anything that could be a mistyped glob's expansion.
 */
export const MAX_APPROVAL_PATHS = 600;

export const listCascadePathApprovals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId?: string; includeInactive?: boolean }) => data ?? {})
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: boolean; approvals: CascadePathApproval[]; error?: string }> => {
      let q = context.supabase
        .from("cascade_path_approvals")
        .select("id, clone_id, kind, path, reason, approved_by, created_at, expires_at, revoked_at")
        .order("created_at", { ascending: false })
        .limit(1000);
      if (data.cloneId) q = q.eq("clone_id", data.cloneId);
      if (!data.includeInactive) {
        q = q.is("revoked_at", null).gt("expires_at", new Date().toISOString());
      }
      const { data: rows, error } = await q;
      if (error) return { ok: false, approvals: [], error: error.message };
      return { ok: true, approvals: (rows ?? []) as CascadePathApproval[] };
    },
  );

export const approveCascadePaths = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { cloneId: string; kind: PathApprovalKind; paths: string[]; reason: string }) => {
      if (!data?.cloneId) throw new Error("cloneId required");
      if (data.kind !== "overwrite" && data.kind !== "bulk_deletion") {
        throw new Error("kind must be 'overwrite' or 'bulk_deletion'");
      }
      if (!Array.isArray(data.paths) || data.paths.length === 0) {
        throw new Error("paths required");
      }
      if (data.paths.length > MAX_APPROVAL_PATHS) {
        throw new Error(
          `Refusing ${data.paths.length} paths in one approval — the ceiling is ` +
            `${MAX_APPROVAL_PATHS}, and a set that size is worth a second look before it is a record.`,
        );
      }
      const unsafe = data.paths.filter((p) => typeof p !== "string" || !isSafeRepoPath(p));
      if (unsafe.length > 0) {
        throw new Error(`Refusing unsafe path(s): ${unsafe.slice(0, 3).join(", ")}`);
      }
      if (typeof data.reason !== "string" || data.reason.trim().length < 10) {
        throw new Error("A reason of at least 10 characters is required — it is the record.");
      }
      return data;
    },
  )
  .handler(
    async ({ data, context }): Promise<{ ok: boolean; recorded: number; error?: string }> => {
      const supabase = context.supabase;
      const now = new Date().toISOString();
      const rows = [...new Set(data.paths)].map((path) => ({
        clone_id: data.cloneId,
        kind: data.kind,
        path,
        reason: data.reason.trim(),
        approved_by: context.userId,
        // A re-approval refreshes the window and un-revokes: the operator is
        // making the decision again, now, and the row records the newest act.
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        revoked_at: null,
        revoked_by: null,
        created_at: now,
      }));
      const { error } = await supabase
        .from("cascade_path_approvals")
        .upsert(rows, { onConflict: "clone_id,kind,path" });
      if (error) return { ok: false, recorded: 0, error: error.message };

      await supabase.from("audit_log").insert({
        action: "cascade.paths_approved",
        entity_type: "clone",
        entity_id: data.cloneId,
        actor_user_id: context.userId,
        metadata: {
          kind: data.kind,
          path_count: rows.length,
          first_paths: rows.slice(0, 10).map((r) => r.path),
          reason: data.reason.trim(),
        },
      });
      return { ok: true, recorded: rows.length };
    },
  );

export const revokeCascadePathApprovals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; kind?: PathApprovalKind; paths?: string[] }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }): Promise<{ ok: boolean; revoked: number; error?: string }> => {
    const supabase = context.supabase;
    let q = supabase
      .from("cascade_path_approvals")
      .update({ revoked_at: new Date().toISOString(), revoked_by: context.userId })
      .eq("clone_id", data.cloneId)
      .is("revoked_at", null);
    if (data.kind) q = q.eq("kind", data.kind);
    if (data.paths && data.paths.length > 0) q = q.in("path", data.paths);
    const { data: rows, error } = await q.select("id");
    if (error) return { ok: false, revoked: 0, error: error.message };

    await supabase.from("audit_log").insert({
      action: "cascade.path_approvals_revoked",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { kind: data.kind ?? "all", path_count: (rows ?? []).length },
    });
    return { ok: true, revoked: (rows ?? []).length };
  });
