/**
 * A tenant's mailboxes, and which of them this deployment may send from.
 *
 * `src/lib/email/mailboxes.pure.ts` carries the reasoning; this is the I/O:
 * the directory listing, the reachability probes, and the mailboxes this
 * deployment already knows about from its own campaigns and message ledger.
 *
 * Every question is asked of ONE tenant — `null` for the deployment's own,
 * or an added tenant's id (see `microsoft-tenants.server.ts`). A mailbox one
 * tenant may use says nothing about another, so every cache is kept per
 * tenant, and per version of its credentials: a rotated secret starts fresh.
 *
 * ## Caching
 *
 * Per isolate, five minutes, for both the directory and each probe. The page
 * asks on every open and the readiness check every thirty seconds; neither
 * needs a fresher answer than that, and a tenant with a thousand users should
 * not cost fifty Graph batches a minute. An "unknown" probe (throttled, timed
 * out) is never cached — it is not an answer. Every caller that is about to
 * act on an answer — saving a campaign's mailbox — asks `fresh`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  capabilitiesFrom,
  describeMailboxAccess,
  mailboxesFromDirectory,
  mergeMailboxOptions,
  qualifyAccess,
  type DirectoryMailbox,
  type GraphCapabilities,
  type MailboxAccess,
  type MailboxOption,
  type MailboxSource,
} from "@/lib/email/mailboxes.pure";
import { tenantKey } from "@/lib/email/microsoftTenants.pure";
import {
  GraphError,
  grantedRoles,
  listDirectoryUsers,
  probeMailboxes,
  type GraphConfig,
} from "@/server/graph-client";
import { graphConfigFor, tenantProblem } from "@/server/microsoft-tenants.server";

const TTL_MS = 5 * 60_000;
/** Directory entries read at most. Past this the picker says it is a partial list. */
const MAX_DIRECTORY = 2000;
/** Mailboxes probed up front; any other is probed when somebody picks it. */
const MAX_PROBES = 200;
/** How far back a mailbox that has sent still counts as one this deployment uses. */
export const SENDING_HISTORY_DAYS = 30;

export type DirectoryRead = {
  readable: boolean;
  error: string | null;
  mailboxes: DirectoryMailbox[];
  truncated: boolean;
};

/** Which tenant, and whether to ask Microsoft again rather than remember. */
export type TenantQuery = { tenantId?: string | null; force?: boolean };

/** Keyed `<tenant config key>|<address>`. */
const accessCache = new Map<string, { at: number; access: MailboxAccess }>();
/** Keyed by tenant config key. */
const directoryCache = new Map<string, { at: number; value: DirectoryRead }>();
const capabilityCache = new Map<string, { at: number; value: GraphCapabilities }>();

const fresh = (at: number) => Date.now() - at < TTL_MS;
const scopeOf = (config: GraphConfig) => config.key ?? "default";

/** Forget what a tenant's token was granted, so the next question asks again. */
export function forgetGraphCapabilities(tenantId: string | null | undefined): void {
  const prefix = tenantKey(tenantId);
  for (const key of capabilityCache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) capabilityCache.delete(key);
  }
}

/** A tenant's mailboxes from the directory, or why they cannot be listed. */
export async function readDirectory({
  tenantId = null,
  force = false,
}: TenantQuery = {}): Promise<DirectoryRead> {
  const config = await graphConfigFor(tenantId);
  if (!config) {
    return {
      readable: false,
      error: await tenantProblem(tenantId),
      mailboxes: [],
      truncated: false,
    };
  }
  const scope = scopeOf(config);
  const cached = directoryCache.get(scope);
  if (!force && cached && fresh(cached.at)) return cached.value;
  let value: DirectoryRead;
  try {
    const { users, truncated } = await listDirectoryUsers(MAX_DIRECTORY, config);
    value = { readable: true, error: null, mailboxes: mailboxesFromDirectory(users), truncated };
  } catch (error) {
    const denied = error instanceof GraphError && (error.status === 403 || error.status === 401);
    value = {
      readable: false,
      error: denied
        ? "this application may not list the tenant's users — grant it the User.ReadBasic.All application permission (or User.Read.All) to choose from every mailbox; meanwhile the mailboxes this deployment already uses are offered, and any address can be entered and checked"
        : `the tenant's users could not be listed: ${error instanceof Error ? error.message : String(error)}`,
      mailboxes: [],
      truncated: false,
    };
    // A transient failure is not cached; a refusal is, so the page does not
    // ask Microsoft for a 403 every time it opens.
    if (!denied) return value;
  }
  directoryCache.set(scope, { at: Date.now(), value });
  return value;
}

