// POST /api/public/security/intake
//
// Provider-neutral security-finding intake. Any registered source in
// `security_intake_sources` can POST here with an HMAC signature keyed by
// that source's secret. The route resolves the correct adapter (Codex /
// Manual / Ticketing / Generic) and dispatches ingest, status, or ticket-
// link operations against the canonical `codex_findings` store.
//
// Header contract:
//   x-intake-source: <source_slug>
//   x-intake-signature: sha256=<hex hmac of raw body using source.hmac_secret>
//
// Body contract (versioned envelope):
//   {
//     "version": "1",
//     "op": "ingest" | "status" | "link_ticket",
//     "finding": NormalizedFinding,         // when op = ingest
//     "external_id": string, "state": str,   // when op = status
//     "reason": string                        // op = status, optional: why
//                                             // (a verdict without one records
//                                             // the source as the decider)
//     "ticket": { provider, external_id, url?, status? },   // when op = link_ticket
//     "finding_external_id": string          // when op = link_ticket
//   }

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { IntakeStatusError, adapterFor, loadSourceBySlug } from "@/server/security-intake/adapters";
import { verifyIntakeSignature } from "@/server/security-intake/signature";
import { writeAuditLog } from "@/server/audit.server";

const FindingSchema = z.object({
  external_id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  description: z.string().optional().nullable(),
  affected_file: z.string().optional().nullable(),
  affected_line: z.number().int().optional().nullable(),
  cwe: z.string().optional().nullable(),
  cvss: z.number().optional().nullable(),
  auto_fix_confidence: z.number().optional().nullable(),
  clone_id: z.string().uuid().optional().nullable(),
  raw: z.record(z.any()).optional(),
});

const TicketSchema = z.object({
  provider: z.string().min(1),
  external_id: z.string().min(1),
  url: z.string().url().optional(),
  status: z.string().optional(),
});

const PayloadSchema = z.discriminatedUnion("op", [
  z.object({ version: z.string().default("1"), op: z.literal("ingest"), finding: FindingSchema }),
  z.object({
    version: z.string().default("1"),
    op: z.literal("status"),
    external_id: z.string().min(1),
    state: z.string().min(1),
    reason: z.string().max(2000).optional(),
  }),
  z.object({
    version: z.string().default("1"),
    op: z.literal("link_ticket"),
    finding_external_id: z.string().min(1),
    ticket: TicketSchema,
  }),
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/public/security/intake")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const slug = request.headers.get("x-intake-source");
        const sig = request.headers.get("x-intake-signature");
        if (!slug) return json({ error: "missing x-intake-source" }, 400);

        const source = await loadSourceBySlug(slug);
        if (!source) return json({ error: "unknown source" }, 404);
        if (!source.active) return json({ error: "source disabled" }, 403);

        const ok = await verifyIntakeSignature(raw, sig, source.hmac_secret);
        if (!ok) return json({ error: "invalid signature" }, 401);

        let payload: z.infer<typeof PayloadSchema>;
        try {
          payload = PayloadSchema.parse(JSON.parse(raw));
        } catch (err) {
          return json({ error: "invalid payload", detail: (err as Error).message }, 400);
        }

        const admin = supabaseAdmin;
        const adapter = adapterFor(source);

        try {
          if (payload.op === "ingest") {
            const result = await adapter.ingestFinding(payload.finding, source);
            await writeAuditLog({
              action: "security.intake.ingest",
              entityType: "codex_finding",
              entityId: result.id,
              metadata: { source: source.slug, created: result.created },
            });
            return json({ ok: true, finding_id: result.id, created: result.created });
          }

          if (payload.op === "status") {
            const result = await adapter.updateStatus(
              payload.external_id,
              payload.state,
              source,
              payload.reason ?? null,
            );
            await writeAuditLog({
              action: "security.intake.status",
              entityType: "codex_finding",
              metadata: {
                source: source.slug,
                external_id: payload.external_id,
                state: payload.state,
                from: result.from ?? null,
                to: result.to ?? null,
                changed: result.changed,
              },
            });
            return json({ ok: true, changed: result.changed, state: result.to ?? null });
          }

          // link_ticket
          const findRes = await admin
            .from("codex_findings")
            .select("id")
            .eq("codex_finding_id", `${source.slug}:${payload.finding_external_id}`)
            .maybeSingle();
          if (!findRes.data?.id) return json({ error: "finding not found" }, 404);
          const link = await adapter.linkExternalTicket(
            findRes.data.id,
            payload.ticket,
            source,
            null,
          );
          await writeAuditLog({
            action: "security.intake.link_ticket",
            entityType: "security_external_ticket",
            entityId: link.id,
            metadata: { source: source.slug, ...payload.ticket },
          });
          return json({ ok: true, ticket_id: link.id });
        } catch (err) {
          if (err instanceof IntakeStatusError) {
            return json({ error: err.message }, err.status);
          }
          return json({ error: "intake failed", detail: (err as Error).message }, 500);
        }
      },
    },
  },
});
