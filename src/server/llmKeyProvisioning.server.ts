/**
 * Minting one clone's model keys, on Aurixa's own provider accounts.
 *
 * The decision — whether to mint at all, and why not — is
 * `llmKeyProvisioning.pure.ts`, which also carries the measured capability of
 * each vendor and the reason a minted key is neither `inherited` nor `set`.
 * This module performs what that decides, and does the four vendor calls.
 *
 * ## What this never does
 *
 * It never overwrites a tenant's own key, because it never reaches a provider
 * whose ledger row says `set` — `decideLlmKeyMint` refuses first, and this
 * module asks it per name rather than per clone.
 *
 * It never fails a provisioning run. A clone whose OpenAI key could not be
 * minted still boots on the forwarded fleet key; a clone that fails to mint
 * ALL of them still boots. Minting improves attribution, and attribution is
 * not worth a workspace that will not start — the same rule the portrait
 * backfill and `armOngoingCdd` follow.
 *
 * ## Each provider is switched on by its own credential
 *
 * There is no fleet-wide "LLM minting is enabled" flag, deliberately. A flag
 * would have to be turned on before the credentials existed or after, and
 * either order has a window where the reading and the reality disagree.
 * Holding `OPENROUTER_PROVISIONING_KEY` IS the switch for OpenRouter, and
 * nothing else changes when it appears.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  decideLlmKeyMint,
  LLM_PROVIDERS,
  MINTED_STATUS,
  mintedKeyLabel,
  type LlmProvider,
  type MintVerdict,
} from "./llmKeyProvisioning.pure";
import { CloneSecretTargetError, resolveCloneSecretTarget } from "./cloneAllowedOrigins.server";

type Db = SupabaseClient<Database>;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Trim a vendor's error body to something loggable that is not a wall. */
const body = async (res: Response) => (await res.text().catch(() => "")).slice(0, 300);

export type MintOutcome =
  | { name: string; minted: true; label: string }
  | { name: string; minted: false; reason: string; detail: string; actionable: boolean };

export type LlmKeyProvisionResult =
  | { ok: true; cloneId: string; outcomes: MintOutcome[] }
  | { ok: false; cloneId: string; reason: string; error: string };

// ─── The four vendor calls ───────────────────────────────────────────────

/**
 * OpenRouter. One POST, and the only provider that can cap its own spend.
 *
 * `limit` is deliberately NOT set here. A ceiling is a commercial decision per
 * plan, and a wrong one stops a paying tenant's reports mid-run — so it is
 * left for an explicit act rather than guessed at provisioning time. The
 * capability is recorded in the provider table so the surface can offer it.
 */
async function mintOpenRouter(credential: string, label: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/keys", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: label }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status} — ${await body(res)}`);
  const json = (await res.json().catch(() => ({}))) as { key?: unknown };
  if (typeof json.key !== "string" || !json.key) {
    // The one moment the value is readable. A response that parsed but
    // carried no key is a key that now exists at the vendor and is lost to
    // us — said plainly rather than reported as a failed call.
    throw new Error("OpenRouter accepted the request and returned no key; it may now be orphaned");
  }
  return json.key;
}

/**
 * OpenAI. A project, then a service account inside it.
 *
 * The project is what carries the attribution — OpenAI's dashboard reports
 * spend per project — and the service account is what carries a key. The key
 * is returned unredacted exactly once, on creation, and can never be read
 * again.
 */
async function mintOpenAI(credential: string, label: string): Promise<string> {
  const h = { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" };

  const projectRes = await fetch("https://api.openai.com/v1/organization/projects", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ name: label }),
  });
  if (!projectRes.ok) {
    throw new Error(`OpenAI project ${projectRes.status} — ${await body(projectRes)}`);
  }
  const project = (await projectRes.json().catch(() => ({}))) as { id?: unknown };
  if (typeof project.id !== "string") throw new Error("OpenAI returned a project with no id");

  const saRes = await fetch(
    `https://api.openai.com/v1/organization/projects/${encodeURIComponent(project.id)}/service_accounts`,
    { method: "POST", headers: h, body: JSON.stringify({ name: label }) },
  );
  if (!saRes.ok) {
    // The project exists and has no key. Named, because the remedy is to
    // finish it rather than to start again — a second run would make a second
    // project and split the attribution this exists to create.
    throw new Error(
      `OpenAI service account ${saRes.status} on project ${project.id} — ${await body(saRes)}`,
    );
  }
  const sa = (await saRes.json().catch(() => ({}))) as { api_key?: { value?: unknown } };
  const value = sa.api_key?.value;
  if (typeof value !== "string" || !value) {
    throw new Error(
      `OpenAI created a service account on project ${project.id} and returned no key value; ` +
        "the key exists at the vendor and cannot be read again",
    );
  }
  return value;
}

