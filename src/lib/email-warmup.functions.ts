/**
 * The operator's API for email warmup.
 *
 * Reads go through the CALLER'S client, so the RLS policies beside the tables
 * decide what an operator sees. Writes go through the service role, behind
 * `requireOperator`, because none of them is a plain row edit: enrolling a
 * mailbox has to ask Microsoft first (its tenant's credentials, its
 * permissions, its warmup folder), and the engine's own columns — where a
 * mailbox is in its ramp, when it next sends — are not a browser's to write.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  HEALTH_WINDOW_DAYS,
  dailySeries,
  dailyTarget,
  daysBefore,
  healthScore,
  localDate,
  rampDay,
  scheduleFromRow,
  scheduleProblems,
  totalsBetween,
  type WarmupDay,
  type WarmupSchedule,
} from "@/lib/email/warmupPlan.pure";

const uuid = z.string().uuid();

const scheduleSchema = z.object({
  startPerDay: z.number().int(),
  increasePerDay: z.number().int(),
  maxPerDay: z.number().int(),
  replyRate: z.number().int(),
  importantRate: z.number().int(),
  weekdaysOnly: z.boolean(),
  timezone: z.string().min(1).max(64),
  windowStart: z.string().max(8),
  windowEnd: z.string().max(8),
});

function scheduleColumns(schedule: WarmupSchedule) {
  return {
    start_per_day: schedule.startPerDay,
    increase_per_day: schedule.increasePerDay,
    max_per_day: schedule.maxPerDay,
    reply_rate: schedule.replyRate,
    important_rate: schedule.importantRate,
    weekdays_only: schedule.weekdaysOnly,
    timezone: schedule.timezone,
    window_start: schedule.windowStart,
    window_end: schedule.windowEnd,
  };
}

function assertSchedule(schedule: WarmupSchedule) {
  const problems = scheduleProblems(schedule);
  if (problems.length > 0) throw new Error(problems.join("; "));
}

async function audit(
  action: string,
  entityId: string | null,
  actorUserId: string,
  metadata: Record<string, unknown>,
) {
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action,
    entityType: "email_warmup_mailbox",
    entityId,
    actorUserId,
    metadata,
  });
}

// ── The pool ─────────────────────────────────────────────────────────────────

/** Everything the warmup page shows at the top level. */
export const getWarmupPool = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const now = new Date();
    const [settings, mailboxes, tenants, days] = await Promise.all([
      context.supabase.from("email_warmup_settings").select("*").maybeSingle(),
      context.supabase
        .from("email_warmup_mailboxes")
        .select("*")
        .neq("status", "removed")
        .order("created_at", { ascending: true }),
      context.supabase.from("microsoft_tenants").select("id, label"),
      context.supabase
        .from("email_warmup_daily")
        .select("*")
        // A day either side of the 7-day window covers every mailbox's zone.
        .gte("day", daysBefore(now.toISOString().slice(0, 10), HEALTH_WINDOW_DAYS + 1)),
    ]);
    for (const result of [settings, mailboxes, tenants, days]) if (result.error) throw result.error;

    const { DEFAULT_TENANT_LABEL } = await import("@/server/microsoft-tenants.server");
    const labels = new Map((tenants.data ?? []).map((row) => [row.id, row.label]));
    const daysByMailbox = new Map<string, Partial<WarmupDay>[]>();
    for (const row of (days.data ?? []) as Partial<WarmupDay & { mailbox_id: string }>[]) {
      if (!row.mailbox_id) continue;
      const list = daysByMailbox.get(row.mailbox_id) ?? [];
      list.push(row);
      daysByMailbox.set(row.mailbox_id, list);
    }

    const rows = (mailboxes.data ?? []).map((row) => {
      const schedule = scheduleFromRow(row);
      const today = localDate(now, schedule.timezone);
      const day = rampDay({ activeDays: row.active_days, lastActiveOn: row.last_active_on, today });
      const own = daysByMailbox.get(row.id) ?? [];
      const todays = totalsBetween(own, today, today);
      const week = totalsBetween(own, daysBefore(today, HEALTH_WINDOW_DAYS - 1), today);
      return {
        id: row.id,
        mailbox: row.mailbox,
        displayName: row.display_name,
        tenantId: row.tenant_id,
        tenantLabel: row.tenant_id
          ? (labels.get(row.tenant_id) ?? "Removed tenant")
          : DEFAULT_TENANT_LABEL,
        organisationId: row.organisation_id,
        status: row.status as "active" | "paused" | "error",
        statusReason: row.status_reason,
        schedule,
        tidySent: row.tidy_sent,
        rampDay: day,
        targetToday: dailyTarget(schedule, day),
        startedToday: todays.sent - todays.replies_sent,
        repliesToday: todays.replies_sent,
        receivedToday: todays.received,
        week,
        health: healthScore(week),
        nextSendAt: row.next_send_at,
        preparedAt: row.prepared_at,
        lastError: row.last_error,
        lastErrorAt: row.last_error_at,
        createdAt: row.created_at,
      };
    });

    const live = rows.filter((row) => row.status === "active" && row.preparedAt);
    const pool = rows.reduce(
      (acc, row) => {
        for (const key of Object.keys(acc.week) as (keyof typeof acc.week)[])
          acc.week[key] += row.week[key];
        acc.startedToday += row.startedToday;
        acc.receivedToday += row.receivedToday;
        return acc;
      },
      {
        startedToday: 0,
        receivedToday: 0,
        week: {
          sent: 0,
          replies_sent: 0,
          inbox: 0,
          junk: 0,
          other: 0,
          missing: 0,
          received: 0,
          rescued: 0,
          replied: 0,
        },
      },
    );

    return {
      settings: {
        paused: Boolean(settings.data?.paused),
        allowSameOrganisation: Boolean(settings.data?.allow_same_organisation),
        lastTickAt: settings.data?.last_tick_at ?? null,
        lastTickNote: settings.data?.last_tick_note ?? null,
      },
      mailboxes: rows,
      warming: live.length,
      organisations: new Set(live.map((row) => row.organisationId).filter(Boolean)).size,
      pool: { ...pool, health: healthScore(pool.week) },
    };
  });

