// Callback keys for the live audit: one per run, one per fix. Server-only.
//
// The same scheme as the Codex workflows (codex-callback-keys.server.ts),
// because it is the one that survived their hardening: the master never
// leaves Mission Control; each run and each fix signs with a key derived for
// it alone and handed over as a dispatch input; signatures cover
// `<unix seconds>.<body>` inside a fifteen-minute window, and every accepted
// signature is recorded so an exact replay is refused. A key that leaks from
// one run opens that run only, and only while it is open.
//
// The derivation label is the live audit's own, so a Codex key can never
// verify a live-audit callback, or the reverse, even under one master.
// `LIVE_AUDIT_WEBHOOK_SECRET` is the master when set; otherwise the Codex scan
// master stands in, which every deployment already has.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveScanMasterSecrets, type MasterSecrets } from "@/server/codex-callback-keys.server";

/** Recorded on a run's `callback_key_version`. */
export const LIVE_AUDIT_RUN_KEY_VERSION = "live-run-v1";
/** Recorded on a fix's `dispatch_payload.callback_key`. */
export const LIVE_AUDIT_FIX_KEY_VERSION = "live-fix-v1";

export type LiveAuditKeyPurpose = "run" | "fix";

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The key one run or one fix signs with. Derived, never stored. */
export async function deriveLiveAuditKey(
  master: string,
  purpose: LiveAuditKeyPurpose,
  subjectId: string,
): Promise<string> {
  if (!master) throw new Error("deriveLiveAuditKey: no master secret");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      enc.encode(`aurixa-live-audit-callback:v1:${purpose}:${subjectId}`),
    ),
  );
}

/** The masters: the live audit's own when configured, else the Codex scan master. */
export async function resolveLiveAuditMasterSecrets(nowMs = Date.now()): Promise<MasterSecrets> {
  const fromEnv = process.env.LIVE_AUDIT_WEBHOOK_SECRET;
  if (fromEnv) {
    const previous = process.env.LIVE_AUDIT_WEBHOOK_SECRET_PREVIOUS;
    return { current: fromEnv, previous: previous ? [previous] : [], mode: "env" };
  }
  return resolveScanMasterSecrets(nowMs);
}

/** Every key a callback for `subjectId` may legitimately be signed with. */
export async function liveAuditKeysFor(
  masters: MasterSecrets,
  purpose: LiveAuditKeyPurpose,
  subjectId: string,
): Promise<string[]> {
  const secrets = [masters.current, ...masters.previous].filter(Boolean);
  return Promise.all(secrets.map((s) => deriveLiveAuditKey(s, purpose, subjectId)));
}

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .* does not exist|Could not find the table/i.test(error.message ?? "")
  );
}

/**
 * Record an accepted signature. `duplicate`: already processed.
 * `unavailable`: the table cannot be used, and the callback proceeds without
 * replay refusal rather than failing a run over its own bookkeeping.
 */
export async function claimLiveAuditReceipt(
  kind: LiveAuditKeyPurpose,
  digest: string,
  subjectId: string,
): Promise<"new" | "duplicate" | "unavailable"> {
  const { error } = await supabaseAdmin
    .from("live_audit_callback_receipts")
    .insert({ digest, kind, subject_id: subjectId });
  if (!error) return "new";
  if (error.code === "23505") return "duplicate";
  if (!isMissingRelation(error))
    console.error("[live-audit-keys] receipt insert failed:", error.message);
  return "unavailable";
}

/** Forget a receipt when processing failed after it was claimed, so a retry is processed. */
export async function releaseLiveAuditReceipt(digest: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("live_audit_callback_receipts")
    .delete()
    .eq("digest", digest);
  if (error && !isMissingRelation(error)) {
    console.error("[live-audit-keys] receipt release failed:", error.message);
  }
}

/** Receipts outlive the skew window many times over; older ones prove nothing. */
export async function pruneLiveAuditReceipts(olderThanHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("live_audit_callback_receipts")
    .delete()
    .lt("received_at", cutoff)
    .select("digest");
  if (error) {
    if (!isMissingRelation(error))
      console.error("[live-audit-keys] receipt prune failed:", error.message);
    return 0;
  }
  return data?.length ?? 0;
}
