/**
 * Sending a workspace its "ask again" signal. The rules — what the signal
 * carries, who is told, why the channel may be public — are in
 * `workspaceSignal.pure.ts`; this reads where each workspace's Realtime is and
 * sends.
 *
 *  - A clone's Realtime is its own Supabase project: `clone_backends` holds its
 *    URL and publishable key, written when Mission Control provisioned it.
 *  - The prime's is `prime_config.supabase_project_ref`; its publishable key is
 *    read through the Management API, as provisioning already reads it to
 *    rewrite the prime's cron jobs for a clone, and kept for the life of the
 *    isolate.
 *
 * Never throws, and never fails the act that called it: the message is already
 * written, and a workspace that was not signalled still hears on its poll.
 * Awaited by its callers, because a Cloudflare Worker may cancel work still
 * pending once the response has gone.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  PRIME_WORKSPACE_ID,
  isPrimeWorkspace,
  type AnnouncementFacts,
  type AudienceClone,
} from "@/lib/cloneAnnouncements.pure";
import {
  NO_SIGNAL,
  SIGNAL_TIMEOUT_MS,
  broadcastRequestOf,
  supabaseProjectUrlOf,
  supabaseUrlForRef,
  workspacesToSignal,
  type SignalEndpoint,
  type SignalSummary,
} from "@/lib/workspaceSignal.pure";
import { getProjectApiKeys, selectProjectKeys } from "@/server/backend-provisioning.server";
import { resolvePrimeBackendRef } from "@/server/prime-backend.server";

const PRIME_KEY_TTL_MS = 10 * 60_000;
let primeEndpointCache: { at: number; endpoint: SignalEndpoint } | null = null;

async function primeEndpoint(): Promise<SignalEndpoint | null> {
  if (primeEndpointCache && Date.now() - primeEndpointCache.at < PRIME_KEY_TTL_MS) {
    return primeEndpointCache.endpoint;
  }
  try {
    const ref = await resolvePrimeBackendRef(supabaseAdmin);
    const supabaseUrl = supabaseUrlForRef(ref);
    if (!supabaseUrl) return null;
    // The Management API has no deadline of its own, and an operator's Send
    // waits on this: a slow answer costs the prime its signal (it still
    // hears on its next check), never the operator a hung button.
    const keys = await Promise.race([
      getProjectApiKeys(ref),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("management API timed out")), SIGNAL_TIMEOUT_MS),
      ),
    ]);
    const { anonKey } = selectProjectKeys(keys);
    if (!anonKey) return null;
    const endpoint = { workspaceId: PRIME_WORKSPACE_ID, supabaseUrl, anonKey };
    primeEndpointCache = { at: Date.now(), endpoint };
    return endpoint;
  } catch (err) {
    console.warn(
      "[workspace-signal] prime endpoint unavailable",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function cloneEndpoints(cloneIds: string[]): Promise<SignalEndpoint[]> {
  if (cloneIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("clone_backends")
    .select("clone_id, supabase_url, anon_key, created_at")
    .in("clone_id", cloneIds)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[workspace-signal] clone backends read failed", error.message);
    return [];
  }
  const seen = new Set<string>();
  const out: SignalEndpoint[] = [];
  for (const row of data ?? []) {
    // The newest backend per clone, and only one that names a real project.
    if (!row.clone_id || seen.has(row.clone_id)) continue;
    const supabaseUrl = supabaseProjectUrlOf(row.supabase_url);
    if (!supabaseUrl || !row.anon_key) continue;
    seen.add(row.clone_id);
    out.push({ workspaceId: row.clone_id, supabaseUrl, anonKey: row.anon_key });
  }
  return out;
}

async function send(endpoint: SignalEndpoint, at: Date): Promise<boolean> {
  const request = broadcastRequestOf(endpoint, at);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGNAL_TIMEOUT_MS);
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("[workspace-signal] refused", endpoint.workspaceId, res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      "[workspace-signal] unreachable",
      endpoint.workspaceId,
      err instanceof Error ? err.message : err,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Signal these workspaces. A workspace with no known Realtime counts as failed. */
export async function signalWorkspaces(workspaceIds: readonly string[]): Promise<SignalSummary> {
  const ids = [...new Set(workspaceIds)];
  if (ids.length === 0) return NO_SIGNAL;
  try {
    const [prime, clones] = await Promise.all([
      ids.some(isPrimeWorkspace) ? primeEndpoint() : Promise.resolve(null),
      cloneEndpoints(ids.filter((id) => !isPrimeWorkspace(id))),
    ]);
    const endpoints = [...(prime ? [prime] : []), ...clones];
    const at = new Date();
    const results = await Promise.all(endpoints.map((e) => send(e, at)));
    const signalled = results.filter(Boolean).length;
    return { reached: ids.length, signalled, failed: ids.length - signalled };
  } catch (err) {
    console.warn("[workspace-signal] failed", err instanceof Error ? err.message : err);
    return { reached: ids.length, signalled: 0, failed: ids.length };
  }
}

/** Every workspace a message can reach: the prime, and every clone with its plan. */
async function readRoster(): Promise<AudienceClone[] | null> {
  const { data, error } = await supabaseAdmin.from("clones").select("id, entitled_plan_slug");
  if (error) {
    console.warn("[workspace-signal] roster read failed", error.message);
    return null;
  }
  return [
    { id: PRIME_WORKSPACE_ID, planSlug: null },
    ...(data ?? []).map((c) => ({ id: c.id, planSlug: c.entitled_plan_slug ?? null })),
  ];
}

/**
 * Signal every workspace a change to a message touches — pass the row as it
 * was and as it is (`workspacesToSignal`).
 */
export async function signalMessageChange(
  rows: ReadonlyArray<
    | Pick<
        AnnouncementFacts,
        "audience_plan_slugs" | "audience_clone_ids" | "audience_match" | "published_at"
      >
    | null
    | undefined
  >,
): Promise<SignalSummary> {
  if (!rows.some((r) => r?.published_at)) return NO_SIGNAL;
  const roster = await readRoster();
  if (!roster) return NO_SIGNAL;
  return signalWorkspaces(workspacesToSignal(rows, roster));
}