/** Perplexity. One POST against an existing key's authority. */
async function mintPerplexity(credential: string, label: string): Promise<string> {
  const res = await fetch("https://api.perplexity.ai/generate_auth_token", {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: label }),
  });
  if (!res.ok) throw new Error(`Perplexity ${res.status} — ${await body(res)}`);
  const json = (await res.json().catch(() => ({}))) as {
    api_key?: unknown;
    key?: unknown;
    token?: unknown;
  };
  // The field name is not something to be confident about from documentation
  // alone, so all three plausible spellings are read and NONE is guessed at:
  // an unrecognised shape is a failure with the body in it, not a key.
  for (const candidate of [json.api_key, json.key, json.token]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  throw new Error("Perplexity accepted the request and returned no recognisable key field");
}

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Import a PEM pkcs8 RSA key for RS256 signing. */
async function importRsaKey(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * An access token for a Google service account, by the JWT-bearer grant.
 *
 * The same shape `agreements.server.ts` already uses for DocuSign, which is
 * why there is no library here: one signed assertion exchanged for a token.
 */
async function googleAccessToken(serviceAccountJson: string): Promise<string> {
  let sa: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    sa = JSON.parse(serviceAccountJson) as typeof sa;
  } catch {
    throw new Error("GOOGLE_APIKEYS_SERVICE_ACCOUNT is not JSON");
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_APIKEYS_SERVICE_ACCOUNT has no client_email or private_key");
  }
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = base64Url(
    encoder.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const input = `${header}.${claim}`;
  const key = await importRsaKey(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
  const assertion = `${input}.${base64Url(new Uint8Array(sig))}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token exchange ${res.status} — ${await body(res)}`);
  }
  return json.access_token;
}

/**
 * Gemini, through Google Cloud's API Keys service.
 *
 * Three steps rather than one, and each is a real constraint rather than
 * ceremony: creating a key is a LONG-RUNNING OPERATION, the value is not in
 * the operation's result, and an unrestricted Google API key is refused by
 * Gemini outright — so the `apiTargets` restriction is part of creating a
 * usable key, not a hardening pass afterwards.
 */
async function mintGemini(
  serviceAccountJson: string,
  projectId: string,
  label: string,
): Promise<string> {
  const token = await googleAccessToken(serviceAccountJson);
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const parent = `projects/${encodeURIComponent(projectId)}/locations/global`;

  const createRes = await fetch(`https://apikeys.googleapis.com/v2/${parent}/keys`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      displayName: label,
      restrictions: { apiTargets: [{ service: "generativelanguage.googleapis.com" }] },
    }),
  });
  if (!createRes.ok)
    throw new Error(`Google keys.create ${createRes.status} — ${await body(createRes)}`);
  const op = (await createRes.json().catch(() => ({}))) as {
    name?: string;
    done?: boolean;
    response?: { name?: string };
    error?: { message?: string };
  };

  let keyName = op.done ? op.response?.name : undefined;
  if (!keyName) {
    if (!op.name) throw new Error("Google keys.create returned neither a key nor an operation");
    // Bounded poll. An operation that has not settled in ~20s is reported as
    // unsettled rather than waited on for ever: this runs inside a
    // provisioning step with a wall-clock budget, and a step that cannot
    // finish is worse than one that says it did not.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const opRes = await fetch(`https://apikeys.googleapis.com/v2/${op.name}`, { headers: h });
      if (!opRes.ok)
        throw new Error(`Google operations.get ${opRes.status} — ${await body(opRes)}`);
      const settled = (await opRes.json().catch(() => ({}))) as {
        done?: boolean;
        response?: { name?: string };
        error?: { message?: string };
      };
      if (settled.error) throw new Error(`Google keys.create failed: ${settled.error.message}`);
      if (settled.done && settled.response?.name) {
        keyName = settled.response.name;
        break;
      }
    }
  }
  if (!keyName) {
    throw new Error(
      `Google keys.create did not settle within the budget (operation ${op.name}); the key may ` +
        "exist and can be found in the Cloud console",
    );
  }

  // The value lives behind its own call. The resource above is a handle.
  const stringRes = await fetch(`https://apikeys.googleapis.com/v2/${keyName}/keyString`, {
    headers: h,
  });
  if (!stringRes.ok) {
    throw new Error(`Google getKeyString ${stringRes.status} — ${await body(stringRes)}`);
  }
  const str = (await stringRes.json().catch(() => ({}))) as { keyString?: unknown };
  if (typeof str.keyString !== "string" || !str.keyString) {
    throw new Error(`Google returned no keyString for ${keyName}`);
  }
  return str.keyString;
}

