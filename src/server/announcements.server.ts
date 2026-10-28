/**
 * Clone announcements — Mission Control's side.
 *
 * One table of notices, one derived lifecycle, one matcher. The console
 * writes rows; the public route serves the active ones to each clone through
 * `cloneAnnouncements.pure.ts`, so what the operator previews and what a
 * clone receives are the same computation.
 *
 * Every operator act writes `audit_log`; publish and archive also raise an
 * operator notification, exactly as the payment gate's acts do. Delivery is
 * stamped per (announcement, workspace) by the route — evidence of effect,
 * never of configuration: a notice nobody's dashboard has fetched must be
 * distinguishable from one that is working.
 *
 * A workspace is a clone or the prime. The prime's key carries no clone; it is
 * addressed by `PRIME_WORKSPACE_ID` and served like any workspace with no plan.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import {
  acknowledgeRefusal,
  activeAnnouncementsForClone,
  audienceSummary,
  isPrimeWorkspace,
  PRIME_WORKSPACE_ID,
  replyRefusal,
  resolveAnnouncementState,
  threadForWorkspace,
  type AnnouncementFacts,
  type AudienceClone,
  type CloneAnnouncementWire,
  type ReplyFacts,
  type ThreadMessageWire,
} from "@/lib/cloneAnnouncements.pure";
import { nextChangeAtFor, type SignalSummary } from "@/lib/workspaceSignal.pure";
import { replyNotificationOf } from "@/lib/workspaceReplyAlert.pure";
import { signalMessageChange, signalWorkspaces } from "@/server/workspaceSignal.server";

export type AnnouncementRow = Tables<"clone_announcements">;
export type DeliveryRow = Tables<"clone_announcement_deliveries">;
export type ReplyRow = Tables<"clone_announcement_replies">;

const factsOf = (row: AnnouncementRow): AnnouncementFacts => row as AnnouncementFacts;

/**
 * `failed` is carried separately from `rows` for the reason the gate read
 * does it: a read that FAILED is not a table that is EMPTY, and the route
 * answers 503 on the first and an honest list on the second.
 */
export type AnnouncementsRead =
  | { ok: true; rows: AnnouncementRow[] }
  | { ok: false; failed: true; error: string };

/** Every row that could possibly serve: published and not archived. The
 *  window (scheduled/expired) is judged by the pure resolver at read time. */
export async function readLiveAnnouncements(): Promise<AnnouncementsRead> {
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .select("*")
    .not("published_at", "is", null)
    .is("archived_at", null);
  if (error) return { ok: false, failed: true, error: error.message };
  return { ok: true, rows: (data ?? []) as AnnouncementRow[] };
}

/**
 * Which workspace a key speaks for. A key with no clone is the prime's (the
 * route's own rule since the channel existed); a key whose clone row is gone
 * speaks for nobody. A failed read is a failure, never "nobody".
 */
export async function resolveWorkspace(
  keyCloneId: string | null,
): Promise<
  | { ok: true; workspace: AudienceClone | null }
  | { ok: false; failed: true; error: string }
> {
  if (!keyCloneId) return { ok: true, workspace: { id: PRIME_WORKSPACE_ID, planSlug: null } };
  const { data, error } = await supabaseAdmin
    .from("clones")
    .select("id, entitled_plan_slug")
    .eq("id", keyCloneId)
    .maybeSingle();
  if (error) return { ok: false, failed: true, error: error.message };
  if (!data) return { ok: true, workspace: null };
  return { ok: true, workspace: { id: data.id, planSlug: data.entitled_plan_slug ?? null } };
}

/**
 * One workspace's replies to the given messages. Asked only for messages that
 * have replies on, so a fleet that has never enabled them never reads the
 * table — and a deployment whose migration has not landed yet is not asked
 * about a table it does not have.
 */
async function readWorkspaceReplies(
  workspaceId: string,
  announcementIds: string[],
): Promise<{ ok: true; rows: ReplyFacts[] } | { ok: false; failed: true; error: string }> {
  if (announcementIds.length === 0) return { ok: true, rows: [] };
  const { data, error } = await supabaseAdmin
    .from("clone_announcement_replies")
    .select("id, announcement_id, workspace_id, direction, body, author_name, created_at")
    .eq("workspace_id", workspaceId)
    .in("announcement_id", announcementIds)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, failed: true, error: error.message };
  return { ok: true, rows: (data ?? []) as ReplyFacts[] };
}