export type WarmupPool = Awaited<ReturnType<typeof getWarmupPool>>;
export type WarmupMailboxSummary = WarmupPool["mailboxes"][number];

/** One mailbox's last 30 days, day by day, and its latest messages both ways. */
export const getWarmupMailbox = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("email_warmup_mailboxes")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("that mailbox is not in the warmup pool");
    const today = localDate(new Date(), scheduleFromRow(row).timezone);
    const [days, messages] = await Promise.all([
      context.supabase
        .from("email_warmup_daily")
        .select("*")
        .eq("mailbox_id", data.id)
        .gte("day", daysBefore(today, 29)),
      context.supabase
        .from("email_warmup_messages")
        .select(
          "id, thread_id, depth, sender_id, recipient_id, sender_address, recipient_address, subject, status, placement, sent_at, landed_at, rescued_at, flagged_at, engaged_at, replied_at, will_reply, error, created_at",
        )
        .or(`sender_id.eq.${data.id},recipient_id.eq.${data.id}`)
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    if (days.error) throw days.error;
    if (messages.error) throw messages.error;
    return {
      series: dailySeries((days.data ?? []) as Partial<WarmupDay>[], today, 30),
      messages: (messages.data ?? []).map((message) => ({
        ...message,
        direction: message.sender_id === data.id ? ("out" as const) : ("in" as const),
        partner: message.sender_id === data.id ? message.recipient_address : message.sender_address,
      })),
    };
  });

// ── Enrolling ────────────────────────────────────────────────────────────────

/**
 * Enrol mailboxes of one tenant. Each is prepared first — its tenant's
 * credentials tried, its warmup folder created — and refused with the reason
 * if that fails; the others go ahead.
 */
export const enrollWarmupMailboxes = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        tenantId: uuid.nullable(),
        mailboxes: z
          .array(
            z.object({
              address: z.string().min(3).max(320),
              displayName: z.string().max(200).nullable(),
            }),
          )
          .min(1)
          .max(25),
        schedule: scheduleSchema,
        tidySent: z.boolean().default(true),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    assertSchedule(data.schedule);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { prepareWarmupMailbox, firstSendAt } = await import("@/server/email-warmup.server");

    const results: { address: string; ok: boolean; reason: string | null }[] = [];
    for (const entry of data.mailboxes) {
      const address = emailKey(entry.address);
      if (!address) {
        results.push({
          address: entry.address,
          ok: false,
          reason: "that is not a valid email address",
        });
        continue;
      }
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("email_warmup_mailboxes")
        .select("id")
        .eq("mailbox", address)
        .is("removed_at", null)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing) {
        results.push({ address, ok: false, reason: "already in the warmup pool" });
        continue;
      }

      const prepared = await prepareWarmupMailbox({ mailbox: address, tenantId: data.tenantId });
      if (!prepared.ok) {
        results.push({ address, ok: false, reason: prepared.reason });
        continue;
      }
      const columns = scheduleColumns(data.schedule);
      const now = new Date();
      const { data: inserted, error } = await supabaseAdmin
        .from("email_warmup_mailboxes")
        .insert({
          tenant_id: data.tenantId,
          mailbox: address,
          display_name: entry.displayName?.trim() || null,
          ...columns,
          tidy_sent: data.tidySent,
          warmup_folder_id: prepared.folderId,
          organisation_id: prepared.organisationId,
          prepared_at: now.toISOString(),
          next_send_at: firstSendAt(columns, now)?.toISOString() ?? null,
          created_by: context.userId,
        })
        .select("id")
        .single();
      if (error) {
        results.push({
          address,
          ok: false,
          reason: error.message.includes("email_warmup_mailboxes_live")
            ? "already in the warmup pool"
            : error.message,
        });
        continue;
      }
      await audit("email_warmup_enrolled", inserted.id, context.userId, {
        mailbox: address,
        tenantId: data.tenantId,
        schedule: data.schedule,
      });
      results.push({ address, ok: true, reason: null });
    }
    return { results };
  });

