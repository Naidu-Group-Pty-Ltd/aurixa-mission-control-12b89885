/**
 * Operator RPCs for website videos (docs/WEBSITE_VIDEOS.md).
 *
 * Reads are `requireOperator`. Every write — copy, media, publishing — is
 * `requireAdmin`: a published listing is a page on the public website, the
 * same weight as a workspace message sent to every customer.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import {
  BRIEFING_STATUSES,
  SLUG_PATTERN,
  UPLOAD_PATH,
  publishProblems,
  premiereProblems,
} from "@/lib/websiteBriefings.pure";
import {
  createUploadGrant,
  createWebsiteBriefing,
  deleteDraftWebsiteBriefing,
  finalizeUpload,
  lastWebsiteRebuild,
  listWebsiteBriefings,
  readWebsiteBriefing,
  requestWebsiteRebuild,
  saveWebsiteBriefing,
  setWebsiteBriefingStatus,
  websiteMediaOrigin,
  websiteRebuildConfigured,
} from "./website-briefings.server";

const id = z.string().uuid();
const slug = z.string().regex(SLUG_PATTERN).max(60);
const text = (max: number) => z.string().max(max);

export const listWebsiteBriefingsFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const [rows, rebuild] = await Promise.all([listWebsiteBriefings(), lastWebsiteRebuild()]);
    return {
      rows: rows.ok ? rows.rows : [],
      error: rows.ok ? null : rows.schemaPending ? "schema_pending" : rows.error,
      mediaOrigin: websiteMediaOrigin(),
      rebuild: { configured: websiteRebuildConfigured(), last: rebuild },
    };
  });

export const getWebsiteBriefingFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id }).parse(input))
  .handler(async ({ data }) => {
    const read = await readWebsiteBriefing(data.id);
    if (!read.ok) throw new Error(read.error);
    return {
      row: read.row,
      publishProblems: read.row ? publishProblems(read.row) : [],
      premiereProblems: read.row ? premiereProblems(read.row) : [],
      mediaOrigin: websiteMediaOrigin(),
      rebuildConfigured: websiteRebuildConfigured(),
    };
  });

export const createWebsiteBriefingFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ slug, title: z.string().trim().min(1).max(120) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await createWebsiteBriefing({ ...data, actorId: context.userId });
    if (!result.ok) {
      return {
        ok: false as const,
        error:
          result.error === "schema_pending"
            ? "Website videos are not in the database yet — the migration that adds them has not applied."
            : result.error,
      };
    }
    return { ok: true as const, id: result.row.id };
  });

export const saveWebsiteBriefingFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id,
        slug,
        copy: z.object({
          title: z.string().trim().min(1).max(120),
          kicker: text(200),
          summary: text(400),
          series: z.enum(["flagship", "platform", "growth", "compliance"]),
          artwork: z.string().regex(/^\/brand\/[A-Za-z0-9_.-]+\.(webp|png|jpe?g)$/),
          artwork_position: text(40).nullable(),
          takeaways: z.array(text(400)).max(6),
          explore_label: text(80),
          explore_to: z.string().regex(/^\/[a-z0-9/-]*(#[a-z0-9-]+)?$/),
          orientation: z.enum(["landscape", "portrait"]),
          disclaimer: text(300).nullable(),
          transcript: z.array(text(4000)).max(200),
          chapters: z
            .array(z.object({ at: z.number().int().min(0).max(86_400), label: text(120) }))
            .max(60),
          sort_order: z.number().int().min(0).max(100_000),
        }),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await saveWebsiteBriefing({ ...data, actorId: context.userId });
    return result.ok
      ? { ok: true as const, rebuild: result.rebuild }
      : { ok: false as const, error: result.error, problems: result.problems ?? [] };
  });

export const setWebsiteBriefingStatusFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id, status: z.enum(BRIEFING_STATUSES) }).parse(input))
  .handler(async ({ data, context }) => {
    const result = await setWebsiteBriefingStatus({ ...data, actorId: context.userId });
    return result.ok
      ? { ok: true as const, status: result.row.status, rebuild: result.rebuild }
      : { ok: false as const, error: result.error, problems: result.problems ?? [] };
  });

export const deleteDraftWebsiteBriefingFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id }).parse(input))
  .handler(async ({ data, context }) =>
    deleteDraftWebsiteBriefing({ ...data, actorId: context.userId }),
  );

export const createBriefingUploadFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({ briefingId: id, paths: z.array(z.string().regex(UPLOAD_PATH)).min(1).max(2000) })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await createUploadGrant({ ...data, actorId: context.userId });
    return result.ok
      ? result
      : { ok: false as const, error: result.error, problems: result.problems ?? [] };
  });

export const finalizeBriefingUploadFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ uploadId: id }).parse(input))
  .handler(async ({ data, context }) => {
    const result = await finalizeUpload({ ...data, actorId: context.userId });
    return result.ok
      ? {
          ok: true as const,
          durationSeconds: result.durationSeconds,
          orientation: result.orientation,
          rebuild: result.rebuild,
        }
      : { ok: false as const, error: result.error, problems: result.problems ?? [] };
  });

export const requestWebsiteRebuildFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) =>
    requestWebsiteRebuild({ reason: "Requested from Website → Videos", actorId: context.userId }),
  );
