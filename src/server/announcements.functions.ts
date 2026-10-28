/**
 * Operator RPCs for clone announcements.
 *
 * The split follows the payment gate's: reads are `requireOperator` so
 * support can see what the fleet is being told, mutations are `requireAdmin`
 * because a notice on every customer's dashboard is an operator-level act
 * only in the reading.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { TIERS } from "@/lib/pricing/aurixa-catalog";
import {
  announcementReachesClone,
  ANNOUNCEMENT_DISPLAYS,
  ANNOUNCEMENT_SEVERITIES,
  audienceSummary,
  PRIME_WORKSPACE_ID,
  resolveAnnouncementState,
  sendTimingRefusal,
  summariseThreads,
  withdrawalOf,
  type AnnouncementFacts,
  type AnnouncementState,
  type ReplyFacts,
  type ThreadSummary,
  type WithdrawalSummary,
} from "@/lib/cloneAnnouncements.pure";
import {
  archiveAnnouncement,
  createAnnouncement,
  markThreadRead,
  postOperatorReply,
  publishAnnouncement,
  readRepliesForAnnouncement,
  recallAnnouncement,
  reraiseAnnouncement,
  sendAnnouncement,
  updateAnnouncement,
  type AnnouncementDraftInput,
  type AnnouncementRow,
  type DeliveryRow,
  type ReplyRow,
} from "./announcements.server";

export type AnnouncementCloneRef = {
  id: string;
  name: string;
  slug: string;
  planSlug: string | null;
  /** The prime: addressed by `PRIME_WORKSPACE_ID`, never on a plan. */
  isPrime: boolean;
};

/**
 * The prime, as the console lists it beside the clones. It has no `clones`
 * row and no plan; it is a workspace because its staff are, and because a
 * message the operator's own team cannot see is one nobody has checked.
 */
export const PRIME_WORKSPACE_REF: AnnouncementCloneRef = {
  id: PRIME_WORKSPACE_ID,
  name: "Prime workspace",
  slug: "prime",
  planSlug: null,
  isPrime: true,
};

export type AnnouncementListRow = {
  row: AnnouncementRow;
  state: AnnouncementState;
  /** Who it targets, in words. */
  audience: string;
  /** The clones the matcher says this notice reaches right now. */
  reaches: Array<
    AnnouncementCloneRef & {
      delivery: {
        count: number;
        lastAt: string;
        lastRevision: number;
        seenCount: number;
        lastSeenAt: string | null;
        /** When its dashboards were answered without the message after a recall. */
        withdrawnAt: string | null;
      } | null;
    }
  >;
  /** How many of those workspaces have actually fetched it at least once. */
  deliveredTo: number;
  /** How many have had a person open, dismiss or acknowledge it. */
  seenBy: number;
  /**
   * For a recalled message: how many workspaces had it, and how many have
   * since been answered without it. Null for every other state.
   */
  withdrawal: WithdrawalSummary | null;
  /**
   * One summary per workspace that has a thread on this message. Null when
   * the replies could not be read — never an empty list standing in for one.
   */
  threads: ThreadSummary[] | null;
};

export type AnnouncementListResult = {
  rows: AnnouncementListRow[];
  /** Every workspace a message can be addressed to: the prime first, then the clones. */
  clones: AnnouncementCloneRef[];
  planOptions: Array<{ slug: string; name: string }>;
  /** Why replies could not be read, when they could not. */
  repliesError: string | null;
  summary: {
    total: number;
    active: number;
    scheduled: number;
    drafts: number;
    recalled: number;
    expired: number;
    archived: number;
    /** Workspace replies no operator has read yet; null when unknown. */
    unreadReplies: number | null;
  };
};

/**
 * Everything the console page needs in one read: the notices with their
 * derived state and per-clone delivery stamps, the clone roster for the
 * audience picker, and the plan vocabulary. The reach preview runs the SAME
 * matcher the public route serves with, so "who will see this" is a fact
 * rather than a second opinion.
 */
