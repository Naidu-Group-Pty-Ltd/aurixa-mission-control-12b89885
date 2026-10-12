/**
 * Microsoft tenants a campaign can send through — the rules, without I/O.
 *
 * The deployment's own tenant is the one in its secrets (MICROSOFT_TENANT_ID,
 * MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_MAILBOX_EMAIL). More
 * can be added from the console; their credentials go to Supabase Vault and,
 * like a deployment secret, are written and never read back to a browser.
 * What the console shows instead is a HINT of each value: the last four
 * characters of the two IDs, and the first three of the secret — the hint the
 * Azure portal shows beside a client secret, so the right one can be found
 * there when it is time to rotate it.
 *
 * `null` is the deployment's own tenant everywhere: on a campaign, on a
 * message, in a function argument.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A verified domain stands in for a tenant ID: contoso.onmicrosoft.com, contoso.com.au. */
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const LABEL_MAX = 80;
export const SECRET_MAX = 512;
/** Warn this many days before a client secret expires. */
export const EXPIRY_WARNING_DAYS = 30;

/** What an admin types to add a tenant. */
export type TenantInput = {
  label: string;
  directoryTenantId: string;
  clientId: string;
  clientSecret: string;
  defaultMailbox?: string | null;
  /** YYYY-MM-DD, when the client secret expires. Optional. */
  secretExpiresOn?: string | null;
};

/** What goes into the Vault, as JSON. */
export type TenantCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

export function isGuid(value: string): boolean {
  return GUID.test(value.trim());
}

/** A tenant may be named by its ID or by one of its verified domains. */
export function isDirectoryTenantId(value: string): boolean {
  const trimmed = value.trim();
  return GUID.test(trimmed) || DOMAIN.test(trimmed);
}

/**
 * Every reason this input cannot be saved, in words, or an empty list. Each
 * is phrased as what to fix, because it is shown beside the form.
 */
export function tenantInputProblems(
  input: Partial<TenantInput>,
  options: { requireCredentials: boolean } = { requireCredentials: true },
): string[] {
  const problems: string[] = [];
  if (input.label !== undefined || options.requireCredentials) {
    const label = (input.label ?? "").trim();
    if (!label) problems.push("give the tenant a name");
    else if (label.length > LABEL_MAX) problems.push(`keep the name under ${LABEL_MAX} characters`);
  }

  const credentialFields = [input.directoryTenantId, input.clientId, input.clientSecret];
  const anyCredential = credentialFields.some((value) => value !== undefined && value !== "");
  if (options.requireCredentials || anyCredential) {
    const tenant = (input.directoryTenantId ?? "").trim();
    if (!tenant) problems.push("enter the Directory (tenant) ID");
    else if (!isDirectoryTenantId(tenant)) {
      problems.push(
        "the Directory (tenant) ID is a GUID like 00000000-0000-0000-0000-000000000000, or one of the tenant's domains",
      );
    }
    const client = (input.clientId ?? "").trim();
    if (!client) problems.push("enter the Application (client) ID");
    else if (!isGuid(client)) {
      problems.push(
        "the Application (client) ID is a GUID like 00000000-0000-0000-0000-000000000000",
      );
    }
    const secret = input.clientSecret ?? "";
    if (!secret.trim()) problems.push("enter the client secret's Value");
    else if (/\s/.test(secret.trim())) {
      problems.push("the client secret has a space in it — copy its Value again from Azure");
    } else if (secret.trim().length > SECRET_MAX) problems.push("that client secret is too long");
    else if (isGuid(secret.trim())) {
      // The most common mistake in the Azure portal: the Secret ID column sits
      // beside the Value column and looks just as official.
      problems.push(
        "that looks like the secret's ID, not its Value — Azure shows the Value only once, when the secret is created",
      );
    }
  }

  if (input.defaultMailbox && !EMAIL.test(input.defaultMailbox.trim())) {
    problems.push("the default mailbox is not a valid email address");
  }
  if (input.secretExpiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.secretExpiresOn)) {
    problems.push("the expiry date should be a date");
  }
  return problems;
}

/**
 * What is wrong with an edit, judging only the fields that were filled in: a
 * credential left blank keeps the stored one, so blank is not a problem here
 * the way it is when a tenant is added.
 */
export function tenantChangeProblems(change: Partial<TenantInput>): string[] {
  const problems = tenantInputProblems(
    {
      ...(change.label !== undefined ? { label: change.label } : {}),
      defaultMailbox: change.defaultMailbox ?? null,
      secretExpiresOn: change.secretExpiresOn ?? null,
    },
    { requireCredentials: false },
  );
  const directory = change.directoryTenantId?.trim();
  if (directory && !isDirectoryTenantId(directory)) {
    problems.push(
      "the Directory (tenant) ID is a GUID like 00000000-0000-0000-0000-000000000000, or one of the tenant's domains",
    );
  }
  const client = change.clientId?.trim();
  if (client && !isGuid(client)) {
    problems.push(
      "the Application (client) ID is a GUID like 00000000-0000-0000-0000-000000000000",
    );
  }
  const secret = change.clientSecret?.trim();
  if (secret) {
    if (/\s/.test(secret)) {
      problems.push("the client secret has a space in it — copy its Value again from Azure");
    } else if (secret.length > SECRET_MAX) problems.push("that client secret is too long");
    else if (isGuid(secret)) {
      problems.push(
        "that looks like the secret's ID, not its Value — Azure shows the Value only once, when the secret is created",
      );
    }
  }
  return problems;
}

