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
 * stamped per (announcement, clone) by the route — evidence of effect, never
 * of configuration: a notice nobody's dashboard has fetched must be
 * distinguishable from one that is working.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { Tables, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import {
  activeAnnouncementsForClone,
  audienceSummary,
  resolveAnnouncementState,
  type AnnouncementFacts,
  type CloneAnnouncementWire,
} from "@/lib/cloneAnnouncements.pure";

export type AnnouncementRow = Tables<"clone_announcements">;
export type DeliveryRow = Tables<"clone_announcement_deliveries">;

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
 * What one clone should be showing right now. The route's whole answer:
 * resolve the clone's entitled plan, run the shared matcher, project onto
 * the wire. A failed clone read fails the call rather than serving a
 * global-only subset that would look complete.
 */
export async function announcementsForClone(
  cloneId: string,
): Promise<
  | { ok: true; announcements: CloneAnnouncementWire[] }
  | { ok: false; failed: true; error: string }
> {
  const [live, cloneQ] = await Promise.all([
    readLiveAnnouncements(),
    supabaseAdmin
      .from("clones")
      .select("id, entitled_plan_slug")
      .eq("id", cloneId)
      .maybeSingle(),
  ]);
  if (!live.ok) return live;
  if (cloneQ.error) return { ok: false, failed: true, error: cloneQ.error.message };
  if (!cloneQ.data) {
    // A key whose clone row is gone serves nothing — an empty list is the
    // honest answer, not an error the clone would render around.
    return { ok: true, announcements: [] };
  }
  const announcements = activeAnnouncementsForClone(
    live.rows.map(factsOf),
    { id: cloneQ.data.id, planSlug: cloneQ.data.entitled_plan_slug ?? null },
    new Date(),
  );
  return { ok: true, announcements };
}

/**
 * Stamp that a clone received these notices. Best-effort and deliberately
 * unawaited by the route — the stamp is observability, and losing one to a
 * race costs a count, not a record. Mirrors `recordGateCheck`.
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
  startsAt?: string | null;
  endsAt?: string | null;
};

type ActResult =
  | { ok: true; row: AnnouncementRow }
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
    starts_at: input.startsAt || null,
    ends_at: input.endsAt || null,
  };
}

export async function createAnnouncement(
  input: AnnouncementDraftInput & { actorId: string },
): Promise<ActResult> {
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .insert(
      asRow<TablesInsert<"clone_announcements">>({
        ...draftToColumns(input),
        created_by: input.actorId,
      }),
    )
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
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
  const { data, error } = await supabaseAdmin
    .from("clone_announcements")
    .update(asRow<TablesUpdate<"clone_announcements">>(draftToColumns(input)))
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
  return { ok: true, row };
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
  const state = resolveAnnouncementState(factsOf(row));
  await writeAuditLog({
    action: "clone_announcement.published",
    entityType: "clone_announcement",
    entityId: row.id,
    actorUserId: input.actorId,
    metadata: {
      title: row.title,
      audience: audienceSummary(factsOf(row)),
      state,
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
  return { ok: true, row };
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
  return { ok: true, row };
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
  return { ok: true, row };
}
