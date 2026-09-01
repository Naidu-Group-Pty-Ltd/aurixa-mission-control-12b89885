/**
 * Issue a working operator login for a clone — for an audit, or for handoff.
 *
 * The rules and the reason nothing here "reveals" a stored password are in
 * `cloneAccessCredentials.pure.ts`. This module is the plumbing: read what the
 * panel needs, mint, write through the SAME path provisioning uses, and record
 * that it happened.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "./audit.server";
import { generateSecurePassword, seedProductAdminIdentity } from "./backend-provisioning.server";
import { readCloneAccessState, type CloneAccessState } from "./cloneAccessCredentials.pure";
import { describeSeed, seedIsUsable } from "./cloneAdminIdentity.pure";

/** The audit action both the writer and the reader name. A literal at each end is how two ends drift. */
export const ACCESS_ISSUED_ACTION = "clone.access_credentials_issued";

type Fail = { ok: false; error: string };

async function readBackend(cloneId: string) {
  const { data, error } = await supabaseAdmin
    .from("clone_backends")
    .select("supabase_project_ref, admin_email, status")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`could not read the clone's backend: ${error.message}`);
  return data;
}

/** Where the credential is actually used — the clone's own site, not its Supabase project. */
async function readDeployUrl(cloneId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("clones")
    .select("deploy_url")
    .eq("id", cloneId)
    .maybeSingle();
  // A missing sign-in link is a smaller loss than refusing the credential, so
  // this one failure is absorbed rather than thrown.
  if (error) return null;
  return data?.deploy_url ?? null;
}

/**
 * The last issue, read from the AUDIT TRAIL rather than from a credential
 * store — because there is no credential store, and there must not be one.
 */
async function readLastIssue(cloneId: string) {
  const { data, error } = await supabaseAdmin
    .from("audit_log")
    .select("created_at, actor_user_id")
    .eq("action", ACCESS_ISSUED_ACTION)
    .eq("entity_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A failed read must not be reported as "never issued": that would drop the
  // rotation warning, which is the one thing the operator has to be told.
  if (error) throw new Error(`could not read the issue history: ${error.message}`);
  return data;
}

export async function getCloneAccessState(
  cloneId: string,
): Promise<{ ok: true; state: CloneAccessState } | Fail> {
  try {
    const [backend, last] = await Promise.all([readBackend(cloneId), readLastIssue(cloneId)]);
    return {
      ok: true,
      state: readCloneAccessState({
        projectRef: backend?.supabase_project_ref ?? null,
        adminEmail: backend?.admin_email ?? null,
        backendStatus: backend?.status ?? null,
        lastIssuedAt: last?.created_at ?? null,
        lastIssuedBy: last?.actor_user_id ?? null,
      }),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read access state" };
  }
}

export type IssuedCredentials = {
  ok: true;
  /** Shown once. Never written to any table, here or on the clone. */
  password: string;
  email: string;
  signInUrl: string | null;
  /** What the clone confirmed it now holds. */
  detail: string;
};

/**
 * Mint, write, verify, disclose — in that order, and only that order.
 *
 * The write goes through `seedProductAdminIdentity`, the same function
 * provisioning calls, so the credential an operator is handed is created the
 * way every other one is. It reads the stored hash back before reporting
 * success, and a credential that cannot be verified is returned as a FAILURE
 * rather than handed over: a password that does not work is worse for both an
 * audit and a handoff than being told it could not be set.
 */
export async function issueCloneAccessCredentials(
  cloneId: string,
  actorUserId: string | null,
): Promise<IssuedCredentials | Fail> {
  let projectRef: string | null = null;
  try {
    const backend = await readBackend(cloneId);
    const last = await readLastIssue(cloneId);
    const state = readCloneAccessState({
      projectRef: backend?.supabase_project_ref ?? null,
      adminEmail: backend?.admin_email ?? null,
      backendStatus: backend?.status ?? null,
      lastIssuedAt: last?.created_at ?? null,
      lastIssuedBy: last?.actor_user_id ?? null,
    });
    if (state.kind !== "ready") return { ok: false, error: state.reason };
    projectRef = backend!.supabase_project_ref!;

    const password = generateSecurePassword();
    const report = await seedProductAdminIdentity(projectRef, state.adminEmail, password, null);

    if (!seedIsUsable(report)) {
      // Deliberately not audited as an issue: nothing was issued.
      return { ok: false, error: describeSeed(report, state.adminEmail) };
    }

    // THAT it happened, never WHAT was issued.
    await writeAuditLog({
      action: ACCESS_ISSUED_ACTION,
      entityType: "clone",
      entityId: cloneId,
      actorUserId,
      metadata: {
        admin_email: state.adminEmail,
        project_ref: projectRef,
        role_label: report.role_label,
        rotated: state.rotates,
      },
    });

    return {
      ok: true,
      password,
      email: state.adminEmail,
      signInUrl: await readDeployUrl(cloneId),
      detail: describeSeed(report, state.adminEmail),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Could not issue access credentials",
    };
  }
}
