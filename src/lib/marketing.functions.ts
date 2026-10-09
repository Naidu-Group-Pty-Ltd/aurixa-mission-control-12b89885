// The Marketing module's server functions: Aurixa Systems' own advertising.
//
// Operators read everything — the channels, the history, the attribution and
// the stored briefs — and may ask for a digest or a weekly brief (a model
// call, written from facts the server re-measures). Only administrators
// connect, test or remove a source, because a connection is a credential.
//
// The work lives in src/server/marketing/ and is reached through the lazy
// server shim, so none of it — and no credential — is bundled for the browser.
// No function here returns a credential: connections come back as field
// names, account identifiers and fingerprints.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import {
  DATE_PRESET_LABELS,
  formatRange,
  resolveRange,
  safeTimeZone,
  todayIn,
  type DateRange,
  type DatePreset,
} from "@/lib/marketing/marketingEngine";
import { MARKETING_SOURCES } from "@/lib/marketing/connectionFields.pure";

const shim = () => import(/* @vite-ignore */ "@/lib/_server-shims/marketing.server");

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const rangeInput = z.object({
  datePreset: z.string().max(32).optional(),
  timeRange: z.object({ since: ymd, until: ymd }).nullable().optional(),
  timeZone: z.string().max(64).optional(),
});

type RangeInput = z.infer<typeof rangeInput>;

export interface RangeEnvelope {
  range: DateRange;
  preset: DatePreset | null;
  rangeLabel: string;
  timeZone: string;
  today: string;
}

/** The range a request names, resolved against the reader's own today. */
function envelopeOf(input: RangeInput): RangeEnvelope {
  const timeZone = safeTimeZone(input.timeZone);
  const today = todayIn(timeZone);
  const resolved = resolveRange(
    { datePreset: input.datePreset, timeRange: input.timeRange ?? undefined },
    today,
  );
  if (!resolved.ok) throw new Error(resolved.error);
  return {
    range: resolved.range,
    preset: resolved.preset,
    rangeLabel: resolved.preset ? DATE_PRESET_LABELS[resolved.preset] : formatRange(resolved.range),
    timeZone,
    today,
  };
}

const adLevel = z.enum(["campaign", "adgroup", "ad"]);
const entityId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/)
  .nullable()
  .optional();

// ── Reading ───────────────────────────────────────────────────────────────────

export const getMarketingConnections = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { connectionStatuses, isEncryptionEnabled } = await shim();
    return { connections: await connectionStatuses(), encryption: isEncryptionEnabled() };
  });

export const getYouTubeOverview = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => rangeInput.parse(input ?? {}))
  .handler(async ({ data }) => {
    const envelope = envelopeOf(data);
    const { buildYouTubeOverview } = await shim();
    return {
      ...envelope,
      ...(await buildYouTubeOverview(envelope.range, envelope.today, envelope.timeZone)),
    };
  });

export const getAdChannel = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    rangeInput
      .extend({
        channel: z.enum(["meta_ads", "youtube_ads", "tiktok_ads"]),
        level: adLevel.default("campaign"),
        campaignId: entityId,
        adGroupId: entityId,
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const envelope = envelopeOf(data);
    const { buildAdChannel } = await shim();
    const view = await buildAdChannel({
      channel: data.channel,
      range: envelope.range,
      preset: envelope.preset,
      today: envelope.today,
      timeZone: envelope.timeZone,
      level: data.level,
      drill: { campaignId: data.campaignId ?? null, adGroupId: data.adGroupId ?? null },
    });
    return { ...envelope, ...view };
  });

export const getMarketingHistory = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => rangeInput.parse(input ?? {}))
  .handler(async ({ data }) => {
    const envelope = envelopeOf(data);
    const { buildHistory } = await shim();
    return { ...envelope, ...(await buildHistory(envelope.range, envelope.timeZone)) };
  });

export const listMarketingReports = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ limit: z.number().int().min(1).max(100).default(30) }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { listReports } = await shim();
    return { reports: await listReports(data.limit) };
  });

// ── Writing: a model's words, on request ──────────────────────────────────────

export const writeMarketingDigest = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    rangeInput
      .extend({ channel: z.enum(["meta_ads", "youtube_ads", "tiktok_ads", "youtube_channel"]) })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const envelope = envelopeOf(data);
    const { writeChannelDigest, DigestError } = await shim();
    try {
      const written = await writeChannelDigest({
        channel: data.channel,
        range: envelope.range,
        preset: envelope.preset,
        today: envelope.today,
        timeZone: envelope.timeZone,
        userId: context.userId,
      });
      return {
        ...envelope,
        ok: true as const,
        id: written.id,
        content: written.content,
        model: written.model,
      };
    } catch (error) {
      if (error instanceof DigestError)
        return { ...envelope, ok: false as const, error: error.message };
      throw error;
    }
  });

export const writeMarketingWeeklyBrief = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => rangeInput.parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const envelope = envelopeOf(data);
    const { writeWeeklyBrief, DigestError } = await shim();
    try {
      const written = await writeWeeklyBrief({
        range: envelope.range,
        preset: envelope.preset,
        today: envelope.today,
        timeZone: envelope.timeZone,
        userId: context.userId,
      });
      return {
        ...envelope,
        ok: true as const,
        id: written.id,
        content: written.content,
        model: written.model,
      };
    } catch (error) {
      if (error instanceof DigestError)
        return { ...envelope, ok: false as const, error: error.message };
      throw error;
    }
  });

// ── Connections: administrators only ─────────────────────────────────────────

const sourceInput = z.enum(MARKETING_SOURCES);
const fieldMap = z.record(z.string().max(4096)).default({});

export const saveMarketingConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ source: sourceInput, settings: fieldMap, secrets: fieldMap }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { saveConnection, probeConnection, ConnectionError } = await shim();
    try {
      const status = await saveConnection({
        source: data.source,
        settings: data.settings,
        secrets: data.secrets,
        userId: context.userId,
        probe: probeConnection,
      });
      return { ok: true as const, status };
    } catch (error) {
      if (error instanceof ConnectionError) return { ok: false as const, error: error.message };
      throw error;
    }
  });

export const testMarketingConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ source: sourceInput }).parse(input ?? {}))
  .handler(async ({ data }) => {
    const { loadConnection, probeConnection, noteConnectionCheck } = await shim();
    const loaded = await loadConnection(data.source);
    if (!loaded.connection)
      return { ok: false as const, error: "This source is not connected yet." };
    const probe = await probeConnection(loaded.connection);
    await noteConnectionCheck(data.source, probe.ok ? null : probe.error);
    return probe.ok
      ? { ok: true as const, accountName: probe.accountName }
      : { ok: false as const, error: probe.error };
  });

export const removeMarketingConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ source: sourceInput }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const { removeConnection } = await shim();
    await removeConnection(data.source, context.userId);
    return { ok: true as const };
  });
