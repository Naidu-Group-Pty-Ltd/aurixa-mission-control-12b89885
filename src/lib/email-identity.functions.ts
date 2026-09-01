// Per-clone email identity server functions — the operator surface over
// `src/server/email-identity.server.ts`. Admin-only throughout: these mint
// vendor credentials and write clone secrets.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/** Read-only state for the panel: row, readiness path, configuration flag. */
export const getCloneEmailIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { getEmailIdentityState } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    return getEmailIdentityState(context.supabase, data.cloneId);
  });

/**
 * Create/advance the clone's email identity: register the domain, install or
 * hand over DNS, poll verification, and — once verified — mint the
 * domain-scoped key and write it to the clone. Safe to call repeatedly.
 */
export const provisionCloneEmailIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; sendingDomain?: string; region?: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    if (input.sendingDomain !== undefined && typeof input.sendingDomain !== "string") {
      throw new Error("sendingDomain must be a string");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { advanceEmailIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    const res = await advanceEmailIdentity(context.supabase, data.cloneId, {
      mode: "provision",
      sendingDomain: data.sendingDomain,
      region: data.region,
      actorUserId: context.userId,
    });
    await context.supabase.from("audit_log").insert({
      action: "clone_email_identity.provision",
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

/**
 * Undo a revocation and mint again.
 *
 * A separate action rather than a flag on Provision, because a revoked
 * identity coming back has to be somebody's decision. Both drains call
 * `advanceEmailIdentity` in `provision` mode, and before `revoked_at` existed
 * they re-minted a key for a clone an operator had deliberately stopped —
 * within five minutes, with nothing recording that it had happened.
 */
export const resumeCloneEmailIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { advanceEmailIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    const res = await advanceEmailIdentity(context.supabase, data.cloneId, {
      mode: "provision",
      resume: true,
      actorUserId: context.userId,
    });
    await context.supabase.from("audit_log").insert({
      action: "clone_email_identity.resume",
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

/** Re-poll Resend (records + verification). Creates nothing, mints nothing. */
export const checkCloneEmailIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { advanceEmailIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    return advanceEmailIdentity(context.supabase, data.cloneId, {
      mode: "refresh",
      actorUserId: context.userId,
    });
  });

/**
 * Mint a fresh key, write it to the clone, then retire the old one. The step
 * a re-provisioned backend needs (the original token cannot be read back).
 */
export const rotateCloneEmailKey = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { rotateEmailIdentityKey } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    const res = await rotateEmailIdentityKey(context.supabase, data.cloneId, context.userId);
    await context.supabase.from("audit_log").insert({
      action: "clone_email_identity.rotate_key",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { ok: res.ok, error: res.ok ? null : res.error },
    });
    return res;
  });

/** Delete the clone's key (and optionally its domain) at Resend. */
export const revokeCloneEmailIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; deleteDomain?: boolean }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { revokeEmailIdentity } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    const res = await revokeEmailIdentity(context.supabase, data.cloneId, {
      deleteDomain: data.deleteDomain === true,
      actorUserId: context.userId,
    });
    await context.supabase.from("audit_log").insert({
      action: "clone_email_identity.revoke",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        ok: res.ok,
        deleteDomain: data.deleteDomain === true,
        error: res.ok ? null : res.error,
      },
    });
    return res;
  });

/**
 * Point the clone's brand-config sender at the verified domain — repairs an
 * empty or prime-legacy address, never a tenant's own configured domain.
 */
export const alignCloneSender = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { alignCloneSenderAddress } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/email-identity.server"
    );
    const res = await alignCloneSenderAddress(context.supabase, data.cloneId);
    await context.supabase.from("audit_log").insert({
      action: "clone_email_identity.align_sender",
      entity_type: "clone",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        ok: res.ok,
        address: res.ok ? res.address : null,
        error: res.ok ? null : res.error,
      },
    });
    return res;
  });
