/**
 * Microsoft tenants: resolving one to credentials, and adding, changing and
 * removing them.
 *
 * `src/lib/email/microsoftTenants.pure.ts` carries the rules; this is the I/O.
 *
 * ## Where the credentials are
 *
 * The deployment's own tenant (`null` everywhere) is read from its secrets by
 * `defaultGraphConfig()`. An added tenant's credentials are in Supabase Vault,
 * reached through `microsoft_tenant_credentials()` with the service role —
 * the only role allowed to execute it. Nothing in this module returns a
 * credential to a caller that could hand it to a browser: summaries carry
 * hints, and the full values only ever become a `GraphConfig` that goes
 * straight to Microsoft.
 *
 * ## Verified before saved
 *
 * New or changed credentials are tried against Microsoft — a token is
 * requested with them — BEFORE anything is stored. A mistyped secret is
 * refused at the form with Microsoft's reason, not discovered when the first
 * campaign pauses.
 *
 * ## Caching
 *
 * A resolved tenant is cached per isolate for a minute. The dispatcher asks
 * for every campaign every tick and the Vault read is not free; a minute is
 * also the longest a rotated secret can keep being used by an isolate that
 * read the old one, and every write here drops this isolate's entry at once.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { sha256Hex } from "@/lib/email/attachments.pure";
import {
  capabilitiesFrom,
  describeMailboxAccess,
  qualifyAccess,
  tokenRoles,
  type GraphCapabilities,
  type MailboxAccess,
} from "@/lib/email/mailboxes.pure";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  credentialHints,
  credentialsFrom,
  fingerprintSource,
  parseCredentials,
  secretExpiry,
  tenantErrorMessage,
  tenantInputProblems,
  type CredentialHints,
  type SecretExpiry,
  type TenantCredentials,
  type TenantInput,
} from "@/lib/email/microsoftTenants.pure";
import {
  GraphError,
  accessToken,
  defaultGraphConfig,
  forgetToken,
  probeMailboxes,
  type GraphConfig,
} from "@/server/graph-client";

type TenantRow = Database["public"]["Tables"]["microsoft_tenants"]["Row"];

const CONFIG_TTL_MS = 60_000;
const configCache = new Map<string, { at: number; config: GraphConfig | null }>();

/** The label the deployment's own tenant goes by in the console. */
export const DEFAULT_TENANT_LABEL = "Deployment tenant (Lovable secrets)";

/**
 * A tenant's credentials, or null when it cannot be used: the deployment's
 * secrets are not all set, or the added tenant was removed or has no
 * credentials on record.
 */
export async function graphConfigFor(
  tenantId: string | null | undefined,
): Promise<GraphConfig | null> {
  if (!tenantId) return defaultGraphConfig();
  const cached = configCache.get(tenantId);
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;

  const { data: row, error } = await supabaseAdmin
    .from("microsoft_tenants")
    .select("id, label, default_mailbox, credentials_version, removed_at")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw error;

  let config: GraphConfig | null = null;
  if (row && !row.removed_at) {
    const { data: secret, error: secretError } = await supabaseAdmin.rpc(
      "microsoft_tenant_credentials",
      { p_tenant: tenantId },
    );
    if (secretError) throw secretError;
    const credentials = parseCredentials(secret as string | null);
    if (credentials) {
      config = {
        ...credentials,
        mailbox: row.default_mailbox,
        key: `tenant:${row.id}:v${row.credentials_version}`,
        label: row.label,
      };
    }
  }
  configCache.set(tenantId, { at: Date.now(), config });
  return config;
}

/** Drop this isolate's copy of a tenant — after it is changed, or all of them. */
export function forgetTenantConfig(tenantId?: string | null): void {
  if (tenantId) configCache.delete(tenantId);
  else configCache.clear();
}

