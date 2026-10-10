/**
 * Every clone's voice-agent stack, built in its own Vapi org from its CRM
 * line's template — the orchestration. See docs/CLONE_VOICE_STACKS.md.
 *
 * The decisions are pure and tested beside their modules:
 *
 *   voiceStackTemplate.pure.ts   the line templates, and the gate
 *   voiceStackMake.pure.ts       a template scenario → a tenant's copy
 *   voiceStackVapi.pure.ts       template tools/assistants/squad → a tenant's
 *   voiceStackPlan.pure.ts       the order, the ledger, the derived status
 *   ghlVoiceCredentials.pure.ts  the dependent line's GoHighLevel requirement
 *   cloneVapiCustody.pure.ts     the clone's own Vapi org
 *
 * This module reads, writes and calls the vendors around them. Four rules:
 *
 * - **The template is read, never written.** Every read of the head's stack
 *   uses Mission Control's own keys; every WRITE uses the clone's — and a
 *   write with Aurixa's Vapi key is refused before it is made
 *   (`assertTenantKey`).
 * - **Refuse before creating.** Discovery dry-runs the copy of every scenario
 *   and reads every template assistant before the first object is created, so
 *   a template the build cannot account for is held with its reasons rather
 *   than half-built.
 * - **One object, one ledger row.** The id of each object goes in the ledger
 *   the moment it exists. A re-run never creates twice; an object that exists
 *   is UPDATED in place when its payload changed (a changed business name).
 * - **A line change moves the stack.** When a clone converts, the stack of the
 *   line it left is parked — its scenarios switched off, nothing deleted — and
 *   the one for the line it joined is built or resumed. The sweep checks this
 *   on every pass, so a missed conversion hook cannot leave a clone answering
 *   with the wrong line's agents.
 */
import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isCrmMode, type CrmMode } from "@/lib/crmMode.pure";
import { OPEN_CONVERSION_STATUSES } from "@/lib/crmConversionStatus.pure";
import type { VoiceStackStatus } from "@/lib/voiceStack.pure";
import { decryptSecret, encryptSecret, isEncryptionEnabled } from "./crypto.server";
import { writeAuditLog } from "./audit.server";
import {
  createCredentialRequest,
  createDataStore,
  createScenario,
  createScenarioFolder,
  createWebhook,
  findConnectionIdByName,
  getConnectionLabel,
  getCredentialRequestCredentials,
  getDataStore,
  getHook,
  getScenarioState,
  getScenarioWithBlueprint,
  isMakeConfigured,
  listRecordsOfPlainStore,
  MakeApiError,
  patchCfg,
  putRecord,
  readCfgFields,
  startScenario,
  stopScenario,
  updateScenarioBlueprint,
  verifyConnection,
} from "./make-client.server";
import {
  compileCfg,
  connectionIdFromRemoteId,
  DEFAULT_VOICE_AUTOMATION_SETTINGS,
  isMakeAuthorisationUrl,
  type MakeZone,
  type VoiceAutomationSettings,
} from "./voiceAutomation.pure";
import {
  excludes,
  judgeStackProvision,
  validateManifest,
  type ProvisionBlock,
  type StackManifest,
} from "./voiceStackTemplate.pure";
import {
  collectBlueprintRefs,
  composeCfgRecord,
  findTemplateResidue,
  rewriteScenario,
  scenarioNameFor,
} from "./voiceStackMake.pure";
import {
  applyReplacements,
  callLogCredentialPayload,
  collectAssistantRefs,
  denylistResidue,
  findDenylisted,
  functionNameOf,
  prepareAssistant,
  prepareSimpleCopy,
  prepareSquad,
  prepareTool,
  renameFor,
  substituteProse,
  validateReplacements,
  VAPI_NAME_MAX,
  type Replacement,
  type VapiObject,
} from "./voiceStackVapi.pure";
import {
  DISCOVER_KEY,
  MAX_STEP_ATTEMPTS,
  planStackSteps,
  readStack,
  retryDelayMs,
  runnableSteps,
  uniqueNames,
  type Discovery,
  type LedgerRow,
  type PlanStep,
  type StackReading,
} from "./voiceStackPlan.pure";
import {
  ghlCfgFields,
  ghlLocationRequest,
  grantMatchesLocation,
  judgeGhlVerification,
  validateGhlInput,
} from "./ghlVoiceCredentials.pure";

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

// ─── Reads ───────────────────────────────────────────────────────────────

type CloneRow = { id: string; name: string | null; slug: string | null; crm_mode: string | null };