/**
 * What one workspace should be showing right now. The route's whole answer:
 * resolve the workspace's entitled plan, run the shared matcher, attach the
 * workspace's own reply threads, project onto the wire. A failed read fails
 * the call rather than serving a subset that would look complete.
 */
export async function announcementsForWorkspace(
  keyCloneId: string | null,
): Promise<
  | {
      ok: true;
      workspaceId: string | null;
      announcements: CloneAnnouncementWire[];
      /** When this workspace's notices next change by themselves (`nextChangeAtFor`). */
      nextChangeAt: string | null;
    }
  | { ok: false; failed: true; error: string }
> {
  const [live, ws] = await Promise.all([readLiveAnnouncements(), resolveWorkspace(keyCloneId)]);
  if (!live.ok) return live;
  if (!ws.ok) return ws;
  if (!ws.workspace) {
    // A key whose clone row is gone serves nothing — an empty list is the
    // honest answer, not an error the clone would render around.
    return { ok: true, workspaceId: null, announcements: [], nextChangeAt: null };
  }
  const now = new Date();
  const facts = live.rows.map(factsOf);
  const served = activeAnnouncementsForClone(facts, ws.workspace, now);
  const nextChangeAt = nextChangeAtFor(facts, ws.workspace, now);
  const withReplies = served.filter((a) => a.repliesEnabled).map((a) => a.id);
  if (withReplies.length === 0) {
    return { ok: true, workspaceId: ws.workspace.id, announcements: served, nextChangeAt };
  }
  const replies = await readWorkspaceReplies(ws.workspace.id, withReplies);
  if (!replies.ok) return replies;
  return {
    ok: true,
    workspaceId: ws.workspace.id,
    announcements: activeAnnouncementsForClone(facts, ws.workspace, now, replies.rows),
    nextChangeAt,
  };
}

/**
 * Stamp that a workspace received these notices. Best-effort — the stamp is
 * observability, and losing one to a race costs a count, not a record — but
 * AWAITED by the route: on a Worker, work still pending when the response is
 * returned may be cancelled, and the one record that says a workspace really
 * fetched a message must not depend on that. Measured 27 Oct 2026: no stamp
 * had ever been written.
 */
export async function recordAnnouncementDeliveries(
  cloneId: string,
  served: Array<Pick<CloneAnnouncementWire, "id" | "revision">>,
): Promise<void> {
  if (served.length === 0) return;
  const now = new Date().toISOString();
  const ids = served.map((s) => s.id);

  const existing = await supabaseAdmin
    .from("clone_announcement_deliveries")
    .select("announcement_id, delivery_count")
    .eq("clone_id", cloneId)
    .in("announcement_id", ids);
  if (existing.error) {
    console.error("[announcements] delivery read failed", existing.error.message);
    return;
  }
  const byId = new Map(
    (existing.data ?? []).map((d) => [d.announcement_id, d.delivery_count ?? 0]),
  );

  const inserts = served
    .filter((s) => !byId.has(s.id))
    .map((s) =>
      asRow<TablesInsert<"clone_announcement_deliveries">>({
        announcement_id: s.id,
        clone_id: cloneId,
        first_delivered_at: now,
        last_delivered_at: now,
        delivery_count: 1,
        last_revision: s.revision,
      }),
    );
  if (inserts.length > 0) {
    const { error } = await supabaseAdmin
      .from("clone_announcement_deliveries")
      .insert(inserts);
    // 23505 = two polls raced the first stamp; the loser's update lands next
    // poll and the count is off by at most one. Not worth a retry loop.
    if (error && error.code !== "23505") {
      console.error("[announcements] delivery insert failed", error.message);
    }
  }

  for (const s of served) {
    if (!byId.has(s.id)) continue;
    const { error } = await supabaseAdmin
      .from("clone_announcement_deliveries")
      .update(
        asRow<TablesUpdate<"clone_announcement_deliveries">>({
          last_delivered_at: now,
          delivery_count: (byId.get(s.id) ?? 0) + 1,
          last_revision: s.revision,
        }),
      )
      .eq("clone_id", cloneId)
      .eq("announcement_id", s.id);
    if (error) {
      console.error("[announcements] delivery stamp failed", error.message);
    }
  }
}

