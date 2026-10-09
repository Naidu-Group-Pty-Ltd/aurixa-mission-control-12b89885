// Mission Control's own advertising and YouTube credentials.
//
// The prime keeps these as edge-function secrets set on its Integrations page;
// Mission Control has no such page for its own accounts, so an administrator
// enters them on /marketing/connections and they live in
// `marketing_connections`. Four rules, each enforced here rather than in the
// browser — the same four the Voice Studio's VAPI key answers to:
//
// - **Fail closed without encryption.** Nothing is stored unless
//   CREDENTIALS_ENC_KEY is set, because encryptSecret() is a no-op without it
//   and an advertising token must never sit in the database as plaintext.
// - **Verified before stored.** Every save asks the vendor with the submitted
//   credentials first; a token the vendor refuses is not saved, and the
//   refusal is said in the vendor's own failure words.
// - **Never returned.** Every read for a browser returns fingerprints; nothing
//   here selects `secrets_enc` for anything but the server's own vendor calls.
// - **Audited.** A save and a removal each write the audit log, with the
//   fingerprints and never a value.
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { decryptSecret, encryptSecret, isEncryptionEnabled } from "@/server/crypto.server";
import { writeAuditLog } from "@/server/audit.server";
import {
  MARKETING_SOURCES,
  SOURCE_DEFINITIONS,
  missingFields,
  validateSubmission,
  type MarketingSource,
} from "@/lib/marketing/connectionFields.pure";

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

