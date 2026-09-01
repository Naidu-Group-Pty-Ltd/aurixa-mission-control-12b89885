// Per-clone backend deployment — the operator surface over
// `src/server/cloneBackendDeploy.server.ts`. Admin-only throughout: these read
// a repository's Actions configuration and write a vendor credential into it.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/**
 * Which route deploys this clone's backend, and the evidence for it.
 *
 * Read-only. The route is derived from the repository's own Actions
 * configuration rather than from anything stored, so it cannot go stale, and
 * the runs beside it are what Mission Control has actually queued or done.
 */
export const getCloneBackendDeploy = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data }) => {
    const { getCloneBackendDeployState } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/cloneBackendDeploy.server"
    );
    return getCloneBackendDeployState(data.cloneId);
  });

/**
 * Hand this clone's own CI a scoped Supabase token, so its engineers can
 * deploy without waiting for a cascade.
 *
 * The token is judged before it is written and a refusal writes nothing at
 * all. There is deliberately no force parameter: a token that cannot be shown
 * to be confined to this clone has no safe use here, and an override would be
 * the only thing anybody ever reached for.
 */
export const attachCloneBackendToken = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: { cloneId: string; token: string }) => {
    if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
    if (typeof input.token !== "string" || !input.token.trim()) {
      throw new Error("token is required");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { attachCloneDeployToken } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/cloneBackendDeploy.server"
    );
    // No audit row is written here. The server module writes one only on the
    // path that actually placed a credential, so a refusal cannot leave a
    // trail reading as though something was attached.
    return attachCloneDeployToken({
      cloneId: data.cloneId,
      token: data.token,
      actorUserId: context.userId ?? null,
    });
  });

/** Take the token back out and return this clone to Mission Control. */
export const detachCloneBackendToken = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { detachCloneDeployToken } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/cloneBackendDeploy.server"
    );
    return detachCloneDeployToken({
      cloneId: data.cloneId,
      actorUserId: context.userId ?? null,
    });
  });