// ── Changing one ─────────────────────────────────────────────────────────────

async function loadMailbox(id: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("email_warmup_mailboxes")
    .select("*")
    .eq("id", id)
    .neq("status", "removed")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("that mailbox is not in the warmup pool");
  return { supabaseAdmin, row: data };
}

/** Change a mailbox's schedule. Its place in the ramp is kept. */
export const updateWarmupMailbox = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, schedule: scheduleSchema, tidySent: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    assertSchedule(data.schedule);
    const { supabaseAdmin, row } = await loadMailbox(data.id);
    const { firstSendAt } = await import("@/server/email-warmup.server");
    const columns = scheduleColumns(data.schedule);
    const now = new Date();
    const { error } = await supabaseAdmin
      .from("email_warmup_mailboxes")
      .update({
        ...columns,
        tidy_sent: data.tidySent,
        // A new window or volume applies from the next pass, not tomorrow.
        next_send_at:
          row.status === "active"
            ? (firstSendAt(columns, now)?.toISOString() ?? null)
            : row.next_send_at,
        updated_at: now.toISOString(),
      })
      .eq("id", data.id);
    if (error) throw error;
    await audit("email_warmup_schedule_changed", data.id, context.userId, {
      mailbox: row.mailbox,
      before: scheduleFromRow(row),
      after: data.schedule,
    });
    return { ok: true };
  });

/**
 * Pause or resume a mailbox. Resuming prepares it again — its tenant, its
 * permissions, its folder — so a mailbox put into `error` comes back only
 * once whatever stopped it is fixed.
 */
export const setWarmupMailboxStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ id: uuid, status: z.enum(["active", "paused"]) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, row } = await loadMailbox(data.id);
    const now = new Date();
    if (data.status === "paused") {
      const { error } = await supabaseAdmin
        .from("email_warmup_mailboxes")
        .update({
          status: "paused",
          status_reason: null,
          next_send_at: null,
          updated_at: now.toISOString(),
        })
        .eq("id", data.id);
      if (error) throw error;
    } else {
      const { prepareWarmupMailbox, firstSendAt } = await import("@/server/email-warmup.server");
      const prepared = await prepareWarmupMailbox({
        mailbox: row.mailbox,
        tenantId: row.tenant_id,
      });
      if (!prepared.ok) throw new Error(prepared.reason);
      const { error } = await supabaseAdmin
        .from("email_warmup_mailboxes")
        .update({
          status: "active",
          status_reason: null,
          consecutive_failures: 0,
          last_error: null,
          last_error_at: null,
          warmup_folder_id: prepared.folderId,
          organisation_id: prepared.organisationId,
          prepared_at: now.toISOString(),
          next_send_at: firstSendAt(row, now)?.toISOString() ?? null,
          updated_at: now.toISOString(),
        })
        .eq("id", data.id);
      if (error) throw error;
    }
    await audit(
      data.status === "paused" ? "email_warmup_paused" : "email_warmup_resumed",
      data.id,
      context.userId,
      {
        mailbox: row.mailbox,
        from: row.status,
      },
    );
    return { ok: true };
  });

/**
 * Take a mailbox out of the pool. Its warmup folder and the mail in it stay
 * in the mailbox; its record stays here, so the messages it exchanged remain
 * attributed. Mail already on its way to it is left alone.
 */
export const removeWarmupMailbox = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, row } = await loadMailbox(data.id);
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("email_warmup_mailboxes")
      .update({
        status: "removed",
        removed_at: now,
        removed_by: context.userId,
        next_send_at: null,
        updated_at: now,
      })
      .eq("id", data.id);
    if (error) throw error;
    await audit("email_warmup_removed", data.id, context.userId, { mailbox: row.mailbox });
    return { ok: true };
  });

/** The pool's own switches: pause everything, and the same-organisation test mode. */
export const updateWarmupSettings = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({ paused: z.boolean().optional(), allowSameOrganisation: z.boolean().optional() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: {
      paused?: boolean;
      allow_same_organisation?: boolean;
      updated_at: string;
      updated_by: string;
    } = {
      updated_at: new Date().toISOString(),
      updated_by: context.userId,
    };
    if (data.paused !== undefined) patch.paused = data.paused;
    if (data.allowSameOrganisation !== undefined)
      patch.allow_same_organisation = data.allowSameOrganisation;
    const { error } = await supabaseAdmin
      .from("email_warmup_settings")
      .update(patch)
      .eq("id", true);
    if (error) throw error;
    await audit("email_warmup_settings_changed", null, context.userId, data);
    return { ok: true };
  });