export const listAnnouncements = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async (): Promise<AnnouncementListResult> => {
    const now = new Date();
    const [annQ, clonesQ, deliveriesQ, repliesQ] = await Promise.all([
      supabaseAdmin
        .from("clone_announcements")
        .select("*")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("clones")
        .select("id, name, slug, entitled_plan_slug")
        .order("name", { ascending: true }),
      supabaseAdmin.from("clone_announcement_deliveries").select("*"),
      supabaseAdmin
        .from("clone_announcement_replies")
        .select(
          "id, announcement_id, workspace_id, direction, body, author_name, created_at, operator_read_at",
        ),
    ]);
    if (annQ.error) throw new Error(annQ.error.message);
    if (clonesQ.error) throw new Error(clonesQ.error.message);
    if (deliveriesQ.error) throw new Error(deliveriesQ.error.message);
    // Replies are read beside the messages, not instead of them: a failure
    // here is shown as "could not read replies", and the list still works.
    const repliesError = repliesQ.error ? repliesQ.error.message : null;
    const replies = repliesQ.error
      ? null
      : ((repliesQ.data ?? []) as Array<ReplyFacts & { operator_read_at: string | null }>);

    const clones: AnnouncementCloneRef[] = [
      PRIME_WORKSPACE_REF,
      ...(clonesQ.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        planSlug: c.entitled_plan_slug ?? null,
        isPrime: false,
      })),
    ];
    const cloneNames = Object.fromEntries(clones.map((c) => [c.id, c.name]));

    const deliveries = new Map<string, DeliveryRow>();
    for (const d of (deliveriesQ.data ?? []) as DeliveryRow[]) {
      deliveries.set(`${d.announcement_id}:${d.clone_id}`, d);
    }

    const rows: AnnouncementListRow[] = ((annQ.data ?? []) as AnnouncementRow[]).map(
      (row) => {
        const facts = row as AnnouncementFacts;
        const reaches = clones
          .filter((c) =>
            announcementReachesClone(facts, { id: c.id, planSlug: c.planSlug }),
          )
          .map((c) => {
            const d = deliveries.get(`${row.id}:${c.id}`);
            return {
              ...c,
              delivery: d
                ? {
                    count: d.delivery_count,
                    lastAt: d.last_delivered_at,
                    lastRevision: d.last_revision,
                    seenCount: d.seen_count ?? 0,
                    lastSeenAt: d.last_seen_at ?? null,
                    withdrawnAt: d.withdrawn_at ?? null,
                  }
                : null,
            };
          });
        const state = resolveAnnouncementState(facts, now);
        return {
          row,
          state,
          audience: audienceSummary(facts, cloneNames),
          reaches,
          deliveredTo: reaches.filter((r) => r.delivery !== null).length,
          seenBy: reaches.filter((r) => (r.delivery?.seenCount ?? 0) > 0).length,
          withdrawal:
            state === "recalled" && row.recalled_at
              ? withdrawalOf(
                  row.recalled_at,
                  reaches.map((r) => r.delivery),
                )
              : null,
          threads: replies
            ? summariseThreads(replies.filter((r) => r.announcement_id === row.id))
            : null,
        };
      },
    );

    // The tier ladder first, then any plan a clone actually carries that the
    // catalogue does not name — the picker must be able to say what is true.
    const planOptions = TIERS.map((t) => ({ slug: t.slug, name: t.name }));
    for (const c of clones) {
      if (c.planSlug && !planOptions.some((p) => p.slug === c.planSlug)) {
        planOptions.push({ slug: c.planSlug, name: c.planSlug });
      }
    }

    return {
      rows,
      clones,
      planOptions,
      repliesError,
      summary: {
        unreadReplies: replies
          ? replies.filter((r) => r.direction === "workspace" && !r.operator_read_at).length
          : null,
        total: rows.length,
        active: rows.filter((r) => r.state === "active").length,
        scheduled: rows.filter((r) => r.state === "scheduled").length,
        drafts: rows.filter((r) => r.state === "draft").length,
        recalled: rows.filter((r) => r.state === "recalled").length,
        expired: rows.filter((r) => r.state === "expired").length,
        archived: rows.filter((r) => r.state === "archived").length,
      },
    };
  });