/** Why a tenant cannot be used, in words, or null when it can. */
export async function tenantProblem(tenantId: string | null | undefined): Promise<string | null> {
  if (!tenantId) {
    return defaultGraphConfig()
      ? null
      : "Microsoft Graph is not configured on this deployment — set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET, or choose an added tenant";
  }
  const { data: row, error } = await supabaseAdmin
    .from("microsoft_tenants")
    .select("label, removed_at, vault_secret_id")
    .eq("id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!row) return "the Microsoft tenant this campaign used no longer exists — choose another";
  if (row.removed_at) {
    return `the Microsoft tenant "${row.label}" was removed — choose another tenant on the Message tab`;
  }
  if (!row.vault_secret_id || !(await graphConfigFor(tenantId))) {
    return `the credentials for "${row.label}" are missing — re-enter them under Microsoft tenants`;
  }
  return null;
}

/** A tenant's credentials, or a `GraphError` saying why there are none. */
export async function requireGraphConfigFor(
  tenantId: string | null | undefined,
): Promise<GraphConfig> {
  const config = await graphConfigFor(tenantId);
  if (config) return config;
  throw new GraphError(
    (await tenantProblem(tenantId)) ?? "Microsoft Graph is not configured",
    0,
    "not_configured",
  );
}

/** How a tenant is named in a sentence. */
export function tenantName(config: GraphConfig | null): string {
  return config?.label ?? DEFAULT_TENANT_LABEL;
}

// ── Verification ─────────────────────────────────────────────────────────────

export type Verification = {
  ok: boolean;
  error: string | null;
  roles: string[] | null;
  capabilities: GraphCapabilities;
};

/** Ask Microsoft for a token with these credentials, now. */
export async function verifyCredentials(config: GraphConfig): Promise<Verification> {
  forgetToken(config);
  try {
    const roles = tokenRoles(await accessToken(config));
    return { ok: true, error: null, roles, capabilities: capabilitiesFrom(roles) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      roles: null,
      capabilities: capabilitiesFrom(null),
    };
  }
}

/** Whether a tenant's credentials can use one mailbox, asked fresh. */
async function probeOne(
  config: GraphConfig,
  address: string,
  capabilities: GraphCapabilities,
): Promise<MailboxAccess> {
  const [probe] = await probeMailboxes([address], config);
  if (!probe || probe.code === "token") {
    return { state: "unknown", reason: "Microsoft did not answer" };
  }
  return qualifyAccess(describeMailboxAccess(probe.status, probe.code), capabilities);
}

async function refuseUnusableMailbox(
  config: GraphConfig,
  mailbox: string,
  capabilities: GraphCapabilities,
): Promise<void> {
  const access = await probeOne(config, mailbox, capabilities);
  if (access.state === "denied" || access.state === "no_mailbox") {
    throw new Error(`${mailbox} cannot be used with these credentials: ${access.reason}`);
  }
}

async function fingerprintOf(
  credentials: Pick<TenantCredentials, "tenantId" | "clientId">,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(fingerprintSource(credentials)));
}

async function assertNotRegistered(
  credentials: TenantCredentials,
  fingerprint: string,
  exceptId: string | null,
): Promise<void> {
  const own = defaultGraphConfig();
  if (own && fingerprintSource(own) === fingerprintSource(credentials)) {
    throw new Error(
      "these are the deployment's own credentials — that tenant is already available as the default",
    );
  }
  let query = supabaseAdmin
    .from("microsoft_tenants")
    .select("id, label")
    .eq("fingerprint", fingerprint)
    .is("removed_at", null);
  if (exceptId) query = query.neq("id", exceptId);
  const { data, error } = await query;
  if (error) throw error;
  if ((data ?? []).length > 0) {
    throw new Error(`this application registration is already added as "${data![0].label}"`);
  }
}

/**
 * Refuse a name another live tenant already has — asked before anything is
 * stored, so a clash cannot leave new credentials in the Vault behind a
 * rename that failed. The unique index stays the authority; this is so a
 * person's typo never gets as far as it.
 */
async function assertNameFree(label: string, exceptId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("microsoft_tenants")
    .select("id, label")
    .is("removed_at", null)
    .neq("id", exceptId);
  if (error) throw error;
  const wanted = label.trim().toLowerCase();
  if ((data ?? []).some((other) => other.label.trim().toLowerCase() === wanted)) {
    throw new Error(tenantErrorMessage("microsoft_tenants_label_live"));
  }
}

// ── Listing ──────────────────────────────────────────────────────────────────

export type TenantSummary = {
  /** null is the deployment's own tenant. */
  id: string | null;
  label: string;
  isDefault: boolean;
  /** Whether it has credentials to send with. */
  configured: boolean;
  defaultMailbox: string | null;
  hints: CredentialHints | null;
  secretExpiresOn: string | null;
  expiry: SecretExpiry;
  verifiedAt: string | null;
  verifyError: string | null;
  grantedRoles: string[] | null;
  /** Campaigns that send through it, by status. */
  campaigns: { running: number; other: number };
  createdAt: string | null;
};

