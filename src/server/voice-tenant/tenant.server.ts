// A deployed tenant fleet's tool backend: the store its tools read and write,
// and the webhook VAPI calls them through.
//
// POST /api/public/voice/t/$tenantKey/webhook
//
// - The tenant key in the URL is opaque and random (it is not the project id
//   and not the business name), so tenants cannot be enumerated and survive a
//   rename.
// - Every request must present that tenant's own secret in `x-vapi-secret`,
//   compared in constant time against the decrypted value. There is no
//   fleet-wide secret here: one leaked tenant secret opens one tenant.
// - Refusals are audited, never quiet (the prime repo lost six weeks of call
//   logs to silent 401s).
// - It answers `tool-calls` only. Call logs go to the client's own
//   workspace (the assistant-level server URL), not here.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { timingSafeEqualStr } from "@/server/cron-auth.server";
import { decryptSecret } from "@/server/crypto.server";
import { tenantWindow, type BookingTypeDef } from "@/lib/voice-studio/tenantBooking.pure";
import {
  handleTenantToolCalls,
  phoneKey,
  ticketReference,
  type TenantCallContext,
  type TenantContact,
  type TenantStore,
} from "@/lib/voice-studio/tenantTools.pure";

type ContextRow = {
  vapi_call_id: string;
  caller_phone: string | null;
  contact_id: string | null;
  first_name: string | null;
  full_name: string | null;
  contact_state: string | null;
  contact_found: boolean | null;
  contact_created: boolean | null;
  confirmed_intent: string | null;
  caller_reason: string | null;
  handoff_ready: boolean;
};

const toContact = (r: { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string }): TenantContact => ({
  id: r.id,
  firstName: r.first_name,
  lastName: r.last_name,
  email: r.email,
  phone: r.phone,
});

const toContext = (r: ContextRow): TenantCallContext => ({
  vapiCallId: r.vapi_call_id,
  callerPhone: r.caller_phone,
  contactId: r.contact_id,
  firstName: r.first_name,
  fullName: r.full_name,
  contactState: r.contact_state,
  contactFound: r.contact_found,
  contactCreated: r.contact_created,
  confirmedIntent: r.confirmed_intent,
  callerReason: r.caller_reason,
  handoffReady: r.handoff_ready,
});

const CONTEXT_COLUMNS =
  "vapi_call_id, caller_phone, contact_id, first_name, full_name, contact_state, contact_found, contact_created, confirmed_intent, caller_reason, handoff_ready";

