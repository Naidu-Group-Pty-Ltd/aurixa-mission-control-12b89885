// G14 — Secret rotation cutover executor.
//
// Given a `handoff_secret_rotations` row, execute the rotation against the
// downstream system and return the outcome. Executors are intentionally
// side-effect-scoped: they never touch other rows in the ledger; the caller
// wraps state transitions + audit logging around this module.
//
// Supported targets:
//   - edge_function_env : POST a Supabase Edge Function secret onto the client
//                         project via Management API (uses decrypted client PAT)
//   - stripe_endpoint   : mark rotated via bookkeeping (per-clone Stripe secret
//                         is managed in `clone_stripe_configs`; this ledger row
//                         only witnesses cutover completion)
//   - cloudflare        : bookkeeping — the physical rotate lives in edge/cf
//   - github_webhook    : bookkeeping — external webhook secret rotate
//   - webhook_consumer  : bookkeeping — downstream webhook consumer rotate
//   - clone_repo        : bookkeeping — GitHub PAT / deploy key cutover
//   - other             : bookkeeping — free-form manual rotate
//
// For every bookkeeping target the executor requires the operator to supply
// `metadata.evidence` (a URL or short description) so the audit trail records
// *why* the rotation is considered complete. `metadata.auto_ack` is honored
// only when an admin explicitly sets it.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type RotationTarget =
  | "clone_repo"
  | "cloudflare"
  | "stripe_endpoint"
  | "github_webhook"
  | "webhook_consumer"
  | "edge_function_env"
  | "other";

export type ExecuteOutcome = {
  status: "rotated" | "failed" | "in_progress";
  error?: string;
  audit: Record<string, unknown>;
};

async function executeEdgeFunctionEnv(row: any): Promise<ExecuteOutcome> {
  const md = (row.metadata ?? {}) as any;
  const projectRef = md.project_ref as string | undefined;
  const secretName = md.secret_name as string | undefined;
  const secretValue = md.secret_value as string | undefined;
  const clientAccountId = md.client_account_id as string | undefined;

  if (!projectRef || !secretName || !secretValue || !clientAccountId) {
    return {
      status: "failed",
      error: "metadata must include project_ref, secret_name, secret_value, client_account_id",
      audit: { missing: true },
    };
  }

  const { data: acct, error: acctErr } = await supabaseAdmin
    .from("client_supabase_accounts")
    // `status` has never been a column here — revocation is `revoked_at`.
    .select("id, pat_ciphertext, revoked_at")
    .eq("id", clientAccountId)
    .maybeSingle();
  if (acctErr) return { status: "failed", error: acctErr.message, audit: {} };
  if (!acct?.pat_ciphertext) {
    return { status: "failed", error: "no_client_pat", audit: {} };
  }
  if (acct.revoked_at) {
    return { status: "failed", error: "client_pat_revoked", audit: {} };
  }

  const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
  const pat = decryptSecret(decodeBytea(acct.pat_ciphertext));

  // Supabase Mgmt API — set project secret (idempotent upsert).
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ name: secretName, value: secretValue }]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      status: "failed",
      error: `mgmt_api_${res.status}`,
      audit: { response: text.slice(0, 400) },
    };
  }
  return {
    status: "rotated",
    audit: {
      project_ref: projectRef,
      secret_name: secretName,
      rotated_via: "supabase_mgmt_api",
    },
  };
}

function executeBookkeeping(row: any): ExecuteOutcome {
  const md = (row.metadata ?? {}) as any;
  if (!md.evidence && !md.auto_ack) {
    return {
      status: "in_progress",
      error: "awaiting_evidence",
      audit: { note: "Complete externally then call markSecretRotation." },
    };
  }
  return {
    status: "rotated",
    audit: {
      evidence: md.evidence ?? null,
      auto_ack: !!md.auto_ack,
      rotated_via: "bookkeeping",
    },
  };
}

export async function executeRotation(row: any): Promise<ExecuteOutcome> {
  const target = row.target as RotationTarget;
  try {
    if (target === "edge_function_env") return await executeEdgeFunctionEnv(row);
    return executeBookkeeping(row);
  } catch (e: any) {
    return { status: "failed", error: String(e?.message ?? e), audit: {} };
  }
}

// ---------------------------------------------------------------------------
// G18 — Rotation rollback executor.
//
// Reverses a rotation that has already landed. The behaviour depends on the
// target:
//   - edge_function_env : if the operator pinned the pre-cutover value in
//                         `metadata.previous_secret_value` when planning the
//                         rotation, POST it back to the client project via
//                         Mgmt API. Otherwise we can't recover the old value
//                         (Mgmt API doesn't return secret values), so we mark
//                         the rollback as `manual_required` with a clear
//                         instruction for the operator.
//   - bookkeeping       : record `rolled_back_at` + rollback evidence in
//                         metadata; the physical undo happens externally.
// ---------------------------------------------------------------------------

