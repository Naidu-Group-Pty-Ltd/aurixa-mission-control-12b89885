// Per-clone Turnstile identity server functions — the operator surface over
// `src/server/turnstile-identity.server.ts`. Admin-only throughout: these mint
// vendor credentials and write clone secrets.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/** Read-only state for the panel: row, readiness path, configuration flags. */
export const getCloneTurnstileIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { getTurnstileIdentityState } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    return getTurnstileIdentityState(context.supabase, data.cloneId);
  });

/**
 * Create this clone's own widget and deliver both halves — the secret onto its
 * Supabase project, the public site key into its hosting environment. Safe to
 * call repeatedly; an existing widget is adopted, never duplicated.
 */
export const provisionCloneTurnstile = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { provisionTurnstileIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    const res = await provisionTurnstileIdentity(context.supabase, data.cloneId, {
      mode: "provision",
      actorUserId: context.userId,
    });
    await context.supabase.from("audit_log").insert({
      action: "clone_turnstile.provision",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        ok: res.ok,
        advanced: res.ok ? res.advanced : null,
        error: res.ok ? null : res.error,
      },
    });
    return res;
  });

/** Re-read the widget at Cloudflare and re-sync its domains. Mints nothing. */
export const refreshCloneTurnstile = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { provisionTurnstileIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    return provisionTurnstileIdentity(context.supabase, data.cloneId, {
      mode: "refresh",
      actorUserId: context.userId,
    });
  });

/** Replace the widget's secret and write the new one to the clone. */
export const rotateCloneTurnstileSecret = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { rotateTurnstileSecret } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    const res = await rotateTurnstileSecret(context.supabase, data.cloneId, context.userId);
    await context.supabase.from("audit_log").insert({
      action: "clone_turnstile.rotate_secret",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { ok: res.ok, error: res.ok ? null : res.error },
    });
    return res;
  });

/** Delete the clone's widget at Cloudflare. */
export const revokeCloneTurnstile = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { revokeTurnstileIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    const res = await revokeTurnstileIdentity(context.supabase, data.cloneId, context.userId);
    await context.supabase.from("audit_log").insert({
      action: "clone_turnstile.revoke",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { ok: res.ok, error: res.ok ? null : res.error },
    });
    return res;
  });

/**
 * Whether this Mission Control can mint widgets at all — the capability, not
 * the token's existence. See `probeTurnstileAccess`: a token scoped for DNS
 * verifies as active and refuses Turnstile, and a panel that cannot tell those
 * apart sends an operator to the wrong remedy.
 */
export const probeCloneTurnstileAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const { probeTurnstileAccess } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/turnstile-identity.server"
    );
    return probeTurnstileAccess(context.supabase);
  });