/** The credentials as they are stored: trimmed, IDs lower-cased. */
export function credentialsFrom(
  input: Pick<TenantInput, "directoryTenantId" | "clientId" | "clientSecret">,
): TenantCredentials {
  return {
    tenantId: input.directoryTenantId.trim().toLowerCase(),
    clientId: input.clientId.trim().toLowerCase(),
    clientSecret: input.clientSecret.trim(),
  };
}

/** What the Vault holds, read back without trusting its shape. */
export function parseCredentials(value: string | null | undefined): TenantCredentials | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TenantCredentials>;
    if (
      typeof parsed.tenantId === "string" &&
      typeof parsed.clientId === "string" &&
      typeof parsed.clientSecret === "string" &&
      parsed.tenantId &&
      parsed.clientId &&
      parsed.clientSecret
    ) {
      return {
        tenantId: parsed.tenantId,
        clientId: parsed.clientId,
        clientSecret: parsed.clientSecret,
      };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export type CredentialHints = { directory: string; client: string; secret: string };

/** Enough of each value to tell registrations apart. Never the value. */
export function credentialHints(credentials: TenantCredentials): CredentialHints {
  const tail = (value: string) => `…${value.slice(-4)}`;
  return {
    directory: tail(credentials.tenantId),
    client: tail(credentials.clientId),
    secret: `${credentials.clientSecret.slice(0, 3)}…`,
  };
}

/** The text hashed into `microsoft_tenants.fingerprint`. One row per app registration. */
export function fingerprintSource(
  credentials: Pick<TenantCredentials, "tenantId" | "clientId">,
): string {
  return `${credentials.tenantId.trim().toLowerCase()}:${credentials.clientId.trim().toLowerCase()}`;
}

export type SecretExpiry = "expired" | "soon" | "ok" | null;

/** Whether a client secret has expired, or will within the warning window. */
export function secretExpiry(expiresOn: string | null | undefined, now: Date): SecretExpiry {
  if (!expiresOn) return null;
  const end = Date.parse(`${expiresOn}T23:59:59Z`);
  if (!Number.isFinite(end)) return null;
  if (end < now.getTime()) return "expired";
  if (end - now.getTime() <= EXPIRY_WARNING_DAYS * 86_400_000) return "soon";
  return "ok";
}

/** The key a tenant is cached and grouped under. */
export function tenantKey(tenantId: string | null | undefined): string {
  return tenantId ? `tenant:${tenantId}` : "default";
}

/** Two tenant references name the same tenant (null and undefined are the default). */
export function sameTenant(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * Why Microsoft refused a token request, from the AADSTS codes it returned —
 * said as what to fix, because the person reading it is usually looking at
 * the form they just filled in. Null for a code with nothing useful to add.
 *
 * Only the codes: Microsoft's own description names the tenant and the
 * application, and is logged rather than shown.
 */
export function explainTokenRefusal(codes: readonly number[] | null | undefined): string | null {
  for (const code of codes ?? []) {
    switch (code) {
      case 7000215:
        return "the client secret is wrong — paste the secret's Value (shown once, when it was created), not its Secret ID";
      case 7000222:
        return "the client secret has expired — create a new one under Certificates & secrets and enter its Value";
      case 700016:
        return "no application with that Application (client) ID exists in that directory — check both IDs on the app registration's Overview page";
      case 90002:
      case 900023:
      case 90023:
        return "no Microsoft directory has that Directory (tenant) ID";
      case 7000112:
        return "the application is disabled in that directory";
      case 7000229:
        return "the application has no service principal in that directory — an administrator of that tenant must consent to it first";
      case 53003:
        return "a Conditional Access policy in that directory blocked the sign-in";
      case 700027:
      case 700023:
        return "Microsoft did not accept the client credential — check the client secret's Value";
    }
  }
  return null;
}

/** What the database raised, said in words. */
export function tenantErrorMessage(raw: string): string {
  if (raw.includes("microsoft_tenant_in_use")) {
    return "a running campaign sends through this tenant — pause it, or move it to another tenant, first";
  }
  if (raw.includes("microsoft_tenant_warming")) {
    return "mailboxes in this tenant are enrolled in email warmup — remove them from warmup first";
  }
  if (raw.includes("microsoft_tenant_not_found"))
    return "that tenant does not exist or was removed";
  if (raw.includes("microsoft_tenants_fingerprint_live")) {
    return "this application registration is already added";
  }
  if (raw.includes("microsoft_tenants_label_live")) return "another tenant already has that name";
  return raw;
}