/** Mint one provider's key, or throw with what the vendor said. */
async function mintKey(provider: LlmProvider, label: string): Promise<string> {
  const credential = provider.provisioningEnv
    ? (process.env[provider.provisioningEnv] ?? "").trim()
    : "";
  if (!credential) throw new Error(`${provider.provisioningEnv} is not set`);

  switch (provider.secretName) {
    case "OPENROUTER_API_KEY":
      return mintOpenRouter(credential, label);
    case "OPENAI_API_KEY":
      return mintOpenAI(credential, label);
    case "PERPLEXITY_API_KEY":
      return mintPerplexity(credential, label);
    case "GEMINI_API_KEY": {
      const projectId = (process.env.GOOGLE_APIKEYS_PROJECT_ID ?? "").trim();
      if (!projectId) throw new Error("GOOGLE_APIKEYS_PROJECT_ID is not set");
      return mintGemini(credential, projectId, label);
    }
    default:
      // Reached only if a provider is marked `api` with no implementation —
      // a programming error, named as one rather than silently skipped.
      throw new Error(`No minting implementation for ${provider.secretName}`);
  }
}

const credentialPresent = (provider: LlmProvider): boolean =>
  Boolean(provider.provisioningEnv && (process.env[provider.provisioningEnv] ?? "").trim());

// ─── The orchestration ───────────────────────────────────────────────────

/**
 * Mint whatever this clone is owed, and record each outcome.
 *
 * Per NAME rather than per clone, so one vendor being unreachable or
 * unconfigured never stops the other four — and so a tenant that has supplied
 * its own OpenAI key still gets a minted OpenRouter one.
 */