/** Every read and write is filtered by the tenant's project id - no query here can reach another tenant. */
export function tenantStore(projectId: string): TenantStore {
  return {
    async findContactByPhone(phone) {
      const key = phoneKey(phone);
      if (!key) return null;
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_contacts")
        .select("id, first_name, last_name, email, phone")
        .eq("project_id", projectId)
        .like("phone", `%${key}`)
        .limit(5);
      if (error) throw error;
      const hit = (data ?? []).find((c) => phoneKey(c.phone) === key);
      return hit ? toContact(hit) : null;
    },
    async createContact(c) {
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_contacts")
        .upsert(
          { project_id: projectId, phone: c.phone, first_name: c.firstName, last_name: c.lastName, email: c.email },
          { onConflict: "project_id,phone" },
        )
        .select("id, first_name, last_name, email, phone")
        .single();
      if (error) throw error;
      return toContact(data);
    },
    async getContact(id) {
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_contacts")
        .select("id, first_name, last_name, email, phone")
        .eq("project_id", projectId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data ? toContact(data) : null;
    },
    async fillContactEmail(id, email) {
      const { error } = await supabaseAdmin
        .from("voice_tenant_contacts")
        .update({ email })
        .eq("project_id", projectId)
        .eq("id", id)
        .is("email", null);
      if (error) throw error;
    },
    async readContext(vapiCallId, key) {
      if (vapiCallId) {
        const { data, error } = await supabaseAdmin
          .from("voice_tenant_call_context")
          .select(CONTEXT_COLUMNS)
          .eq("project_id", projectId)
          .eq("vapi_call_id", vapiCallId)
          .maybeSingle();
        if (error) throw error;
        if (data) return toContext(data);
      }
      // A squad member that lost the call id across a handoff: the most recent
      // context for the caller's number.
      if (!key) return null;
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_call_context")
        .select(CONTEXT_COLUMNS)
        .eq("project_id", projectId)
        .eq("normalized_phone", key)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? toContext(data) : null;
    },
    async upsertContext(vapiCallId, f) {
      if (!vapiCallId) return;
      const row: Record<string, unknown> = { project_id: projectId, vapi_call_id: vapiCallId };
      if (f.callerPhone !== undefined) row.caller_phone = f.callerPhone;
      if (f.phoneKey !== undefined) row.normalized_phone = f.phoneKey;
      if (f.contactId !== undefined) row.contact_id = f.contactId;
      if (f.firstName !== undefined) row.first_name = f.firstName;
      if (f.fullName !== undefined) row.full_name = f.fullName;
      if (f.contactState !== undefined) row.contact_state = f.contactState;
      if (f.contactFound !== undefined) row.contact_found = f.contactFound;
      if (f.contactCreated !== undefined) row.contact_created = f.contactCreated;
      if (f.confirmedIntent !== undefined) row.confirmed_intent = f.confirmedIntent;
      if (f.callerReason !== undefined) row.caller_reason = f.callerReason;
      if (f.handoffReady !== undefined) row.handoff_ready = f.handoffReady;
      const { error } = await supabaseAdmin
        .from("voice_tenant_call_context")
        .upsert(row as never, { onConflict: "project_id,vapi_call_id" });
      if (error) throw error;
    },
    async bookedIntervals(fromIso, toIso) {
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_appointments")
        .select("starts_at, ends_at")
        .eq("project_id", projectId)
        .in("status", ["scheduled", "confirmed"])
        .gte("ends_at", fromIso)
        .lte("starts_at", toIso);
      if (error) throw error;
      return (data ?? []).map((b) => ({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at) }));
    },
    async createAppointment(a) {
      const { data, error } = await supabaseAdmin
        .from("voice_tenant_appointments")
        .insert({
          project_id: projectId,
          contact_id: a.contactId,
          booking_type: a.bookingType,
          starts_at: a.startsAt,
          ends_at: a.endsAt,
          vapi_call_id: a.vapiCallId,
          notes: a.notes,
        })
        .select("id, starts_at")
        .single();
      // 23505: the one-live-booking-per-start index - two calls raced for the
      // same slot and this one lost.
      if (error?.code === "23505") return null;
      if (error) throw error;
      return { id: data.id, startsAt: data.starts_at };
    },
    async createTicket(t) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const reference = ticketReference();
        const { error } = await supabaseAdmin.from("voice_tenant_tickets").insert({
          project_id: projectId,
          contact_id: t.contactId,
          reference,
          summary: t.summary,
          detail: t.detail,
          email: t.email,
          vapi_call_id: t.vapiCallId,
        });
        if (!error) return { reference };
        if (error.code !== "23505") throw error;
      }
      throw new Error("could not mint a unique ticket reference");
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function refuse(reason: string, tenantKey: string, status = 401): Promise<Response> {
  await writeAuditLog({
    action: "voice_tenant_webhook_rejected",
    entityType: "voice_tenant_webhook",
    metadata: { reason, tenant_key_prefix: tenantKey.slice(0, 6) },
  });
  return json({ ok: false, error: reason }, status);
}

export async function ingestTenantWebhook(request: Request, tenantKey: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(tenantKey)) return refuse("unknown_tenant", tenantKey, 404);

  const { data: config, error } = await supabaseAdmin
    .from("voice_tenant_configs")
    .select("project_id, webhook_secret_enc, enabled, business_name, timezone, booking_window, booking_types")
    .eq("tenant_key", tenantKey)
    .maybeSingle();
  if (error) {
    console.error("[voice-tenant] config read failed:", error.message);
    return json({ ok: false, error: "config_unavailable" }, 503);
  }
  if (!config) return refuse("unknown_tenant", tenantKey, 404);

  const presented = request.headers.get("x-vapi-secret") ?? request.headers.get("x-vapi-webhook-secret") ?? "";
  if (!presented) return refuse("secret_not_presented", tenantKey);
  let secret: string;
  try {
    secret = decryptSecret(config.webhook_secret_enc);
  } catch {
    return json({ ok: false, error: "secret_unreadable" }, 503);
  }
  if (!timingSafeEqualStr(presented, secret)) return refuse("secret_mismatch", tenantKey);
  if (!config.enabled) return refuse("tenant_disabled", tenantKey, 403);

  let payload: Record<string, any>;
  try {
    payload = (await request.json()) as Record<string, any>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const message = payload?.message && typeof payload.message === "object" ? payload.message : {};
  if (message.type !== "tool-calls") return json({ ok: true, ignored: message.type ?? "unknown" });

  const timezone = config.timezone || "Australia/Sydney";
  const result = await handleTenantToolCalls(message, {
    businessName: config.business_name ?? "the business",
    timezone,
    window: tenantWindow(config.booking_window as never, timezone),
    bookingTypes: Array.isArray(config.booking_types) ? (config.booking_types as unknown as BookingTypeDef[]) : [],
    store: tenantStore(config.project_id),
    now: () => new Date(),
  });
  return json(result);
}