/** Shared shape validation for create and update. Mirrors the CHECKs so an
 *  operator reads a sentence instead of a constraint name. */
function validateDraft(data: AnnouncementDraftInput): AnnouncementDraftInput {
  const title = (data.title ?? "").trim();
  const body = (data.body ?? "").trim();
  if (title.length < 1 || title.length > 140) {
    throw new Error("The title must be 1–140 characters");
  }
  if (body.length < 1 || body.length > 2000) {
    throw new Error("The body must be 1–2000 characters");
  }
  const linkUrl = data.linkUrl?.trim() || null;
  if (linkUrl && !linkUrl.startsWith("https://")) {
    throw new Error("A link must be https://");
  }
  if (!(ANNOUNCEMENT_SEVERITIES as readonly string[]).includes(data.severity)) {
    throw new Error("Severity must be info, success, warning or critical");
  }
  if (!(ANNOUNCEMENT_DISPLAYS as readonly string[]).includes(data.display)) {
    throw new Error("Display must be banner or modal");
  }
  // An explicit empty list names nobody. Storing it would widen to every
  // workspace (an absent scope means "all"), so it is refused, never read
  // as "everyone". Everyone is said by sending null.
  if (Array.isArray(data.audienceCloneIds) && data.audienceCloneIds.length === 0) {
    throw new Error("Choose at least one workspace, or address it to all workspaces");
  }
  if (Array.isArray(data.audiencePlanSlugs) && data.audiencePlanSlugs.length === 0) {
    throw new Error("Choose at least one plan, or address it to all workspaces");
  }
  if (data.startsAt && data.endsAt && Date.parse(data.endsAt) <= Date.parse(data.startsAt)) {
    throw new Error("The end time must come after the start time");
  }
  if (
    data.audienceMatch !== undefined &&
    data.audienceMatch !== "all" &&
    data.audienceMatch !== "any"
  ) {
    throw new Error("audienceMatch must be all or any");
  }
  if (data.clientRequestId && !UUID.test(data.clientRequestId)) {
    throw new Error("clientRequestId must be a uuid");
  }
  return {
    ...data,
    title,
    body,
    linkUrl,
    linkLabel: linkUrl ? data.linkLabel?.trim() || null : null,
    repliesEnabled: data.repliesEnabled === true,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: AnnouncementDraftInput) => validateDraft(data))
  .handler(async ({ data, context }) =>
    createAnnouncement({ ...data, actorId: context.userId }),
  );

export const updateAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: AnnouncementDraftInput & { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return { ...validateDraft(data), id: data.id };
  })
  .handler(async ({ data, context }) =>
    updateAnnouncement({ ...data, actorId: context.userId }),
  );

export const publishAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) =>
    publishAnnouncement({ id: data.id, actorId: context.userId }),
  );

export const archiveAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { id: string; reason: string }) => {
    if (!data?.id) throw new Error("id required");
    if (!data.reason || data.reason.trim().length < 5) {
      throw new Error("A reason of at least 5 characters is required");
    }
    return { id: data.id, reason: data.reason.trim() };
  })
  .handler(async ({ data, context }) =>
    archiveAnnouncement({ id: data.id, actorId: context.userId, reason: data.reason }),
  );

export const reraiseAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { id: string }) => {
    if (!data?.id) throw new Error("id required");
    return data;
  })
  .handler(async ({ data, context }) =>
    reraiseAnnouncement({ id: data.id, actorId: context.userId }),
  );

/**
 * Recall: withdraw a message that went out wrong. The note says what was wrong
 * with it, for the audit log and the other operators; it is optional, because
 * a recall is the urgent act and must not wait on a sentence.
 */
export const recallAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { id: string; note?: string | null }) => {
    if (!data?.id || !UUID.test(data.id)) throw new Error("id required");
    const note = data.note?.trim() || null;
    if (note && note.length > 300) throw new Error("Keep the note under 300 characters");
    return { id: data.id, note };
  })
  .handler(async ({ data, context }) =>
    recallAnnouncement({ id: data.id, actorId: context.userId, note: data.note }),
  );

