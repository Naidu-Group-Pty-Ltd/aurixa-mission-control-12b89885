// Admin server functions for the provider-neutral security intake system:
// - list/create/update/delete intake sources
// - manually link an external ticket to a Codex finding
//
// End-user vendors POST to /api/public/security/intake instead of calling
// these functions; this file exists for the Mission Control admin UI.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { asRow } from "@/lib/json-cast";
import type { TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { adapterFor, loadSourceBySlug } from "@/server/security-intake/adapters";

const admin = supabaseAdmin;

const SourceKind = z.enum(["codex", "manual", "ticketing", "generic"]);

export const listSecurityIntakeSources = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .handler(async () => {
    const { data, error } = await admin
      .from("security_intake_sources")
      .select("id, slug, name, kind, active, metadata, created_at, updated_at, hmac_secret")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return {
      sources: (data ?? []).map((r: any) => ({
        ...r,
        hmac_secret_set: Boolean(r.hmac_secret),
        hmac_secret: undefined,
      })),
    };
  });

export const upsertSecurityIntakeSource = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid().optional(),
        slug: z
          .string()
          .min(2)
          .max(64)
          .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase, digits, _ or - only"),
        name: z.string().min(2).max(120),
        kind: SourceKind,
        active: z.boolean().default(true),
        hmac_secret: z.string().min(16).optional(),
        metadata: z.record(z.any()).default({}),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {
      slug: data.slug,
      name: data.name,
      kind: data.kind,
      active: data.active,
      metadata: data.metadata,
      created_by: context.userId,
    };
    if (data.hmac_secret) patch.hmac_secret = data.hmac_secret;

    const res = data.id
      ? await admin
          .from("security_intake_sources")
          .update(asRow<TablesUpdate<"security_intake_sources">>(patch))
          .eq("id", data.id)
          .select("id, slug")
          .single()
      : await admin
          .from("security_intake_sources")
          .insert(asRow<TablesInsert<"security_intake_sources">>(patch))
          .select("id, slug")
          .single();

    if (res.error) throw new Error(res.error.message);
    await admin.from("audit_log").insert({
      action: data.id ? "security.intake_source.updated" : "security.intake_source.created",
      entity_type: "security_intake_source",
      entity_id: res.data.id,
      actor_user_id: context.userId,
      metadata: { slug: data.slug, kind: data.kind },
    });
    return { ok: true, id: res.data.id };
  });

export const rotateSecurityIntakeSecret = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    // Generate 48-byte random secret, hex-encoded → 96 chars.
    const bytes = new Uint8Array(48);
    crypto.getRandomValues(bytes);
    const secret = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // The built-in `codex` source's secret is also the master every scan
    // job's callback key is derived from. Keeping the previous value for a
    // grace window lets scans already running still report after a rotation.
    const current = await admin
      .from("security_intake_sources")
      .select("hmac_secret")
      .eq("id", data.id)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    let res = await admin
      .from("security_intake_sources")
      .update({
        hmac_secret: secret,
        previous_hmac_secret: current.data?.hmac_secret ?? null,
        hmac_rotated_at: new Date().toISOString(),
      })
      .eq("id", data.id)
      .select("id, slug")
      .single();
    // Before migration 20261018090000 there are no rotation columns.
    if (
      res.error &&
      (res.error.code === "42703" || /column .* does not exist/i.test(res.error.message))
    ) {
      res = await admin
        .from("security_intake_sources")
        .update({ hmac_secret: secret })
        .eq("id", data.id)
        .select("id, slug")
        .single();
    }
    if (res.error) throw new Error(res.error.message);
    await admin.from("audit_log").insert({
      action: "security.intake_source.secret_rotated",
      entity_type: "security_intake_source",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: { slug: res.data.slug },
    });
    // Returned exactly once — admin must copy immediately.
    return { ok: true, secret };
  });

export const deleteSecurityIntakeSource = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const existing = await admin
      .from("security_intake_sources")
      .select("slug, metadata")
      .eq("id", data.id)
      .maybeSingle();
    const existingMeta = existing.data?.metadata;
    const isBuiltIn =
      existingMeta && typeof existingMeta === "object" && !Array.isArray(existingMeta)
        ? existingMeta["built_in"] === true
        : false;
    if (isBuiltIn) throw new Error("built_in_source_cannot_be_deleted");
    const res = await admin.from("security_intake_sources").delete().eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    await admin.from("audit_log").insert({
      action: "security.intake_source.deleted",
      entity_type: "security_intake_source",
      entity_id: data.id,
      actor_user_id: context.userId,
      metadata: { slug: existing.data?.slug },
    });
    return { ok: true };
  });

export const linkExternalTicket = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        findingId: z.string().uuid(),
        sourceSlug: z.string().min(1),
        provider: z.string().min(1),
        externalId: z.string().min(1),
        url: z.string().url().optional(),
        status: z.string().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const source = await loadSourceBySlug(data.sourceSlug);
    if (!source) throw new Error("unknown_intake_source");
    const adapter = adapterFor(source);
    const link = await adapter.linkExternalTicket(
      data.findingId,
      {
        provider: data.provider,
        external_id: data.externalId,
        url: data.url,
        status: data.status,
      },
      source,
      context.userId,
    );
    await admin.from("audit_log").insert({
      action: "security.external_ticket.linked",
      entity_type: "security_external_ticket",
      entity_id: link.id,
      actor_user_id: context.userId,
      metadata: { finding_id: data.findingId, source: source.slug, provider: data.provider },
    });
    return { ok: true, ticket_id: link.id };
  });

export const listExternalTicketsForFinding = createServerFn({ method: "GET" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ findingId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const { data: rows, error } = await admin
      .from("security_external_tickets")
      .select("id, source_slug, provider, external_id, url, status, created_at, updated_at")
      .eq("codex_finding_id", data.findingId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { tickets: rows ?? [] };
  });
