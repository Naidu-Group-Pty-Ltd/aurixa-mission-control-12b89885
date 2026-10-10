/**
 * A CRM-independent clone reading and changing its voice agents' calendar and
 * email settings — the only door a TENANT has to its own Make stack.
 *
 *   GET  /api/public/voice-automation/view
 *   POST /api/public/voice-automation/update    { expectedRevision, settings, actor }
 *   POST /api/public/voice-automation/connect   { kind, actor: { label, name, email } }
 *   POST /api/public/voice-automation/refresh   { kind }
 *   POST /api/public/voice-automation/apply     {}
 *
 * Authenticated with the clone's own Mission Control key. The clone is the
 * key's clone and nothing in a request can name another one; the stack is the
 * one registered for that clone and nothing in a request can name a scenario,
 * a data store or a team.
 *
 * The Make API token never leaves Mission Control (`make-client.server.ts`
 * says why), so a tenant's change is a REQUEST: `voice-automation.server.ts`
 * validates it, refuses locked fields, checks the revision it was made
 * against, records it, and applies it. `actor` is the clone's statement of
 * which of its users acted — recorded as such, never used to authorise.
 *
 * Refusals that are Mission Control's own carry `x-mission-control-refusal`,
 * like every other broker here, so the clone can tell "Mission Control would
 * not" from a relayed answer.
 */
import { createFileRoute } from "@tanstack/react-router";
import { resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

const OPERATIONS = ["view", "update", "connect", "refresh", "apply"] as const;
type Operation = (typeof OPERATIONS)[number];

/** Accepted while live keys are widened onto the new default scope. */
const SCOPES = ["automation:configure", "integrations:write"];

const json = (body: unknown, status = 200, refusal?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...(refusal ? { "x-mission-control-refusal": refusal } : {}),
    },
  });

const refuse = (
  error: string,
  message: string,
  status: number,
  extra: Record<string, unknown> = {},
) => json({ ok: false, error, message, ...extra }, status, error);

async function authorise(request: Request) {
  const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), SCOPES);
  if (!key)
    return {
      response: refuse(
        "unauthorized",
        "This Mission Control key is unknown, revoked, or lacks the automation:configure scope.",
        401,
      ),
    };
  if (!key.clone_id)
    return { response: refuse("not_a_clone_key", "This key does not belong to a clone.", 403) };
  const rl = await checkRateLimit(key.id);
  if (!rl.ok) {
    const res = refuse("rate_limited", "Too many requests.", 429, {
      retry_after_seconds: rl.retry_after_seconds,
    });
    res.headers.set("Retry-After", String(rl.retry_after_seconds));
    return { response: res };
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: clone, error } = await supabaseAdmin
    .from("clones")
    .select("crm_mode")
    .eq("id", key.clone_id)
    .maybeSingle();
  if (error)
    return { response: refuse("unavailable", "Mission Control could not read this clone.", 503) };
  if (clone?.crm_mode !== "independent")
    return {
      response: refuse(
        "not_crm_independent",
        "Voice-agent calendar and email settings exist only on the CRM-independent line.",
        403,
      ),
    };
  return { cloneId: key.clone_id as string };
}

function operationOf(params: unknown): Operation | null {
  const op = String((params as { operation?: string }).operation ?? "");
  return (OPERATIONS as readonly string[]).includes(op) ? (op as Operation) : null;
}

export const Route = createFileRoute("/api/public/voice-automation/$operation")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (operationOf(params) !== "view")
          return refuse("unknown_operation", "GET serves view only.", 404);
        const auth = await authorise(request);
        if ("response" in auth) return auth.response;
        const { getVoiceAutomationView } = await import("@/server/voice-automation.server");
        return json({
          ok: true,
          view: await getVoiceAutomationView(auth.cloneId, { forTenant: true }),
        });
      },

      POST: async ({ request, params }) => {
        const op = operationOf(params);
        if (!op || op === "view") return refuse("unknown_operation", "Unknown operation.", 404);
        const auth = await authorise(request);
        if ("response" in auth) return auth.response;

        let body: Record<string, unknown> = {};
        try {
          const text = await request.text();
          if (text.length > 20_000)
            return refuse("body_too_large", "Request body is too large.", 413);
          body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("not an object");
        } catch {
          return refuse("invalid_json", "Body must be a JSON object.", 400);
        }

        const svc = await import("@/server/voice-automation.server");
        const actorIn = (body.actor && typeof body.actor === "object" ? body.actor : {}) as Record<
          string,
          unknown
        >;
        const actor = { kind: "tenant" as const, label: svc.cleanLabel(actorIn.label) };

        try {
          if (op === "update") {
            const r = await svc.submitSettingsChange({
              cloneId: auth.cloneId,
              expectedRevision: body.expectedRevision,
              patch: body.settings,
              actor,
            });
            return r.ok
              ? json({ ok: true, view: r.value })
              : refuse(r.error, r.message, r.status, { detail: r.detail ?? null });
          }
          if (op === "connect") {
            const r = await svc.startConnection({
              cloneId: auth.cloneId,
              kind: body.kind,
              actor: { ...actor, name: actorIn.name, email: actorIn.email },
            });
            return r.ok ? json({ ok: true, ...r.value }) : refuse(r.error, r.message, r.status);
          }
          if (op === "refresh") {
            const { isConnectionKind } = await import("@/server/voiceAutomation.pure");
            if (!isConnectionKind(body.kind))
              return refuse("invalid_kind", "Unknown connection kind.", 400);
            const r = await svc.refreshConnection(auth.cloneId, body.kind);
            return json({
              ok: true,
              result: r,
              view: await svc.getVoiceAutomationView(auth.cloneId, { forTenant: true }),
            });
          }
          // apply
          const r = await svc.applyVoiceAutomation(auth.cloneId);
          return json({
            ok: true,
            result: { status: r.status },
            view: await svc.getVoiceAutomationView(auth.cloneId, { forTenant: true }),
          });
        } catch (e) {
          console.error(`[voice-automation] ${op} failed:`, (e as Error)?.message);
          return refuse(
            "internal_error",
            "Mission Control could not complete this request. It has been logged.",
            500,
          );
        }
      },
    },
  },
});