/**
 * A member of a workspace's staff opened, dismissed or acknowledged a message.
 * Counted on the delivery stamp, never by name. A workspace may only
 * acknowledge what it could have been served.
 */
export async function recordAnnouncementSeen(input: {
  keyCloneId: string | null;
  announcementId: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string }
> {
  const [ws, rowQ] = await Promise.all([
    resolveWorkspace(input.keyCloneId),
    supabaseAdmin
      .from("clone_announcements")
      .select("*")
      .eq("id", input.announcementId)
      .maybeSingle(),
  ]);
  if (!ws.ok) return { ok: false, status: 503, error: "workspace_read_failed" };
  if (!ws.workspace) return { ok: false, status: 404, error: "workspace_not_found" };
  if (rowQ.error) return { ok: false, status: 503, error: "announcement_read_failed" };
  const refusal = acknowledgeRefusal(
    rowQ.data ? factsOf(rowQ.data as AnnouncementRow) : null,
    ws.workspace,
  );
  if (refusal) return { ok: false, status: refusal === "not_found" ? 404 : 409, error: refusal };

  const now = new Date().toISOString();
  const workspaceId = ws.workspace.id;
  const existing = await supabaseAdmin
    .from("clone_announcement_deliveries")
    .select("seen_count, first_seen_at")
    .eq("clone_id", workspaceId)
    .eq("announcement_id", input.announcementId)
    .maybeSingle();
  if (existing.error) return { ok: false, status: 503, error: "delivery_read_failed" };
  if (!existing.data) {
    const { error } = await supabaseAdmin.from("clone_announcement_deliveries").insert(
      asRow<TablesInsert<"clone_announcement_deliveries">>({
        announcement_id: input.announcementId,
        clone_id: workspaceId,
        first_delivered_at: now,
        last_delivered_at: now,
        delivery_count: 1,
        last_revision: (rowQ.data as AnnouncementRow).revision,
        first_seen_at: now,
        last_seen_at: now,
        seen_count: 1,
      }),
    );
    if (error && error.code !== "23505") {
      return { ok: false, status: 503, error: "seen_write_failed" };
    }
    return { ok: true };
  }
  const { error } = await supabaseAdmin
    .from("clone_announcement_deliveries")
    .update(
      asRow<TablesUpdate<"clone_announcement_deliveries">>({
        seen_count: (existing.data.seen_count ?? 0) + 1,
        first_seen_at: existing.data.first_seen_at ?? now,
        last_seen_at: now,
      }),
    )
    .eq("clone_id", workspaceId)
    .eq("announcement_id", input.announcementId);
  if (error) return { ok: false, status: 503, error: "seen_write_failed" };
  return { ok: true };
}

// ── Replies ─────────────────────────────────────────────────────────────────

export type WorkspaceAuthor = {
  /** The workspace's own user id — resolved by the workspace's server. */
  ref: string;
  name: string;
  email?: string | null;
  role?: string | null;
};

async function readThread(
  announcementId: string,
  workspaceId: string,
): Promise<{ ok: true; thread: ThreadMessageWire[] } | { ok: false; error: string }> {
  const replies = await readWorkspaceReplies(workspaceId, [announcementId]);
  if (!replies.ok) return { ok: false, error: replies.error };
  return { ok: true, thread: threadForWorkspace(replies.rows, announcementId, workspaceId) };
}

/**
 * A workspace's member answers a message. Refused unless the message asked
 * for replies, is live, and reaches this workspace — the matcher it was served
 * by. A retry carrying the same request id finds the first reply instead of
 * writing a second. The operators are told, and the act is audited.
 */
export async function postWorkspaceReply(input: {
  keyCloneId: string | null;
  announcementId: string;
  body: string;
  author: WorkspaceAuthor;
  clientRequestId: string | null;
  /** The business the workspace's own server says it is, or null (an older relay). */
  businessName?: string | null;
}): Promise<
  | { ok: true; thread: ThreadMessageWire[] }
  | { ok: false; status: number; error: string }
> {
  const [ws, rowQ] = await Promise.all([
    resolveWorkspace(input.keyCloneId),
    supabaseAdmin
      .from("clone_announcements")
      .select("*")
      .eq("id", input.announcementId)
      .maybeSingle(),
  ]);
  if (!ws.ok) return { ok: false, status: 503, error: "workspace_read_failed" };
  if (!ws.workspace) return { ok: false, status: 404, error: "workspace_not_found" };
  if (rowQ.error) return { ok: false, status: 503, error: "announcement_read_failed" };
  const row = (rowQ.data as AnnouncementRow | null) ?? null;
  const refusal = replyRefusal(row ? factsOf(row) : null, ws.workspace);
  if (refusal) return { ok: false, status: refusal === "not_found" ? 404 : 409, error: refusal };
  const workspaceId = ws.workspace.id;

  const { error } = await supabaseAdmin.from("clone_announcement_replies").insert(
    asRow<TablesInsert<"clone_announcement_replies">>({
      announcement_id: input.announcementId,
      workspace_id: workspaceId,
      direction: "workspace",
      body: input.body,
      author_name: input.author.name,
      author_email: input.author.email ?? null,
      author_role: input.author.role ?? null,
      author_ref: input.author.ref,
      client_request_id: input.clientRequestId,
    }),
  );
  // 23505 on the request id: this reply was already written by an earlier
  // attempt. Answer with the thread as it stands, exactly as a success would.
  const duplicate = error?.code === "23505";
  if (error && !duplicate) {
    console.error("[announcements] reply insert failed", error.message);
    return { ok: false, status: 503, error: "reply_write_failed" };
  }

  if (!duplicate) {
    const cloneName = isPrimeWorkspace(workspaceId)
      ? null
      : ((await supabaseAdmin.from("clones").select("name").eq("id", workspaceId).maybeSingle()).data
          ?.name ?? null);
    const alert = replyNotificationOf({
      announcementId: input.announcementId,
      messageTitle: row!.title,
      workspaceId,
      cloneName,
      businessName: input.businessName ?? null,
      authorName: input.author.name,
      body: input.body,
    });
    const workspaceName = alert.metadata.workspace_name;
    await writeAuditLog({
      action: "clone_announcement.reply_received",
      entityType: "clone_announcement",
      entityId: input.announcementId,
      actorUserId: null,
      metadata: {
        title: row!.title,
        workspace_id: workspaceId,
        workspace: workspaceName,
        business: alert.metadata.business_name,
        author: input.author.name,
        author_ref: input.author.ref,
      },
    });
    // The bell, the pop-up and the desktop notification all draw this row
    // (`workspaceReplyAlert.pure.ts`), as a phone notification will.
    await notifyOperators({
      kind: "clone_announcement_reply",
      severity: "info",
      title: alert.title,
      body: alert.body,
      cloneId: isPrimeWorkspace(workspaceId) ? null : workspaceId,
      url: alert.url,
      metadata: alert.metadata,
    });
  }

  const thread = await readThread(input.announcementId, workspaceId);
  // The reply is stored; a failed re-read must not turn that into an error the
  // workspace would retry. It is told the write landed and re-reads on its poll.
  return { ok: true, thread: thread.ok ? thread.thread : [] };
}

/** Every reply to one message, all workspaces — the console's thread view. */
export async function readRepliesForAnnouncement(
  announcementId: string,
): Promise<{ ok: true; rows: ReplyRow[] } | { ok: false; error: string }> {
  const { data, error } = await supabaseAdmin
    .from("clone_announcement_replies")
    .select("*")
    .eq("announcement_id", announcementId)
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as ReplyRow[] };
}