/**
 * Whether each address can be used by a tenant's credentials, probing what is
 * not already known. A tenant with no usable credentials gets no answers.
 */
export async function checkMailboxes(
  addresses: string[],
  { tenantId = null, force = false }: TenantQuery = {},
): Promise<Map<string, MailboxAccess>> {
  const out = new Map<string, MailboxAccess>();
  const config = await graphConfigFor(tenantId);
  if (!config) return out;
  const scope = scopeOf(config);
  const toProbe: string[] = [];
  for (const raw of addresses) {
    const key = emailKey(raw);
    if (!key || out.has(key) || toProbe.includes(key)) continue;
    const cached = accessCache.get(`${scope}|${key}`);
    if (!force && cached && fresh(cached.at)) out.set(key, cached.access);
    else toProbe.push(key);
  }
  if (toProbe.length === 0) return out;

  const capabilities = await graphCapabilities({ tenantId });
  for (const probe of await probeMailboxes(toProbe, config)) {
    const access: MailboxAccess =
      probe.code === "token"
        ? {
            state: "unknown",
            reason: "this deployment could not obtain a Microsoft token to check",
          }
        : qualifyAccess(describeMailboxAccess(probe.status, probe.code), capabilities);
    out.set(probe.address, access);
    if (access.state !== "unknown") {
      accessCache.set(`${scope}|${probe.address}`, { at: Date.now(), access });
    }
  }
  return out;
}

/** One address, for one tenant. */
export async function checkMailbox(
  address: string,
  query: TenantQuery = {},
): Promise<MailboxAccess> {
  const key = emailKey(address);
  if (!key) return { state: "no_mailbox", reason: "that is not a valid email address" };
  if (!(await graphConfigFor(query.tenantId))) {
    return {
      state: "unknown",
      reason: (await tenantProblem(query.tenantId)) ?? "Microsoft Graph is not configured",
    };
  }
  return (
    (await checkMailboxes([key], query)).get(key) ?? {
      state: "unknown",
      reason: "Microsoft did not answer",
    }
  );
}

/** What a tenant's token says its application was granted. Advisory. */
export async function graphCapabilities({
  tenantId = null,
  force = false,
}: TenantQuery = {}): Promise<GraphCapabilities> {
  const config = await graphConfigFor(tenantId);
  if (!config) return capabilitiesFrom(null);
  const scope = scopeOf(config);
  const cached = capabilityCache.get(scope);
  if (!force && cached && fresh(cached.at)) return cached.value;
  let value: GraphCapabilities;
  try {
    value = capabilitiesFrom(await grantedRoles(config));
  } catch {
    // No token at all is reported by whatever tried to send; here it only
    // means the page cannot say what was granted.
    return capabilitiesFrom(null);
  }
  capabilityCache.set(scope, { at: Date.now(), value });
  return value;
}

export type KnownMailbox = { address: string; source: MailboxSource; tenantId: string | null };

/**
 * Mailboxes this deployment already uses: those campaigns name, and those
 * messages have actually left from recently — each with the tenant it was
 * used through. Read with whichever client the caller holds — an operator's
 * own, or the service role for the bounce scan.
 *
 * `tenantId` narrows to one tenant (`null` the deployment's own); leaving it
 * out returns every tenant's.
 */