/**
 * Every tenant a campaign can choose, the deployment's own first. Hints only:
 * the deployment's own are worked out from its environment here, and an added
 * tenant's were written beside it when its credentials were stored.
 */
export async function listTenants(): Promise<TenantSummary[]> {
  const [{ data: rows, error }, { data: campaigns, error: campaignError }] = await Promise.all([
    supabaseAdmin
      .from("microsoft_tenants")
      .select("*")
      .is("removed_at", null)
      .order("created_at", { ascending: true }),
    supabaseAdmin.from("email_campaigns").select("tenant_id, status"),
  ]);
  if (error) throw error;
  if (campaignError) throw campaignError;

  const usage = new Map<string, { running: number; other: number }>();
  for (const row of campaigns ?? []) {
    const key = (row.tenant_id as string | null) ?? "default";
    const entry = usage.get(key) ?? { running: 0, other: 0 };
    if (row.status === "running") entry.running += 1;
    else if (row.status !== "completed" && row.status !== "cancelled") entry.other += 1;
    usage.set(key, entry);
  }

  const now = new Date();
  const own = defaultGraphConfig();
  const summaries: TenantSummary[] = [
    {
      id: null,
      label: DEFAULT_TENANT_LABEL,
      isDefault: true,
      configured: own !== null,
      defaultMailbox: own?.mailbox ? emailKey(own.mailbox) : null,
      hints: own ? credentialHints(own) : null,
      secretExpiresOn: null,
      expiry: null,
      verifiedAt: null,
      verifyError: null,
      grantedRoles: null,
      campaigns: usage.get("default") ?? { running: 0, other: 0 },
      createdAt: null,
    },
  ];
  for (const row of (rows ?? []) as TenantRow[]) {
    summaries.push({
      id: row.id,
      label: row.label,
      isDefault: false,
      configured: Boolean(row.vault_secret_id),
      defaultMailbox: row.default_mailbox,
      hints: { directory: row.directory_hint, client: row.client_hint, secret: row.secret_hint },
      secretExpiresOn: row.secret_expires_on,
      expiry: secretExpiry(row.secret_expires_on, now),
      verifiedAt: row.verified_at,
      verifyError: row.verify_error,
      grantedRoles: row.granted_roles,
      campaigns: usage.get(row.id) ?? { running: 0, other: 0 },
      createdAt: row.created_at,
    });
  }
  return summaries;
}

// ── Writes (admin-gated by the server functions that call these) ────────────

async function audit(
  action: string,
  tenantId: string,
  actorUserId: string,
  metadata: Record<string, unknown>,
) {
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action,
    entityType: "microsoft_tenant",
    entityId: tenantId,
    actorUserId,
    metadata,
  });
}

/** Add a tenant: check the input, try the credentials, then store them. */
export async function addTenant(
  input: TenantInput,
  actorUserId: string,
): Promise<{ id: string; verification: Verification }> {
  const problems = tenantInputProblems(input);
  if (problems.length > 0) throw new Error(problems.join("; "));

  const credentials = credentialsFrom(input);
  const fingerprint = await fingerprintOf(credentials);
  await assertNotRegistered(credentials, fingerprint, null);

  const label = input.label.trim();
  const mailbox = input.defaultMailbox?.trim() ? emailKey(input.defaultMailbox) : null;
  const trial: GraphConfig = { ...credentials, mailbox, key: `trial:${fingerprint}`, label };
  const verification = await verifyCredentials(trial);
  forgetToken(trial);
  if (!verification.ok)
    throw new Error(verification.error ?? "Microsoft did not accept these credentials");
  if (mailbox) await refuseUnusableMailbox(trial, mailbox, verification.capabilities);

  const hints = credentialHints(credentials);
  const { data: row, error } = await supabaseAdmin
    .from("microsoft_tenants")
    .insert({
      label,
      default_mailbox: mailbox,
      directory_hint: hints.directory,
      client_hint: hints.client,
      secret_hint: hints.secret,
      secret_expires_on: input.secretExpiresOn || null,
      fingerprint,
      granted_roles: verification.roles,
      verified_at: new Date().toISOString(),
      created_by: actorUserId,
    })
    .select("id")
    .single();
  if (error) throw new Error(tenantErrorMessage(error.message));

  const { error: putError } = await supabaseAdmin.rpc("microsoft_tenant_credentials_put", {
    p_tenant: row.id,
    p_credentials: JSON.stringify(credentials),
  });
  if (putError) {
    // Without its credentials the row is a tenant that can never send. Take
    // it back out rather than leave a trap in the picker.
    const { error: undoError } = await supabaseAdmin
      .from("microsoft_tenants")
      .delete()
      .eq("id", row.id);
    if (undoError)
      console.error(
        "[tenants] could not remove a tenant whose credentials failed to store:",
        undoError.message,
      );
    throw new Error(`the credentials could not be stored: ${putError.message}`);
  }

  await audit("microsoft_tenant_added", row.id, actorUserId, {
    label,
    hints,
    defaultMailbox: mailbox,
  });
  return { id: row.id, verification };
}

