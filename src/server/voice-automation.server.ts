/**
 * Applying a CRM-independent clone's calendar and email settings to its Make
 * stack — from whichever of the three writers changed them.
 *
 *   provisioning ─┐
 *   operator ─────┼─► clone_voice_automation (desired, revisioned) ─► apply ─► Make
 *   tenant ───────┘        (via /api/public/voice-automation)          (adapter + notifier
 *                                                                         blueprints, CFG record)
 *
 * The rules each step answers to are in the pure modules beside this one:
 * `voiceAutomation.pure.ts` (what a setting may be, who may change it, what
 * reaches CFG), `voiceAutomationBlueprint.pure.ts` (binding a connection) and
 * `voiceAutomationPlan.pure.ts` (what an apply writes, in what order, or why it
 * writes nothing). This module is the I/O around them and owns three things of
 * its own:
 *
 * - **One apply at a time per clone**, by a lease taken with a compare-and-set
 *   on `updated_at` — never a filter composed as a string.
 * - **Desired is never mistaken for applied.** A revision that is accepted and
 *   then blocked or failed leaves `applied_*` on the previous one, and both are
 *   in every view, so nobody is told a change is live that is not.
 * - **Nothing a Make response carries is stored or relayed** beyond what the
 *   client module already narrowed it to (see `make-client.server.ts`).
 *
 * Doc: docs/CLONE_VOICE_AUTOMATION.md.
 */

import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";
import { decryptSecret, encryptSecret, isEncryptionEnabled } from "@/server/crypto.server";
import {
  CONNECTION_KINDS,
  CONNECTION_KIND_VALUES,
  DEFAULT_LOCKED_BEFORE_HANDOFF,
  EMAIL_PROVIDERS,
  CALENDAR_PROVIDERS,
  SETTING_FIELDS,
  SLOT_STEPS,
  connectionIdFromRemoteId,
  connectionNameFor,
  detectDrift,
  diffSettings,
  isEmail,
  isMakeAuthorisationUrl,
  isMakeZone,
  lockedFieldViolations,
  mergeSettingsPatch,
  normaliseLockedFields,
  requiredConnections,
  validateSettings,
  type ConnectionKind,
  type FieldError,
  type MakeZone,
  type VoiceAutomationSettings,
} from "@/server/voiceAutomation.pure";
import {
  MAX_APPLY_ATTEMPTS,
  nextAttemptDelayMs,
  planApply,
  type ApplyBlock,
  type ConnectionReading,
} from "@/server/voiceAutomationPlan.pure";
import {
  MakeApiError,
  MakeNotConfiguredError,
  createCredentialRequest,
  deleteCredentialRequest,
  findConnectionIdByName,
  getConnectionLabel,
  getCredentialRequestCredentials,
  getScenarioBlueprint,
  isMakeConfigured,
  patchCfg,
  readManagedCfg,
  updateScenarioBlueprint,
  verifyConnection,
} from "@/server/make-client.server";

type StackRow = Database["public"]["Tables"]["clone_voice_automation"]["Row"];
type ConnectionRow = Database["public"]["Tables"]["clone_voice_automation_connections"]["Row"];

export type ActorKind = "provisioning" | "operator" | "tenant";
export type Actor = { kind: ActorKind; label: string | null; userId?: string | null };

const LEASE_MS = 3 * 60_000;
const BLOCKED_RECHECK_MS = 15 * 60_000;
const DRIFT_INTERVAL_MS = 24 * 60 * 60_000;
const PENDING_LINK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; message: string; detail?: unknown };

const fail = (
  status: number,
  error: string,
  message: string,
  detail?: unknown,
): Outcome<never> => ({ ok: false, status, error, message, detail });

/** A label a writer gave itself, made safe to store and to show. */
export function cleanLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = [...v]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f && !"<>{}".includes(ch))
    .join("")
    .trim()
    .slice(0, 120);
  return s || null;
}

function errorText(e: unknown): string {
  if (e instanceof MakeApiError || e instanceof MakeNotConfiguredError) return e.message;
  return "Unexpected error while applying (see server logs)";
}

// ---------------------------------------------------------------------------
// Reads

async function loadStack(cloneId: string): Promise<StackRow | null> {
  const { data, error } = await supabaseAdmin
    .from("clone_voice_automation")
    .select("*")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`voice automation read failed: ${error.message}`);
  return data;
}

async function loadConnections(cloneId: string): Promise<ConnectionRow[]> {
  const { data, error } = await supabaseAdmin
    .from("clone_voice_automation_connections")
    .select("*")
    .eq("clone_id", cloneId)
    .order("requested_at", { ascending: false });
  if (error) throw new Error(`voice automation connections read failed: ${error.message}`);
  return data ?? [];
}

function readings(rows: ConnectionRow[]): ConnectionReading[] {
  return rows
    .filter((r) => r.state === "authorized")
    .map((r) => ({
      kind: r.kind as ConnectionKind,
      state: r.state,
      makeConnectionId: r.make_connection_id,
    }));
}

function storedSettings(row: StackRow): VoiceAutomationSettings | null {
  const v = validateSettings(row.settings);
  return v.ok ? v.settings : null;
}

