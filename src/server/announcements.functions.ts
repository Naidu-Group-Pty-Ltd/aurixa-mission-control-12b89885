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
  resolveAnnouncementState,
  type AnnouncementFacts,
  type AnnouncementState,
} from "@/lib/cloneAnnouncements.pure";
import {
  archiveAnnouncement,
  createAnnouncement,
  publishAnnouncement,
  reraiseAnnouncement,
  updateAnnouncement,
  type AnnouncementDraftInput,
  type AnnouncementRow,
  type DeliveryRow,
} from "./announcements.server";

export type AnnouncementCloneRef = {
  id: string;
  name: string;
  slug: string;
  planSlug: string | null;
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
      } | null;
    }
  >;
  /** How many of those clones have actually fetched it at least once. */
  deliveredTo: number;
};

export type AnnouncementListResult = {
  rows: AnnouncementListRow[];
  clones: AnnouncementCloneRef[];
  planOptions: Array<{ slug: string; name: string }>;
  summary: {
    total: number;
    active: number;
    scheduled: number;
    drafts: number;
    expired: number;
    archived: number;
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
    const [annQ, clonesQ, deliveriesQ] = await Promise.all([
      supabaseAdmin
        .from("clone_announcements")
        .select("*")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("clones")
        .select("id, name, slug, entitled_plan_slug")
        .order("name", { ascending: true }),
      supabaseAdmin.from("clone_announcement_deliveries").select("*"),
    ]);
    if (annQ.error) throw new Error(annQ.error.message);
    if (clonesQ.error) throw new Error(clonesQ.error.message);
    if (deliveriesQ.error) throw new Error(deliveriesQ.error.message);

    const clones: AnnouncementCloneRef[] = (clonesQ.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      planSlug: c.entitled_plan_slug ?? null,
    }));
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
                  }
                : null,
            };
          });
        return {
          row,
          state: resolveAnnouncementState(facts, now),
          audience: audienceSummary(facts, cloneNames),
          reaches,
          deliveredTo: reaches.filter((r) => r.delivery !== null).length,
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
      summary: {
        total: rows.length,
        active: rows.filter((r) => r.state === "active").length,
        scheduled: rows.filter((r) => r.state === "scheduled").length,
        drafts: rows.filter((r) => r.state === "draft").length,
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
  if (data.startsAt && data.endsAt && Date.parse(data.endsAt) <= Date.parse(data.startsAt)) {
    throw new Error("The end time must come after the start time");
  }
  return {
    ...data,
    title,
    body,
    linkUrl,
    linkLabel: linkUrl ? data.linkLabel?.trim() || null : null,
  };
}

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