/**
 * An operator answers inside one workspace's thread. The workspace reads it,
 * signed "Aurixa Systems", as soon as it is signalled (or on its next poll
 * where the signal does not land); only that workspace is ever served it. Answering marks what the workspace wrote as read.
 */
export async function postOperatorReply(input: {
  announcementId: string;
  workspaceId: string;
  body: string;
  actorId: string;
  actorName: string;
  clientRequestId: string | null;
}): Promise<{ ok: true; signal?: SignalSummary } | { ok: false; error: string }> {
  const rowQ = await supabaseAdmin
    .from("clone_announcements")
    .select("*")
    .eq("id", input.announcementId)
    .maybeSingle();
  if (rowQ.error) return { ok: false, error: rowQ.error.message };
  const row = (rowQ.data as AnnouncementRow | null) ?? null;

  let planSlug: string | null = null;
  if (!isPrimeWorkspace(input.workspaceId)) {
    const c = await supabaseAdmin
      .from("clones")
      .select("entitled_plan_slug")
      .eq("id", input.workspaceId)
      .maybeSingle();
    if (c.error) return { ok: false, error: c.error.message };
    if (!c.data) return { ok: false, error: "That workspace no longer exists." };
    planSlug = c.data.entitled_plan_slug ?? null;
  }
  const refusal = replyRefusal(row ? factsOf(row) : null, { id: input.workspaceId, planSlug });
  if (refusal) {
    const why: Record<NonNullable<typeof refusal>, string> = {
      not_found: "That message no longer exists.",
      not_addressed: "That message does not reach this workspace.",
      replies_disabled: "Replies are off for this message.",
      not_live: "The message is not live, so the workspace would never see an answer.",
    };
    return { ok: false, error: why[refusal] };
  }

  const { error } = await supabaseAdmin.from("clone_announcement_replies").insert(
    asRow<TablesInsert<"clone_announcement_replies">>({
      announcement_id: input.announcementId,
      workspace_id: input.workspaceId,
      direction: "operator",
      body: input.body,
      author_name: input.actorName,
      author_ref: input.actorId,
      client_request_id: input.clientRequestId,
    }),
  );
  if (error && error.code !== "23505") return { ok: false, error: error.message };
  if (!error) {
    await markThreadRead({ announcementId: input.announcementId, workspaceId: input.workspaceId });
    await writeAuditLog({
      action: "clone_announcement.reply_sent",
      entityType: "clone_announcement",
      entityId: input.announcementId,
      actorUserId: input.actorId,
      metadata: { title: row!.title, workspace_id: input.workspaceId },
    });
    // Only this workspace: the answer is its own thread, nobody else's.
    return { ok: true, signal: await signalWorkspaces([input.workspaceId]) };
  }
  return { ok: true };
}