/** The options a form may offer — sent with the view so the clone draws what this side accepts. */
export const SETTING_OPTIONS = {
  calendarProviders: CALENDAR_PROVIDERS,
  emailProviders: EMAIL_PROVIDERS,
  slotSteps: SLOT_STEPS,
  fields: SETTING_FIELDS.map((f) => f.path),
  connectionKinds: CONNECTION_KIND_VALUES.map((k) => ({
    kind: k,
    label: CONNECTION_KINDS[k].label,
  })),
};

export type ConnectionView = {
  kind: ConnectionKind;
  label: string;
  state: "not_connected" | "requested" | "authorized" | "declined" | "failed";
  accountLabel: string | null;
  requestedAt: string | null;
  authorizedAt: string | null;
  /** Only while a request is open, and only to the clone that made it. */
  authorisationUrl: string | null;
  lastError: string | null;
  /** True when an authorised connection exists AND a newer request is open. */
  replacing: boolean;
};

export type VoiceAutomationView = {
  provisioned: boolean;
  revision: number | null;
  settings: VoiceAutomationSettings | null;
  appliedRevision: number | null;
  appliedSettings: VoiceAutomationSettings | null;
  appliedAt: string | null;
  applyStatus: StackRow["apply_status"] | null;
  applyBlocks: ApplyBlock[];
  applyError: string | null;
  lockedFields: string[];
  handedOffAt: string | null;
  updatedBy: { kind: string; label: string | null } | null;
  requiredConnections: ConnectionKind[];
  connections: ConnectionView[];
  history: {
    revision: number;
    actorKind: string;
    actorLabel: string | null;
    at: string;
    changes: Json;
  }[];
  drift: Json;
  makeConfigured: boolean;
  options: typeof SETTING_OPTIONS;
};

function connectionViews(rows: ConnectionRow[]): ConnectionView[] {
  return CONNECTION_KIND_VALUES.map((kind) => {
    const live = rows.find((r) => r.kind === kind && r.state === "authorized");
    const open = rows.find((r) => r.kind === kind && r.state === "requested");
    const last = rows.find((r) => r.kind === kind);
    const shown = open ?? live ?? last;
    let url: string | null = null;
    if (open?.public_uri_enc) {
      try {
        const d = decryptSecret(open.public_uri_enc);
        url = isMakeAuthorisationUrl(d) ? d : null;
      } catch {
        url = null;
      }
    }
    const state: ConnectionView["state"] = open
      ? "requested"
      : live
        ? "authorized"
        : last && (last.state === "declined" || last.state === "failed")
          ? (last.state as "declined" | "failed")
          : "not_connected";
    return {
      kind,
      label: CONNECTION_KINDS[kind].label,
      state,
      accountLabel: live?.account_label ?? null,
      requestedAt: shown?.requested_at ?? null,
      authorizedAt: live?.authorized_at ?? null,
      authorisationUrl: url,
      lastError: (open ?? last)?.last_error ?? null,
      replacing: !!(open && live),
    };
  });
}