/** A source's stored values, decrypted, for the server's own vendor calls only. */
export interface LoadedConnection {
  source: MarketingSource;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

/** What a browser may see about a source: names, fingerprints and state. Never a value. */
export interface ConnectionStatus {
  source: MarketingSource;
  label: string;
  configured: boolean;
  /** Field keys still needed before the source can be read. */
  missing: string[];
  settings: Record<string, string>;
  fingerprints: Record<string, string>;
  accountName: string | null;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

function asStringRecord(value: Json | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** Last four characters and a hash prefix: enough to tell keys apart, never enough to use one. */
export function fingerprintOf(secret: string): string {
  const hash = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  return `…${secret.slice(-4)} (${hash})`;
}

/**
 * The stored values of one source, decrypted — or which fields are still
 * missing, by key, when nothing usable is stored. A read that FAILS throws:
 * "the database did not answer" and "nothing is connected" send an operator to
 * different places.
 */
export async function loadConnection(
  source: MarketingSource,
): Promise<
  { connection: LoadedConnection; missing: [] } | { connection: null; missing: string[] }
> {
  const { data, error } = await supabaseAdmin
    .from("marketing_connections")
    .select("settings, secrets_enc")
    .eq("source", source)
    .maybeSingle();
  if (error) throw error;
  const settings = asStringRecord(data?.settings);
  const sealed = asStringRecord(data?.secrets_enc);
  const missing = missingFields(source, settings, new Set(Object.keys(sealed)));
  if (!data || missing.length > 0) return { connection: null, missing };
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(sealed)) secrets[key] = decryptSecret(value);
  return { connection: { source, settings, secrets }, missing: [] };
}

export async function connectionStatuses(): Promise<ConnectionStatus[]> {
  const { data, error } = await supabaseAdmin
    .from("marketing_connections")
    .select(
      "source, settings, secrets_enc, fingerprints, account_name, verified_at, last_checked_at, last_error, updated_at",
    );
  if (error) throw error;
  const bySource = new Map((data ?? []).map((row) => [row.source, row]));
  return MARKETING_SOURCES.map((source) => {
    const row = bySource.get(source);
    const settings = asStringRecord(row?.settings);
    // Only the KEYS of the sealed object are read: which credentials exist.
    const stored = new Set(Object.keys(asStringRecord(row?.secrets_enc)));
    const missing = missingFields(source, settings, stored);
    return {
      source,
      label: SOURCE_DEFINITIONS[source].label,
      configured: !!row && missing.length === 0,
      missing,
      settings,
      fingerprints: asStringRecord(row?.fingerprints),
      accountName: row?.account_name ?? null,
      verifiedAt: row?.verified_at ?? null,
      lastCheckedAt: row?.last_checked_at ?? null,
      lastError: row?.last_error ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/** The outcome of asking the vendor with a set of credentials. */
export type ProbeResult = { ok: true; accountName: string | null } | { ok: false; error: string };

/**
 * Save a source's credentials after the vendor has accepted them.
 *
 * `probe` asks the vendor with the MERGED values (a blank secret keeps the one
 * already stored), so a save that changes only the account id is checked
 * against the stored token too.
 */
export async function saveConnection(args: {
  source: MarketingSource;
  settings: Record<string, string>;
  secrets: Record<string, string>;
  userId: string;
  probe: (connection: LoadedConnection) => Promise<ProbeResult>;
}): Promise<ConnectionStatus> {
  if (!isEncryptionEnabled()) {
    throw new ConnectionError(
      "CREDENTIALS_ENC_KEY is not set, so no credential can be stored safely; set it before connecting a source",
    );
  }
  const valid = validateSubmission(args.source, { settings: args.settings, secrets: args.secrets });
  if (!valid.ok) throw new ConnectionError(valid.error);

  const { data: existing, error: readError } = await supabaseAdmin
    .from("marketing_connections")
    .select("secrets_enc, fingerprints")
    .eq("source", args.source)
    .maybeSingle();
  if (readError) throw readError;

  const storedSealed = asStringRecord(existing?.secrets_enc);
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(storedSealed)) secrets[key] = decryptSecret(value);
  Object.assign(secrets, valid.secrets);
  const settings = valid.settings;

  const missing = missingFields(args.source, settings, new Set(Object.keys(secrets)));
  if (missing.length > 0) {
    const labels = SOURCE_DEFINITIONS[args.source].fields
      .filter((f) => missing.includes(f.key))
      .map((f) => f.label);
    throw new ConnectionError(`Still needed: ${labels.join(", ")}`);
  }

  const probe = await args.probe({ source: args.source, settings, secrets });
  const now = new Date().toISOString();
  if (!probe.ok) {
    // The refusal is recorded against an EXISTING row so the page can say why
    // the last attempt failed; a source never saved stays unsaved.
    if (existing) {
      const { error: noteError } = await supabaseAdmin
        .from("marketing_connections")
        .update({ last_checked_at: now, last_error: probe.error })
        .eq("source", args.source);
      if (noteError)
        console.warn("[marketing] could not record a refused check", noteError.message);
    }
    throw new ConnectionError(probe.error);
  }

  const sealed: Record<string, string> = {};
  const fingerprints: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    sealed[key] = encryptSecret(value);
    fingerprints[key] = fingerprintOf(value);
  }
  const { error: writeError } = await supabaseAdmin.from("marketing_connections").upsert(
    {
      source: args.source,
      settings,
      secrets_enc: sealed,
      fingerprints,
      account_name: probe.accountName,
      verified_at: now,
      last_checked_at: now,
      last_error: null,
      updated_by: args.userId,
      updated_at: now,
    },
    { onConflict: "source" },
  );
  if (writeError) throw writeError;

  await writeAuditLog({
    action: "marketing.connection_saved",
    entityType: "marketing_connection",
    entityId: args.source,
    actorUserId: args.userId,
    metadata: { fingerprints, settings, accountName: probe.accountName },
  });

  const statuses = await connectionStatuses();
  return statuses.find((s) => s.source === args.source)!;
}

export async function removeConnection(source: MarketingSource, userId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("marketing_connections").delete().eq("source", source);
  if (error) throw error;
  await writeAuditLog({
    action: "marketing.connection_removed",
    entityType: "marketing_connection",
    entityId: source,
    actorUserId: userId,
    metadata: {},
  });
}

/** Record what the vendor said the last time a source was read on a schedule. */
export async function noteConnectionCheck(
  source: MarketingSource,
  error: string | null,
): Promise<void> {
  const { error: writeError } = await supabaseAdmin
    .from("marketing_connections")
    .update({ last_checked_at: new Date().toISOString(), last_error: error })
    .eq("source", source);
  if (writeError) console.warn("[marketing] could not record a check", writeError.message);
}
