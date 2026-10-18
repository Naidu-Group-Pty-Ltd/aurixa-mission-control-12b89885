// Callback authentication for the Codex scan and remediation workflows.
// Server-only.
//
// WHAT WAS WRONG
//
// One HMAC secret signed every callback from every repository. Mission
// Control sent it to Prime and to every clone as a plain `workflow_dispatch`
// input, and the workflows put it in job-level `env:` — which GitHub prints,
// unmasked, in the header of every step's log. Anyone who could read the
// Actions logs of ANY fleet repository (clones can live under a client's own
// GitHub account) held the key for all of them. With the default setup it was
// also the built-in `codex` intake key, which accepts findings for any clone or
// Prime through /api/public/security/intake. Signatures carried no timestamp,
// so a captured callback could be replayed for ever.
//
// WHAT RUNS NOW
//
//  - The master secret never leaves Mission Control. Each scan job and each
//    remediation gets its own key, derived from the master and the job's id.
//    A key that leaks from one run's log authenticates that one run, and only
//    while it is still open: the webhooks refuse callbacks for closed jobs.
//  - The workflows read the key from the event payload, mask it before
//    anything can print it, and keep it in a 0600 file outside the workspace.
//  - Signatures cover `<unix seconds>.<body>`; anything older than the skew
//    window is refused, and every accepted signature is recorded so an exact
//    replay inside the window is refused too.
//  - Older workflow copies (clones a cascade has not reached yet) still sign
//    the bare body. That is accepted — with the per-job key — and labelled, so
//    engine health can say which repositories still run the old file.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/** Recorded on a scan job's `request_payload.callback_key`. */
export const SCAN_CALLBACK_KEY_VERSION = "job-v1";
/** Recorded on a remediation's `dispatch_payload.callback_key`. */
export const REMEDIATION_CALLBACK_KEY_VERSION = "rem-v1";

/** How far a callback's timestamp may drift from Mission Control's clock. */
export const CALLBACK_MAX_SKEW_SECONDS = 15 * 60;

/** How long the previous master keeps authenticating after a rotation. */
export const ROTATION_GRACE_HOURS = 24;

export type CallbackPurpose = "scan" | "remediation";

const enc = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

/** Length-independent, branch-free comparison of two hex digests. */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * The key one scan job or one remediation signs its callbacks with. Derived,
 * not stored: the webhook recomputes it from the id the callback names, so
 * there is no per-job secret to keep, leak from the database, or rotate.
 */
export async function deriveCallbackKey(
  master: string,
  purpose: CallbackPurpose,
  subjectId: string,
): Promise<string> {
  if (!master) throw new Error("deriveCallbackKey: no master secret");
  return hmacHex(master, `aurixa-codex-callback:v1:${purpose}:${subjectId}`);
}

export type CallbackVerification =
  | { ok: true; scheme: "timestamped" | "legacy"; digest: string }
  | {
      ok: false;
      reason:
        | "missing_signature"
        | "no_keys"
        | "stale_timestamp"
        | "bad_timestamp"
        | "bad_signature";
    };

/**
 * Check a callback against candidate keys.
 *
 * Every candidate is tried with no early exit, so timing says nothing about
 * which one matched. `digest` identifies the exact signature that was
 * accepted, for replay refusal.
 */
