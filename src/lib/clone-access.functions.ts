// Operator surface over `src/server/cloneAccessCredentials.server.ts`.
//
// Admin-only: issuing sets a live password on a tenant's administrator account
// and returns it in the response body. The reason this issues rather than
// reveals a stored password is in `cloneAccessCredentials.pure.ts`.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const requireCloneId = (input: { cloneId: string }) => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/** Read-only: which account credentials would be issued against, and whether issuing rotates. */
export const getCloneAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data }) => {
    const { getCloneAccessState } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/cloneAccessCredentials.server"
    );
    return getCloneAccessState(data.cloneId);
  });

/**
 * Mint a password, write it to the clone, verify it, and return it ONCE.
 *
 * The plaintext exists only in this response. The audit row records that
 * credentials were issued, by whom and for which account — never what they
 * were.
 */
export const issueCloneAccess = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(requireCloneId)
  .handler(async ({ data, context }) => {
    const { issueCloneAccessCredentials } = await import(
      /* @vite-ignore */ "@/lib/_server-shims/cloneAccessCredentials.server"
    );
    return issueCloneAccessCredentials(data.cloneId, context.userId ?? null);
  });