/** Everything a workspace wrote in this thread is now read by an operator. */
export async function markThreadRead(input: {
  announcementId: string;
  workspaceId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("clone_announcement_replies")
    .update(
      asRow<TablesUpdate<"clone_announcement_replies">>({
        operator_read_at: new Date().toISOString(),
      }),
    )
    .eq("announcement_id", input.announcementId)
    .eq("workspace_id", input.workspaceId)
    .eq("direction", "workspace")
    .is("operator_read_at", null);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ── Operator acts ───────────────────────────────────────────────────────────

export type AnnouncementDraftInput = {
  title: string;
  body: string;
  linkUrl?: string | null;
  linkLabel?: string | null;
  severity: string;
  display: string;
  dismissible: boolean;
  audiencePlanSlugs?: string[] | null;
  audienceCloneIds?: string[] | null;
  /** 'any' reaches a workspace on a chosen plan OR a chosen workspace. */
  audienceMatch?: "all" | "any";
  repliesEnabled?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  /** The console's id for this act; a repeat finds the row it already made. */
  clientRequestId?: string | null;
};

/**
 * `signal` says how many of the workspaces the change reaches were told at
 * once (`workspaceSignal.pure.ts`); absent where the act changed nothing a
 * workspace is shown — a draft.
 */
type ActResult =
  | { ok: true; row: AnnouncementRow; signal?: SignalSummary }
  | { ok: false; error: string };

function draftToColumns(input: AnnouncementDraftInput) {
  return {
    title: input.title.trim(),
    body: input.body.trim(),
    link_url: input.linkUrl?.trim() || null,
    link_label: input.linkUrl?.trim() ? input.linkLabel?.trim() || null : null,
    severity: input.severity,
    display: input.display,
    // The CHECK enforces this too; writing it here keeps the row honest
    // rather than relying on the projection to paper over it.
    dismissible: input.display === "modal" ? true : input.dismissible,
    audience_plan_slugs:
      input.audiencePlanSlugs && input.audiencePlanSlugs.length > 0
        ? input.audiencePlanSlugs
        : null,
    audience_clone_ids:
      input.audienceCloneIds && input.audienceCloneIds.length > 0
        ? input.audienceCloneIds
        : null,
    audience_match: input.audienceMatch === "any" ? "any" : "all",
    replies_enabled: input.repliesEnabled === true,
    starts_at: input.startsAt || null,
    ends_at: input.endsAt || null,
  };
}

/** The row an earlier attempt of this same act already made, if any. */
async function rowForRequest(
  clientRequestId: string | null | undefined,
): Promise<{ ok: true; row: AnnouncementRow | null } | { ok: false; error: string }> {
  if (!clientRequestId) return { ok: true, row: null };
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .select("*")
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: (data as AnnouncementRow | null) ?? null };
}

export async function createAnnouncement(
  input: AnnouncementDraftInput & { actorId: string },
): Promise<ActResult> {
  const earlier = await rowForRequest(input.clientRequestId);
  if (!earlier.ok) return { ok: false, error: earlier.error };
  if (earlier.row) return { ok: true, row: earlier.row };
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .insert(
      asRow<TablesInsert<"clone_announcements">>({
        ...draftToColumns(input),
        created_by: input.actorId,
        client_request_id: input.clientRequestId ?? null,
      }),
    )
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const raced = await rowForRequest(input.clientRequestId);
      if (raced.ok && raced.row) return { ok: true, row: raced.row };
    }
    return { ok: false, error: error.message };
  }
  const row = data as AnnouncementRow;
  await writeAuditLog({
    action: "clone_announcement.created",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { title: row.title, audience: audienceSummary(factsOf(row)) },
  });
  return { ok: true, row };
}

