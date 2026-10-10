// Voice-automation server functions — the OPERATOR surface over
// `src/server/voice-automation.server.ts`: register a CRM-independent clone's
// Make stack with its first (provisioning) settings, change settings and locks,
// connect or register calendars and mailboxes, hand the settings over, and
// apply. Admin-only throughout: these change what a tenant's voice agents do
// and which accounts they act through. The tenant's own door is
// `/api/public/voice-automation/*`, which reaches the same functions.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const load = () => import(/* @vite-ignore */ "@/lib/_server-shims/voice-automation.server");

type WithClone = { cloneId: string };
const needClone = <T extends WithClone>(input: T): T => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/** Throws the outcome's message so the card's toast says what was refused. */
function unwrap<T>(
  r: { ok: true; value: T } | { ok: false; message: string; error: string; detail?: unknown },
): T {
  if (r.ok) return r.value;
  const detail = (r.detail as { errors?: { field: string; message: string }[] } | undefined)
    ?.errors;
  throw new Error(
    detail?.length
      ? `${r.message} ${detail.map((e) => `${e.field}: ${e.message}`).join(" · ")}`
      : r.message,
  );
}

const operator = (userId: string) => ({
  kind: "operator" as const,
  label: "Mission Control operator",
  userId,
});

export const getCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data }) =>
    (await load()).getVoiceAutomationView(data.cloneId, { forTenant: false }),
  );

export const registerCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { stack: Record<string, unknown>; settings: unknown }) =>
    needClone(input),
  )
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await load()
      ).registerStack({
        cloneId: data.cloneId,
        stack: data.stack,
        settings: data.settings,
        actor: operator(context.userId),
      }),
    ),
  );

export const updateCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (
      input: WithClone & { expectedRevision: number; settings?: unknown; lockedFields?: string[] },
    ) => needClone(input),
  )
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await load()
      ).submitSettingsChange({
        cloneId: data.cloneId,
        expectedRevision: data.expectedRevision,
        patch: data.settings ?? {},
        lockedFields: data.lockedFields,
        actor: operator(context.userId),
      }),
    ),
  );

export const applyCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data }) => {
    const svc = await load();
    const result = await svc.applyVoiceAutomation(data.cloneId);
    return { result, view: await svc.getVoiceAutomationView(data.cloneId, { forTenant: false }) };
  });

export const handOffCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { releaseLocks: boolean }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await load()
      ).markHandedOff({
        cloneId: data.cloneId,
        releaseLocks: !!data.releaseLocks,
        actor: operator(context.userId),
      }),
    ),
  );

export const connectCloneVoiceAutomation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { kind: string; name: string; email: string }) =>
    needClone(input),
  )
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await load()
      ).startConnection({
        cloneId: data.cloneId,
        kind: data.kind,
        actor: { ...operator(context.userId), name: data.name, email: data.email },
      }),
    ),
  );

export const refreshCloneVoiceAutomationConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { kind: string }) => needClone(input))
  .handler(async ({ data }) => {
    const svc = await load();
    const { isConnectionKind } = await import("@/server/voiceAutomation.pure");
    if (!isConnectionKind(data.kind)) throw new Error("Unknown connection kind");
    const result = await svc.refreshConnection(data.cloneId, data.kind);
    return { result, view: await svc.getVoiceAutomationView(data.cloneId, { forTenant: false }) };
  });

export const registerCloneVoiceAutomationConnection = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { kind: string; connectionId: number }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await load()
      ).registerExistingConnection({
        cloneId: data.cloneId,
        kind: data.kind,
        connectionId: data.connectionId,
        actor: operator(context.userId),
      }),
    ),
  );

export const checkCloneVoiceAutomationDrift = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data }) => {
    const svc = await load();
    const drift = await svc.checkDrift(data.cloneId);
    return { drift, view: await svc.getVoiceAutomationView(data.cloneId, { forTenant: false }) };
  });