export async function knownMailboxes(
  client: SupabaseClient<Database>,
  options: { includeDrafts?: boolean; tenantId?: string | null } = {},
): Promise<KnownMailbox[]> {
  const narrow = "tenantId" in options && options.tenantId !== undefined;
  let campaigns = client
    .from("email_campaigns")
    .select("from_mailbox, tenant_id")
    .not("from_mailbox", "is", null);
  if (!options.includeDrafts) campaigns = campaigns.neq("status", "draft");
  const since = new Date(Date.now() - SENDING_HISTORY_DAYS * 86_400_000).toISOString();
  let sent = client
    .from("email_campaign_sending_mailboxes")
    .select("mailbox, tenant_id")
    .gte("last_used_at", since);
  if (narrow) {
    if (options.tenantId) {
      campaigns = campaigns.eq("tenant_id", options.tenantId);
      sent = sent.eq("tenant_id", options.tenantId);
    } else {
      campaigns = campaigns.is("tenant_id", null);
      sent = sent.is("tenant_id", null);
    }
  }
  const [named, used] = await Promise.all([campaigns, sent]);
  if (named.error) throw named.error;
  if (used.error) throw used.error;

  const out: KnownMailbox[] = [];
  for (const row of named.data ?? []) {
    const address = emailKey(String(row.from_mailbox ?? ""));
    if (address) out.push({ address, source: "campaign", tenantId: row.tenant_id ?? null });
  }
  for (const row of used.data ?? []) {
    const address = emailKey(String(row.mailbox ?? ""));
    if (address) out.push({ address, source: "history", tenantId: row.tenant_id ?? null });
  }
  return out;
}

export type MailboxDirectory = {
  tenantId: string | null;
  configured: boolean;
  /** Why the tenant cannot be used, when it cannot. */
  problem: string | null;
  defaultMailbox: string | null;
  directory: { readable: boolean; error: string | null; truncated: boolean; count: number };
  options: MailboxOption[];
  /** Mailboxes listed but not checked yet — checked when chosen. */
  unchecked: number;
  capabilities: GraphCapabilities;
};

/** Everything the mailbox picker shows, for one tenant. */
export async function mailboxDirectory(
  client: SupabaseClient<Database>,
  { tenantId = null, force = false }: TenantQuery = {},
): Promise<MailboxDirectory> {
  const config = await graphConfigFor(tenantId);
  const fallbackDefault = config?.mailbox ?? null;
  if (!config) {
    return {
      tenantId,
      configured: false,
      problem: await tenantProblem(tenantId),
      defaultMailbox: null,
      directory: { readable: false, error: null, truncated: false, count: 0 },
      options: [],
      unchecked: 0,
      capabilities: capabilitiesFrom(null),
    };
  }

  const scope = scopeOf(config);
  const [directory, known, capabilities] = await Promise.all([
    readDirectory({ tenantId, force }),
    knownMailboxes(client, { includeDrafts: true, tenantId }),
    graphCapabilities({ tenantId, force }),
  ]);

  // The ones that matter most are checked first: the default, the ones this
  // deployment uses, then the directory in name order.
  const ordered: string[] = [];
  const push = (raw: string | null | undefined) => {
    const key = raw ? emailKey(raw) : null;
    if (key && !ordered.includes(key)) ordered.push(key);
  };
  push(fallbackDefault);
  for (const entry of known) push(entry.address);
  for (const mailbox of directory.mailboxes) push(mailbox.address);

  const access = await checkMailboxes(ordered.slice(0, MAX_PROBES), { tenantId, force });
  // Beyond the probe budget, show whatever an earlier check already knows.
  for (const address of ordered.slice(MAX_PROBES)) {
    const cached = accessCache.get(`${scope}|${address}`);
    if (cached && fresh(cached.at)) access.set(address, cached.access);
  }

  const options = mergeMailboxOptions({
    defaultMailbox: fallbackDefault,
    directory: directory.mailboxes,
    known,
    access,
  });

  return {
    tenantId,
    configured: true,
    problem: null,
    defaultMailbox: fallbackDefault ? emailKey(fallbackDefault) : null,
    directory: {
      readable: directory.readable,
      error: directory.error,
      truncated: directory.truncated,
      count: directory.mailboxes.length,
    },
    options,
    unchecked: options.filter((option) => !option.access).length,
    capabilities,
  };
}

/** A display name for an address, when the tenant's directory has one. */
export async function displayNameFor(
  address: string,
  tenantId: string | null = null,
): Promise<string | null> {
  const key = emailKey(address);
  if (!key) return null;
  const directory = await readDirectory({ tenantId });
  return directory.mailboxes.find((mailbox) => mailbox.address === key)?.displayName ?? null;
}