/**
 * Send now / Schedule: write the message and publish it in one act. "now"
 * goes live at once (any start time is cleared); "schedule" goes live at its
 * start time, which must be in the future. The request id makes a repeat of
 * the same act find the first row rather than send the message twice.
 */
export const sendAnnouncementFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (data: AnnouncementDraftInput & { id?: string | null; timing: "now" | "schedule" }) => {
      if (data?.timing !== "now" && data?.timing !== "schedule") {
        throw new Error("timing must be now or schedule");
      }
      if (!data.clientRequestId) throw new Error("clientRequestId required");
      const draft = validateDraft(data);
      const startsAt = data.timing === "now" ? null : (draft.startsAt ?? null);
      const refusal = sendTimingRefusal(data.timing, startsAt, draft.endsAt ?? null);
      if (refusal) throw new Error(refusal);
      return { ...draft, id: data.id ?? null, startsAt };
    },
  )
  .handler(async ({ data, context }) => sendAnnouncement({ ...data, actorId: context.userId }));

export type ThreadView = {
  workspaceId: string;
  messages: Array<{
    id: string;
    direction: "workspace" | "operator";
    authorName: string;
    authorEmail: string | null;
    authorRole: string | null;
    body: string;
    createdAt: string;
    unread: boolean;
  }>;
};

/** Every thread on one message, grouped by workspace, most recent activity first. */
export const listAnnouncementRepliesFn = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((data: { id: string }) => {
    if (!data?.id || !UUID.test(data.id)) throw new Error("id required");
    return data;
  })
  .handler(async ({ data }): Promise<{ threads: ThreadView[] }> => {
    const read = await readRepliesForAnnouncement(data.id);
    if (!read.ok) throw new Error(read.error);
    const byWorkspace = new Map<string, ThreadView>();
    for (const r of read.rows as ReplyRow[]) {
      const t = byWorkspace.get(r.workspace_id) ?? { workspaceId: r.workspace_id, messages: [] };
      t.messages.push({
        id: r.id,
        direction: r.direction === "operator" ? "operator" : "workspace",
        authorName: r.author_name,
        authorEmail: r.author_email,
        authorRole: r.author_role,
        body: r.body,
        createdAt: r.created_at,
        unread: r.direction === "workspace" && !r.operator_read_at,
      });
      byWorkspace.set(r.workspace_id, t);
    }
    const lastAt = (t: ThreadView) =>
      Date.parse(t.messages[t.messages.length - 1]?.createdAt ?? "") || 0;
    return { threads: [...byWorkspace.values()].sort((a, b) => lastAt(b) - lastAt(a)) };
  });

/** An operator answers inside one workspace's thread. */
export const replyToWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (data: { id: string; workspaceId: string; body: string; clientRequestId: string }) => {
      if (!data?.id || !UUID.test(data.id)) throw new Error("id required");
      if (!data.workspaceId || !UUID.test(data.workspaceId)) throw new Error("workspaceId required");
      if (!data.clientRequestId || !UUID.test(data.clientRequestId)) {
        throw new Error("clientRequestId required");
      }
      const body = (data.body ?? "").trim();
      if (body.length < 1 || body.length > 2000) {
        throw new Error("A reply must be 1–2000 characters");
      }
      return { ...data, body };
    },
  )
  .handler(async ({ data, context }) => {
    const profile = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("user_id", context.userId)
      .maybeSingle();
    return postOperatorReply({
      announcementId: data.id,
      workspaceId: data.workspaceId,
      body: data.body,
      actorId: context.userId,
      actorName: profile.data?.display_name?.trim() || "Mission Control operator",
      clientRequestId: data.clientRequestId,
    });
  });

/** An operator has read a workspace's thread. */
export const markThreadReadFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((data: { id: string; workspaceId: string }) => {
    if (!data?.id || !UUID.test(data.id)) throw new Error("id required");
    if (!data.workspaceId || !UUID.test(data.workspaceId)) throw new Error("workspaceId required");
    return data;
  })
  .handler(async ({ data }) =>
    markThreadRead({ announcementId: data.id, workspaceId: data.workspaceId }),
  );