export async function getVoiceAutomationView(
  cloneId: string,
  opts: { forTenant: boolean },
): Promise<VoiceAutomationView> {
  const row = await loadStack(cloneId);
  const base = { makeConfigured: isMakeConfigured(), options: SETTING_OPTIONS };
  if (!row) {
    return {
      provisioned: false,
      revision: null,
      settings: null,
      appliedRevision: null,
      appliedSettings: null,
      appliedAt: null,
      applyStatus: null,
      applyBlocks: [],
      applyError: null,
      lockedFields: [],
      handedOffAt: null,
      updatedBy: null,
      requiredConnections: [],
      connections: [],
      history: [],
      drift: [],
      ...base,
    };
  }
  const conns = await loadConnections(cloneId);
  const { data: hist } = await supabaseAdmin
    .from("clone_voice_automation_revisions")
    .select("revision, actor_kind, actor_label, created_at, changes")
    .eq("clone_id", cloneId)
    .order("revision", { ascending: false })
    .limit(20);
  const settings = storedSettings(row);
  const applied = row.applied_settings ? validateSettings(row.applied_settings) : null;
  return {
    provisioned: true,
    revision: row.revision,
    settings,
    appliedRevision: row.applied_revision,
    appliedSettings: applied && applied.ok ? applied.settings : null,
    appliedAt: row.applied_at,
    applyStatus: row.apply_status,
    applyBlocks: (Array.isArray(row.apply_blocks) ? row.apply_blocks : []) as ApplyBlock[],
    applyError: row.apply_error,
    lockedFields: row.locked_fields ?? [],
    handedOffAt: row.handed_off_at,
    updatedBy: { kind: row.updated_by_kind, label: row.updated_by_label },
    requiredConnections: settings ? requiredConnections(settings) : [],
    connections: connectionViews(conns),
    history: (hist ?? []).map((h) => ({
      revision: h.revision,
      actorKind: h.actor_kind,
      actorLabel: h.actor_label,
      at: h.created_at,
      changes: h.changes,
    })),
    // Drift names Make-side values; the tenant sees only that it exists.
    drift: opts.forTenant
      ? Array.isArray(row.drift) && row.drift.length
        ? [{ fields: (row.drift as { field: string }[]).map((d) => d.field) }]
        : []
      : row.drift,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Writes

export async function submitSettingsChange(input: {
  cloneId: string;
  expectedRevision: unknown;
  patch: unknown;
  actor: Actor;
  /** Operator-only: replace the locked set in the same revision. */
  lockedFields?: unknown;
}): Promise<Outcome<VoiceAutomationView>> {
  const row = await loadStack(input.cloneId);
  if (!row)
    return fail(
      404,
      "not_provisioned",
      "Voice-agent calendar and email have not been set up for this workspace yet. Mission Control provisions them.",
    );
  if (typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision))
    return fail(
      400,
      "revision_required",
      "Say which revision this change was made against (expectedRevision).",
    );
  if (input.expectedRevision !== row.revision)
    return fail(
      409,
      "revision_conflict",
      "These settings were changed since you loaded them. Reload, then make your change again.",
      {
        currentRevision: row.revision,
      },
    );

  const current = storedSettings(row);
  if (!current)
    return fail(
      500,
      "stored_settings_invalid",
      "The stored settings do not pass validation; an operator must correct them in Mission Control.",
    );

  const merged = mergeSettingsPatch(current, input.patch ?? {});
  if (!merged.ok)
    return fail(422, "invalid_settings", "Some settings are not valid.", { errors: merged.errors });
  const valid = validateSettings(merged.merged);
  if (!valid.ok)
    return fail(422, "invalid_settings", "Some settings are not valid.", { errors: valid.errors });

  const changes = diffSettings(current, valid.settings);
  const nextLocks =
    input.actor.kind === "tenant" || input.lockedFields === undefined
      ? null
      : normaliseLockedFields(input.lockedFields);
  const locksChanged =
    nextLocks !== null &&
    JSON.stringify([...nextLocks].sort()) !== JSON.stringify([...(row.locked_fields ?? [])].sort());

  if (input.actor.kind === "tenant") {
    const locked = lockedFieldViolations(changes, row.locked_fields ?? []);
    if (locked.length) {
      return fail(
        403,
        "field_locked",
        "Your provider manages some of these settings. Ask them to change them.",
        {
          errors: locked.map(
            (f): FieldError => ({ field: f, message: "Managed by your provider." }),
          ),
        },
      );
    }
  }

  if (changes.length === 0 && !locksChanged) {
    return {
      ok: true,
      value: await getVoiceAutomationView(input.cloneId, {
        forTenant: input.actor.kind === "tenant",
      }),
    };
  }

  const nextRevision = row.revision + 1;
  const label = cleanLabel(input.actor.label);
  const { data: updated, error: upErr } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({
      settings: valid.settings as unknown as Json,
      revision: nextRevision,
      updated_by_kind: input.actor.kind,
      updated_by_label: label,
      ...(locksChanged ? { locked_fields: nextLocks! } : {}),
      apply_status: "pending",
      apply_attempts: 0,
      apply_error: null,
      next_attempt_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("revision", input.expectedRevision)
    .select("id");
  if (upErr) throw new Error(`voice automation write failed: ${upErr.message}`);
  if (!updated || updated.length === 0)
    return fail(
      409,
      "revision_conflict",
      "These settings were changed since you loaded them. Reload, then make your change again.",
    );

  const { error: revErr } = await supabaseAdmin.from("clone_voice_automation_revisions").insert({
    clone_id: input.cloneId,
    revision: nextRevision,
    settings: valid.settings as unknown as Json,
    changes: [
      ...changes,
      ...(locksChanged ? [{ field: "lockedFields", from: row.locked_fields, to: nextLocks }] : []),
    ] as unknown as Json,
    actor_kind: input.actor.kind,
    actor_label: label,
    actor_user_id: input.actor.userId ?? null,
  });
  if (revErr) console.error("[voice-automation] revision ledger write failed:", revErr.message);

  await writeAuditLog({
    action: "voice_automation.settings_changed",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actor.userId ?? null,
    metadata: {
      revision: nextRevision,
      actor_kind: input.actor.kind,
      actor_label: label,
      fields: changes.map((c) => c.field),
      locks_changed: locksChanged,
    },
  });

  // Applied now, so the person who saved sees the outcome; the drain retries anything that cannot finish.
  await applyVoiceAutomation(input.cloneId).catch((e) =>
    console.error("[voice-automation] inline apply threw:", errorText(e)),
  );
  return {
    ok: true,
    value: await getVoiceAutomationView(input.cloneId, {
      forTenant: input.actor.kind === "tenant",
    }),
  };
}

// ---------------------------------------------------------------------------
// Apply

export type ApplyResult = {
  status: "busy" | "applied" | "noop" | "blocked" | "failed" | "not_provisioned";
  detail?: Json;
};

async function takeLease(row: StackRow): Promise<StackRow | null> {
  const now = Date.now();
  if (row.apply_lease_until && Date.parse(row.apply_lease_until) > now) return null;
  const { data, error } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({ apply_status: "applying", apply_lease_until: new Date(now + LEASE_MS).toISOString() })
    .eq("id", row.id)
    .eq("updated_at", row.updated_at)
    .select("*");
  if (error) throw new Error(`voice automation lease failed: ${error.message}`);
  return data && data.length ? data[0] : null;
}

async function finish(
  rowId: string,
  patch: Database["public"]["Tables"]["clone_voice_automation"]["Update"],
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({ ...patch, apply_lease_until: null })
    .eq("id", rowId);
  if (error) console.error("[voice-automation] could not record the apply outcome:", error.message);
}

/** Apply the clone's CURRENT revision to Make, or say why it cannot be. */
export async function applyVoiceAutomation(cloneId: string): Promise<ApplyResult> {
  const fresh = await loadStack(cloneId);
  if (!fresh) return { status: "not_provisioned" };
  const row = await takeLease(fresh);
  if (!row) return { status: "busy" };

  const settings = storedSettings(row);
  if (!settings) {
    await finish(row.id, {
      apply_status: "blocked",
      apply_blocks: [
        { reason: "stored_settings_invalid", message: "The stored settings do not validate." },
      ] as unknown as Json,
    });
    return { status: "blocked" };
  }
  if (!isMakeZone(row.make_zone)) {
    await finish(row.id, {
      apply_status: "blocked",
      apply_blocks: [
        { reason: "invalid_zone", message: "The stack's Make zone is not one this applier knows." },
      ] as unknown as Json,
    });
    return { status: "blocked" };
  }
  const zone: MakeZone = row.make_zone;

  if (!isMakeConfigured()) {
    await finish(row.id, {
      apply_status: "blocked",
      apply_blocks: [
        {
          reason: "make_not_configured",
          message:
            "Mission Control has no Make API token yet (MAKE_API_TOKEN). An operator must add it before any change reaches the voice agents.",
        },
      ] as unknown as Json,
      next_attempt_at: new Date(Date.now() + BLOCKED_RECHECK_MS).toISOString(),
    });
    return { status: "blocked", detail: "make_not_configured" };
  }

  try {
    const conns = await loadConnections(cloneId);
    const [adapter, notifier, liveManagedCfg] = await Promise.all([
      getScenarioBlueprint(zone, row.adapter_scenario_id),
      getScenarioBlueprint(zone, row.notifier_scenario_id),
      readManagedCfg(zone, row.cfg_data_store_id, row.cfg_record_key),
    ]);
    if (!liveManagedCfg) throw new MakeApiError("cfg.read", 404, "cfg_record_missing");

    const plan = planApply({
      settings,
      connections: readings(conns),
      adapter,
      notifier,
      liveManagedCfg,
    });
    if (plan.status === "blocked") {
      await finish(row.id, {
        apply_status: "blocked",
        apply_blocks: plan.blocks as unknown as Json,
        apply_error: null,
        next_attempt_at: new Date(Date.now() + BLOCKED_RECHECK_MS).toISOString(),
      });
      await writeAuditLog({
        action: "voice_automation.apply_blocked",
        entityType: "clone",
        entityId: cloneId,
        metadata: { revision: row.revision, blocks: plan.blocks.map((b) => b.reason) },
      });
      return { status: "blocked", detail: plan.blocks as unknown as Json };
    }

    // Order is load-bearing: bindings first, CFG (which SELECTS a provider) last.
    if (plan.adapter)
      await updateScenarioBlueprint(zone, row.adapter_scenario_id, plan.adapter.blueprint);
    if (plan.notifier)
      await updateScenarioBlueprint(zone, row.notifier_scenario_id, plan.notifier.blueprint);
    if (Object.keys(plan.cfgPatch).length) {
      await patchCfg(zone, row.cfg_data_store_id, row.cfg_record_key, {
        ...plan.cfgPatch,
        updated_at: new Date().toISOString(),
      });
    }

    const bindings = [...(plan.adapter?.changes ?? []), ...(plan.notifier?.changes ?? [])];
    // A revision written while this apply ran is still owed: leave it pending.
    const after = await loadStack(cloneId);
    const stillCurrent = after?.revision === row.revision;
    await finish(row.id, {
      apply_status: stillCurrent ? "applied" : "pending",
      apply_blocks: [] as unknown as Json,
      apply_error: null,
      apply_attempts: 0,
      next_attempt_at: stillCurrent ? null : new Date().toISOString(),
      applied_revision: row.revision,
      applied_settings: settings as unknown as Json,
      applied_at: new Date().toISOString(),
      last_bindings: bindings as unknown as Json,
      drift: [] as unknown as Json,
      drift_checked_at: new Date().toISOString(),
    });
    await writeAuditLog({
      action: "voice_automation.applied",
      entityType: "clone",
      entityId: cloneId,
      metadata: {
        revision: row.revision,
        noop: plan.noop,
        cfg_fields: Object.keys(plan.cfgPatch),
        bindings,
      },
    });
    return { status: plan.noop ? "noop" : "applied" };
  } catch (e) {
    const attempts = (row.apply_attempts ?? 0) + 1;
    const giveUp = attempts >= MAX_APPLY_ATTEMPTS;
    await finish(row.id, {
      apply_status: "failed",
      apply_error: errorText(e),
      apply_attempts: attempts,
      next_attempt_at: giveUp
        ? null
        : new Date(Date.now() + nextAttemptDelayMs(attempts)).toISOString(),
    });
    await writeAuditLog({
      action: "voice_automation.apply_failed",
      entityType: "clone",
      entityId: cloneId,
      metadata: { revision: row.revision, attempts, error: errorText(e) },
    });
    if (giveUp) {
      await notifyOperators({
        kind: "deployment_failed",
        severity: "error",
        title: "Voice-agent settings could not be applied",
        body: `Revision ${row.revision} failed ${attempts} times: ${errorText(e)}. Retrying has stopped; open the clone's Voice automation card.`,
        cloneId,
        url: `/clones/${cloneId}`,
      });
    }
    return { status: "failed", detail: errorText(e) };
  }
}

// ---------------------------------------------------------------------------
// Connections

export async function startConnection(input: {
  cloneId: string;
  kind: unknown;
  actor: Actor & { name?: unknown; email?: unknown };
}): Promise<Outcome<{ authorisationUrl: string; reused: boolean }>> {
  if (!CONNECTION_KIND_VALUES.includes(input.kind as ConnectionKind))
    return fail(400, "invalid_kind", "Choose a calendar or mailbox to connect.");
  const kind = input.kind as ConnectionKind;
  const row = await loadStack(input.cloneId);
  if (!row)
    return fail(
      404,
      "not_provisioned",
      "Voice-agent calendar and email have not been set up for this workspace yet.",
    );
  if (!isMakeConfigured())
    return fail(
      503,
      "make_not_configured",
      "Connecting is unavailable until your provider finishes setting up Mission Control.",
    );
  if (!isMakeZone(row.make_zone))
    return fail(500, "invalid_zone", "This workspace's automation stack is misconfigured.");
  const email = typeof input.actor.email === "string" ? input.actor.email.trim() : "";
  const name =
    cleanLabel(input.actor.name) ?? cleanLabel(input.actor.label) ?? "Workspace administrator";
  if (!isEmail(email))
    return fail(400, "email_required", "An email address for the person authorising is required.");

  const conns = await loadConnections(input.cloneId);
  const open = conns.find((c) => c.kind === kind && c.state === "requested");
  if (open) {
    const fresh = Date.now() - Date.parse(open.requested_at) < PENDING_LINK_MAX_AGE_MS;
    let url: string | null = null;
    try {
      url = open.public_uri_enc ? decryptSecret(open.public_uri_enc) : null;
    } catch {
      url = null;
    }
    if (fresh && url && isMakeAuthorisationUrl(url))
      return { ok: true, value: { authorisationUrl: url, reused: true } };
    const { error } = await supabaseAdmin
      .from("clone_voice_automation_connections")
      .update({ state: "superseded", last_error: "replaced by a newer request" })
      .eq("id", open.id);
    if (error) throw new Error(`could not retire the previous request: ${error.message}`);
    // Withdraw it at Make too, so a stale link cannot attach an account later.
    // Best effort: Make refuses (unconfirmed) once a credential is attached,
    // and an attached-but-superseded request is harmless — it is never bound.
    if (open.credential_request_id) {
      await deleteCredentialRequest(row.make_zone, open.credential_request_id).catch(
        () => undefined,
      );
    }
  }

  const { data: clone } = await supabaseAdmin
    .from("clones")
    .select("name, github_repo")
    .eq("id", input.cloneId)
    .maybeSingle();
  const slug = (clone?.github_repo ?? clone?.name ?? input.cloneId) as string;
  const connectionName = connectionNameFor(slug, kind, randomBytes(8).toString("hex"));
  const spec = CONNECTION_KINDS[kind];
  const created = await createCredentialRequest(row.make_zone, {
    teamId: Number(row.make_team_id),
    name: `${clone?.name ?? "Workspace"} — ${spec.label} for the voice agents`,
    description: `Authorise the ${spec.label} the ${clone?.name ?? "workspace"} voice agents use. Only the access listed is requested.`,
    credential: {
      appName: spec.appName,
      appVersion: spec.appVersion,
      appModules: spec.appModules,
      nameOverride: connectionName,
      description: spec.label,
    },
    provider: { name, email },
  });
  if (!isMakeAuthorisationUrl(created.publicUri))
    return fail(
      502,
      "unexpected_authorisation_link",
      "Make answered with a link that is not Make's.",
    );

  const { error: insErr } = await supabaseAdmin.from("clone_voice_automation_connections").insert({
    clone_id: input.cloneId,
    kind,
    state: "requested",
    source: input.actor.kind === "tenant" ? "tenant" : "operator",
    credential_request_id: created.requestId,
    connection_name: connectionName,
    public_uri_enc: isEncryptionEnabled() ? encryptSecret(created.publicUri) : null,
    requested_by_label: cleanLabel(input.actor.label),
  });
  if (insErr) throw new Error(`could not record the connection request: ${insErr.message}`);

  await writeAuditLog({
    action: "voice_automation.connection_requested",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actor.userId ?? null,
    metadata: {
      kind,
      actor_kind: input.actor.kind,
      actor_label: cleanLabel(input.actor.label),
      request_id: created.requestId,
    },
  });
  return { ok: true, value: { authorisationUrl: created.publicUri, reused: false } };
}

/** Promote a connection to the live one for its kind, retiring the previous. */
async function promoteConnection(
  cloneId: string,
  kind: ConnectionKind,
  keepId: string | null,
): Promise<void> {
  const { data: live, error: readErr } = await supabaseAdmin
    .from("clone_voice_automation_connections")
    .select("id")
    .eq("clone_id", cloneId)
    .eq("kind", kind)
    .eq("state", "authorized");
  if (readErr) throw new Error(`could not read the previous connection: ${readErr.message}`);
  for (const r of live ?? []) {
    if (r.id === keepId) continue;
    const { error } = await supabaseAdmin
      .from("clone_voice_automation_connections")
      .update({ state: "superseded" })
      .eq("id", r.id);
    if (error) throw new Error(`could not retire the previous connection: ${error.message}`);
  }
}

/** Read Make's answer for an open request and act on it. */
export async function refreshConnection(
  cloneId: string,
  kind: ConnectionKind,
): Promise<{ changed: boolean; state: string }> {
  const row = await loadStack(cloneId);
  if (!row || !isMakeZone(row.make_zone) || !isMakeConfigured())
    return { changed: false, state: "unavailable" };
  const conns = await loadConnections(cloneId);
  const open = conns.find((c) => c.kind === kind && c.state === "requested");
  if (!open || !open.credential_request_id) return { changed: false, state: "none_open" };
  const now = new Date().toISOString();

  const creds = await getCredentialRequestCredentials(row.make_zone, open.credential_request_id);
  const cred = creds.find((c) => c.nameOverride === open.connection_name) ?? creds[0];
  const mark = async (
    patch: Database["public"]["Tables"]["clone_voice_automation_connections"]["Update"],
  ) => {
    const { error } = await supabaseAdmin
      .from("clone_voice_automation_connections")
      .update({ last_checked_at: now, ...patch })
      .eq("id", open.id);
    if (error) throw new Error(`could not record the connection state: ${error.message}`);
  };
  if (!cred) {
    await mark({ last_error: "Make returned no credential for this request" });
    return { changed: false, state: "requested" };
  }
  if (cred.state === "declined" || cred.state === "invalid") {
    await mark({
      state: cred.state === "declined" ? "declined" : "failed",
      last_error: cred.declineReason ?? `Make reports the credential as ${cred.state}`,
    });
    return { changed: true, state: cred.state };
  }
  if (cred.state !== "authorized") {
    await mark({ credential_id: cred.id || null });
    return { changed: false, state: "requested" };
  }

  const connectionId =
    connectionIdFromRemoteId(cred.remoteId) ??
    (open.connection_name
      ? await findConnectionIdByName(row.make_zone, Number(row.make_team_id), open.connection_name)
      : null);
  if (!connectionId) {
    await mark({
      credential_id: cred.id || null,
      last_error: "Authorised, but the connection is not visible in the team yet",
    });
    return { changed: false, state: "requested" };
  }
  const info = await getConnectionLabel(row.make_zone, connectionId);
  if (info.teamId !== null && info.teamId !== Number(row.make_team_id)) {
    await mark({
      state: "failed",
      last_error: "The authorised connection belongs to a different Make team",
    });
    return { changed: true, state: "failed" };
  }
  const verified = await verifyConnection(row.make_zone, connectionId);
  if (!verified) {
    await mark({
      state: "failed",
      make_connection_id: null,
      last_error: "Make could not verify the authorised connection",
    });
    return { changed: true, state: "failed" };
  }

  await promoteConnection(cloneId, kind, open.id);
  await mark({
    state: "authorized",
    credential_id: cred.id || null,
    make_connection_id: connectionId,
    account_label: info.accountLabel,
    authorized_at: now,
    last_error: null,
  });
  await writeAuditLog({
    action: "voice_automation.connection_authorized",
    entityType: "clone",
    entityId: cloneId,
    metadata: { kind, make_connection_id: connectionId },
  });

  // The revision that was waiting on this connection can go now.
  const { error: dueErr } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({ next_attempt_at: now })
    .eq("id", row.id);
  if (dueErr) console.error("[voice-automation] could not mark the revision due:", dueErr.message);
  await applyVoiceAutomation(cloneId).catch((e) =>
    console.error("[voice-automation] apply after authorisation threw:", errorText(e)),
  );
  return { changed: true, state: "authorized" };
}

/** Operator: put an EXISTING Make connection in service for a kind. */
export async function registerExistingConnection(input: {
  cloneId: string;
  kind: unknown;
  connectionId: unknown;
  actor: Actor;
}): Promise<Outcome<{ accountLabel: string | null }>> {
  if (!CONNECTION_KIND_VALUES.includes(input.kind as ConnectionKind))
    return fail(400, "invalid_kind", "Unknown connection kind.");
  const kind = input.kind as ConnectionKind;
  const id = Number(input.connectionId);
  if (!Number.isInteger(id) || id <= 0)
    return fail(400, "invalid_connection_id", "A Make connection id is a positive whole number.");
  const row = await loadStack(input.cloneId);
  if (!row) return fail(404, "not_provisioned", "Register the stack first.");
  if (!isMakeConfigured() || !isMakeZone(row.make_zone))
    return fail(503, "make_not_configured", "MAKE_API_TOKEN is not set.");
  const info = await getConnectionLabel(row.make_zone, id);
  if (info.teamId !== null && info.teamId !== Number(row.make_team_id))
    return fail(400, "connection_in_other_team", "That connection is in a different Make team.");
  if (!(await verifyConnection(row.make_zone, id)))
    return fail(400, "connection_not_verified", "Make could not verify that connection.");
  await promoteConnection(input.cloneId, kind, null);
  const { error } = await supabaseAdmin.from("clone_voice_automation_connections").insert({
    clone_id: input.cloneId,
    kind,
    state: "authorized",
    source: "operator",
    make_connection_id: id,
    account_label: info.accountLabel,
    requested_by_label: cleanLabel(input.actor.label),
    authorized_at: new Date().toISOString(),
  });
  if (error) throw new Error(`could not record the connection: ${error.message}`);
  await writeAuditLog({
    action: "voice_automation.connection_registered",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actor.userId ?? null,
    metadata: { kind, make_connection_id: id },
  });
  await applyVoiceAutomation(input.cloneId).catch(() => undefined);
  return { ok: true, value: { accountLabel: info.accountLabel } };
}

// ---------------------------------------------------------------------------
// Provisioning and hand-off (operator)

export type StackRegistration = {
  makeZone?: unknown;
  makeTeamId?: unknown;
  cfgDataStoreId?: unknown;
  cfgRecordKey?: unknown;
  adapterScenarioId?: unknown;
  notifierScenarioId?: unknown;
  stackScenarioIds?: unknown;
};

const posInt = (v: unknown) => (typeof v === "number" ? v : Number(v));

/**
 * Register a clone's stack and its FIRST revision — what the operator sets up
 * before hand-off. Refuses a clone that is not on the CRM-independent line, and
 * refuses to overwrite an existing registration (the stack ids can be corrected
 * with `updateStackIds`, which keeps the revision history).
 */
export async function registerStack(input: {
  cloneId: string;
  stack: StackRegistration;
  settings: unknown;
  actor: Actor;
}): Promise<Outcome<VoiceAutomationView>> {
  const { data: clone, error } = await supabaseAdmin
    .from("clones")
    .select("id, crm_mode")
    .eq("id", input.cloneId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!clone) return fail(404, "clone_not_found", "No such clone.");
  if (clone.crm_mode !== "independent")
    return fail(
      409,
      "not_crm_independent",
      "Only clones on the CRM-independent line carry this voice-agent stack.",
    );
  if (await loadStack(input.cloneId))
    return fail(409, "already_registered", "This clone's stack is already registered.");

  const s = input.stack;
  if (!isMakeZone(s.makeZone))
    return fail(400, "invalid_zone", "Zone must be eu1, eu2, us1 or us2.");
  const ids = [s.makeTeamId, s.cfgDataStoreId, s.adapterScenarioId, s.notifierScenarioId].map(
    posInt,
  );
  if (ids.some((n) => !Number.isInteger(n) || n <= 0))
    return fail(
      400,
      "invalid_ids",
      "Team, data store and scenario ids are positive whole numbers.",
    );
  const key = typeof s.cfgRecordKey === "string" && s.cfgRecordKey ? s.cfgRecordKey : "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key))
    return fail(400, "invalid_record_key", "The CFG record key is 1–64 letters, digits, _ or -.");
  const valid = validateSettings(input.settings);
  if (!valid.ok)
    return fail(422, "invalid_settings", "Some settings are not valid.", { errors: valid.errors });

  const label = cleanLabel(input.actor.label) ?? "Provisioning";
  const { error: insErr } = await supabaseAdmin.from("clone_voice_automation").insert({
    clone_id: input.cloneId,
    make_zone: s.makeZone,
    make_team_id: ids[0],
    cfg_data_store_id: ids[1],
    cfg_record_key: key,
    adapter_scenario_id: ids[2],
    notifier_scenario_id: ids[3],
    stack_scenario_ids: (s.stackScenarioIds && typeof s.stackScenarioIds === "object"
      ? s.stackScenarioIds
      : {}) as Json,
    settings: valid.settings as unknown as Json,
    revision: 1,
    updated_by_kind: "provisioning",
    updated_by_label: label,
    locked_fields: [...DEFAULT_LOCKED_BEFORE_HANDOFF],
    apply_status: "pending",
    created_by: input.actor.userId ?? null,
  });
  if (insErr) throw new Error(`could not register the stack: ${insErr.message}`);
  const { error: revErr } = await supabaseAdmin.from("clone_voice_automation_revisions").insert({
    clone_id: input.cloneId,
    revision: 1,
    settings: valid.settings as unknown as Json,
    changes: [] as unknown as Json,
    actor_kind: "provisioning",
    actor_label: label,
    actor_user_id: input.actor.userId ?? null,
  });
  if (revErr) throw new Error(`could not record revision 1: ${revErr.message}`);
  await writeAuditLog({
    action: "voice_automation.stack_registered",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actor.userId ?? null,
    metadata: { zone: s.makeZone, team: ids[0] },
  });
  await applyVoiceAutomation(input.cloneId).catch(() => undefined);
  return { ok: true, value: await getVoiceAutomationView(input.cloneId, { forTenant: false }) };
}

/**
 * Hand the settings over: from now on the tenant changes them. Optionally
 * releases every lock (including the test gate) — which is the go-live act, so
 * it is a separate, audited decision rather than a side effect of a save.
 */
export async function markHandedOff(input: {
  cloneId: string;
  releaseLocks: boolean;
  actor: Actor;
}): Promise<Outcome<VoiceAutomationView>> {
  const row = await loadStack(input.cloneId);
  if (!row) return fail(404, "not_provisioned", "Register the stack first.");
  const { error } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({
      handed_off_at: new Date().toISOString(),
      ...(input.releaseLocks ? { locked_fields: [] } : {}),
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
  await writeAuditLog({
    action: "voice_automation.handed_off",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actor.userId ?? null,
    metadata: { release_locks: input.releaseLocks },
  });
  return { ok: true, value: await getVoiceAutomationView(input.cloneId, { forTenant: false }) };
}

// ---------------------------------------------------------------------------
// Drift and the drain

export async function checkDrift(cloneId: string): Promise<{ fields: string[] } | null> {
  const row = await loadStack(cloneId);
  if (!row || !row.applied_settings || !isMakeZone(row.make_zone) || !isMakeConfigured())
    return null;
  const applied = validateSettings(row.applied_settings);
  if (!applied.ok) return null;
  const live = await readManagedCfg(row.make_zone, row.cfg_data_store_id, row.cfg_record_key);
  if (!live) return null;
  const drift = detectDrift(applied.settings, live);
  const hadDrift = Array.isArray(row.drift) && row.drift.length > 0;
  const { error: driftErr } = await supabaseAdmin
    .from("clone_voice_automation")
    .update({ drift: drift as unknown as Json, drift_checked_at: new Date().toISOString() })
    .eq("id", row.id);
  if (driftErr) throw new Error(`could not record the drift reading: ${driftErr.message}`);
  if (drift.length && !hadDrift) {
    await notifyOperators({
      kind: "drift_medium",
      severity: "warning",
      title: "Voice-agent settings were changed directly in Make",
      body: `${drift.length} field(s) differ from revision ${row.applied_revision}: ${drift.map((d) => d.field).join(", ")}. The next applied change will overwrite them.`,
      cloneId,
      url: `/clones/${cloneId}`,
    });
  }
  return { fields: drift.map((d) => d.field) };
}

export async function sweepVoiceAutomation(): Promise<Record<string, unknown>> {
  const summary: Record<string, unknown> = {
    makeConfigured: isMakeConfigured(),
    refreshed: [],
    applied: [],
    drift: [],
  };
  const now = Date.now();

  const { data: open, error: openErr } = await supabaseAdmin
    .from("clone_voice_automation_connections")
    .select("clone_id, kind, requested_at")
    .eq("state", "requested")
    .limit(25);
  if (openErr) throw new Error(`voice automation sweep read failed: ${openErr.message}`);
  for (const c of open ?? []) {
    try {
      const r = await refreshConnection(c.clone_id, c.kind as ConnectionKind);
      (summary.refreshed as unknown[]).push({ cloneId: c.clone_id, kind: c.kind, state: r.state });
    } catch (e) {
      (summary.refreshed as unknown[]).push({
        cloneId: c.clone_id,
        kind: c.kind,
        error: errorText(e),
      });
    }
  }

  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("clone_voice_automation")
    .select(
      "clone_id, revision, applied_revision, apply_status, next_attempt_at, apply_attempts, drift_checked_at, apply_lease_until",
    );
  if (rowsErr) throw new Error(`voice automation sweep read failed: ${rowsErr.message}`);
  for (const r of rows ?? []) {
    const owed = r.revision !== r.applied_revision || r.apply_status !== "applied";
    const due = !r.next_attempt_at || Date.parse(r.next_attempt_at) <= now;
    const exhausted = r.apply_status === "failed" && (r.apply_attempts ?? 0) >= MAX_APPLY_ATTEMPTS;
    // An apply that died holding its lease is retried once the lease expires.
    const leaseHeld = !!r.apply_lease_until && Date.parse(r.apply_lease_until) > now;
    if (owed && due && !exhausted && !leaseHeld) {
      const res = await applyVoiceAutomation(r.clone_id).catch((e) => ({
        status: "failed",
        detail: errorText(e),
      }));
      (summary.applied as unknown[]).push({
        cloneId: r.clone_id,
        revision: r.revision,
        status: res.status,
      });
    } else if (
      !owed &&
      (!r.drift_checked_at || now - Date.parse(r.drift_checked_at) > DRIFT_INTERVAL_MS)
    ) {
      const d = await checkDrift(r.clone_id).catch(() => null);
      (summary.drift as unknown[]).push({ cloneId: r.clone_id, fields: d?.fields ?? null });
    }
  }
  return summary;
}