export type TenantChange = Partial<Omit<TenantInput, "defaultMailbox" | "secretExpiresOn">> & {
  defaultMailbox?: string | null;
  secretExpiresOn?: string | null;
};

/**
 * Change a tenant. Credentials are replaced only when new values are given —
 * a secret left blank keeps the stored one, exactly as a deployment secret
 * does — and replaced credentials are tried before they are stored.
 *
 * The Vault and the row are two writes. A new name is checked before either,
 * and if the row still cannot be saved once new credentials are in, the
 * previous ones are put back: a refused change leaves the tenant as it was,
 * not sending with a secret its hints do not describe.
 */
export async function updateTenant(
  tenantId: string,
  change: TenantChange,
  actorUserId: string,
): Promise<{ verification: Verification | null }> {
  const { data: row, error } = await supabaseAdmin
    .from("microsoft_tenants")
    .select("*")
    .eq("id", tenantId)
    .is("removed_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new Error("that tenant does not exist or was removed");

  const newCredentialValues = [change.directoryTenantId, change.clientId, change.clientSecret].some(
    (value) => typeof value === "string" && value.trim() !== "",
  );
  const problems = tenantInputProblems(
    {
      ...(change.label !== undefined ? { label: change.label } : {}),
      defaultMailbox: change.defaultMailbox ?? null,
      secretExpiresOn: change.secretExpiresOn ?? null,
    },
    { requireCredentials: false },
  );
  if (problems.length > 0) throw new Error(problems.join("; "));

  const patch: Database["public"]["Tables"]["microsoft_tenants"]["Update"] = {
    updated_at: new Date().toISOString(),
  };
  if (change.label !== undefined) patch.label = change.label.trim();
  if (patch.label !== undefined && patch.label.toLowerCase() !== row.label.trim().toLowerCase()) {
    await assertNameFree(patch.label, tenantId);
  }
  if (change.secretExpiresOn !== undefined)
    patch.secret_expires_on = change.secretExpiresOn || null;
  const mailbox =
    change.defaultMailbox === undefined
      ? row.default_mailbox
      : change.defaultMailbox?.trim()
        ? emailKey(change.defaultMailbox)
        : null;
  if (change.defaultMailbox !== undefined) patch.default_mailbox = mailbox;

  let verification: Verification | null = null;
  let credentials: TenantCredentials | null = null;
  // What the Vault held before, to put back if the row cannot follow.
  let previous: TenantCredentials | null = null;
  if (newCredentialValues) {
    // Read from the Vault, not this isolate's minute-old copy: these are the
    // values blank fields keep and a failed save puts back.
    forgetTenantConfig(tenantId);
    const current = await graphConfigFor(tenantId);
    previous = current
      ? {
          tenantId: current.tenantId,
          clientId: current.clientId,
          clientSecret: current.clientSecret,
        }
      : null;
    const merged = {
      directoryTenantId: change.directoryTenantId?.trim() || current?.tenantId || "",
      clientId: change.clientId?.trim() || current?.clientId || "",
      clientSecret: change.clientSecret?.trim() || current?.clientSecret || "",
    };
    const credentialProblems = tenantInputProblems(
      { ...merged, label: change.label ?? row.label },
      { requireCredentials: true },
    );
    if (credentialProblems.length > 0) throw new Error(credentialProblems.join("; "));
    credentials = credentialsFrom(merged);
    const fingerprint = await fingerprintOf(credentials);
    await assertNotRegistered(credentials, fingerprint, tenantId);

    const trial: GraphConfig = {
      ...credentials,
      mailbox,
      key: `trial:${fingerprint}`,
      label: patch.label ?? row.label,
    };
    verification = await verifyCredentials(trial);
    forgetToken(trial);
    if (!verification.ok)
      throw new Error(verification.error ?? "Microsoft did not accept these credentials");
    if (mailbox && change.defaultMailbox !== undefined) {
      await refuseUnusableMailbox(trial, mailbox, verification.capabilities);
    }

    const hints = credentialHints(credentials);
    patch.directory_hint = hints.directory;
    patch.client_hint = hints.client;
    patch.secret_hint = hints.secret;
    patch.fingerprint = fingerprint;
    patch.granted_roles = verification.roles;
    patch.verified_at = new Date().toISOString();
    patch.verify_error = null;
  } else if (mailbox && change.defaultMailbox !== undefined) {
    const config = await requireGraphConfigFor(tenantId);
    const check = await verifyCredentials(config);
    if (check.ok) await refuseUnusableMailbox(config, mailbox, check.capabilities);
  }

  // The new credentials go in first: a row whose hints describe a secret the
  // Vault does not hold would be worse than a rename that did not happen.
  if (credentials) {
    const { error: putError } = await supabaseAdmin.rpc("microsoft_tenant_credentials_put", {
      p_tenant: tenantId,
      p_credentials: JSON.stringify(credentials),
    });
    if (putError) throw new Error(`the credentials could not be stored: ${putError.message}`);
  }
  const { error: updateError } = await supabaseAdmin
    .from("microsoft_tenants")
    .update(patch)
    .eq("id", tenantId);
  if (updateError) {
    const reason = tenantErrorMessage(updateError.message);
    // The row could not follow the Vault. Put the old credentials back, so
    // "nothing was saved" stays true and the hints describe what is in use.
    if (credentials) {
      const restored = previous
        ? await supabaseAdmin.rpc("microsoft_tenant_credentials_put", {
            p_tenant: tenantId,
            p_credentials: JSON.stringify(previous),
          })
        : { error: { message: "there were no previous credentials to restore" } };
      forgetTenantConfig(tenantId);
      if (restored.error) {
        console.error(
          "[tenants] could not restore credentials after a failed update:",
          restored.error.message,
        );
        throw new Error(
          `the new credentials were stored but the tenant's details could not be (${reason}), and the previous credentials could not be put back — save the tenant again`,
        );
      }
    }
    throw new Error(reason);
  }
  forgetTenantConfig(tenantId);

  // The names of what changed, never a value: the secret is in this object.
  const fields = Object.entries(change)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key]) => key);
  await audit("microsoft_tenant_updated", tenantId, actorUserId, {
    fields,
    hints: credentials ? credentialHints(credentials) : undefined,
  });
  return { verification };
}