async function readClone(cloneId: string): Promise<CloneRow> {
  const { data, error } = await supabaseAdmin
    .from("clones")
    .select("id, name, slug, crm_mode")
    .eq("id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone: ${error.message}`);
  if (!data) throw new Error("No such clone.");
  return data as CloneRow;
}

/** Both lines' head clone ids, from the column every cascade on the line reads. */
export async function readLineHeads(): Promise<Record<CrmMode, string | null>> {
  const { data, error } = await supabaseAdmin
    .from("prime_config")
    .select("crm_dependent_parent_clone_id, crm_independent_parent_clone_id")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not read the line heads: ${error.message}`);
  const d = (data ?? {}) as Record<string, string | null>;
  return {
    dependent: d.crm_dependent_parent_clone_id ?? null,
    independent: d.crm_independent_parent_clone_id ?? null,
  };
}

type TemplateRow = {
  crm_mode: CrmMode;
  enabled: boolean;
  disabled_reason: string | null;
  manifest: unknown;
  version: number;
};

async function readTemplate(
  mode: CrmMode,
): Promise<{ row: TemplateRow; manifest: StackManifest | null; problems: string[] } | null> {
  const { data, error } = await supabaseAdmin
    .from("voice_stack_templates")
    .select("crm_mode, enabled, disabled_reason, manifest, version")
    .eq("crm_mode", mode)
    .maybeSingle();
  if (error) throw new Error(`Could not read the ${mode} template: ${error.message}`);
  if (!data) return null;
  const row = data as TemplateRow;
  const v = validateManifest(row.manifest);
  return {
    row,
    manifest: v.ok ? v.manifest : null,
    problems: v.ok ? [] : v.problems.map((p) => `${p.path}: ${p.message}`),
  };
}

type StackRow = {
  id: string;
  clone_id: string;
  crm_mode: CrmMode;
  template_version: number | null;
  clone_label: string | null;
  identity_replacements: unknown;
  discovery: unknown;
  make_zone: string | null;
  make_team_id: number | null;
  make_folder_id: number | null;
  vapi_org_id: string | null;
  call_log_url: string | null;
  status: VoiceStackStatus;
  blocks: unknown;
  warnings: unknown;
  steps_done: number;
  steps_total: number;
  lease_until: string | null;
  parked_at: string | null;
  parked_reason: string | null;
  live_at: string | null;
  last_error: string | null;
  operator_notified_at: string | null;
  updated_at: string | null;
};

const STACK_COLUMNS =
  "id, clone_id, crm_mode, template_version, clone_label, identity_replacements, discovery, make_zone, make_team_id, make_folder_id, vapi_org_id, call_log_url, status, blocks, warnings, steps_done, steps_total, lease_until, parked_at, parked_reason, live_at, last_error, operator_notified_at, updated_at";

async function readStacks(cloneId: string): Promise<StackRow[]> {
  const { data, error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .select(STACK_COLUMNS)
    .eq("clone_id", cloneId);
  if (error) throw new Error(`Could not read the clone's voice stacks: ${error.message}`);
  return (data ?? []) as StackRow[];
}

async function readStackById(id: string): Promise<StackRow | null> {
  const { data, error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .select(STACK_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as StackRow | null) ?? null;
}

async function ensureStack(
  cloneId: string,
  mode: CrmMode,
  label: string | null,
): Promise<StackRow> {
  const existing = (await readStacks(cloneId)).find((s) => s.crm_mode === mode);
  if (existing) return existing;
  const { error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .insert({ clone_id: cloneId, crm_mode: mode, clone_label: label } as never);
  if (error && !/duplicate key/i.test(error.message))
    throw new Error(`Could not open the voice stack: ${error.message}`);
  const again = (await readStacks(cloneId)).find((s) => s.crm_mode === mode);
  if (!again) throw new Error("The voice stack could not be read back after opening it.");
  return again;
}

async function patchStack(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .update(patch as never)
    .eq("id", id);
  if (error) throw new Error(`Could not update the voice stack: ${error.message}`);
}

async function readLedger(
  stackId: string,
): Promise<Map<string, LedgerRow & { secret_enc: string | null }>> {
  const { data, error } = await supabaseAdmin
    .from("clone_voice_stack_ledger")
    .select(
      "step_key, status, external_id, external_ref, payload_sha, secret_enc, detail, attempts, next_attempt_at",
    )
    .eq("stack_id", stackId);
  if (error) throw new Error(`Could not read the stack's ledger: ${error.message}`);
  return new Map(
    ((data ?? []) as (LedgerRow & { secret_enc: string | null })[]).map((r) => [r.step_key, r]),
  );
}

async function writeLedger(
  stackId: string,
  key: string,
  row: Partial<LedgerRow> & { status: LedgerRow["status"]; secret_enc?: string | null },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("clone_voice_stack_ledger")
    .upsert({ stack_id: stackId, step_key: key, ...row } as never, {
      onConflict: "stack_id,step_key",
    });
  if (error) throw new Error(`Could not record step ${key}: ${error.message}`);
}

async function readGhl(cloneId: string): Promise<{
  location_id: string;
  location_name: string | null;
  api_key_enc: string;
  key_fingerprint: string;
  verified_at: string | null;
  last_error: string | null;
} | null> {
  const { data, error } = await supabaseAdmin
    .from("clone_ghl_voice_credentials")
    .select("location_id, location_name, api_key_enc, key_fingerprint, verified_at, last_error")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the GoHighLevel credentials: ${error.message}`);
  return (data as never) ?? null;
}

async function backendRef(cloneId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("clone_backends_safe")
    .select("supabase_project_ref")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone's backend: ${error.message}`);
  const ref = (
    (data as { supabase_project_ref?: string | null } | null)?.supabase_project_ref ?? ""
  ).trim();
  return ref || null;
}

async function conversionOpen(cloneId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("clone_crm_conversions")
    .select("id")
    .eq("clone_id", cloneId)
    .in("status", [...OPEN_CONVERSION_STATUSES])
    .limit(1);
  if (error) throw new Error(`Could not read the clone's conversions: ${error.message}`);
  return (data ?? []).length > 0;
}

function replacementsOf(v: unknown): Replacement[] {
  return Array.isArray(v)
    ? (v as Replacement[]).filter((r) => typeof r?.from === "string" && typeof r?.to === "string")
    : [];
}

// ─── The gate ────────────────────────────────────────────────────────────

type Gathered = {
  clone: CloneRow;
  mode: CrmMode | null;
  heads: Record<CrmMode, string | null>;
  template: Awaited<ReturnType<typeof readTemplate>>;
  blocks: ProvisionBlock[];
};

async function gather(cloneId: string): Promise<Gathered> {
  const clone = await readClone(cloneId);
  const mode = isCrmMode(clone.crm_mode) ? clone.crm_mode : null;
  const [heads, template, ref, ghl, open] = await Promise.all([
    readLineHeads(),
    mode ? readTemplate(mode) : Promise.resolve(null),
    backendRef(cloneId),
    mode === "dependent" ? readGhl(cloneId) : Promise.resolve(null),
    conversionOpen(cloneId),
  ]);
  const { isVapiCustodyActive } = await import("./clone-vapi-custody.server");
  const custodyActive = await isVapiCustodyActive(cloneId);
  const blocks = judgeStackProvision({
    crmMode: mode,
    isLineHead: mode !== null && heads[mode] === cloneId,
    conversionOpen: open,
    template: template
      ? {
          crmMode: template.row.crm_mode,
          enabled: template.row.enabled,
          disabledReason: template.row.disabled_reason,
          manifestValid: template.manifest !== null,
        }
      : null,
    makeConfigured: isMakeConfigured(),
    aurixaVapiConfigured: Boolean(process.env.VAPI_API_KEY?.trim()),
    encryptionEnabled: isEncryptionEnabled(),
    custodyActive,
    backendProjectRef: ref,
    ghl: ghl ? { verified: Boolean(ghl.verified_at) } : null,
  });
  return { clone, mode, heads, template, blocks };
}

// ─── The view ────────────────────────────────────────────────────────────

/**
 * One step as the card draws it. `retrying` is a step that failed with a retry
 * still to come; `failed` is one out of attempts, which runs again only when an
 * operator retries it.
 */
export type StackStepView = {
  key: string;
  label: string;
  status: "done" | "waiting" | "retrying" | "failed" | "pending";
  detail: string | null;
  attempts: number;
};

export type VoiceStackView = {
  crmMode: CrmMode | null;
  isLineHead: boolean;
  lineHeadCloneId: string | null;
  lineHeadName: string | null;
  template: {
    label: string | null;
    enabled: boolean;
    disabledReason: string | null;
    version: number | null;
    problems: string[];
    denylist: string[];
  } | null;
  stack: {
    id: string;
    status: VoiceStackStatus;
    reading: StackReading;
    steps: StackStepView[];
    cloneLabel: string | null;
    replacements: Replacement[];
    blocks: ProvisionBlock[];
    warnings: string[];
    identityResidue: string[];
    liveAt: string | null;
    lastError: string | null;
    vapiOrgId: string | null;
    makeFolderId: number | null;
  } | null;
  otherLines: {
    crmMode: CrmMode;
    status: VoiceStackStatus;
    parkedAt: string | null;
    parkedReason: string | null;
  }[];
  ghl: {
    locationId: string;
    locationName: string | null;
    fingerprint: string;
    verifiedAt: string | null;
    lastError: string | null;
  } | null;
  ghlGrant: {
    state: "not_requested" | "requested" | "authorised";
    authorisationUrl: string | null;
  } | null;
};

export async function getVoiceStackView(cloneId: string): Promise<VoiceStackView> {
  const g = await gather(cloneId);
  const stacks = await readStacks(cloneId);
  const current = g.mode ? (stacks.find((s) => s.crm_mode === g.mode) ?? null) : null;
  let headName: string | null = null;
  const headId = g.mode ? g.heads[g.mode] : null;
  if (headId) {
    const { data } = await supabaseAdmin
      .from("clones")
      .select("name")
      .eq("id", headId)
      .maybeSingle();
    headName = (data as { name?: string } | null)?.name ?? null;
  }
  let stackView: VoiceStackView["stack"] = null;
  let ghlGrant: VoiceStackView["ghlGrant"] = null;
  if (current && g.template?.manifest && g.mode) {
    const discovery = (current.discovery ?? null) as
      | (Discovery & { identityResidue?: string[] })
      | null;
    const steps = planStackSteps(g.template.manifest, g.mode, discovery);
    const ledger = await readLedger(current.id);
    const reading = readStack(steps, ledger, {
      blocked: g.blocks.length > 0,
      parked: Boolean(current.parked_at),
      discovered: Boolean(discovery),
    });
    stackView = {
      id: current.id,
      status: reading.status,
      reading,
      steps: steps.map((s) => {
        const r = ledger.get(s.key);
        const status: StackStepView["status"] =
          r?.status === "failed" && r.attempts < MAX_STEP_ATTEMPTS
            ? "retrying"
            : (r?.status ?? "pending");
        return {
          key: s.key,
          label: s.label,
          status,
          detail: r?.detail ?? null,
          attempts: r?.attempts ?? 0,
        };
      }),
      cloneLabel: current.clone_label,
      replacements: replacementsOf(current.identity_replacements),
      blocks: g.blocks,
      warnings: Array.isArray(current.warnings) ? (current.warnings as string[]) : [],
      identityResidue: discovery?.identityResidue ?? [],
      liveAt: current.live_at,
      lastError: current.last_error,
      vapiOrgId: current.vapi_org_id,
      makeFolderId: current.make_folder_id,
    };
    if (g.mode === "dependent") {
      const req = ledger.get("make_connection_request:ghl");
      let url: string | null = null;
      if (req?.secret_enc && req.status !== "done") {
        try {
          const u = decryptSecret(req.secret_enc);
          url = isMakeAuthorisationUrl(u) ? u : null;
        } catch {
          url = null;
        }
      }
      ghlGrant = {
        state:
          req?.status === "done" ? "authorised" : req?.external_ref ? "requested" : "not_requested",
        authorisationUrl: url,
      };
    }
  }
  const ghl = g.mode === "dependent" ? await readGhl(cloneId) : null;
  return {
    crmMode: g.mode,
    isLineHead: g.mode !== null && g.heads[g.mode] === cloneId,
    lineHeadCloneId: headId,
    lineHeadName: headName,
    template: g.template
      ? {
          label: g.template.manifest?.label ?? null,
          enabled: g.template.row.enabled,
          disabledReason: g.template.row.disabled_reason,
          version: g.template.row.version,
          problems: g.template.problems,
          denylist: g.template.manifest?.identity.denylist ?? [],
        }
      : null,
    stack: stackView,
    otherLines: stacks
      .filter((s) => s.crm_mode !== g.mode)
      .map((s) => ({
        crmMode: s.crm_mode,
        status: s.status,
        parkedAt: s.parked_at,
        parkedReason: s.parked_reason,
      })),
    ghl: ghl
      ? {
          locationId: ghl.location_id,
          locationName: ghl.location_name,
          fingerprint: ghl.key_fingerprint,
          verifiedAt: ghl.verified_at,
          lastError: ghl.last_error,
        }
      : null,
    ghlGrant,
  };
}

/**
 * Every clone's voice line, for the tree. A clone's line is `clones.crm_mode`;
 * its stack is the unparked row on that line, and any other rows are lines it
 * has left (parked by a conversion, never deleted).
 *
 * A line head is reported with role `template` and NO status: its stack was
 * built by hand and is what every stack on its line is copied from, so Mission
 * Control has never measured it and must not claim it is live. A clone on a
 * line with no row yet is `none` — not provisioned, which the sweep opens on
 * its next run.
 */
export type VoiceLineageEntry = {
  cloneId: string;
  crmMode: CrmMode | null;
  role: "template" | "stack" | "none";
  status: VoiceStackStatus | null;
  parkedLines: CrmMode[];
};

export async function getVoiceLineageSummary(): Promise<VoiceLineageEntry[]> {
  const [heads, clonesRead, rowsRead] = await Promise.all([
    readLineHeads(),
    supabaseAdmin.from("clones").select("id, crm_mode"),
    supabaseAdmin.from("clone_voice_stacks").select("clone_id, crm_mode, status, parked_at"),
  ]);
  if (clonesRead.error) throw new Error(`Could not read the clones: ${clonesRead.error.message}`);
  if (rowsRead.error) throw new Error(`Could not read the voice stacks: ${rowsRead.error.message}`);
  const rows = (rowsRead.data ?? []) as {
    clone_id: string;
    crm_mode: CrmMode;
    status: VoiceStackStatus;
    parked_at: string | null;
  }[];
  return ((clonesRead.data ?? []) as { id: string; crm_mode: string | null }[]).map((c) => {
    const mode = isCrmMode(c.crm_mode) ? c.crm_mode : null;
    const mine = rows.filter((r) => r.clone_id === c.id);
    const parkedLines = mine
      .filter((r) => r.parked_at || r.crm_mode !== mode)
      .map((r) => r.crm_mode);
    if (mode && heads[mode] === c.id) {
      return { cloneId: c.id, crmMode: mode, role: "template", status: null, parkedLines };
    }
    const current = mode ? mine.find((r) => r.crm_mode === mode && !r.parked_at) : undefined;
    return current
      ? { cloneId: c.id, crmMode: mode, role: "stack", status: current.status, parkedLines }
      : { cloneId: c.id, crmMode: mode, role: "none", status: null, parkedLines };
  });
}

// ─── Operator inputs ─────────────────────────────────────────────────────

export async function setGhlCredentials(input: {
  cloneId: string;
  apiKey: string;
  locationId: string;
  actorUserId: string;
}): Promise<{ ok: true; locationName: string } | Fail> {
  if (!isEncryptionEnabled()) return fail("CREDENTIALS_ENC_KEY is not set on Mission Control");
  const clone = await readClone(input.cloneId);
  if (clone.crm_mode !== "dependent")
    return fail(
      "GoHighLevel credentials belong to a CRM-dependent clone; this clone is not on that line.",
    );
  const v = validateGhlInput({ apiKey: input.apiKey, locationId: input.locationId });
  if (!v.ok) return fail(v.errors.join(" "));
  const req = ghlLocationRequest(v.value.locationId);
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(req.url, {
      headers: { ...req.headers, Authorization: `Bearer ${v.value.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    return fail(`GoHighLevel could not be reached: ${msg(e)}`);
  }
  const verdict = judgeGhlVerification(status, body, v.value.locationId);
  const { fingerprintOf } = await import("./voice-studio/credentials.server");
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("clone_ghl_voice_credentials").upsert(
    {
      clone_id: input.cloneId,
      location_id: v.value.locationId,
      location_name: verdict.ok ? verdict.locationName : null,
      api_key_enc: encryptSecret(v.value.apiKey),
      key_fingerprint: fingerprintOf(v.value.apiKey),
      verified_at: verdict.ok ? now : null,
      last_error: verdict.ok ? null : verdict.message,
      set_by: input.actorUserId,
    } as never,
    { onConflict: "clone_id" },
  );
  if (error) return fail(error.message);
  await writeAuditLog({
    action: verdict.ok
      ? "voice_stack.ghl_credentials_verified"
      : "voice_stack.ghl_credentials_refused",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { location_id: v.value.locationId, reason: verdict.ok ? null : verdict.reason },
  });
  return verdict.ok ? { ok: true, locationName: verdict.locationName } : fail(verdict.message);
}

export async function setStackIdentity(input: {
  cloneId: string;
  cloneLabel: string;
  replacements: unknown;
  actorUserId: string;
}): Promise<{ ok: true } | Fail> {
  const g = await gather(input.cloneId);
  if (!g.mode || !g.template?.manifest) return fail("The clone's line has no usable template.");
  const label = input.cloneLabel.replace(/\s+/g, " ").trim();
  if (label.length < 2 || label.length > 60) return fail("The business label is 2–60 characters.");
  const deny = g.template.manifest.identity.denylist;
  const named = findDenylisted(label, deny);
  if (named.length > 0)
    return fail(`The label still names the line head's business (${named.join(", ")}).`);
  const v = validateReplacements(input.replacements, deny);
  if (!v.ok) return fail(v.problems.join(" "));
  const stack = await ensureStack(input.cloneId, g.mode, label);
  await patchStack(stack.id, {
    clone_label: label,
    identity_replacements: v.replacements as unknown as never,
  });
  // Re-read the template under the new words, and re-apply any object already
  // created: tools, assistants and the squad are UPDATED in place.
  await resetSteps(
    stack.id,
    (k) =>
      k === DISCOVER_KEY ||
      k.startsWith("vapi_tool:") ||
      k.startsWith("vapi_assistant:") ||
      k === "vapi_squad",
    "Re-applying: the business details changed.",
  );
  await writeAuditLog({
    action: "voice_stack.identity_set",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { label, replacements: v.replacements.length },
  });
  return { ok: true };
}

/** Mark steps for another run, keeping any object they created (it is updated, not re-created). */
async function resetSteps(
  stackId: string,
  which: (key: string) => boolean,
  why: string,
): Promise<void> {
  const ledger = await readLedger(stackId);
  for (const [key, r] of ledger) {
    if (!which(key)) continue;
    await writeLedger(stackId, key, {
      status: "failed",
      external_id: r.external_id,
      external_ref: r.external_ref,
      payload_sha: null,
      detail: why,
      attempts: 0,
      next_attempt_at: null,
    });
  }
}

export async function retryStackStep(input: {
  cloneId: string;
  stepKey: string;
  actorUserId: string;
}): Promise<{ ok: true } | Fail> {
  const g = await gather(input.cloneId);
  if (!g.mode) return fail("The clone's line is not recorded.");
  const stack = (await readStacks(input.cloneId)).find((s) => s.crm_mode === g.mode);
  if (!stack) return fail("No stack for this clone's line.");
  const row = (await readLedger(stack.id)).get(input.stepKey);
  if (!row) return fail("That step has not run.");
  if (row.status === "done") return fail("That step is done; there is nothing to retry.");
  await writeLedger(stack.id, input.stepKey, { ...row, attempts: 0, next_attempt_at: null });
  await writeAuditLog({
    action: "voice_stack.step_retried",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { step: input.stepKey },
  });
  return { ok: true };
}

/** Start the GoHighLevel grant request: who authorises it (the tenant's GHL admin). */
export async function requestGhlGrant(input: {
  cloneId: string;
  authoriserName: string;
  authoriserEmail: string;
  actorUserId: string;
}): Promise<{ ok: true; authorisationUrl: string } | Fail> {
  const g = await gather(input.cloneId);
  if (g.mode !== "dependent" || !g.template?.manifest)
    return fail("Only a CRM-dependent clone needs a GoHighLevel grant.");
  const ghl = await readGhl(input.cloneId);
  if (!ghl?.verified_at)
    return fail("Verify the GoHighLevel key first: the grant is checked against its location.");
  if (!isMakeConfigured()) return fail("MAKE_API_TOKEN is not set on Mission Control.");
  const email = input.authoriserEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return fail("An email address for the person authorising is required.");
  const m = g.template.manifest;
  const slot = m.make.connections.slotsByApp.highlevel;
  if (!slot) return fail("The dependent template declares no GoHighLevel grant.");
  const stack = await ensureStack(input.cloneId, "dependent", g.clone.name);
  const discovery = (stack.discovery ?? null) as
    | (Discovery & { modulesByApp?: Record<string, string[]> })
    | null;
  const modules = [
    ...new Set([...slot.appModules, ...(discovery?.modulesByApp?.highlevel ?? [])]),
  ].sort();
  const name =
    `aurixa-${(g.clone.slug ?? "clone").replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}-ghl-${randomBytes(5).toString("hex")}`.toLowerCase();
  const created = await createCredentialRequest(m.make.zone, {
    teamId: m.make.teamId,
    name: `${g.clone.name ?? "Workspace"} — GoHighLevel for the voice agents`,
    description: `Authorise the GoHighLevel location "${ghl.location_name ?? ghl.location_id}" for the ${g.clone.name ?? "workspace"} voice agents.`,
    credential: {
      appName: slot.appName,
      appVersion: slot.appVersion,
      appModules: modules,
      nameOverride: name,
      description: slot.label,
    },
    provider: { name: input.authoriserName.trim() || "GoHighLevel administrator", email },
  });
  if (!isMakeAuthorisationUrl(created.publicUri))
    return fail("Make answered with a link that is not Make's.");
  await writeLedger(stack.id, "make_connection_request:ghl", {
    status: "waiting",
    external_id: null,
    external_ref: `${created.requestId}|${name}`,
    secret_enc: encryptSecret(created.publicUri),
    detail: `Waiting for ${email} to authorise GoHighLevel.`,
    attempts: 0,
    next_attempt_at: null,
  });
  await writeAuditLog({
    action: "voice_stack.ghl_grant_requested",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { request_id: created.requestId },
  });
  return { ok: true, authorisationUrl: created.publicUri };
}

/** The operator's "build it now": runs one tick for this clone straight away. */
export async function buildVoiceStackNow(input: {
  cloneId: string;
  actorUserId: string;
}): Promise<{ ok: true; reading: StackReading | null; blocks: ProvisionBlock[] } | Fail> {
  const g = await gather(input.cloneId);
  if (!g.mode) return fail("The clone's CRM line is not recorded.");
  const stack = await ensureStack(input.cloneId, g.mode, g.clone.name);
  if (stack.parked_at) await patchStack(stack.id, { parked_at: null, parked_reason: null });
  await writeAuditLog({
    action: "voice_stack.build_requested",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { crm_mode: g.mode },
  });
  const res = await tickStack(stack.id, 60_000);
  return { ok: true, reading: res.reading, blocks: res.blocks };
}

export async function parkVoiceStack(input: {
  cloneId: string;
  crmMode: CrmMode;
  reason: string;
  actorUserId: string | null;
}): Promise<{ ok: true; stopped: number } | Fail> {
  const stack = (await readStacks(input.cloneId)).find((s) => s.crm_mode === input.crmMode);
  if (!stack) return { ok: true, stopped: 0 };
  if (stack.parked_at) return { ok: true, stopped: 0 };
  const ledger = await readLedger(stack.id);
  const zone = stack.make_zone as MakeZone | null;
  let stopped = 0;
  const errors: string[] = [];
  if (zone && isMakeConfigured()) {
    for (const [key, r] of ledger) {
      if (!key.startsWith("make_scenario:") || !r.external_id) continue;
      try {
        await stopScenario(zone, Number(r.external_id));
        stopped += 1;
        const act = ledger.get(`make_activate:${key.slice("make_scenario:".length)}`);
        if (act)
          await writeLedger(stack.id, `make_activate:${key.slice("make_scenario:".length)}`, {
            ...act,
            status: "failed",
            attempts: 0,
            detail: "Parked: switched off.",
          });
      } catch (e) {
        errors.push(`${key}: ${msg(e)}`);
      }
    }
  }
  // The read-back is reset with the activations: a stack resumed after a park
  // must switch its scenarios back on and then be read again before it can be
  // called live, rather than carrying a verification of the stack it was.
  const verify = ledger.get("verify");
  if (verify)
    await writeLedger(stack.id, "verify", {
      ...verify,
      status: "failed",
      attempts: 0,
      next_attempt_at: null,
      detail: "Parked: read back again on resume.",
    });
  await patchStack(stack.id, {
    parked_at: new Date().toISOString(),
    parked_reason: input.reason.slice(0, 500),
    status: "parked",
    last_error:
      errors.length > 0 ? `Some scenarios could not be switched off: ${errors.join("; ")}` : null,
  });
  await writeAuditLog({
    action: "voice_stack.parked",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { crm_mode: input.crmMode, stopped, reason: input.reason },
  });
  return { ok: true, stopped };
}

/**
 * A clone moved line (the CRM conversion finished). Park the stack of the line
 * it left, open (or resume) the one for the line it joined. Never deletes:
 * converting back resumes the stack it had, ledger intact. Never throws — the
 * conversion it follows has already happened.
 */
export async function onCrmLineChanged(input: {
  cloneId: string;
  fromMode: string | null;
  toMode: string;
}): Promise<string> {
  try {
    const notes: string[] = [];
    if (isCrmMode(input.fromMode)) {
      const r = await parkVoiceStack({
        cloneId: input.cloneId,
        crmMode: input.fromMode,
        reason: `The clone converted to the ${input.toMode} line.`,
        actorUserId: null,
      });
      notes.push(
        r.ok ? `${input.fromMode} stack parked (${r.stopped} scenario(s) switched off)` : r.error,
      );
    }
    if (isCrmMode(input.toMode)) {
      const clone = await readClone(input.cloneId);
      const s = await ensureStack(input.cloneId, input.toMode, clone.name);
      if (s.parked_at)
        await patchStack(s.id, { parked_at: null, parked_reason: null, status: "ready" });
      notes.push(`${input.toMode} stack ${s.parked_at ? "resumed" : "opened"}`);
    }
    return notes.join("; ");
  } catch (e) {
    return `voice stack not moved: ${msg(e)}`;
  }
}

// ─── One tick ────────────────────────────────────────────────────────────

type TickContext = {
  stack: StackRow;
  clone: CloneRow;
  mode: CrmMode;
  m: StackManifest;
  zone: MakeZone;
  team: number;
  ledger: Map<string, LedgerRow & { secret_enc: string | null }>;
  discovery: (Discovery & Record<string, unknown>) | null;
  replacements: Replacement[];
  label: string;
  cloneKey: string | null;
  aurixa: ReturnType<typeof aurixaReader>;
};

function aurixaReader() {
  const key = process.env.VAPI_API_KEY?.trim();
  if (!key) throw new Error("VAPI_API_KEY is not set on Mission Control");
  // Template reads only. Every write goes through `tenantApi`, never this.
  return import("./voice-studio/vapi-client.server").then(({ vapiClient }) => {
    const api = vapiClient(key);
    return { get: (p: string) => api.get(p) };
  });
}

async function tenantApi(ctx: TickContext) {
  if (!ctx.cloneKey) throw new Error("The clone's Vapi key is not available.");
  const aurixa = process.env.VAPI_API_KEY?.trim();
  if (aurixa && aurixa === ctx.cloneKey)
    throw new Error("Refusing to write with Aurixa's own Vapi key.");
  const { vapiClient } = await import("./voice-studio/vapi-client.server");
  return vapiClient(ctx.cloneKey);
}

const ledgerId = (ctx: TickContext, key: string) => ctx.ledger.get(key)?.external_id ?? null;
const ledgerRef = (ctx: TickContext, key: string) => ctx.ledger.get(key)?.external_ref ?? null;

function hookMaps(ctx: TickContext) {
  const ids = new Map<number, number>();
  const urls = new Map<string, string>();
  const templateUrls = (ctx.discovery?.templateHookUrls ?? {}) as Record<string, string>;
  for (const h of ctx.m.make.hooks) {
    const id = ledgerId(ctx, `make_hook:${h.role}`);
    const url = ledgerRef(ctx, `make_hook:${h.role}`);
    if (id) ids.set(h.templateHookId, Number(id));
    if (url && templateUrls[h.role]) urls.set(templateUrls[h.role], url);
  }
  return { ids, urls };
}

function storeMap(ctx: TickContext) {
  const out = new Map<number, number>();
  for (const s of ctx.m.make.dataStores) {
    const id = ledgerId(ctx, `make_data_store:${s.role}`);
    if (id) out.set(s.templateStoreId, Number(id));
  }
  return out;
}

function grantedSlots(ctx: TickContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, r] of ctx.ledger) {
    if (key.startsWith("make_connection_request:") && r.status === "done" && r.external_id)
      out[key.slice("make_connection_request:".length)] = Number(r.external_id);
  }
  return out;
}

const substituteFor = (ctx: TickContext) => (s: string) => applyReplacements(s, ctx.replacements);

/** Assistant names in the clone's org, unique, from the names discovery read. */
function assistantNames(ctx: TickContext): Map<string, string> {
  const names = (ctx.discovery?.assistantNames ?? {}) as Record<string, string>;
  const entries = ctx.m.vapi.assistants.map((a) => ({
    key: a.templateAssistantId,
    name: renameFor(names[a.templateAssistantId] ?? a.role, ctx.m.vapi.namePrefix, ctx.label),
    role: a.role,
  }));
  return uniqueNames(entries, VAPI_NAME_MAX);
}

class StepWait extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepWait";
  }
}

async function runStep(
  step: PlanStep,
  ctx: TickContext,
): Promise<{
  external_id?: string | null;
  external_ref?: string | null;
  payload_sha?: string | null;
  detail?: string | null;
  secret_enc?: string | null;
}> {
  const { m, zone, team } = ctx;
  switch (step.kind) {
    case "discover":
      return discover(ctx);

    case "make_folder": {
      const id = ledgerId(ctx, step.key);
      if (id) return { external_id: id };
      const folder = await createScenarioFolder(zone, {
        teamId: team,
        name: `${ctx.label} — voice agents (${ctx.clone.slug ?? ctx.clone.id.slice(0, 8)})`.slice(
          0,
          120,
        ),
      });
      await patchStack(ctx.stack.id, {
        make_folder_id: folder,
        make_zone: zone,
        make_team_id: team,
      });
      return { external_id: String(folder) };
    }

    case "make_hook": {
      const prior = ledgerId(ctx, step.key);
      if (prior) {
        const h = await getHook(zone, Number(prior));
        if (h) return { external_id: String(h.id), external_ref: h.url };
      }
      const h = await createWebhook(zone, {
        teamId: team,
        name: `${ctx.clone.slug ?? "clone"}-voice-${step.ref}`.slice(0, 120),
      });
      return { external_id: String(h.id), external_ref: h.url };
    }

    case "make_data_store": {
      const prior = ledgerId(ctx, step.key);
      if (prior && (await getDataStore(zone, Number(prior)))) return { external_id: prior };
      const spec = m.make.dataStores.find((s) => s.role === step.ref)!;
      const tpl = await getDataStore(zone, spec.templateStoreId);
      if (!tpl?.datastructureId)
        throw new Error(`The template data store ${spec.templateStoreId} could not be read.`);
      const id = await createDataStore(zone, {
        teamId: team,
        name: `${ctx.clone.slug ?? "clone"} voice ${step.ref}`.slice(0, 120),
        datastructureId: tpl.datastructureId,
        maxSizeMB: tpl.maxSizeMB ?? 1,
      });
      return { external_id: String(id) };
    }

    case "make_records": {
      const spec = m.make.dataStores.find((s) => s.role === step.ref)!;
      if (spec.isCfg) throw new Error("The CFG store is never copied.");
      const target = ledgerId(ctx, `make_data_store:${step.ref}`);
      if (!target) throw new Error("The clone's data store does not exist yet.");
      const records = await listRecordsOfPlainStore(zone, spec.templateStoreId);
      for (const r of records) await putRecord(zone, Number(target), r.key, r.data);
      return {
        payload_sha: sha(records.map((r) => [r.key, r.data])),
        detail: `${records.length} record(s) copied`,
      };
    }

    case "make_cfg": {
      const cfg = m.make.cfg!;
      const storeId = ledgerId(ctx, `make_data_store:${cfg.storeRole}`);
      const cfgStore = m.make.dataStores.find((s) => s.role === cfg.storeRole)!;
      if (!storeId) throw new Error("The clone's CFG store does not exist yet.");
      const settings: VoiceAutomationSettings = {
        calendar: { ...DEFAULT_VOICE_AUTOMATION_SETTINGS.calendar },
        email: { ...DEFAULT_VOICE_AUTOMATION_SETTINGS.email, businessName: ctx.label },
      };
      const carried = cfg.copyFields.length
        ? ((await readCfgFields(
            zone,
            cfgStore.templateStoreId,
            cfg.key,
            cfg.copyFields,
            cfg.secretFields,
          )) ?? {})
        : {};
      const minted: Record<string, string> = {};
      for (const s of cfg.mintSecrets) minted[s] = randomBytes(36).toString("base64url");
      const hookUrlFields: Record<string, string> = {};
      for (const [field, role] of Object.entries(cfg.hookUrls)) {
        const url = ledgerRef(ctx, `make_hook:${role}`);
        if (!url) throw new Error(`The clone's ${role} hook does not exist yet.`);
        hookUrlFields[field] = url;
      }
      let ghl: Record<string, string> | null = null;
      if (cfg.ghlFields) {
        const creds = await readGhl(ctx.clone.id);
        if (!creds?.verified_at)
          throw new StepWait("Waiting for the tenant's verified GoHighLevel key.");
        ghl = ghlCfgFields(cfg.ghlFields, {
          apiKey: decryptSecret(creds.api_key_enc),
          locationId: creds.location_id,
        });
      }
      const { record } = composeCfgRecord({
        managed: compileCfg(settings),
        minted,
        hookUrlFields,
        carried,
        assistantMapField: cfg.assistantMapField,
        assistantIds: new Map(),
        ghl,
        updatedAt: new Date().toISOString(),
      });
      await putRecord(zone, Number(storeId), cfg.key, record);
      // The record holds a secret: nothing of it is kept here but the fact it was written.
      return {
        detail: `written with ${cfg.mintSecrets.length} minted secret(s) and ${Object.keys(hookUrlFields).length} hook URL(s)`,
      };
    }

    case "make_scenario": {
      const spec = m.make.scenarios.find((s) => s.role === step.ref)!;
      const tpl = await getScenarioWithBlueprint(zone, spec.templateScenarioId);
      if (!tpl)
        throw new Error(`The template scenario ${spec.templateScenarioId} could not be read.`);
      const { ids, urls } = hookMaps(ctx);
      const cfgStore = m.make.dataStores.find((s) => s.isCfg);
      const rewrite = rewriteScenario(tpl.blueprint, {
        name: scenarioNameFor(ctx.label, step.ref.replace(/_/g, " ")),
        hooks: ids,
        dataStores: storeMap(ctx),
        hookUrls: urls,
        connections: m.make.connections,
        clonesConnections: grantedSlots(ctx),
        secretPlaceholders: m.make.cfg?.secretPlaceholders ?? {},
        cfg:
          cfgStore && m.make.cfg
            ? { templateStoreId: cfgStore.templateStoreId, key: m.make.cfg.key }
            : null,
      });
      if (rewrite.problems.length > 0)
        throw new Error(
          `Held: ${rewrite.problems.map((p) => `${p.code} (module ${p.moduleId ?? "-"}: ${p.detail})`).join("; ")}`,
        );
      const residue = findTemplateResidue(rewrite.blueprint, templateIdentity(ctx));
      if (residue.length > 0)
        throw new Error(
          `Held: the copy still names the template's ${residue.map((r) => `${r.kind} ${r.detail}`).join(", ")}`,
        );
      const prior = ledgerId(ctx, step.key);
      if (prior) {
        await updateScenarioBlueprint(zone, Number(prior), rewrite.blueprint).catch((e) => {
          if (e instanceof MakeApiError && e.code === "scenario_invalid_after_update") return null;
          throw e;
        });
        return {
          external_id: prior,
          external_ref: rewrite.awaitingSlots.join(","),
          payload_sha: sha(rewrite.blueprint),
        };
      }
      const created = await createScenario(zone, {
        teamId: team,
        folderId: ctx.stack.make_folder_id ?? Number(ledgerId(ctx, "make_folder")),
        blueprint: rewrite.blueprint,
        scheduling: tpl.scheduling,
      });
      return {
        external_id: String(created.id),
        external_ref: rewrite.awaitingSlots.join(","),
        payload_sha: sha(rewrite.blueprint),
        detail: rewrite.awaitingSlots.length
          ? `unbound until granted: ${rewrite.awaitingSlots.join(", ")}`
          : null,
      };
    }

    case "clone_call_log_secret": {
      const ref = await backendRef(ctx.clone.id);
      if (!ref) throw new StepWait("The clone has no Supabase project recorded yet.");
      // A failed read must not look like "never minted": minting again would
      // write a second secret to the clone while the Vapi credential holds the
      // first, and every call log would then be refused.
      const { data, error } = await supabaseAdmin
        .from("clone_voice_stacks")
        .select("call_log_secret_enc")
        .eq("id", ctx.stack.id)
        .maybeSingle();
      if (error) throw new Error(`Could not read the call-log secret: ${error.message}`);
      const held =
        (data as { call_log_secret_enc?: string | null } | null)?.call_log_secret_enc ?? null;
      const secret = held ? decryptSecret(held) : randomBytes(36).toString("base64url");
      const { resolveCloneSecretTarget } = await import("./cloneAllowedOrigins.server");
      const target = await resolveCloneSecretTarget(supabaseAdmin, ctx.clone.id);
      const { setCloneSecretValues } = await import("./backend-provisioning.server");
      const res = await setCloneSecretValues(target.projectRef, [
        { name: "VAPI_WEBHOOK_SECRET", value: secret },
      ]);
      if (!res.ok) throw new Error(res.error);
      const url = `https://${target.projectRef}.supabase.co/functions/v1/vapi-call-webhook`;
      await patchStack(ctx.stack.id, {
        call_log_secret_enc: held ?? encryptSecret(secret),
        call_log_url: url,
      });
      ctx.stack.call_log_url = url;
      return { external_ref: url, detail: "VAPI_WEBHOOK_SECRET written to the clone" };
    }

    case "vapi_call_log_credential": {
      const api = await tenantApi(ctx);
      const prior = ledgerId(ctx, step.key);
      if (prior && (await api.get(`/credential/${prior}`))) return { external_id: prior };
      const { data, error } = await supabaseAdmin
        .from("clone_voice_stacks")
        .select("call_log_secret_enc")
        .eq("id", ctx.stack.id)
        .maybeSingle();
      if (error) throw new Error(`Could not read the call-log secret: ${error.message}`);
      const enc = (data as { call_log_secret_enc?: string | null } | null)?.call_log_secret_enc;
      if (!enc) throw new Error("The call-log secret has not been minted.");
      const created = await api.post(
        "/credential",
        callLogCredentialPayload(`${ctx.label} call logs`, decryptSecret(enc)),
      );
      if (typeof created.id !== "string") throw new Error("Vapi answered without a credential id.");
      return { external_id: created.id };
    }

    case "vapi_file": {
      const api = await tenantApi(ctx);
      const prior = ledgerId(ctx, step.key);
      if (prior && (await api.get(`/file/${prior}`))) return { external_id: prior };
      const tpl = await (await ctx.aurixa).get(`/file/${step.ref}`);
      if (!tpl) throw new Error(`The template file ${step.ref} could not be read.`);
      const url = typeof tpl.url === "string" ? tpl.url : null;
      const mimetype = typeof tpl.mimetype === "string" ? tpl.mimetype : "text/plain";
      if (!url) throw new Error("Vapi gives no download URL for the template file.");
      if (!/^text\//.test(mimetype))
        throw new Error(`Only text knowledge-base files are copied (this is ${mimetype}).`);
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok)
        throw new Error(`The template file could not be downloaded (HTTP ${res.status}).`);
      const text = applyReplacements(await res.text(), ctx.replacements);
      const residue = denylistResidue(text, m.identity.denylist);
      if (residue.length > 0)
        throw new Error(
          `Held: the knowledge base still names ${[...new Set(residue.map((r) => r.term))].join(", ")}`,
        );
      const name =
        typeof tpl.name === "string" ? tpl.name.replace(/\.[^.]+$/, "") : "knowledge-base";
      const created = await api.uploadTextFile(`${name}.txt`, "text/plain", text);
      if (typeof created.id !== "string") throw new Error("Vapi answered without a file id.");
      return { external_id: created.id, payload_sha: sha(text) };
    }

    case "vapi_structured_output":
    case "vapi_scorecard": {
      const path =
        step.kind === "vapi_scorecard" ? "/observability/scorecard" : "/structured-output";
      const api = await tenantApi(ctx);
      const tpl = await (await ctx.aurixa).get(`${path}/${step.ref}`);
      if (!tpl)
        throw new Error(`The template ${step.kind.slice(5)} ${step.ref} could not be read.`);
      const payload = prepareSimpleCopy(tpl as VapiObject, substituteFor(ctx));
      return upsertVapi(ctx, step, api, path, payload, m.identity.denylist);
    }

    case "vapi_tool": {
      const api = await tenantApi(ctx);
      const tpl = await (await ctx.aurixa).get(`/tool/${step.ref}`);
      if (!tpl) throw new Error(`The template tool ${step.ref} could not be read.`);
      const { urls } = hookMaps(ctx);
      const prepared = prepareTool(tpl as VapiObject, {
        hookUrls: urls,
        substitute: substituteFor(ctx),
      });
      if (prepared.problems.length > 0)
        throw new Error(`Held: ${prepared.problems.map((p) => `${p.code} ${p.path}`).join("; ")}`);
      return upsertVapi(ctx, step, api, "/tool", prepared.payload, m.identity.denylist);
    }

    case "vapi_assistant": {
      const api = await tenantApi(ctx);
      const tpl = await (await ctx.aurixa).get(`/assistant/${step.ref}`);
      if (!tpl) throw new Error(`The template assistant ${step.ref} could not be read.`);
      const credentialId = ledgerId(ctx, "vapi_call_log_credential");
      if (!credentialId || !ctx.stack.call_log_url)
        throw new Error("The call-log credential does not exist yet.");
      const mapFor = (prefix: string) => {
        const out = new Map<string, string>();
        for (const [k, r] of ctx.ledger)
          if (k.startsWith(prefix) && r.external_id && r.status === "done")
            out.set(k.slice(prefix.length).toLowerCase(), r.external_id);
        return out;
      };
      const excluded = excludedToolIds(ctx);
      const names = assistantNames(ctx);
      const prepared = prepareAssistant(tpl as VapiObject, {
        maps: {
          tools: mapFor("vapi_tool:"),
          files: mapFor("vapi_file:"),
          structuredOutputs: mapFor("vapi_structured_output:"),
          scorecards: mapFor("vapi_scorecard:"),
        },
        excludedTools: excluded.ids,
        excludedFunctionNames: excluded.names,
        rename: () => names.get(step.ref) ?? ctx.label,
        substitute: substituteFor(ctx),
        callLog: { url: ctx.stack.call_log_url, credentialId },
      });
      if (prepared.problems.length > 0)
        throw new Error(
          `Held: ${prepared.problems.map((p) => `${p.code} at ${p.path}`).join("; ")}`,
        );
      if (prepared.warnings.length > 0)
        await addWarnings(
          ctx,
          prepared.warnings.map((w) => `${names.get(step.ref)}: ${w}`),
        );
      const out = await upsertVapi(
        ctx,
        step,
        api,
        "/assistant",
        prepared.payload,
        m.identity.denylist,
      );
      return { ...out, external_ref: names.get(step.ref) ?? null };
    }

    case "vapi_squad": {
      const api = await tenantApi(ctx);
      const tpl = await (await ctx.aurixa).get(`/squad/${step.ref}`);
      if (!tpl) throw new Error(`The template squad ${step.ref} could not be read.`);
      const ids = new Map<string, string>();
      const names = new Map<string, string>();
      const tplNames = (ctx.discovery?.assistantNames ?? {}) as Record<string, string>;
      for (const a of m.vapi.assistants) {
        const r = ctx.ledger.get(`vapi_assistant:${a.templateAssistantId}`);
        if (r?.external_id) ids.set(a.templateAssistantId.toLowerCase(), r.external_id);
        if (r?.external_ref && tplNames[a.templateAssistantId])
          names.set(tplNames[a.templateAssistantId], r.external_ref);
      }
      const prepared = prepareSquad(tpl as VapiObject, {
        assistants: ids,
        names,
        rename: (n) => renameFor(n, m.vapi.namePrefix, ctx.label),
        substitute: substituteFor(ctx),
      });
      if (prepared.problems.length > 0)
        throw new Error(
          `Held: ${prepared.problems.map((p) => `${p.code} at ${p.path}`).join("; ")}`,
        );
      return upsertVapi(ctx, step, api, "/squad", prepared.payload, m.identity.denylist);
    }

    case "make_cfg_assistants": {
      const cfg = m.make.cfg!;
      const cfgStore = m.make.dataStores.find((s) => s.role === cfg.storeRole)!;
      const storeId = ledgerId(ctx, `make_data_store:${cfg.storeRole}`);
      if (!storeId || !cfg.assistantMapField) return { detail: "nothing to map" };
      const carried =
        (await readCfgFields(
          zone,
          cfgStore.templateStoreId,
          cfg.key,
          [cfg.assistantMapField],
          cfg.secretFields,
        )) ?? {};
      const ids = new Map<string, string>();
      for (const a of m.vapi.assistants) {
        const r = ctx.ledger.get(`vapi_assistant:${a.templateAssistantId}`);
        if (r?.external_id) ids.set(a.templateAssistantId.toLowerCase(), r.external_id);
      }
      const { record, unmappedAssistants } = composeCfgRecord({
        managed: {},
        minted: {},
        hookUrlFields: {},
        carried,
        assistantMapField: cfg.assistantMapField,
        assistantIds: ids,
        ghl: null,
        updatedAt: new Date().toISOString(),
      });
      await patchCfg(zone, Number(storeId), cfg.key, {
        [cfg.assistantMapField]: record[cfg.assistantMapField],
        updated_at: record.updated_at,
      });
      return {
        detail: unmappedAssistants.length
          ? `${unmappedAssistants.length} template assistant(s) in the map have no counterpart and were left empty`
          : "every assistant mapped",
      };
    }

    case "make_connection_request": {
      const row = ctx.ledger.get(step.key);
      if (!row?.external_ref)
        throw new StepWait(`Waiting for an operator to request the tenant's ${step.ref} grant.`);
      const [requestId, name] = row.external_ref.split("|");
      const creds = await getCredentialRequestCredentials(zone, requestId);
      const c = creds[0];
      if (!c || c.state !== "authorized") {
        if (c?.state === "declined" || c?.state === "invalid")
          throw new Error(
            `The tenant's ${step.ref} grant was ${c.state}${c.declineReason ? `: ${c.declineReason}` : ""}. Request it again.`,
          );
        throw new StepWait(`Waiting for the tenant to authorise ${step.ref}.`);
      }
      const connId =
        connectionIdFromRemoteId(c.remoteId) ??
        (name ? await findConnectionIdByName(zone, team, name) : null);
      if (!connId)
        throw new StepWait("Authorised; waiting for Make to report the connection's id.");
      const meta = await getConnectionLabel(zone, connId);
      if (meta.teamId !== team)
        throw new Error("The authorised connection is not in the stack's team.");
      if (step.ref === "ghl") {
        const ghl = await readGhl(ctx.clone.id);
        if (!grantMatchesLocation(meta.accountLabel, ghl?.location_name ?? null))
          throw new Error(
            `The grant is for ${meta.accountLabel ?? "an unnamed location"}, not ${ghl?.location_name ?? "the verified location"}. Ask the tenant to authorise the right location.`,
          );
      }
      if (!(await verifyConnection(zone, connId)))
        throw new Error("Make could not verify the authorised connection.");
      return {
        external_id: String(connId),
        external_ref: row.external_ref,
        secret_enc: null,
        detail: meta.accountLabel,
      };
    }

    case "make_activate": {
      const scenarioKey = `make_scenario:${step.ref}`;
      const sc = ctx.ledger.get(scenarioKey);
      if (!sc?.external_id) throw new Error("The scenario does not exist yet.");
      const awaiting = (sc.external_ref ?? "").split(",").filter(Boolean);
      const granted = grantedSlots(ctx);
      const slotSpec = (slot: string) =>
        Object.values(m.make.connections.slotsByApp).find((x) => x.slot === slot);
      const stackOwed = awaiting.filter((s) => slotSpec(s)?.grantedBy === "stack" && !granted[s]);
      if (stackOwed.length > 0)
        throw new StepWait(
          `Waiting for the tenant's ${stackOwed.join(", ")} grant before switching ${step.ref} on.`,
        );
      // A grant that has since arrived is bound before switching on.
      if (awaiting.some((s) => granted[s])) {
        const re = await runStep({ ...step, key: scenarioKey, kind: "make_scenario" }, ctx);
        await writeLedger(ctx.stack.id, scenarioKey, {
          status: "done",
          external_id: re.external_id ?? sc.external_id,
          external_ref: re.external_ref ?? "",
          payload_sha: re.payload_sha ?? null,
          detail: re.detail ?? null,
          attempts: 0,
          next_attempt_at: null,
        });
      }
      try {
        const state = await startScenario(zone, Number(sc.external_id));
        if (!state.isActive) throw new Error("Make did not report the scenario active.");
      } catch (e) {
        const viaAutomation = awaiting.filter((s) => slotSpec(s)?.grantedBy === "voice_automation");
        if (viaAutomation.length > 0)
          throw new StepWait(
            `Make will not switch ${step.ref} on while ${viaAutomation.join(", ")} ${viaAutomation.length > 1 ? "are" : "is"} unbound; it switches on when the tenant connects ${viaAutomation.length > 1 ? "them" : "it"} through voice automation (${msg(e)}).`,
          );
        throw e;
      }
      return { external_id: sc.external_id };
    }

    case "voice_automation_register": {
      const cfg = m.make.cfg!;
      const storeId = ledgerId(ctx, `make_data_store:${cfg.storeRole}`);
      const adapter = ledgerId(ctx, "make_scenario:adapter");
      const notifier = ledgerId(ctx, "make_scenario:notifier");
      if (!storeId || !adapter || !notifier)
        throw new Error("The stack's CFG store, adapter and notifier must exist first.");
      const { registerStack, getVoiceAutomationView } = await import("./voice-automation.server");
      const stackScenarioIds: Record<string, number> = {};
      for (const sc of m.make.scenarios) {
        const id = ledgerId(ctx, `make_scenario:${sc.role}`);
        if (id) stackScenarioIds[sc.role] = Number(id);
      }
      const res = await registerStack({
        cloneId: ctx.clone.id,
        stack: {
          makeZone: zone,
          makeTeamId: team,
          cfgDataStoreId: Number(storeId),
          cfgRecordKey: cfg.key,
          adapterScenarioId: Number(adapter),
          notifierScenarioId: Number(notifier),
          stackScenarioIds,
        },
        settings: {
          ...DEFAULT_VOICE_AUTOMATION_SETTINGS,
          email: { ...DEFAULT_VOICE_AUTOMATION_SETTINGS.email, businessName: ctx.label },
        },
        actor: { kind: "provisioning", label: "Voice stack build", userId: null },
      });
      if (!res.ok) {
        // A stack already registered (a resumed build) is the same answer as one registered now.
        if (res.error === "already_registered") {
          const view = await getVoiceAutomationView(ctx.clone.id, { forTenant: false });
          return { detail: `already registered (revision ${view.revision ?? "?"})` };
        }
        throw new Error(res.message);
      }
      return { detail: "registered with voice automation" };
    }

    case "verify":
      return verify(ctx);
  }
}

function templateIdentity(ctx: TickContext) {
  const urls = Object.values((ctx.discovery?.templateHookUrls ?? {}) as Record<string, string>);
  return {
    hookIds: ctx.m.make.hooks.map((h) => h.templateHookId),
    dataStoreIds: ctx.m.make.dataStores.map((s) => s.templateStoreId),
    tenantOwnedConnectionIds: ctx.m.make.connections.tenantOwned.map((c) => c.templateConnectionId),
    hookUrls: urls,
  };
}

function excludedToolIds(ctx: TickContext): { ids: Set<string>; names: string[] } {
  const ids = new Set<string>();
  const names: string[] = [];
  const all = (ctx.discovery?.tools ?? {}) as Record<string, string | null>;
  const extra = (ctx.discovery?.otherTools ?? {}) as Record<string, string | null>;
  for (const [id, fn] of Object.entries({ ...all, ...extra })) {
    if (ctx.m.vapi.excludedTools.some((e) => excludes(e, { id, functionName: fn }))) {
      ids.add(id.toLowerCase());
      if (fn) names.push(fn);
    }
  }
  return { ids, names: [...new Set(names)] };
}

async function addWarnings(ctx: TickContext, warnings: string[]): Promise<void> {
  const existing = Array.isArray(ctx.stack.warnings) ? (ctx.stack.warnings as string[]) : [];
  const next = [...new Set([...existing, ...warnings])].slice(0, 50);
  ctx.stack.warnings = next;
  await patchStack(ctx.stack.id, { warnings: next as unknown as never });
}

/** Create, or update in place if the ledger already holds the object's id. */
async function upsertVapi(
  ctx: TickContext,
  step: PlanStep,
  api: Awaited<ReturnType<typeof tenantApi>>,
  path: string,
  payload: VapiObject,
  denylist: readonly string[],
) {
  const residue = denylistResidue(payload, denylist);
  if (residue.length > 0)
    throw new Error(
      `Held: still speaks as the line head (${[...new Set(residue.map((r) => r.term))].join(", ")} at ${residue[0].path}). Add a replacement for it.`,
    );
  const payloadSha = sha(payload);
  const prior = ledgerId(ctx, step.key);
  if (prior) {
    const live = await api.get(`${path}/${prior}`);
    if (live) {
      if (ctx.ledger.get(step.key)?.payload_sha === payloadSha)
        return { external_id: prior, payload_sha: payloadSha };
      // Vapi refuses `type` on a tool update; everything else is the payload.
      const { type: _type, ...patch } = payload;
      await api.patch(`${path}/${prior}`, path === "/tool" ? patch : payload);
      return { external_id: prior, payload_sha: payloadSha, detail: "updated in place" };
    }
  }
  const created = await api.post(path, payload);
  if (typeof created.id !== "string")
    throw new Error(`Vapi answered without an id for ${step.key}.`);
  return { external_id: created.id, payload_sha: payloadSha };
}

/**
 * Read the template once, completely, and refuse before anything is created:
 * every hook's URL, every scenario dry-run copied, every tool and assistant
 * read and its references classified, the squad's members checked, and the
 * prose read for the head's words under the operator's replacements.
 */
async function discover(ctx: TickContext) {
  const { m, zone } = ctx;
  const problems: string[] = [];

  const templateHookUrls: Record<string, string> = {};
  for (const h of m.make.hooks) {
    const hook = await getHook(zone, h.templateHookId);
    if (!hook) problems.push(`template hook ${h.role} (${h.templateHookId}) does not exist`);
    else templateHookUrls[h.role] = hook.url;
  }

  const fakeHooks = new Map(m.make.hooks.map((h) => [h.templateHookId, h.templateHookId + 1]));
  const fakeStores = new Map(
    m.make.dataStores.map((s) => [s.templateStoreId, s.templateStoreId + 1]),
  );
  const fakeUrls = new Map(Object.values(templateHookUrls).map((u) => [u, `${u}x`]));
  const cfgStore = m.make.dataStores.find((s) => s.isCfg);
  const stackSlots = new Set<string>();
  const modulesByApp: Record<string, string[]> = {};
  for (const sc of m.make.scenarios) {
    const tpl = await getScenarioWithBlueprint(zone, sc.templateScenarioId);
    if (!tpl) {
      problems.push(`template scenario ${sc.role} (${sc.templateScenarioId}) does not exist`);
      continue;
    }
    if (
      sc.hookRole &&
      tpl.hookId !== null &&
      tpl.hookId !== m.make.hooks.find((h) => h.role === sc.hookRole)?.templateHookId
    )
      problems.push(
        `template scenario ${sc.role} is triggered by hook ${tpl.hookId}, not the manifest's ${sc.hookRole}`,
      );
    const dry = rewriteScenario(tpl.blueprint, {
      name: "dry run",
      hooks: fakeHooks,
      dataStores: fakeStores,
      hookUrls: fakeUrls,
      connections: m.make.connections,
      clonesConnections: {},
      secretPlaceholders: m.make.cfg?.secretPlaceholders ?? {},
      cfg:
        cfgStore && m.make.cfg
          ? { templateStoreId: cfgStore.templateStoreId, key: m.make.cfg.key }
          : null,
    });
    for (const p of dry.problems)
      problems.push(`scenario ${sc.role}: ${p.code} (module ${p.moduleId ?? "-"}: ${p.detail})`);
    for (const slot of dry.awaitingSlots) {
      const spec = Object.values(m.make.connections.slotsByApp).find((x) => x.slot === slot);
      if (spec?.grantedBy === "stack") stackSlots.add(slot);
    }
    for (const [app, mods] of Object.entries(collectBlueprintRefs(tpl.blueprint).modulesByApp))
      modulesByApp[app] = [...new Set([...(modulesByApp[app] ?? []), ...mods])].sort();
  }

  const reader = await ctx.aurixa;
  const tools: Record<string, string | null> = {};
  for (const t of m.vapi.tools) {
    const tool = await reader.get(`/tool/${t.templateToolId}`);
    if (!tool) {
      problems.push(`template tool ${t.templateToolId} does not exist`);
      continue;
    }
    tools[t.templateToolId] = functionNameOf(tool as VapiObject);
    const url = (tool.server as { url?: string } | undefined)?.url ?? null;
    if (t.hookRole && url !== templateHookUrls[t.hookRole])
      problems.push(
        `template tool ${tools[t.templateToolId] ?? t.templateToolId} calls ${url ?? "nothing"}, not the ${t.hookRole} hook`,
      );
  }

  const assistantNames: Record<string, string> = {};
  const files = new Set<string>();
  const structuredOutputs = new Set<string>();
  const scorecards = new Set<string>();
  const otherTools: Record<string, string | null> = {};
  const identityResidue = new Set<string>();
  for (const a of m.vapi.assistants) {
    const asst = await reader.get(`/assistant/${a.templateAssistantId}`);
    if (!asst) {
      problems.push(`template assistant ${a.role} (${a.templateAssistantId}) does not exist`);
      continue;
    }
    assistantNames[a.templateAssistantId] = typeof asst.name === "string" ? asst.name : a.role;
    const refs = collectAssistantRefs(asst as VapiObject);
    refs.fileIds.forEach((f) => files.add(f));
    refs.structuredOutputIds.forEach((s) => structuredOutputs.add(s));
    refs.scorecardIds.forEach((s) => scorecards.add(s));
    for (const u of refs.unknown)
      problems.push(`assistant ${a.role}: an id nothing accounts for at ${u.path}`);
    for (const toolId of refs.toolIds) {
      if (
        tools[toolId] !== undefined ||
        m.vapi.tools.some((t) => t.templateToolId.toLowerCase() === toolId)
      )
        continue;
      if (otherTools[toolId] === undefined) {
        const t = await reader.get(`/tool/${toolId}`);
        otherTools[toolId] = t ? functionNameOf(t as VapiObject) : null;
      }
      if (
        !m.vapi.excludedTools.some((e) =>
          excludes(e, { id: toolId, functionName: otherTools[toolId] }),
        )
      )
        problems.push(
          `assistant ${a.role} uses tool ${otherTools[toolId] ?? toolId}, which the template neither carries nor excludes`,
        );
    }
    // The assistant's NAME is renamed, not substituted; everything else is prose.
    const { name: _name, ...rest } = asst as VapiObject;
    const prose = substituteProse(rest, (s: string) => applyReplacements(s, ctx.replacements));
    for (const r of denylistResidue(prose, m.identity.denylist)) identityResidue.add(r.term);
  }

  if (m.vapi.squad) {
    const squad = await reader.get(`/squad/${m.vapi.squad.templateSquadId}`);
    if (!squad) problems.push(`template squad ${m.vapi.squad.templateSquadId} does not exist`);
    else {
      const members = Array.isArray(squad.members)
        ? (squad.members as { assistantId?: string }[])
        : [];
      for (const mem of members)
        if (
          mem.assistantId &&
          !m.vapi.assistants.some(
            (a) => a.templateAssistantId.toLowerCase() === mem.assistantId!.toLowerCase(),
          )
        )
          problems.push(
            `the template squad includes assistant ${mem.assistantId}, which the template does not carry`,
          );
    }
  }

  if (problems.length > 0)
    throw new Error(`Held before anything was created: ${problems.join("; ")}`);
  const discovery = {
    tools,
    otherTools,
    files: [...files].sort(),
    structuredOutputs: [...structuredOutputs].sort(),
    scorecards: [...scorecards].sort(),
    stackSlots: [...stackSlots].sort(),
    templateHookUrls,
    assistantNames,
    modulesByApp,
    identityResidue: [...identityResidue].sort(),
  };
  await patchStack(ctx.stack.id, { discovery: discovery as unknown as never });
  ctx.discovery = discovery;
  if (discovery.identityResidue.length > 0)
    throw new StepWait(
      `The template's agents still speak as the line head under the current replacements: ${discovery.identityResidue.join(", ")}. Add replacements for these.`,
    );
  return {
    payload_sha: sha(discovery),
    detail: `${m.make.scenarios.length} scenarios, ${m.vapi.assistants.length} assistants, ${files.size} file(s) read`,
  };
}

/** Read everything back. A difference is a failure, never a pass. */
async function verify(ctx: TickContext) {
  const { m, zone } = ctx;
  const problems: string[] = [];
  for (const sc of m.make.scenarios) {
    const id = ledgerId(ctx, `make_scenario:${sc.role}`);
    if (!id) {
      problems.push(`${sc.role}: no scenario`);
      continue;
    }
    const state = await getScenarioState(zone, Number(id));
    const act = ctx.ledger.get(`make_activate:${sc.role}`);
    if (act?.status === "done" && !state.isActive) problems.push(`${sc.role} is not active`);
    if (state.isInvalid) problems.push(`${sc.role} is marked invalid by Make`);
    if (sc.hookRole) {
      const hookId = ledgerId(ctx, `make_hook:${sc.hookRole}`);
      const hook = hookId ? await getHook(zone, Number(hookId)) : null;
      if (!hook || hook.scenarioId !== Number(id))
        problems.push(`${sc.role}'s hook is not attached to it`);
    }
  }
  const api = await tenantApi(ctx);
  const templateIds = new Set([
    ...m.vapi.tools.map((t) => t.templateToolId),
    ...m.vapi.assistants.map((a) => a.templateAssistantId),
    ...(ctx.discovery?.files ?? []),
    ...(ctx.discovery?.structuredOutputs ?? []),
    ...(ctx.discovery?.scorecards ?? []),
  ]);
  for (const a of m.vapi.assistants) {
    const id = ledgerId(ctx, `vapi_assistant:${a.templateAssistantId}`);
    const live = id ? await api.get(`/assistant/${id}`) : null;
    if (!live) {
      problems.push(`assistant ${a.role} does not exist in the clone's org`);
      continue;
    }
    const s = JSON.stringify(live);
    for (const t of templateIds)
      if (s.includes(t))
        problems.push(`assistant ${a.role} still names template object ${t.slice(0, 8)}`);
    const server = live.server as { url?: string } | undefined;
    if (server?.url !== ctx.stack.call_log_url)
      problems.push(`assistant ${a.role} does not report to the clone's Call Logs`);
    if (denylistResidue(live, m.identity.denylist).length > 0)
      problems.push(`assistant ${a.role} still speaks as the line head`);
  }
  if (m.vapi.squad) {
    const id = ledgerId(ctx, "vapi_squad");
    if (!id || !(await api.get(`/squad/${id}`)))
      problems.push("the squad does not exist in the clone's org");
  }
  if (problems.length > 0) throw new Error(`Verification: ${problems.join("; ")}`);
  await patchStack(ctx.stack.id, { live_at: new Date().toISOString() });
  return { detail: "every object read back and matched" };
}

async function claim(stackId: string, ms: number): Promise<boolean> {
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .update({ lease_until: new Date(now.getTime() + ms).toISOString() } as never)
    .eq("id", stackId)
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/**
 * One tick for one stack: judge, then run every runnable step in order until
 * the budget is spent. Leased, so the drain and an operator's click cannot run
 * the same stack at once.
 */
export async function tickStack(
  stackId: string,
  budgetMs: number,
): Promise<{ reading: StackReading | null; blocks: ProvisionBlock[]; ran: string[] }> {
  const start = Date.now();
  const stack = await readStackById(stackId);
  if (!stack) return { reading: null, blocks: [], ran: [] };
  const g = await gather(stack.clone_id);
  const mode = stack.crm_mode;
  if (g.mode !== mode && !stack.parked_at) {
    // The clone is no longer on this stack's line: park it, whatever missed the conversion.
    await parkVoiceStack({
      cloneId: stack.clone_id,
      crmMode: mode,
      reason: "The clone is no longer on this line.",
      actorUserId: null,
    });
    return { reading: null, blocks: [], ran: [] };
  }
  const blocks = g.blocks;
  const m = g.template?.manifest ?? null;
  if (!m) {
    await patchStack(stack.id, {
      status: "awaiting_requirements",
      blocks: blocks as unknown as never,
    });
    return { reading: null, blocks, ran: [] };
  }
  const discovery0 = (stack.discovery ?? null) as (Discovery & Record<string, unknown>) | null;
  const ledger = await readLedger(stack.id);
  const steps0 = planStackSteps(m, mode, discovery0);
  const flags = {
    blocked: blocks.length > 0,
    parked: Boolean(stack.parked_at),
    discovered: Boolean(discovery0),
  };
  if (flags.blocked || flags.parked) {
    const reading = readStack(steps0, ledger, flags);
    await patchStack(stack.id, {
      status: reading.status,
      blocks: blocks as unknown as never,
      steps_done: reading.done,
      steps_total: reading.total,
    });
    return { reading, blocks, ran: [] };
  }
  if (!(await claim(stack.id, budgetMs + 30_000)))
    return { reading: readStack(steps0, ledger, flags), blocks, ran: [] };
  const ran: string[] = [];
  try {
    const custody = await import("./clone-vapi-custody.server");
    const key = await custody.vapiKeyForClone(stack.clone_id);
    const ctx: TickContext = {
      stack,
      clone: g.clone,
      mode,
      m,
      zone: m.make.zone,
      team: m.make.teamId,
      ledger,
      discovery: discovery0,
      replacements: replacementsOf(stack.identity_replacements),
      label: stack.clone_label ?? g.clone.name ?? "Clone",
      cloneKey: key.ok ? key.key : null,
      aurixa: aurixaReader(),
    };
    if (key.ok)
      await patchStack(stack.id, {
        vapi_org_id: key.orgId,
        template_version: g.template?.row.version ?? null,
      });
    for (;;) {
      if (Date.now() - start > budgetMs) break;
      const steps = planStackSteps(m, mode, ctx.discovery);
      const next = runnableSteps(steps, ctx.ledger, Date.now());
      if (next.length === 0) break;
      const step = next[0];
      const prior = ctx.ledger.get(step.key);
      try {
        const out = await runStep(step, ctx);
        const row = {
          status: "done" as const,
          external_id: out.external_id ?? prior?.external_id ?? null,
          external_ref: out.external_ref ?? prior?.external_ref ?? null,
          payload_sha: out.payload_sha ?? null,
          secret_enc: out.secret_enc === undefined ? (prior?.secret_enc ?? null) : out.secret_enc,
          detail: out.detail ?? null,
          attempts: 0,
          next_attempt_at: null,
        };
        await writeLedger(stack.id, step.key, row);
        ctx.ledger.set(step.key, { step_key: step.key, ...row });
      } catch (e) {
        const waiting = e instanceof StepWait;
        const attempts = waiting ? (prior?.attempts ?? 0) : (prior?.attempts ?? 0) + 1;
        const row = {
          status: (waiting ? "waiting" : "failed") as LedgerRow["status"],
          external_id: prior?.external_id ?? null,
          external_ref: prior?.external_ref ?? null,
          payload_sha: prior?.payload_sha ?? null,
          secret_enc: prior?.secret_enc ?? null,
          detail: msg(e).slice(0, 2000),
          attempts,
          next_attempt_at: new Date(
            Date.now() + (waiting ? 5 * 60_000 : retryDelayMs(attempts)),
          ).toISOString(),
        };
        await writeLedger(stack.id, step.key, row);
        ctx.ledger.set(step.key, { step_key: step.key, ...row });
      }
      ran.push(step.key);
    }
    const steps = planStackSteps(m, mode, ctx.discovery);
    const reading = readStack(steps, ctx.ledger, { ...flags, discovered: Boolean(ctx.discovery) });
    const exhausted = reading.failed.filter((f) => f.exhausted);
    await patchStack(stack.id, {
      status: reading.status,
      blocks: [] as unknown as never,
      steps_done: reading.done,
      steps_total: reading.total,
      last_error: reading.failed[0]?.detail ?? null,
      lease_until: null,
      ...(exhausted.length > 0 && !stack.operator_notified_at
        ? { operator_notified_at: new Date().toISOString() }
        : {}),
    });
    if (exhausted.length > 0 && !stack.operator_notified_at) {
      const { notifyOperators } = await import("./audit.server");
      await notifyOperators({
        kind: "deployment_failed",
        severity: "error",
        title: `${g.clone.name ?? "A clone"}'s voice stack stopped building`,
        body: exhausted
          .map((f) => `${f.key}: ${f.detail}`)
          .join("; ")
          .slice(0, 900),
        cloneId: g.clone.id,
        url: `/clones/${g.clone.id}`,
      });
    }
    return { reading, blocks: [], ran };
  } finally {
    await patchStack(stack.id, { lease_until: null }).catch(() => undefined);
  }
}

/** The drain: custody first, then every stack with work, oldest first. */
export async function sweepVoiceStacks(budgetMs = 240_000): Promise<Record<string, unknown>> {
  const start = Date.now();
  const { sweepVapiCustody } = await import("./clone-vapi-custody.server");
  const custody = await sweepVapiCustody().catch((e) => ({ error: msg(e) }));
  // Clones whose line has no stack row yet get one, so the gate can say what they need.
  // Both reads are checked: a failed read of the stacks would make every clone
  // look unopened, and a failed read of the clones would open none and say so
  // nowhere.
  const [clonesRead, rowsRead, heads] = await Promise.all([
    supabaseAdmin.from("clones").select("id, name, crm_mode").not("crm_mode", "is", null),
    supabaseAdmin.from("clone_voice_stacks").select("clone_id, crm_mode"),
    readLineHeads(),
  ]);
  if (clonesRead.error) throw new Error(`Could not read the clones: ${clonesRead.error.message}`);
  if (rowsRead.error) throw new Error(`Could not read the voice stacks: ${rowsRead.error.message}`);
  const have = new Set(
    ((rowsRead.data ?? []) as { clone_id: string; crm_mode: string }[]).map(
      (r) => `${r.clone_id}|${r.crm_mode}`,
    ),
  );
  let opened = 0;
  const openFailures: string[] = [];
  for (const c of (clonesRead.data ?? []) as {
    id: string;
    name: string | null;
    crm_mode: string;
  }[]) {
    if (!isCrmMode(c.crm_mode) || heads[c.crm_mode] === c.id || have.has(`${c.id}|${c.crm_mode}`))
      continue;
    try {
      await ensureStack(c.id, c.crm_mode, c.name);
      opened += 1;
    } catch (e) {
      openFailures.push(`${c.id}: ${msg(e)}`);
    }
  }
  const { data: due, error } = await supabaseAdmin
    .from("clone_voice_stacks")
    .select("id, status, updated_at")
    .is("parked_at", null)
    .neq("status", "live")
    .order("updated_at", { ascending: true })
    .limit(10);
  if (error) throw new Error(error.message);
  const ran: Record<string, string[]> = {};
  for (const s of (due ?? []) as { id: string }[]) {
    const left = budgetMs - (Date.now() - start);
    if (left < 20_000) break;
    const r = await tickStack(s.id, Math.min(left - 10_000, 120_000)).catch((e) => ({
      ran: [`error: ${msg(e)}`],
    }));
    if (r.ran.length > 0) ran[s.id] = r.ran;
  }
  return {
    custody,
    opened,
    openFailures,
    ticked: Object.keys(ran).length,
    ran,
    makeConfigured: isMakeConfigured(),
    aurixaVapiConfigured: Boolean(process.env.VAPI_API_KEY?.trim()),
  };
}
