// The secrets a deployment needs: the client's VAPI key, the tenant webhook's
// key and secret, the Make transfer hook, and where call logs go.
//
// Four rules, each enforced here rather than in the browser:
//
// - **Fail closed without encryption.** Nothing is stored unless
//   CREDENTIALS_ENC_KEY is set, because encryptSecret() is a no-op without it
//   and a client's VAPI key must never sit in the database as plaintext.
// - **Never Aurixa's key.** A key that matches Mission Control's own
//   VAPI_API_KEY is refused: deploying a client's fleet into Aurixa's org would
//   put their agents on our bill and their callers in our call logs.
// - **Verified before stored.** A key VAPI refuses is not saved.
// - **Never returned.** Every read here returns a fingerprint; nothing selects
//   an encrypted column for a browser.
import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptSecret, encryptSecret, isEncryptionEnabled } from "@/server/crypto.server";
import { resolveMissionControlOrigin } from "@/server/missionControlLink.pure";
import { writeAuditLog } from "@/server/audit.server";
import { probeVapiKey } from "./vapi-client.server";

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

function requireEncryption(): void {
  if (!isEncryptionEnabled()) {
    throw new CredentialError(
      "CREDENTIALS_ENC_KEY is not set, so no secret can be stored safely; set it before using deploy",
    );
  }
}

/** Last four characters and a hash prefix: enough to tell keys apart, never enough to use one. */
export function fingerprintOf(secret: string): string {
  const hash = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  return `...${secret.slice(-4)} (${hash})`;
}

export async function setProjectVapiKey(args: {
  projectId: string;
  apiKey: string;
  userId: string;
}): Promise<{ fingerprint: string }> {
  requireEncryption();
  const key = args.apiKey.trim();
  if (key.length < 16) throw new CredentialError("that does not look like a VAPI private key");
  const own = process.env.VAPI_API_KEY?.trim();
  if (own && own === key) {
    await writeAuditLog({
      action: "voice_studio.vapi_key_refused",
      entityType: "voice_studio_project",
      entityId: args.projectId,
      actorUserId: args.userId,
      metadata: { reason: "mission_control_key" },
    });
    throw new CredentialError(
      "this is Mission Control's own VAPI key; a client's fleet must deploy into the client's org",
    );
  }
  const probe = await probeVapiKey(key);
  if (!probe.ok) throw new CredentialError(probe.reason);

  const fingerprint = fingerprintOf(key);
  const { error } = await supabaseAdmin.from("voice_studio_vapi_credentials").upsert(
    {
      project_id: args.projectId,
      api_key_enc: encryptSecret(key),
      fingerprint,
      verified_at: new Date().toISOString(),
      last_error: null,
      set_by: args.userId,
    },
    { onConflict: "project_id" },
  );
  if (error) throw error;
  await writeAuditLog({
    action: "voice_studio.vapi_key_set",
    entityType: "voice_studio_project",
    entityId: args.projectId,
    actorUserId: args.userId,
    metadata: { fingerprint },
  });
  return { fingerprint };
}

export async function readProjectVapiKey(projectId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("voice_studio_vapi_credentials")
    .select("api_key_enc")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CredentialError("no VAPI key is set for this project");
  return decryptSecret(data.api_key_enc);
}

export interface DeploySettingsStatus {
  vapiKey: { fingerprint: string; verifiedAt: string | null } | null;
  tenant: {
    webhookUrl: string;
    secretFingerprint: string;
    enabled: boolean;
    transferHookSet: boolean;
    escalationNumber: string | null;
    callLogUrl: string | null;
    callLogSecretSet: boolean;
  } | null;
}

export function tenantWebhookUrl(tenantKey: string): string {
  return `${resolveMissionControlOrigin({ PUBLIC_APP_URL: process.env.PUBLIC_APP_URL })}/api/public/voice/t/${tenantKey}/webhook`;
}