/** Try a tenant's stored credentials again and record the answer. */
export async function verifyTenant(tenantId: string | null): Promise<Verification> {
  forgetTenantConfig(tenantId);
  const config = await graphConfigFor(tenantId);
  const verification: Verification = config
    ? await verifyCredentials(config)
    : {
        ok: false,
        error: (await tenantProblem(tenantId)) ?? "no credentials",
        roles: null,
        capabilities: capabilitiesFrom(null),
      };
  if (tenantId) {
    const { error } = await supabaseAdmin
      .from("microsoft_tenants")
      .update({
        verified_at: verification.ok ? new Date().toISOString() : undefined,
        verify_error: verification.ok ? null : verification.error,
        granted_roles: verification.ok ? verification.roles : undefined,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tenantId);
    if (error) throw error;
  }
  return verification;
}

/** Remove a tenant: its Vault secret is destroyed, its row kept for the record. */
export async function removeTenant(tenantId: string, actorUserId: string): Promise<void> {
  const { data: row, error: rowError } = await supabaseAdmin
    .from("microsoft_tenants")
    .select("label, directory_hint, client_hint")
    .eq("id", tenantId)
    .maybeSingle();
  if (rowError) throw rowError;
  const { error } = await supabaseAdmin.rpc("microsoft_tenant_remove", {
    p_tenant: tenantId,
    p_actor: actorUserId,
  });
  if (error) throw new Error(tenantErrorMessage(error.message));
  forgetTenantConfig(tenantId);
  await audit("microsoft_tenant_removed", tenantId, actorUserId, {
    label: row?.label ?? null,
    hints: row ? { directory: row.directory_hint, client: row.client_hint } : null,
  });
}