export async function verifyCallbackSignature(input: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  keys: (string | null | undefined)[];
  allowUntimestamped: boolean;
  nowMs?: number;
}): Promise<CallbackVerification> {
  if (!input.signature) return { ok: false, reason: "missing_signature" };
  const keys = input.keys.filter((k): k is string => typeof k === "string" && k.length > 0);
  if (keys.length === 0) return { ok: false, reason: "no_keys" };

  const provided = input.signature.startsWith("sha256=")
    ? input.signature.slice(7)
    : input.signature;

  const tsRaw = (input.timestamp ?? "").trim();
  if (tsRaw) {
    if (!/^\d{9,12}$/.test(tsRaw)) return { ok: false, reason: "bad_timestamp" };
    const ts = Number(tsRaw);
    const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(now - ts) > CALLBACK_MAX_SKEW_SECONDS) {
      return { ok: false, reason: "stale_timestamp" };
    }
    let ok = false;
    for (const key of keys) {
      if (constantTimeEquals(await hmacHex(key, `${ts}.${input.rawBody}`), provided)) ok = true;
    }
    if (!ok) return { ok: false, reason: "bad_signature" };
    return { ok: true, scheme: "timestamped", digest: await sha256Hex(`${ts}:${provided}`) };
  }

  if (!input.allowUntimestamped) return { ok: false, reason: "bad_timestamp" };
  let ok = false;
  for (const key of keys) {
    if (constantTimeEquals(await hmacHex(key, input.rawBody), provided)) ok = true;
  }
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true, scheme: "legacy", digest: await sha256Hex(`legacy:${provided}`) };
}

// ── Master secrets ───────────────────────────────────────────────────────

export type MasterSecrets = {
  /** The secret new keys are derived from. Empty when nothing is configured. */
  current: string;
  /** Secrets still accepted during a rotation's grace window. */
  previous: string[];
  mode: "env" | "intake_source" | "none";
};

type CodexSourceRow = {
  id: string;
  hmac_secret: string | null;
  previous_hmac_secret?: string | null;
  hmac_rotated_at?: string | null;
};

/** PostgREST / Postgres codes for "this column does not exist (yet)". */
function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || /column .* does not exist/i.test(error.message ?? "");
}

async function loadCodexIntakeSource(): Promise<CodexSourceRow | null> {
  const { data, error } = await supabaseAdmin
    .from("security_intake_sources")
    .select("id, hmac_secret, previous_hmac_secret, hmac_rotated_at")
    .eq("slug", "codex")
    .maybeSingle();
  if (!error) return (data as CodexSourceRow | null) ?? null;

  // Before 20261018090000 there are no rotation columns; the current secret
  // is all there is.
  if (isMissingColumn(error)) {
    const legacy = await supabaseAdmin
      .from("security_intake_sources")
      .select("id, hmac_secret")
      .eq("slug", "codex")
      .maybeSingle();
    if (!legacy.error) return (legacy.data as CodexSourceRow | null) ?? null;
    console.error(
      "[codex-callback-keys] could not read the codex intake source:",
      legacy.error.message,
    );
    return null;
  }
  console.error("[codex-callback-keys] could not read the codex intake source:", error.message);
  return null;
}

function previousWithinGrace(source: CodexSourceRow, nowMs: number): string[] {
  const prev = source.previous_hmac_secret ?? "";
  const rotatedAt = source.hmac_rotated_at ? Date.parse(source.hmac_rotated_at) : NaN;
  if (!prev || Number.isNaN(rotatedAt)) return [];
  return nowMs - rotatedAt <= ROTATION_GRACE_HOURS * 3_600_000 ? [prev] : [];
}

/**
 * The scan master: `CODEX_SECURITY_WEBHOOK_SECRET` when set, otherwise the
 * auto-generated secret on the built-in `codex` intake source — the same
 * chain the dispatcher has always used, so a fresh deployment needs no
 * provisioning.
 */
export async function resolveScanMasterSecrets(nowMs = Date.now()): Promise<MasterSecrets> {
  const fromEnv = process.env.CODEX_SECURITY_WEBHOOK_SECRET;
  if (fromEnv) {
    const previous = process.env.CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS;
    return { current: fromEnv, previous: previous ? [previous] : [], mode: "env" };
  }
  const source = await loadCodexIntakeSource();
  if (source?.hmac_secret) {
    return {
      current: source.hmac_secret,
      previous: previousWithinGrace(source, nowMs),
      mode: "intake_source",
    };
  }
  return { current: "", previous: [], mode: "none" };
}

/** The remediation master: its own env var, else the scan master. */
export async function resolveRemediationMasterSecrets(nowMs = Date.now()): Promise<MasterSecrets> {
  const fromEnv = process.env.CODEX_REMEDIATION_WEBHOOK_SECRET;
  if (fromEnv) {
    const previous = process.env.CODEX_REMEDIATION_WEBHOOK_SECRET_PREVIOUS;
    return { current: fromEnv, previous: previous ? [previous] : [], mode: "env" };
  }
  return resolveScanMasterSecrets(nowMs);
}

