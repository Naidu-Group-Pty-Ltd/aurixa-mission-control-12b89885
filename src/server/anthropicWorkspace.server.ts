/**
 * Creating a clone's Anthropic workspace, and writing its id onto the project.
 *
 * The decisions are in `anthropicWorkspace.pure.ts`; this is the half that
 * calls Anthropic's Admin API and the Supabase Management API. It mirrors
 * `llmKeyProvisioning.server.ts` deliberately — the two run side by side at
 * provisioning and a reader should not have to learn two shapes.
 */

import {
  ANTHROPIC_ADMIN_ENV,
  ANTHROPIC_WORKSPACE_SECRET,
  decideWorkspaceProvision,
  readWorkspaceId,
  workspaceCapWarning,
  workspaceNameFor,
} from "./anthropicWorkspace.pure";
import { CloneSecretTargetError, resolveCloneSecretTarget } from "./cloneAllowedOrigins.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

const ADMIN_API = "https://api.anthropic.com/v1/organizations";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;

type Db = SupabaseClient<Database>;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function adminKey(): string {
  return (process.env[ANTHROPIC_ADMIN_ENV] ?? "").trim();
}

function adminHeaders(): Record<string, string> {
  return {
    "x-api-key": adminKey(),
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

async function adminFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${ADMIN_API}${path}`, {
      ...init,
      headers: { ...adminHeaders(), ...(init.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface AnthropicWorkspace {
  id: string;
  name: string;
}

/**
 * Every live workspace in the organisation.
 *
 * `include_archived=false` is explicit rather than defaulted: an archived
 * workspace keeps its NAME, so a run that saw archived rows would match one
 * by name and hand a clone a workspace whose keys Anthropic archived within
 * seconds of the workspace itself.
 */
export async function listAnthropicWorkspaces(): Promise<AnthropicWorkspace[]> {
  const out: AnthropicWorkspace[] = [];
  let page: string | null = null;

  // Bounded rather than `while (true)`: the organisation cap is 100 and the
  // page size is 100, so anything past a handful of pages means the cursor is
  // not advancing and a loop here would hold the provisioning run open.
  for (let i = 0; i < 10; i += 1) {
    const query = new URLSearchParams({ limit: "100", include_archived: "false" });
    if (page) query.set("page", page);
    const res = await adminFetch(`/workspaces?${query.toString()}`, { method: "GET" });
    if (!res.ok) {
      throw new Error(
        `Anthropic refused to list workspaces (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as { data?: Array<{ id?: string; name?: string }>; next_page?: string | null };
    for (const row of body.data ?? []) {
      const id = readWorkspaceId(row?.id);
      if (id && typeof row?.name === "string") out.push({ id, name: row.name });
    }
    page = body.next_page ?? null;
    if (!page) break;
  }

  return out;
}

/** Create one workspace. The caller has already checked no live one shares its name. */
export async function createAnthropicWorkspace(name: string): Promise<AnthropicWorkspace> {
  const res = await adminFetch("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      `Anthropic refused to create the workspace "${name}" (${res.status}): ${(await res.text().catch(() => "")).slice(0, 300)}`,
    );
  }
  const body = (await res.json()) as { id?: string; name?: string };
  const id = readWorkspaceId(body?.id);
  if (!id) {
    // A 200 whose body carries no usable id is worse than a refusal: the
    // workspace exists and nothing here can name it, so the next run would
    // create a second one.
    throw new Error(
      `Anthropic reported creating "${name}" but returned no workspace id, so it cannot be recorded. ` +
        "Check the organisation's workspace list before retrying — one may now exist unrecorded.",
    );
  }
  return { id, name: body.name ?? name };
}

export type WorkspaceOutcome = {
  cloneId: string;
  provisioned: boolean;
  workspaceId?: string;
  reason?: string;
  detail?: string;
  actionable?: boolean;
  /** Present when the organisation is near its workspace ceiling. */
  warning?: string;
};

/**
 * Give one clone its own Anthropic workspace and tell its project about it.
 *
 * Never throws. Every refusal is a returned reason, because this runs inside a
 * provisioning pipeline whose other steps must complete regardless: a clone
 * with no workspace reaches Anthropic exactly as every clone does today.
 */
