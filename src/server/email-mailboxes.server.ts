/**
 * The tenant's mailboxes, and which of them this deployment may send from.
 *
 * `src/lib/email/mailboxes.pure.ts` carries the reasoning; this is the I/O:
 * the directory listing, the reachability probes, and the mailboxes this
 * deployment already knows about from its own campaigns and message ledger.
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
import {
  GraphError,
  defaultMailbox,
  grantedRoles,
  isGraphConfigured,
  listDirectoryUsers,
  probeMailboxes,
} from "@/server/graph-client";

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

const accessCache = new Map<string, { at: number; access: MailboxAccess }>();
let directoryCache: { at: number; value: DirectoryRead } | null = null;
let capabilityCache: { at: number; value: GraphCapabilities } | null = null;

const fresh = (at: number) => Date.now() - at < TTL_MS;

/** The tenant's mailboxes from the directory, or why they cannot be listed. */
export async function readDirectory(force = false): Promise<DirectoryRead> {
  if (!force && directoryCache && fresh(directoryCache.at)) return directoryCache.value;
  let value: DirectoryRead;
  try {
    const { users, truncated } = await listDirectoryUsers(MAX_DIRECTORY);
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
  directoryCache = { at: Date.now(), value };
  return value;
}

/** Whether each address can be used, probing what is not already known. */
export async function checkMailboxes(
  addresses: string[],
  force = false,
): Promise<Map<string, MailboxAccess>> {
  const out = new Map<string, MailboxAccess>();
  const toProbe: string[] = [];
  for (const raw of addresses) {
    const key = emailKey(raw);
    if (!key || out.has(key) || toProbe.includes(key)) continue;
    const cached = accessCache.get(key);
    if (!force && cached && fresh(cached.at)) out.set(key, cached.access);
    else toProbe.push(key);
  }
  if (toProbe.length === 0) return out;

  const capabilities = await graphCapabilities();
  for (const probe of await probeMailboxes(toProbe)) {
    const access: MailboxAccess =
      probe.code === "token"
        ? {
            state: "unknown",
            reason: "this deployment could not obtain a Microsoft token to check",
          }
        : qualifyAccess(describeMailboxAccess(probe.status, probe.code), capabilities);
    out.set(probe.address, access);
    if (access.state !== "unknown") accessCache.set(probe.address, { at: Date.now(), access });
  }
  return out;
}

/** One address. */
export async function checkMailbox(address: string, force = false): Promise<MailboxAccess> {
  const key = emailKey(address);
  if (!key) return { state: "no_mailbox", reason: "that is not a valid email address" };
  if (!isGraphConfigured()) {
    return { state: "unknown", reason: "Microsoft Graph is not configured on this deployment" };
  }
  return (
    (await checkMailboxes([key], force)).get(key) ?? {
      state: "unknown",
      reason: "Microsoft did not answer",
    }
  );
}

/** What the token says this application was granted. Advisory. */
export async function graphCapabilities(force = false): Promise<GraphCapabilities> {
  if (!force && capabilityCache && fresh(capabilityCache.at)) return capabilityCache.value;
  let value: GraphCapabilities;
  try {
    value = capabilitiesFrom(await grantedRoles());
  } catch {
    // No token at all is reported by whatever tried to send; here it only
    // means the page cannot say what was granted.
    return capabilitiesFrom(null);
  }
  capabilityCache = { at: Date.now(), value };
  return value;
}

/**
 * Mailboxes this deployment already uses: those campaigns name, and those
 * messages have actually left from recently. Read with whichever client the
 * caller holds — an operator's own, or the service role for the bounce scan.
 */
export async function knownMailboxes(
  client: SupabaseClient<Database>,
  options: { includeDrafts?: boolean } = {},
): Promise<{ address: string; source: MailboxSource }[]> {
  let campaigns = client
    .from("email_campaigns")
    .select("from_mailbox")
    .not("from_mailbox", "is", null);
  if (!options.includeDrafts) campaigns = campaigns.neq("status", "draft");
  const since = new Date(Date.now() - SENDING_HISTORY_DAYS * 86_400_000).toISOString();
  const [named, sent] = await Promise.all([
    campaigns,
    client.from("email_campaign_sending_mailboxes").select("mailbox").gte("last_used_at", since),
  ]);
  if (named.error) throw named.error;
  if (sent.error) throw sent.error;

  const out: { address: string; source: MailboxSource }[] = [];
  for (const row of named.data ?? []) {
    const address = emailKey(String(row.from_mailbox ?? ""));
    if (address) out.push({ address, source: "campaign" });
  }
  for (const row of sent.data ?? []) {
    const address = emailKey(String(row.mailbox ?? ""));
    if (address) out.push({ address, source: "history" });
  }
  return out;
}

export type MailboxDirectory = {
  configured: boolean;
  defaultMailbox: string | null;
  directory: { readable: boolean; error: string | null; truncated: boolean; count: number };
  options: MailboxOption[];
  /** Mailboxes listed but not checked yet — checked when chosen. */
  unchecked: number;
  capabilities: GraphCapabilities;
};

/** Everything the mailbox picker shows. */
export async function mailboxDirectory(
  client: SupabaseClient<Database>,
  force = false,
): Promise<MailboxDirectory> {
  const fallbackDefault = defaultMailbox();
  if (!isGraphConfigured()) {
    return {
      configured: false,
      defaultMailbox: fallbackDefault,
      directory: { readable: false, error: null, truncated: false, count: 0 },
      options: [],
      unchecked: 0,
      capabilities: capabilitiesFrom(null),
    };
  }

  const [directory, known, capabilities] = await Promise.all([
    readDirectory(force),
    knownMailboxes(client, { includeDrafts: true }),
    graphCapabilities(force),
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

  const access = await checkMailboxes(ordered.slice(0, MAX_PROBES), force);
  // Beyond the probe budget, show whatever an earlier check already knows.
  for (const address of ordered.slice(MAX_PROBES)) {
    const cached = accessCache.get(address);
    if (cached && fresh(cached.at)) access.set(address, cached.access);
  }

  const options = mergeMailboxOptions({
    defaultMailbox: fallbackDefault,
    directory: directory.mailboxes,
    known,
    access,
  });

  return {
    configured: true,
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

/** A display name for an address, when the directory has one. */
export async function displayNameFor(address: string): Promise<string | null> {
  const key = emailKey(address);
  if (!key) return null;
  const directory = await readDirectory();
  return directory.mailboxes.find((mailbox) => mailbox.address === key)?.displayName ?? null;
}