/** Every key a callback for `subjectId` may legitimately be signed with. */
export async function callbackKeysFor(
  masters: MasterSecrets,
  purpose: CallbackPurpose,
  subjectId: string,
): Promise<string[]> {
  const secrets = [masters.current, ...masters.previous].filter(Boolean);
  return Promise.all(secrets.map((s) => deriveCallbackKey(s, purpose, subjectId)));
}

/**
 * Replace the auto-generated scan master on the `codex` intake source. The
 * previous value keeps authenticating for ROTATION_GRACE_HOURS so scans in
 * flight can still report. Refused when the master comes from an env var —
 * that one is rotated in the deployment's settings.
 */
export async function rotateScanMasterSecret(): Promise<
  { ok: true; rotatedAt: string } | { ok: false; reason: string }
> {
  if (process.env.CODEX_SECURITY_WEBHOOK_SECRET) {
    return {
      ok: false,
      reason:
        "The signing key comes from CODEX_SECURITY_WEBHOOK_SECRET. Set a new value in the " +
        "deployment's secrets and move the old one to CODEX_SECURITY_WEBHOOK_SECRET_PREVIOUS " +
        "for a day.",
    };
  }
  const source = await loadCodexIntakeSource();
  if (!source) return { ok: false, reason: "The built-in codex intake source is missing." };

  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  const next = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const rotatedAt = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("security_intake_sources")
    .update({
      hmac_secret: next,
      previous_hmac_secret: source.hmac_secret ?? null,
      hmac_rotated_at: rotatedAt,
    })
    .eq("id", source.id);
  if (error) {
    // Without the rotation columns there is no grace window, and scans in
    // flight would be orphaned — refuse rather than half-rotate.
    if (isMissingColumn(error)) {
      return {
        ok: false,
        reason: "Apply migration 20261018090000 first: it adds the columns a safe rotation needs.",
      };
    }
    return { ok: false, reason: error.message };
  }
  return { ok: true, rotatedAt };
}

// ── Replay receipts ──────────────────────────────────────────────────────

/** PostgREST / Postgres codes for "this table does not exist (yet)". */
function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /relation .* does not exist|Could not find the table/i.test(error.message ?? "")
  );
}

/**
 * Record an accepted signature. `duplicate` means this exact signature was
 * already processed; `unavailable` means the receipts table cannot be used
 * (an unmigrated deployment) and the callback proceeds without replay refusal
 * rather than failing a scan over its own bookkeeping.
 */
export async function claimCallbackReceipt(
  kind: CallbackPurpose,
  digest: string,
  subjectId: string,
): Promise<"new" | "duplicate" | "unavailable"> {
  const { error } = await supabaseAdmin
    .from("codex_callback_receipts")
    .insert({ digest, kind, subject_id: subjectId });
  if (!error) return "new";
  if (error.code === "23505") return "duplicate";
  if (!isMissingRelation(error)) {
    console.error("[codex-callback-keys] receipt insert failed:", error.message);
  }
  return "unavailable";
}

/**
 * Forget a receipt when processing failed after it was claimed, so the
 * sender's retry is processed rather than refused as a replay.
 */
export async function releaseCallbackReceipt(digest: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("codex_callback_receipts")
    .delete()
    .eq("digest", digest);
  if (error && !isMissingRelation(error)) {
    console.error("[codex-callback-keys] receipt release failed:", error.message);
  }
}

/** Receipts outlive the skew window many times over; older ones prove nothing. */
export async function pruneCallbackReceipts(olderThanHours = 48): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("codex_callback_receipts")
    .delete()
    .lt("received_at", cutoff)
    .select("digest");
  if (error) {
    if (!isMissingRelation(error)) {
      console.error("[codex-callback-keys] receipt prune failed:", error.message);
    }
    return 0;
  }
  return data?.length ?? 0;
}
