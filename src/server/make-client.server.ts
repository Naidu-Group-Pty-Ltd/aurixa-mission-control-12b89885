/**
 * The only place Mission Control talks to the Make.com API.
 *
 * ## The credential, and why it never travels
 *
 * `MAKE_API_TOKEN` is a Make API token for the team(s) that hold the clones'
 * voice-automation stacks. A Make token is scoped to the USER and the scopes it
 * was minted with — not to a scenario, a data store or a tenant — so one token
 * reads and rewrites every tenant's scenarios in the team. It is the fourth
 * credential this platform brokers rather than forwards (Didit, Airtable, the
 * Supabase management token are the others): it stays here, and a tenant's
 * change arrives as a request `voice-automation.server.ts` judges and applies.
 *
 * Scopes the token needs: `scenarios:read`, `scenarios:write`,
 * `datastores:read`, `datastores:write`, `connections:read`,
 * `connections:write` (the verify call), `credential-requests:read`,
 * `credential-requests:write`.
 *
 * ## Two rules about what comes back
 *
 * 1. **A CFG record is projected the moment it is read.** Make's data-store
 *    endpoints answer with the WHOLE record, and the stack's record carries the
 *    shared secret the scenarios authenticate each other with. `readManagedCfg`
 *    returns `projectManagedCfg(record)` and nothing else; `patchCfg` discards
 *    the response body unread except for its status. Neither is ever logged.
 * 2. **A Make error is reported by status and code, never by body.** A body can
 *    echo the request — and a request to the data-store endpoint carries
 *    tenant values — so errors carry `status`, Make's `code` when it sent one,
 *    and the operation name.
 */

import { projectManagedCfg, makeApiBase, type MakeZone } from "./voiceAutomation.pure";
import type { Blueprint } from "./voiceAutomationBlueprint.pure";

const TIMEOUT_MS = 20_000;

export function isMakeConfigured(): boolean {
  return (process.env.MAKE_API_TOKEN ?? "").trim().length > 0;
}

export class MakeApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`Make ${operation} failed (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "MakeApiError";
  }
}

export class MakeNotConfiguredError extends Error {
  constructor() {
    super("MAKE_API_TOKEN is not set on Mission Control");
    this.name = "MakeNotConfiguredError";
  }
}

async function makeFetch(
  zone: MakeZone,
  operation: string,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | string[]> } = {},
): Promise<unknown> {
  const token = (process.env.MAKE_API_TOKEN ?? "").trim();
  if (!token) throw new MakeNotConfiguredError();
  const url = new URL(makeApiBase(zone) + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Token ${token}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
  } catch (e) {
    throw new MakeApiError(
      operation,
      0,
      (e as Error)?.name === "AbortError" ? "timeout" : "network",
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const code =
      json && typeof json === "object" && typeof (json as { code?: unknown }).code === "string"
        ? (json as { code: string }).code
        : null;
    throw new MakeApiError(operation, res.status, code);
  }
  return json;
}

// ---------------------------------------------------------------------------
// Scenarios

export async function getScenarioBlueprint(zone: MakeZone, scenarioId: number): Promise<Blueprint> {
  const json = (await makeFetch(zone, "blueprint.get", `/scenarios/${scenarioId}/blueprint`)) as {
    response?: { blueprint?: Blueprint };
  };
  const bp = json?.response?.blueprint;
  if (!bp || !Array.isArray(bp.flow)) throw new MakeApiError("blueprint.get", 200, "no_blueprint");
  return bp;
}

export type ScenarioState = { isActive: boolean; isInvalid: boolean };

export async function getScenarioState(zone: MakeZone, scenarioId: number): Promise<ScenarioState> {
  const json = (await makeFetch(zone, "scenario.get", `/scenarios/${scenarioId}`, {
    query: { "cols[]": ["id", "isActive", "isinvalid"] },
  })) as { scenario?: { isActive?: boolean; isinvalid?: boolean } };
  return { isActive: !!json?.scenario?.isActive, isInvalid: !!json?.scenario?.isinvalid };
}

/**
 * Replace a scenario's blueprint, then read the scenario back: an update Make
 * accepted but marked invalid is a stopped stack, and is reported as a failure
 * rather than as the success the PATCH status alone would suggest.
 */
export async function updateScenarioBlueprint(
  zone: MakeZone,
  scenarioId: number,
  blueprint: Blueprint,
): Promise<ScenarioState> {
  await makeFetch(zone, "blueprint.update", `/scenarios/${scenarioId}`, {
    method: "PATCH",
    query: { confirmed: "true" },
    body: { blueprint: JSON.stringify(blueprint) },
  });
  const state = await getScenarioState(zone, scenarioId);
  if (state.isInvalid)
    throw new MakeApiError("blueprint.update", 200, "scenario_invalid_after_update");
  return state;
}

// ---------------------------------------------------------------------------
// The CFG record

/** The managed fields of one record, or null when the record does not exist. */
export async function readManagedCfg(
  zone: MakeZone,
  dataStoreId: number,
  key: string,
): Promise<Record<string, unknown> | null> {
  const pageSize = 100;
  for (let offset = 0; offset < 1000; offset += pageSize) {
    const json = (await makeFetch(zone, "cfg.read", `/data-stores/${dataStoreId}/data`, {
      query: { "pg[limit]": String(pageSize), "pg[offset]": String(offset) },
    })) as { records?: { key?: string; data?: unknown }[] };
    const records = json?.records ?? [];
    const hit = records.find((r) => r.key === key);
    // Projected HERE: the record's secret goes no further than this line.
    if (hit) return projectManagedCfg(hit.data);
    if (records.length < pageSize) return null;
  }
  return null;
}

/** Partial update of the CFG record. The echoed record is discarded unread. */
export async function patchCfg(
  zone: MakeZone,
  dataStoreId: number,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await makeFetch(
    zone,
    "cfg.patch",
    `/data-stores/${dataStoreId}/data/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      body: patch,
    },
  );
}