export type RollbackOutcome = {
  status: "rolled_back" | "failed" | "manual_required";
  error?: string;
  audit: Record<string, unknown>;
};

async function rollbackEdgeFunctionEnv(row: any): Promise<RollbackOutcome> {
  const md = (row.metadata ?? {}) as any;
  const projectRef = md.project_ref as string | undefined;
  const secretName = md.secret_name as string | undefined;
  const previous = md.previous_secret_value as string | undefined;
  const clientAccountId = md.client_account_id as string | undefined;

  if (!projectRef || !secretName || !clientAccountId) {
    return {
      status: "failed",
      error: "metadata must include project_ref, secret_name, client_account_id",
      audit: { missing: true },
    };
  }
  if (!previous) {
    return {
      status: "manual_required",
      error: "no_previous_value_pinned",
      audit: {
        instruction: `Re-set '${secretName}' on project ${projectRef} to the pre-cutover value manually via Supabase Mgmt API.`,
      },
    };
  }

  // Same as above: `revoked_at`, not `status`. This one also discarded the
  // error, so a failed read was indistinguishable from an account with no PAT.
  const { data: acct, error: acctReadErr } = await supabaseAdmin
    .from("client_supabase_accounts")
    .select("id, pat_ciphertext, revoked_at")
    .eq("id", clientAccountId)
    .maybeSingle();
  if (acctReadErr) return { status: "failed", error: acctReadErr.message, audit: {} };
  if (!acct?.pat_ciphertext) return { status: "failed", error: "no_client_pat", audit: {} };
  if (acct.revoked_at) return { status: "failed", error: "client_pat_revoked", audit: {} };

  const { decryptSecret, decodeBytea } = await import("@/server/crypto.server");
  const pat = decryptSecret(decodeBytea(acct.pat_ciphertext));
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify([{ name: secretName, value: previous }]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      status: "failed",
      error: `mgmt_api_${res.status}`,
      audit: { response: text.slice(0, 400) },
    };
  }
  return {
    status: "rolled_back",
    audit: {
      project_ref: projectRef,
      secret_name: secretName,
      rolled_back_via: "supabase_mgmt_api",
    },
  };
}

function rollbackBookkeeping(row: any): RollbackOutcome {
  const md = (row.metadata ?? {}) as any;
  return {
    status: "rolled_back",
    audit: {
      rolled_back_via: "bookkeeping",
      rollback_evidence: md.rollback_evidence ?? null,
      note: "Physical undo happens externally; ledger marks the reversal for audit.",
    },
  };
}

export async function rollbackRotation(row: any): Promise<RollbackOutcome> {
  const target = row.target as RotationTarget;
  try {
    if (target === "edge_function_env") return await rollbackEdgeFunctionEnv(row);
    return rollbackBookkeeping(row);
  } catch (e: any) {
    return { status: "failed", error: String(e?.message ?? e), audit: {} };
  }
}

// The default rotation plan enqueued when a handoff enters cutover. Each entry
// is `(target, key_ref, hint)`; hint lands in `metadata.hint` so operators
// know what secret to supply.
//
// No platform key Mission Control forwards is rotated here. LOVABLE_API_KEY
// was, until the owner decided D6 on 30 Oct 2026: a platform key keeps running
// after handover, billed through the usage forwarder, and is withdrawn only
// when the client brings its own. Its row now comes from the clone's ledger
// (`platformCredentialRotations`), as every other such key's does.
export const DEFAULT_ROTATION_PLAN: Array<{
  target: RotationTarget;
  key_ref: string;
  hint: string;
}> = [
  {
    target: "edge_function_env",
    key_ref: "STRIPE_SECRET_KEY",
    hint: "Rotate STRIPE_SECRET_KEY on the client's Supabase project.",
  },
  {
    target: "edge_function_env",
    key_ref: "STRIPE_WEBHOOK_SECRET",
    hint: "Rotate STRIPE_WEBHOOK_SECRET after re-pointing Stripe webhook to client.",
  },
  {
    target: "stripe_endpoint",
    key_ref: "stripe.webhook_endpoint",
    hint: "Point Stripe webhook at the client's own /stripe/webhook and rotate secret.",
  },
  {
    target: "cloudflare",
    key_ref: "cf.zone_owner",
    hint: "Transfer Cloudflare zone ownership (or DNS records) to the client.",
  },
  {
    target: "github_webhook",
    key_ref: "gh.webhook_secret",
    hint: "Rotate the GitHub webhook secret on the client repository.",
  },
  {
    target: "clone_repo",
    key_ref: "gh.repo_ownership",
    hint: "Transfer GitHub repository / grant client-owned deploy key.",
  },
  {
    target: "webhook_consumer",
    key_ref: "downstream.consumer",
    hint: "Notify downstream webhook consumers of new signing secret.",
  },
];