export async function updateAnnouncement(
  input: AnnouncementDraftInput & { id: string; actorId: string },
): Promise<ActResult> {
  // The row as it was: an edit that narrows a live message must signal the
  // workspace that is losing it, not only the ones it still reaches.
  const before = await supabaseAdmin
    .from("clone_announcements")
    .select("audience_plan_slugs, audience_clone_ids, audience_match, published_at")
    .eq("id", input.id)
    .maybeSingle();
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .update(
      asRow<TablesUpdate<"clone_announcements">>({
        ...draftToColumns(input),
        // The act's id, so a repeat of a Send now on this draft finds it sent.
        ...(input.clientRequestId ? { client_request_id: input.clientRequestId } : {}),
      }),
    )
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const row = data as AnnouncementRow;
  await writeAuditLog({
    action: "clone_announcement.updated",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { title: row.title, audience: audienceSummary(factsOf(row)) },
  });
  if (!row.published_at) return { ok: true, row };
  const signal = await signalMessageChange([before.data ?? null, row]);
  return { ok: true, row, signal };
}

/**
 * Send now / Schedule: write the message and publish it in one act.
 *
 * A new message is inserted ALREADY published — there is no moment at which a
 * draft exists that a failure could strand, which is how the 17 Oct 2026
 * message came to sit as a draft nobody could see. A draft being sent is
 * saved and then published. A repeat of the same act (a double click, a retry
 * after a timeout) carries the same request id and finds the row the first
 * one made, so a message is never sent twice.
 */
export async function sendAnnouncement(
  input: AnnouncementDraftInput & { id?: string | null; actorId: string },
): Promise<ActResult & { repeated?: boolean }> {
  const earlier = await rowForRequest(input.clientRequestId);
  if (!earlier.ok) return { ok: false, error: earlier.error };
  if (earlier.row?.published_at) return { ok: true, row: earlier.row, repeated: true };

  const draftId = input.id ?? earlier.row?.id ?? null;
  if (draftId) {
    const current = await supabaseAdmin
      .from("clone_announcements")
      .select("published_at, archived_at")
      .eq("id", draftId)
      .maybeSingle();
    if (current.error) return { ok: false, error: current.error.message };
    if (!current.data) return { ok: false, error: "not_found" };
    // Sending is for a draft. A message already out is edited with Save, and
    // brought back to everyone's attention with Re-raise.
    if (current.data.published_at && !current.data.archived_at) {
      return { ok: false, error: "already_published" };
    }
    const saved = await updateAnnouncement({ ...input, id: draftId });
    if (!saved.ok) return saved;
    return publishAnnouncement({ id: draftId, actorId: input.actorId });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .insert(
      asRow<TablesInsert<"clone_announcements">>({
        ...draftToColumns(input),
        created_by: input.actorId,
        client_request_id: input.clientRequestId ?? null,
        published_at: now,
      }),
    )
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      const raced = await rowForRequest(input.clientRequestId);
      if (raced.ok && raced.row) return { ok: true, row: raced.row, repeated: true };
    }
    return { ok: false, error: error.message };
  }
  const row = data as AnnouncementRow;
  await writeAuditLog({
    action: "clone_announcement.created",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { title: row.title, audience: audienceSummary(factsOf(row)) },
  });
  await recordPublished(row, input.actorId);
  const signal = await signalMessageChange([row]);
  return { ok: true, row, signal };
}