/** What the Deploy tab shows: fingerprints and flags, never a value. */
export async function readDeploySettings(projectId: string): Promise<DeploySettingsStatus> {
  const [{ data: cred, error: credError }, { data: cfg, error: cfgError }] = await Promise.all([
    supabaseAdmin
      .from("voice_studio_vapi_credentials")
      .select("fingerprint, verified_at")
      .eq("project_id", projectId)
      .maybeSingle(),
    supabaseAdmin
      .from("voice_tenant_configs")
      .select(
        "tenant_key, secret_fingerprint, enabled, transfer_hook_url_enc, escalation_number, call_log_url, call_log_secret_enc",
      )
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);
  if (credError) throw credError;
  if (cfgError) throw cfgError;
  return {
    vapiKey: cred ? { fingerprint: cred.fingerprint, verifiedAt: cred.verified_at } : null,
    tenant: cfg
      ? {
          webhookUrl: tenantWebhookUrl(cfg.tenant_key),
          secretFingerprint: cfg.secret_fingerprint,
          enabled: cfg.enabled,
          transferHookSet: Boolean(cfg.transfer_hook_url_enc),
          escalationNumber: cfg.escalation_number,
          callLogUrl: cfg.call_log_url,
          callLogSecretSet: Boolean(cfg.call_log_secret_enc),
        }
      : null,
  };
}

/** Mint the tenant's webhook identity once; an existing one is kept (rotating it would break a live fleet). */
export async function ensureTenantConfig(
  projectId: string,
  businessName: string | null,
): Promise<{ tenantKey: string }> {
  requireEncryption();
  const { data: existing, error } = await supabaseAdmin
    .from("voice_tenant_configs")
    .select("tenant_key")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (existing) return { tenantKey: existing.tenant_key };
  const tenantKey = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const { error: insertError } = await supabaseAdmin.from("voice_tenant_configs").insert({
    project_id: projectId,
    tenant_key: tenantKey,
    webhook_secret_enc: encryptSecret(secret),
    secret_fingerprint: fingerprintOf(secret),
    business_name: businessName,
  });
  if (insertError) throw insertError;
  return { tenantKey };
}

export async function setDeploySettings(args: {
  projectId: string;
  userId: string;
  makeTransferHookUrl?: string | null;
  escalationNumber?: string | null;
  callLogUrl?: string | null;
  callLogSecret?: string | null;
}): Promise<void> {
  requireEncryption();
  await ensureTenantConfig(args.projectId, null);
  const patch: Record<string, unknown> = {};
  if (args.makeTransferHookUrl !== undefined) {
    const url = args.makeTransferHookUrl?.trim() || null;
    if (url && !/^https:\/\/hook\.[a-z0-9.-]+\.make\.com\/[A-Za-z0-9]+$/.test(url)) {
      throw new CredentialError(
        "the transfer hook must be a Make webhook URL (https://hook.<region>.make.com/...)",
      );
    }
    patch.transfer_hook_url_enc = url ? encryptSecret(url) : null;
  }
  if (args.escalationNumber !== undefined) {
    const n = args.escalationNumber?.replace(/[^\d+]/g, "") || null;
    if (n && !/^\+\d{8,15}$/.test(n))
      throw new CredentialError(
        "the escalation number must be in international form, e.g. +61 2 9999 9999",
      );
    patch.escalation_number = n;
  }
  if (args.callLogUrl !== undefined) {
    const url = args.callLogUrl?.trim() || null;
    if (url && !/^https:\/\//.test(url))
      throw new CredentialError("the call log URL must be https");
    patch.call_log_url = url;
  }
  if (args.callLogSecret !== undefined) {
    patch.call_log_secret_enc = args.callLogSecret?.trim()
      ? encryptSecret(args.callLogSecret.trim())
      : null;
  }
  if (!Object.keys(patch).length) return;
  const { error } = await supabaseAdmin
    .from("voice_tenant_configs")
    .update(patch as never)
    .eq("project_id", args.projectId);
  if (error) throw error;
  await writeAuditLog({
    action: "voice_studio.deploy_settings_set",
    entityType: "voice_studio_project",
    entityId: args.projectId,
    actorUserId: args.userId,
    metadata: { fields: Object.keys(patch) },
  });
}

/** The decrypted values a deploy resolves its placeholders with. Server-side only, in memory only. */
export async function readDeploySecrets(projectId: string): Promise<{
  tenantKey: string;
  tenantWebhookUrl: string;
  tenantWebhookSecret: string;
  makeTransferUrl: string | null;
  callLogUrl: string | null;
  callLogSecret: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from("voice_tenant_configs")
    .select(
      "tenant_key, webhook_secret_enc, transfer_hook_url_enc, call_log_url, call_log_secret_enc",
    )
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new CredentialError("this project has no tenant configuration yet");
  return {
    tenantKey: data.tenant_key,
    tenantWebhookUrl: tenantWebhookUrl(data.tenant_key),
    tenantWebhookSecret: decryptSecret(data.webhook_secret_enc),
    makeTransferUrl: data.transfer_hook_url_enc ? decryptSecret(data.transfer_hook_url_enc) : null,
    callLogUrl: data.call_log_url,
    callLogSecret: data.call_log_secret_enc ? decryptSecret(data.call_log_secret_enc) : null,
  };
}