export async function provisionAnthropicWorkspace(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null },
): Promise<WorkspaceOutcome> {
  let target: { cloneId: string; cloneName: string; projectRef: string };
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    if (e instanceof CloneSecretTargetError) {
      return { cloneId, provisioned: false, reason: e.reason, detail: e.message, actionable: false };
    }
    return { cloneId, provisioned: false, reason: "unreadable", detail: msg(e), actionable: true };
  }

  const existing = await supabase
    .from("clone_anthropic_identity")
    .select("workspace_id")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (existing.error) {
    // A read that FAILED is not a clone that HAS no workspace. Treating it as
    // absent would create a second one and split this tenant's spend.
    return {
      cloneId,
      provisioned: false,
      reason: "unreadable",
      detail: `the recorded Anthropic identity could not be read: ${existing.error.message}`,
      actionable: true,
    };
  }

  const keyRow = await supabase
    .from("clone_backend_secrets")
    .select("status")
    .eq("clone_id", cloneId)
    .eq("name", "ANTHROPIC_API_KEY")
    .maybeSingle();
  if (keyRow.error) {
    return {
      cloneId,
      provisioned: false,
      reason: "unreadable",
      detail: `the Anthropic key's ledger row could not be read: ${keyRow.error.message}`,
      actionable: true,
    };
  }

  const verdict = decideWorkspaceProvision({
    existingWorkspaceId: (existing.data?.workspace_id as string | undefined) ?? null,
    anthropicKeyStatus: (keyRow.data?.status as string | undefined) ?? null,
    credentialPresent: adminKey().length > 0,
    backendProvisioned: true, // resolveCloneSecretTarget already proved it
  });

  if (!verdict.act) {
    return {
      cloneId,
      provisioned: false,
      reason: verdict.reason,
      detail: verdict.message,
      actionable: verdict.actionable,
      ...(verdict.reason === "already_provisioned"
        ? { workspaceId: (existing.data?.workspace_id as string | undefined) ?? undefined }
        : {}),
    };
  }

  const name = workspaceNameFor(target.cloneName, target.cloneId);

  let workspace: AnthropicWorkspace;
  let warning: string | undefined;
  try {
    /*
     * Found before created. A retry after a partial run would otherwise make a
     * second workspace under the same name, and both would be live — so this
     * clone's spend would be split across two lines and the organisation's
     * allowance spent twice as fast.
     */
    const live = await listAnthropicWorkspaces();
    warning = workspaceCapWarning(live.length) ?? undefined;
    const already = live.find((w) => w.name === name);
    workspace = already ?? (await createAnthropicWorkspace(name));
  } catch (e) {
    return { cloneId, provisioned: false, reason: "create_failed", detail: msg(e), actionable: true };
  }

  const { setCloneSecretValues } = await import("./backend-provisioning.server");
  const write = await setCloneSecretValues(target.projectRef, [
    { name: ANTHROPIC_WORKSPACE_SECRET, value: workspace.id },
  ]);

  if (!write.ok) {
    /*
     * The workspace exists at the vendor and the project does not know about
     * it. Recording it anyway is right and the ordering is the reason: without
     * the row, the next run creates a SECOND workspace, and the failure that
     * costs an allowance is worse than the one that costs an attribution. The
     * clone meanwhile bills to the default workspace, which is today's
     * behaviour rather than a regression.
     */
    await recordIdentity(supabase, cloneId, workspace, `the workspace id could not be written to the project: ${write.error}`);
    return {
      cloneId,
      provisioned: false,
      workspaceId: workspace.id,
      reason: "write_failed",
      detail:
        `Anthropic workspace ${workspace.id} exists for this clone and could not be written to its ` +
        `project: ${write.error}. It is recorded here, so a retry writes the same one rather than ` +
        "creating another.",
      actionable: true,
      ...(warning ? { warning } : {}),
    };
  }

  const recorded = await recordIdentity(supabase, cloneId, workspace, null);
  if (recorded) {
    return {
      cloneId,
      provisioned: false,
      workspaceId: workspace.id,
      reason: "ledger_failed",
      detail: recorded,
      actionable: true,
      ...(warning ? { warning } : {}),
    };
  }

  void opts?.actorUserId;

  return {
    cloneId,
    provisioned: true,
    workspaceId: workspace.id,
    detail: `Anthropic workspace ${workspace.name} (${workspace.id}) now carries this clone's model spend.`,
    ...(warning ? { warning } : {}),
  };
}

/** Write the identity row. Returns an error message, or null on success. */
async function recordIdentity(
  supabase: Db,
  cloneId: string,
  workspace: AnthropicWorkspace,
  lastError: string | null,
): Promise<string | null> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("clone_anthropic_identity")
    .upsert(
      {
        clone_id: cloneId,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        last_error: lastError,
        updated_at: now,
      },
      { onConflict: "clone_id" },
    );
  return error ? `the Anthropic workspace could not be recorded: ${error.message}` : null;
}

/**
 * Give every clone that has no workspace one.
 *
 * Runs on the same sweep as the other reconciles. Refusals are ordinary here —
 * a clone whose tenant supplied their own key will refuse on every pass, for
 * ever, and that is the correct answer rather than a backlog.
 */
export async function reconcileAnthropicWorkspaces(
  supabase: Db,
): Promise<{ considered: number; provisioned: number; outcomes: WorkspaceOutcome[] }> {
  /*
   * The candidates are clones with a BACKEND, read the same way
   * `reconcileLlmKeys` reads them — a clone with no Supabase project has
   * nowhere for the workspace id to be written, and `clones` carries no status
   * column to filter on.
   */
  const { data, error } = await supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clone backends: ${error.message}`);

  const candidates = (data ?? [])
    .map((r) => r as { clone_id: string | null })
    .filter(
      (r): r is { clone_id: string } => typeof r.clone_id === "string" && r.clone_id.length > 0,
    );

  const outcomes: WorkspaceOutcome[] = [];
  for (const row of candidates) {
    outcomes.push(await provisionAnthropicWorkspace(supabase, row.clone_id));
  }

  return {
    considered: outcomes.length,
    provisioned: outcomes.filter((o) => o.provisioned).length,
    outcomes,
  };
}