export async function provisionLlmKeys(
  supabase: Db,
  cloneId: string,
  opts?: { actorUserId?: string | null; only?: readonly string[] },
): Promise<LlmKeyProvisionResult> {
  let target: { cloneId: string; cloneName: string; projectRef: string };
  try {
    target = await resolveCloneSecretTarget(supabase, cloneId);
  } catch (e) {
    if (e instanceof CloneSecretTargetError) {
      return { ok: false, cloneId, reason: e.reason, error: e.message };
    }
    return { ok: false, cloneId, reason: "unreadable", error: msg(e) };
  }

  const names = LLM_PROVIDERS.map((p) => p.secretName);
  const ledger = await supabase
    .from("clone_backend_secrets")
    .select("name, status")
    .eq("clone_id", cloneId)
    .in("name", names);
  if (ledger.error) {
    // A read that FAILED is not a ledger that is EMPTY. Treating it as empty
    // would decide every name looks unminted and overwrite a tenant's own key.
    return { ok: false, cloneId, reason: "unreadable", error: ledger.error.message };
  }
  const statusOf = new Map<string, string>(
    (ledger.data ?? []).map((r) => [r.name as string, (r.status as string) ?? ""]),
  );

  const label = mintedKeyLabel(target.cloneName);
  const outcomes: MintOutcome[] = [];

  for (const provider of LLM_PROVIDERS) {
    if (opts?.only && !opts.only.includes(provider.secretName)) continue;

    const verdict: MintVerdict = decideLlmKeyMint({
      secretName: provider.secretName,
      ledgerStatus: statusOf.get(provider.secretName) ?? null,
      credentialPresent: credentialPresent(provider),
      backendProvisioned: true, // resolveCloneSecretTarget already proved it
    });

    if (!verdict.act) {
      outcomes.push({
        name: provider.secretName,
        minted: false,
        reason: verdict.reason,
        detail: verdict.message,
        actionable: verdict.actionable,
      });
      continue;
    }

    let value: string;
    try {
      value = await mintKey(provider, label);
    } catch (e) {
      outcomes.push({
        name: provider.secretName,
        minted: false,
        reason: "mint_failed",
        detail: msg(e),
        actionable: true,
      });
      continue;
    }

    const { setCloneSecretValues } = await import("./backend-provisioning.server");
    const write = await setCloneSecretValues(target.projectRef, [
      { name: provider.secretName, value },
    ]);

    if (!write.ok) {
      /*
       * The key exists at the vendor and is not on the project.
       *
       * The ledger row is deliberately NOT touched. The project's value is
       * unchanged — the clone is still running on the forwarded fleet key —
       * so writing `failed` here would describe a state that is not true, and
       * three things read that row: `resolve_api_key_billability` would rate
       * a working key `no_key` and stop recharging its usage, the secrets page
       * would show "Failed" for a credential that is present, and an operator
       * would go looking for a fault in a clone that has none.
       *
       * Said as its own reason too: a retry is safe (it mints a second key and
       * the first is orphaned but harmless), where "mint_failed" would suggest
       * nothing was created at the vendor.
       */
      outcomes.push({
        name: provider.secretName,
        minted: false,
        reason: "write_failed",
        detail: `${provider.label} minted a key and it could not be written to the project: ${write.error}`,
        actionable: true,
      });
      continue;
    }

    const now = new Date().toISOString();
    const { error: ledgerErr } = await supabase.from("clone_backend_secrets").upsert(
      {
        clone_id: cloneId,
        name: provider.secretName,
        status: MINTED_STATUS,
        last_set_at: now,
        last_error: null,
        set_by: opts?.actorUserId ?? null,
      },
      { onConflict: "clone_id,name" },
    );

    if (ledgerErr) {
      /*
       * Written and unrecorded is the dangerous half, not the harmless one:
       * the ledger is what `resolve_api_key_billability` reads, so a minted
       * key with no `minted` row rates `unknown_secret` and recharges nobody,
       * AND the fleet sweep will write the shared key over it. Logged loudly
       * and reported, never swallowed.
       */
      console.error("[llm_keys] key written but ledger not updated", {
        cloneId,
        name: provider.secretName,
        error: ledgerErr.message,
      });
      outcomes.push({
        name: provider.secretName,
        minted: false,
        reason: "ledger_failed",
        detail:
          `The ${provider.label} key was written to the project and the ledger row was not: ` +
          `${ledgerErr.message}. Until it is recorded, this clone's ${provider.label} usage is ` +
          "not recharged and the fleet sweep may overwrite the key.",
        actionable: true,
      });
      continue;
    }

    outcomes.push({ name: provider.secretName, minted: true, label });
  }

  return { ok: true, cloneId: target.cloneId, outcomes };
}

/**
 * Mint what every provisioned clone is still owed, on the half-hourly sweep.
 *
 * Deliberately a reconcile rather than a provisioning-only step, for two
 * reasons that both come from how this arrives. Every clone that already
 * exists is running on the forwarded fleet key, so a provisioning-only version
 * would apply to nobody who has one today. And each provider is switched on by
 * its own credential appearing in Mission Control's environment — an event
 * with no hook to hang off, so the sweep is what notices.
 *
 * It is idempotent by the ledger: `decideLlmKeyMint` refuses a name already
 * `minted` and a name the tenant supplied, so a clone converges and then costs
 * one ledger read a tick.
 */
export async function reconcileLlmKeys(supabase: Db): Promise<{
  considered: number;
  minted: number;
  /** Counted by reason, so "nothing happened" is legible rather than blank. */
  skipped: Record<string, number>;
  refused: Array<{ cloneId: string; reason: string }>;
}> {
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

  const out = {
    considered: candidates.length,
    minted: 0,
    skipped: {} as Record<string, number>,
    refused: [] as Array<{ cloneId: string; reason: string }>,
  };

  for (const c of candidates) {
    const res = await provisionLlmKeys(supabase, c.clone_id);
    if (!res.ok) {
      out.refused.push({ cloneId: c.clone_id, reason: res.reason });
      continue;
    }
    for (const o of res.outcomes) {
      if (o.minted) out.minted += 1;
      else out.skipped[o.reason] = (out.skipped[o.reason] ?? 0) + 1;
    }
  }
  return out;
}