/** The publish act's record and receipt, shared by Publish and Send now. */
async function recordPublished(row: AnnouncementRow, actorId: string): Promise<void> {
  const state = resolveAnnouncementState(factsOf(row));
  await writeAuditLog({
    action: "clone_announcement.published",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: actorId,
    metadata: {
      title: row.title,
      audience: audienceSummary(factsOf(row)),
      state,
      replies_enabled: row.replies_enabled === true,
    },
  });
  await notifyOperators({
    kind: "clone_announcement_published",
    severity: "info",
    title: `Announcement published: ${row.title}`,
    body: `Reaches ${audienceSummary(factsOf(row))}. ${
      state === "scheduled" ? "Waiting for its start time." : "Live now."
    }`,
    url: "/announcements",
    metadata: { announcement_id: row.id, state },
  });
}

/**
 * Publishing is a stamp, not a copy: `published_at` set once. Publishing an
 * archived notice un-archives it deliberately — that is what "publish again"
 * means on a put-away notice, and the event trail records both acts.
 */
export async function publishAnnouncement(input: {
  id: string;
  actorId: string;
}): Promise<ActResult> {
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .update(
      asRow<TablesUpdate<"clone_announcements">>({
        published_at: now,
        archived_at: null,
      }),
    )
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const row = data as AnnouncementRow;
  await recordPublished(row, input.actorId);
  const signal = await signalMessageChange([row]);
  return { ok: true, row, signal };
}

/** Putting away, never throwing away: the row and its deliveries survive. */
export async function archiveAnnouncement(input: {
  id: string;
  actorId: string;
  reason: string;
}): Promise<ActResult> {
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .update(
      asRow<TablesUpdate<"clone_announcements">>({
        archived_at: new Date().toISOString(),
      }),
    )
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const row = data as AnnouncementRow;
  await writeAuditLog({
    action: "clone_announcement.archived",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { title: row.title, reason: input.reason },
  });
  await notifyOperators({
    kind: "clone_announcement_archived",
    severity: "info",
    title: `Announcement archived: ${row.title}`,
    body: input.reason,
    url: "/announcements",
    metadata: { announcement_id: row.id },
  });
  // The dashboards showing it drop it now, not on their next check.
  const signal = await signalMessageChange([row]);
  return { ok: true, row, signal };
}

/**
 * Re-raise: bump the revision so every dashboard's per-revision dismissal
 * key changes and the notice comes back. An EDIT never does this — a typo
 * fix must not re-interrupt everyone — so re-raising is its own act with its
 * own audit entry.
 */
export async function reraiseAnnouncement(input: {
  id: string;
  actorId: string;
}): Promise<ActResult> {
  const current = await supabaseAdmin
    .from("clone_announcements")
    .select("revision")
    .eq("id", input.id)
    .maybeSingle();
  if (current.error) return { ok: false, error: current.error.message };
  if (!current.data) return { ok: false, error: "not_found" };

  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .update(
      asRow<TablesUpdate<"clone_announcements">>({
        revision: (current.data.revision ?? 1) + 1,
      }),
    )
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const row = data as AnnouncementRow;
  await writeAuditLog({
    action: "clone_announcement.reraised",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: { title: row.title, revision: row.revision },
  });
  const signal = await signalMessageChange([row]);
  return { ok: true, row, signal };
}