// ---------------------------------------------------------------------------
// Credential requests and connections

export type CreatedCredentialRequest = { requestId: string; publicUri: string };

export async function createCredentialRequest(
  zone: MakeZone,
  input: {
    teamId: number;
    name: string;
    description: string;
    credential: {
      appName: string;
      appVersion: number;
      appModules: readonly string[];
      nameOverride: string;
      description: string;
    };
    provider: { name: string; email: string };
  },
): Promise<CreatedCredentialRequest> {
  const json = (await makeFetch(
    zone,
    "credential_request.create",
    "/credential-requests/requests/v2",
    {
      method: "POST",
      body: {
        teamId: input.teamId,
        name: input.name,
        description: input.description,
        credentials: [
          {
            appName: input.credential.appName,
            appVersion: input.credential.appVersion,
            appModules: [...input.credential.appModules],
            nameOverride: input.credential.nameOverride,
            description: input.credential.description,
          },
        ],
        provider: { newUser: { name: input.provider.name, email: input.provider.email } },
      },
    },
  )) as { request?: { id?: string }; publicUri?: string };
  const requestId = json?.request?.id;
  const publicUri = json?.publicUri;
  if (!requestId || !publicUri)
    throw new MakeApiError("credential_request.create", 200, "incomplete_answer");
  return { requestId, publicUri };
}

export type CredentialReading = {
  id: string;
  state: string;
  remoteId: unknown;
  appName: string | null;
  nameOverride: string | null;
  declineReason: string | null;
};

export async function getCredentialRequestCredentials(
  zone: MakeZone,
  requestId: string,
): Promise<CredentialReading[]> {
  const json = (await makeFetch(
    zone,
    "credential_request.detail",
    `/credential-requests/requests/${encodeURIComponent(requestId)}/detail`,
  )) as {
    requestDetail?: { credentials?: Record<string, unknown>[] };
  };
  return (json?.requestDetail?.credentials ?? []).map((c) => ({
    id: String(c.id ?? ""),
    state: String(c.state ?? ""),
    remoteId: c.remoteId ?? null,
    appName: typeof c.appName === "string" ? c.appName : null,
    nameOverride: typeof c.nameOverride === "string" ? c.nameOverride : null,
    declineReason: typeof c.declineReason === "string" ? c.declineReason.slice(0, 300) : null,
  }));
}

export async function deleteCredentialRequest(zone: MakeZone, requestId: string): Promise<void> {
  await makeFetch(
    zone,
    "credential_request.delete",
    `/credential-requests/requests/${encodeURIComponent(requestId)}`,
    {
      method: "DELETE",
      query: { confirmed: "false" },
    },
  );
}

export async function findConnectionIdByName(
  zone: MakeZone,
  teamId: number,
  name: string,
): Promise<number | null> {
  const json = (await makeFetch(zone, "connections.list", "/connections", {
    query: { teamId: String(teamId), "cols[]": ["id", "name"] },
  })) as { connections?: { id?: number; name?: string }[] };
  const hit = (json?.connections ?? []).find((c) => c.name === name);
  return typeof hit?.id === "number" ? hit.id : null;
}

export async function getConnectionLabel(
  zone: MakeZone,
  connectionId: number,
): Promise<{ teamId: number | null; accountLabel: string | null; accountName: string | null }> {
  const json = (await makeFetch(zone, "connection.get", `/connections/${connectionId}`, {
    query: { "cols[]": ["id", "teamId", "accountLabel", "accountName", "metadata"] },
  })) as {
    connection?: {
      teamId?: number;
      accountLabel?: string;
      accountName?: string;
      metadata?: { value?: unknown };
    };
  };
  const c = json?.connection ?? {};
  const meta = typeof c.metadata?.value === "string" ? c.metadata.value : null;
  return {
    teamId: typeof c.teamId === "number" ? c.teamId : null,
    accountLabel: (meta ?? c.accountLabel ?? null)?.toString().slice(0, 200) ?? null,
    accountName: c.accountName ?? null,
  };
}

export async function verifyConnection(zone: MakeZone, connectionId: number): Promise<boolean> {
  const json = (await makeFetch(zone, "connection.test", `/connections/${connectionId}/test`, {
    method: "POST",
  })) as { verified?: boolean };
  return json?.verified === true;
}
