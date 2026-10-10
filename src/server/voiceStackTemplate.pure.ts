/**
 * The voice stack each CRM line's clones are copied from — the manifest, and
 * the judgement of whether a clone's stack may be built. No I/O.
 *
 * ## A template is a line head's live stack, named
 *
 * Each line's clones get the stack the line's HEAD clone runs, exactly as they
 * get the code the head carries. The manifest does not hold a copy of that
 * stack — blueprints, prompts and tool schemas are read LIVE from Make and Vapi
 * at build time, so a fix made to the head's stack reaches the next clone built
 * from it, the way a fix made on the head reaches the next cascade. What the
 * manifest holds is the part nothing can read back: which object plays which
 * ROLE, and what each foreign reference in it must become in a tenant's copy.
 *
 * ## Refuse rather than guess
 *
 * A copied scenario that still names one of the template's hooks calls the
 * HEAD's scenario; one that still names a template data store writes the
 * head's contacts; one that still names the head's mailbox or GoHighLevel
 * connection acts as the head's business. Every one of those is a cross-tenant
 * write that looks, from the tenant's side, exactly like a working agent. So a
 * reference the manifest does not account for is never carried over: the
 * builder holds the object and names the reference (`voiceStackMake.pure.ts`,
 * `voiceStackVapi.pure.ts`). The manifest is the complete list of what may be
 * remapped, and what may be SHARED (Aurixa's own platform connections, by name).
 *
 * ## What a line requires, decided once
 *
 * `judgeStackProvision` is the one gate. It answers every block at once, not
 * the first, so an operator sees the whole list. The dependent line ALWAYS
 * requires the tenant's GoHighLevel API key and location (the owner's rule,
 * 11 Oct 2026): a dependent stack talks to the tenant's GHL, and building one
 * without it would either fail on its first call or — worse — call the head's.
 *
 * Pure: tested beside it.
 */

import type { CrmMode } from "@/lib/crmMode.pure";
import type { LineRequirement } from "@/lib/voiceStack.pure";
import { isMakeZone, type MakeZone } from "./voiceAutomation.pure";

export const STACK_MANIFEST_VERSION = 1 as const;

/**
 * The connections a template's scenarios name, and what each becomes.
 *
 * - `shared`: Aurixa's own platform connection (the availability classifier's
 *   OpenAI). Carried, and named as carried.
 * - `tenantOwned`: an account of the HEAD's business (its mailbox, its
 *   calendar placeholder, its GoHighLevel location). Never carried. Each module
 *   that used one is re-bound to the CLONE's own grant for that module's APP
 *   (`slotsByApp`), or left unbound until the tenant authorises it — never by
 *   the template connection's id, because the head binds one connection into
 *   modules of different apps (its adapter's Outlook-calendar module runs on
 *   its MAIL connection).
 *
 * A connection id in a template blueprint that is in neither list is not
 * guessed at: the scenario is held and the id named.
 */
export type ManifestConnections = {
  shared: { templateConnectionId: number; label: string }[];
  tenantOwned: { templateConnectionId: number; label: string }[];
  slotsByApp: Record<string, TenantSlot>;
};

export type TenantSlot = {
  /** The clone's grant this app's modules are bound to: `ghl`, `outlook_mail`, `outlook_calendar`, ... */
  slot: string;
  /** Make app, version and modules a credential request asks the tenant to authorise. */
  appName: string;
  appVersion: number;
  appModules: string[];
  label: string;
  /**
   * `voice_automation`: an independent stack's calendars and mailboxes, which
   * the tenant connects through voice automation after hand-off (and which do
   * not hold the stack back from going live — no route selects them until
   * they are bound). `stack`: requested by this build, and the scenarios using
   * it stay inactive until it is authorised (the dependent line's GoHighLevel).
   */
  grantedBy: "voice_automation" | "stack";
};

export type ManifestDataStore = {
  role: string;
  templateStoreId: number;
  /** `copy`: the template's records travel (a code library). `none`: the clone's store starts empty. */
  records: "none" | "copy";
  /** The stack's configuration record lives here. At most one per manifest. */
  isCfg?: boolean;
};

export type ManifestScenario = {
  role: string;
  templateScenarioId: number;
  /** The role of the hook that triggers it, or null for a scenario no hook starts. */
  hookRole: string | null;
};

export type ManifestCfg = {
  storeRole: string;
  key: string;
  /** Secrets minted fresh per clone, never read from the template. */
  mintSecrets: string[];
  /** CFG fields that hold the URL of one of the stack's own hooks. */
  hookUrls: Record<string, string>;
  /** Non-secret template CFG fields carried over (and remapped where they name assistants). */
  copyFields: string[];
  /** A CFG field whose values are template assistant ids. */
  assistantMapField: string | null;
  /** Fields the template keeps secret: never read, even by `copyFields`. */
  secretFields: string[];
  /**
   * `{{SECRET:NAME}}` placeholders in template blueprints, by NAME, and the CFG
   * field a clone's value is written to. A scenario using one must read the
   * CFG record; one that does not is held (OPEN_QUESTIONS C1).
   */
  secretPlaceholders: Record<string, string>;
  /** Where the tenant's GoHighLevel key and location are written (dependent line). */
  ghlFields: { apiKey: string; locationId: string } | null;
};

export type ManifestTool = {
  templateToolId: string;
  /** The hook a function tool calls. Null for a tool with no server (endCall). */
  hookRole: string | null;
};

export type ExcludedTool =
  | { templateToolId: string; functionName?: undefined; reason: string }
  | { functionName: string; templateToolId?: undefined; reason: string };

/** Whether an excluded-tool entry names this template tool. */
export function excludes(
  entry: ExcludedTool,
  tool: { id: string; functionName: string | null },
): boolean {
  if (entry.templateToolId) return entry.templateToolId.toLowerCase() === tool.id.toLowerCase();
  const name = entry.functionName ?? "";
  if (!tool.functionName) return false;
  return name.endsWith("*")
    ? tool.functionName.startsWith(name.slice(0, -1))
    : tool.functionName === name;
}

export type StackManifest = {
  manifestVersion: typeof STACK_MANIFEST_VERSION;
  label: string;
  make: {
    zone: MakeZone;
    teamId: number;
    hooks: { role: string; templateHookId: number }[];
    dataStores: ManifestDataStore[];
    scenarios: ManifestScenario[];
    connections: ManifestConnections;
    cfg: ManifestCfg | null;
  };
  vapi: {
    tools: ManifestTool[];
    /**
     * Template tools a clone does NOT get, each with the reason the card shows.
     * Named by id, or by the tool's function name (a trailing `*` matches a
     * prefix) where the template's own records give only the name.
     */
    excludedTools: ExcludedTool[];
    assistants: { templateAssistantId: string; role: string }[];
    squad: { templateSquadId: string } | null;
    /** The template's own name prefix, replaced by the clone's label. */
    namePrefix: string;
  };
  identity: {
    /** Words of the head's business that may not reach a tenant's agents. */
    denylist: string[];
  };
};

export type ManifestProblem = { path: string; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE = /^[a-z][a-z0-9_]{0,40}$/;
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Validate a manifest. Every problem, not the first: a template is edited by a
 * person, and a list is what lets them fix it in one pass.
 */
export function validateManifest(
  input: unknown,
): { ok: true; manifest: StackManifest } | { ok: false; problems: ManifestProblem[] } {
  const problems: ManifestProblem[] = [];
  const p = (path: string, message: string) => problems.push({ path, message });
  const m = input as StackManifest;
  if (!m || typeof m !== "object")
    return { ok: false, problems: [{ path: "", message: "not an object" }] };
  if (m.manifestVersion !== STACK_MANIFEST_VERSION)
    p("manifestVersion", `must be ${STACK_MANIFEST_VERSION}`);
  if (typeof m.label !== "string" || !m.label.trim()) p("label", "required");
  const mk = m.make;
  if (!mk || typeof mk !== "object") {
    p("make", "required");
  } else {
    if (!isMakeZone(mk.zone)) p("make.zone", "not a Make zone");
    if (!posInt(mk.teamId)) p("make.teamId", "must be a positive integer");
    const hookRoles = new Set<string>();
    const hookIds = new Set<number>();
    for (const [i, h] of (mk.hooks ?? []).entries()) {
      if (!ROLE.test(h?.role ?? "")) p(`make.hooks[${i}].role`, "not a role name");
      if (!posInt(h?.templateHookId))
        p(`make.hooks[${i}].templateHookId`, "must be a positive integer");
      if (hookRoles.has(h.role)) p(`make.hooks[${i}].role`, `"${h.role}" twice`);
      if (hookIds.has(h.templateHookId)) p(`make.hooks[${i}].templateHookId`, "named twice");
      hookRoles.add(h.role);
      hookIds.add(h.templateHookId);
    }
    const storeRoles = new Set<string>();
    let cfgStores = 0;
    for (const [i, s] of (mk.dataStores ?? []).entries()) {
      if (!ROLE.test(s?.role ?? "")) p(`make.dataStores[${i}].role`, "not a role name");
      if (!posInt(s?.templateStoreId))
        p(`make.dataStores[${i}].templateStoreId`, "must be a positive integer");
      if (s.records !== "none" && s.records !== "copy")
        p(`make.dataStores[${i}].records`, "none | copy");
      if (s.isCfg && s.records === "copy")
        p(
          `make.dataStores[${i}].records`,
          "the CFG store holds a secret and is never copied; it is composed",
        );
      if (s.isCfg) cfgStores += 1;
      if (storeRoles.has(s.role)) p(`make.dataStores[${i}].role`, `"${s.role}" twice`);
      storeRoles.add(s.role);
    }
    if (cfgStores > 1) p("make.dataStores", "at most one CFG store");
    const scenarioRoles = new Set<string>();
    const hooksUsed = new Set<string>();
    for (const [i, s] of (mk.scenarios ?? []).entries()) {
      if (!ROLE.test(s?.role ?? "")) p(`make.scenarios[${i}].role`, "not a role name");
      if (!posInt(s?.templateScenarioId))
        p(`make.scenarios[${i}].templateScenarioId`, "must be a positive integer");
      if (s.hookRole !== null && !hookRoles.has(s.hookRole))
        p(`make.scenarios[${i}].hookRole`, `no hook "${s.hookRole}"`);
      if (s.hookRole && hooksUsed.has(s.hookRole))
        p(`make.scenarios[${i}].hookRole`, `hook "${s.hookRole}" already starts another scenario`);
      if (s.hookRole) hooksUsed.add(s.hookRole);
      if (scenarioRoles.has(s.role)) p(`make.scenarios[${i}].role`, `"${s.role}" twice`);
      scenarioRoles.add(s.role);
    }
    if ((mk.scenarios ?? []).length === 0) p("make.scenarios", "at least one");
    const conns = mk.connections;
    if (!conns || typeof conns !== "object") {
      p("make.connections", "required");
    } else {
      const seen = new Set<number>();
      for (const [list, items] of [
        ["shared", conns.shared ?? []],
        ["tenantOwned", conns.tenantOwned ?? []],
      ] as const) {
        for (const [i, c] of items.entries()) {
          if (!posInt(c?.templateConnectionId))
            p(`make.connections.${list}[${i}].templateConnectionId`, "must be a positive integer");
          else if (seen.has(c.templateConnectionId))
            p(
              `make.connections.${list}[${i}]`,
              "named twice (a connection is shared OR the head's own)",
            );
          seen.add(c?.templateConnectionId);
          if (typeof c?.label !== "string" || !c.label.trim())
            p(`make.connections.${list}[${i}].label`, "required");
        }
      }
      for (const [app, sl] of Object.entries(conns.slotsByApp ?? {})) {
        if (!/^[a-z][a-z0-9-]{1,40}$/.test(app))
          p(`make.connections.slotsByApp.${app}`, "not a Make app name");
        if (!ROLE.test(sl?.slot ?? ""))
          p(`make.connections.slotsByApp.${app}.slot`, "not a slot name");
        if (sl?.appName !== app)
          p(`make.connections.slotsByApp.${app}.appName`, "must be the app it is keyed by");
        if (!posInt(sl?.appVersion) || !Array.isArray(sl?.appModules) || sl.appModules.length === 0)
          p(`make.connections.slotsByApp.${app}`, "names the version and modules to request");
        if (sl?.grantedBy !== "voice_automation" && sl?.grantedBy !== "stack")
          p(`make.connections.slotsByApp.${app}.grantedBy`, "voice_automation | stack");
      }
    }
    const cfg = mk.cfg;
    if (cfg) {
      const store = (mk.dataStores ?? []).find((s) => s.role === cfg.storeRole);
      if (!store) p("make.cfg.storeRole", `no data store "${cfg.storeRole}"`);
      else if (!store.isCfg) p("make.cfg.storeRole", "that store is not marked isCfg");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(cfg.key ?? "")) p("make.cfg.key", "not a record key");
      for (const [field, role] of Object.entries(cfg.hookUrls ?? {}))
        if (!hookRoles.has(role)) p(`make.cfg.hookUrls.${field}`, `no hook "${role}"`);
      for (const f of cfg.copyFields ?? [])
        if ((cfg.secretFields ?? []).includes(f) || (cfg.mintSecrets ?? []).includes(f))
          p("make.cfg.copyFields", `"${f}" is secret and is never read from the template`);
      if (cfg.assistantMapField && !(cfg.copyFields ?? []).includes(cfg.assistantMapField))
        p("make.cfg.assistantMapField", "must also be a copy field");
      for (const s of cfg.mintSecrets ?? [])
        if (!(cfg.secretFields ?? []).includes(s))
          p("make.cfg.mintSecrets", `"${s}" must also be listed as secret`);
      for (const [name, field] of Object.entries(cfg.secretPlaceholders ?? {})) {
        if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name))
          p(`make.cfg.secretPlaceholders.${name}`, "not a placeholder name");
        if (!(cfg.secretFields ?? []).includes(field))
          p(`make.cfg.secretPlaceholders.${name}`, `"${field}" must be a secret CFG field`);
      }
      if (cfg.ghlFields) {
        if (!(cfg.secretFields ?? []).includes(cfg.ghlFields.apiKey))
          p("make.cfg.ghlFields.apiKey", "the API key field must be secret");
      }
    }
  }
  const v = m.vapi;
  if (!v || typeof v !== "object") {
    p("vapi", "required");
  } else {
    const hookRoles = new Set((mk?.hooks ?? []).map((h) => h.role));
    const toolIds = new Set<string>();
    for (const [i, t] of (v.tools ?? []).entries()) {
      if (!UUID.test(t?.templateToolId ?? ""))
        p(`vapi.tools[${i}].templateToolId`, "not a Vapi id");
      if (t.hookRole !== null && !hookRoles.has(t.hookRole))
        p(`vapi.tools[${i}].hookRole`, `no hook "${t.hookRole}"`);
      if (toolIds.has(t.templateToolId)) p(`vapi.tools[${i}]`, "named twice");
      toolIds.add(t.templateToolId);
    }
    for (const [i, t] of (v.excludedTools ?? []).entries()) {
      if (t?.templateToolId !== undefined) {
        if (!UUID.test(t.templateToolId))
          p(`vapi.excludedTools[${i}].templateToolId`, "not a Vapi id");
        if (toolIds.has(t.templateToolId))
          p(`vapi.excludedTools[${i}]`, "both carried and excluded");
      } else if (!/^[a-zA-Z0-9_-]{2,64}\*?$/.test(t?.functionName ?? "")) {
        p(`vapi.excludedTools[${i}]`, "names a tool by id or by function name");
      }
      if (typeof t.reason !== "string" || t.reason.length < 10)
        p(`vapi.excludedTools[${i}].reason`, "say why");
    }
    const asst = new Set<string>();
    for (const [i, a] of (v.assistants ?? []).entries()) {
      if (!UUID.test(a?.templateAssistantId ?? ""))
        p(`vapi.assistants[${i}].templateAssistantId`, "not a Vapi id");
      if (!ROLE.test(a?.role ?? "")) p(`vapi.assistants[${i}].role`, "not a role name");
      if (asst.has(a.templateAssistantId)) p(`vapi.assistants[${i}]`, "named twice");
      asst.add(a.templateAssistantId);
    }
    if ((v.assistants ?? []).length === 0) p("vapi.assistants", "at least one");
    if (v.squad && !UUID.test(v.squad.templateSquadId ?? ""))
      p("vapi.squad.templateSquadId", "not a Vapi id");
    if (typeof v.namePrefix !== "string") p("vapi.namePrefix", "required (may be empty)");
  }
  const deny = m.identity?.denylist;
  if (!Array.isArray(deny) || deny.length === 0)
    p("identity.denylist", "at least one word of the head's business");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, manifest: m };
}

// ─── The gate ────────────────────────────────────────────────────────────

export type ProvisionFacts = {
  crmMode: CrmMode | null;
  isLineHead: boolean;
  conversionOpen: boolean;
  template: {
    crmMode: CrmMode;
    enabled: boolean;
    disabledReason: string | null;
    manifestValid: boolean;
  } | null;
  makeConfigured: boolean;
  aurixaVapiConfigured: boolean;
  encryptionEnabled: boolean;
  custodyActive: boolean;
  backendProjectRef: string | null;
  /** The dependent line's GHL credentials, as held. Null: none held. */
  ghl: { verified: boolean } | null;
};

export type ProvisionBlock = {
  code:
    | "crm_mode_unrecorded"
    | "clone_is_line_head"
    | "conversion_open"
    | "template_missing"
    | "template_disabled"
    | "template_invalid"
    | "make_not_configured"
    | "aurixa_vapi_not_configured"
    | "encryption_not_configured"
    | "vapi_org_not_active"
    | "no_backend"
    | "ghl_credentials_missing"
    | "ghl_credentials_unverified";
  message: string;
  requirement?: LineRequirement;
};

export function judgeStackProvision(f: ProvisionFacts): ProvisionBlock[] {
  const out: ProvisionBlock[] = [];
  if (!f.crmMode) {
    out.push({
      code: "crm_mode_unrecorded",
      message: "The clone's CRM line is not recorded, so neither stack can be chosen for it.",
    });
    return out;
  }
  if (f.isLineHead)
    out.push({
      code: "clone_is_line_head",
      message:
        "This clone heads its line: its stack IS the template every other clone on the line is copied from, so it is never rebuilt from itself.",
    });
  if (f.conversionOpen)
    out.push({
      code: "conversion_open",
      message:
        "A CRM conversion is in flight. The stack waits for it to finish, so it is built for the line the clone ends up on.",
    });
  if (!f.template)
    out.push({
      code: "template_missing",
      message: `No voice stack template is registered for the ${f.crmMode} line.`,
    });
  else if (!f.template.manifestValid)
    out.push({
      code: "template_invalid",
      message: `The ${f.crmMode} line's template does not validate.`,
    });
  else if (!f.template.enabled)
    out.push({
      code: "template_disabled",
      message: f.template.disabledReason ?? `The ${f.crmMode} line's template is switched off.`,
    });
  if (!f.makeConfigured)
    out.push({
      code: "make_not_configured",
      message: "MAKE_API_TOKEN is not set on Mission Control.",
    });
  if (!f.aurixaVapiConfigured)
    out.push({
      code: "aurixa_vapi_not_configured",
      message:
        "VAPI_API_KEY is not set on Mission Control, so the template's assistants cannot be read.",
    });
  if (!f.encryptionEnabled)
    out.push({
      code: "encryption_not_configured",
      message:
        "CREDENTIALS_ENC_KEY is not set on Mission Control, so no secret this stack mints can be held.",
    });
  if (!f.custodyActive)
    out.push({
      code: "vapi_org_not_active",
      message:
        "The clone's own Vapi organisation is not active yet (its custody steps say what is open).",
      requirement: "vapi_org",
    });
  if (!f.backendProjectRef)
    out.push({
      code: "no_backend",
      message:
        "The clone has no Supabase project recorded, so its agents have no Call Logs page to report to.",
      requirement: "call_log_target",
    });
  if (f.crmMode === "dependent") {
    if (!f.ghl)
      out.push({
        code: "ghl_credentials_missing",
        message:
          "A CRM-dependent stack talks to the tenant's own GoHighLevel. Its API key and location are required before anything is built.",
        requirement: "ghl_api_key",
      });
    else if (!f.ghl.verified)
      out.push({
        code: "ghl_credentials_unverified",
        message: "The GoHighLevel key has not been verified against its location yet.",
        requirement: "ghl_location",
      });
  }
  return out;
}

// ─── The seeds (one per line), as registered by the migration ────────────

/** Aurixa's own Vapi org — the template assistants' org, and never a tenant's. */
export const AURIXA_VAPI_ORG_ID = "453f00c2-cb26-43f0-8da3-2eb13b578e15";

const NPC_DENYLIST = [
  "Naidu",
  "NPC",
  "npcservices",
  "npcservices.com.au",
  "Naidu Property Consulting",
  "NPC Services",
];

/**
 * The CRM-INDEPENDENT line: the stack built for NPC CRM Independent on
 * 9 Oct 2026 (the clone repository's `voice-agents/crm-independent/HANDOFF.md`
 * §00.1), every id read back from Make and Vapi at the time.
 */
export const INDEPENDENT_TEMPLATE_SEED: StackManifest = {
  manifestVersion: 1,
  label: "NPC CRM Independent — native stack",
  make: {
    zone: "us2",
    teamId: 2731020,
    hooks: [
      { role: "adapter", templateHookId: 2911007 },
      { role: "availability", templateHookId: 2911143 },
      { role: "resolve_contact", templateHookId: 2911144 },
      { role: "get_call_context", templateHookId: 2911145 },
      { role: "context_inject", templateHookId: 2911146 },
      { role: "create_booking", templateHookId: 2911147 },
      { role: "manage_booking", templateHookId: 2911148 },
      { role: "notifier", templateHookId: 2911149 },
      { role: "loader", templateHookId: 2911176 },
    ],
    dataStores: [
      { role: "cfg", templateStoreId: 168061, records: "none", isCfg: true },
      { role: "contacts", templateStoreId: 168062, records: "none" },
      { role: "call_context", templateStoreId: 168063, records: "none" },
      { role: "bookings", templateStoreId: 168064, records: "none" },
      { role: "code_library", templateStoreId: 168112, records: "copy" },
    ],
    scenarios: [
      { role: "adapter", templateScenarioId: 6561418, hookRole: "adapter" },
      { role: "loader", templateScenarioId: 6561648, hookRole: "loader" },
      { role: "notifier", templateScenarioId: 6570895, hookRole: "notifier" },
      { role: "availability", templateScenarioId: 6561680, hookRole: "availability" },
      { role: "resolve_contact", templateScenarioId: 6570898, hookRole: "resolve_contact" },
      { role: "get_call_context", templateScenarioId: 6570904, hookRole: "get_call_context" },
      { role: "context_inject", templateScenarioId: 6570912, hookRole: "context_inject" },
      { role: "create_booking", templateScenarioId: 6570921, hookRole: "create_booking" },
      { role: "manage_booking", templateScenarioId: 6570940, hookRole: "manage_booking" },
    ],
    connections: {
      shared: [
        { templateConnectionId: 10496826, label: "Aurixa OpenAI (availability classifier)" },
      ],
      tenantOwned: [
        { templateConnectionId: 10496840, label: "The head's Outlook mailbox (property@)" },
        {
          templateConnectionId: 10770538,
          label: "The head's Google placeholder (Sheets, no calendar scope)",
        },
      ],
      slotsByApp: {
        "microsoft-calendar": {
          slot: "outlook_calendar",
          appName: "microsoft-calendar",
          appVersion: 2,
          appModules: ["makeApiCall"],
          label: "Outlook calendar",
          grantedBy: "voice_automation",
        },
        "google-calendar": {
          slot: "google_calendar",
          appName: "google-calendar",
          appVersion: 5,
          appModules: ["makeApiCall"],
          label: "Google Calendar",
          grantedBy: "voice_automation",
        },
        "microsoft-email": {
          slot: "outlook_mail",
          appName: "microsoft-email",
          appVersion: 2,
          appModules: ["createAndSendAMessage"],
          label: "Outlook mailbox",
          grantedBy: "voice_automation",
        },
        "google-email": {
          slot: "gmail",
          appName: "google-email",
          appVersion: 4,
          appModules: ["sendAnEmail"],
          label: "Gmail mailbox",
          grantedBy: "voice_automation",
        },
      },
    },
    cfg: {
      storeRole: "cfg",
      key: "default",
      mintSecrets: ["adapter_secret"],
      hookUrls: { adapter_url: "adapter", notifier_url: "notifier" },
      copyFields: ["outbound_assistants"],
      assistantMapField: "outbound_assistants",
      secretFields: ["adapter_secret"],
      secretPlaceholders: {},
      ghlFields: null,
    },
  },
  vapi: {
    tools: [
      { templateToolId: "9cf05400-00e4-40ed-98e3-7ae7fbe14346", hookRole: "availability" },
      { templateToolId: "8097aa3c-cb72-4e7b-9f6a-1b788f990f05", hookRole: "create_booking" },
      { templateToolId: "4b59270b-a240-44ae-bce9-6aaf7b3a1672", hookRole: "resolve_contact" },
      { templateToolId: "532347a9-b7f6-4e5d-ab38-76bd80419a35", hookRole: "get_call_context" },
      { templateToolId: "3c5449c7-36ec-4ebb-8d1b-eec481d1b9ea", hookRole: "context_inject" },
      { templateToolId: "70f3d5b3-fc62-42d0-854e-7c21b9319e2d", hookRole: "manage_booking" },
      { templateToolId: "838edbad-fc35-444b-865f-64b622af0121", hookRole: null },
    ],
    excludedTools: [
      {
        templateToolId: "bf4b9260-0168-4beb-8a1b-52b5c4788f15",
        reason:
          "transfer_to_human redirects a Twilio call through a scenario and store shared with NPC's production; a clone gets one with its own number (OPEN_QUESTIONS C3).",
      },
    ],
    assistants: [
      { templateAssistantId: "215286a3-0dcf-47a0-a845-5d6c2b0134d8", role: "inbound" },
      {
        templateAssistantId: "23d3cdb3-afbf-46ed-b71f-7b55e2947dcc",
        role: "opt_in_follow_up_inbound",
      },
      {
        templateAssistantId: "f08a7b8f-d687-45ab-8a19-d3e4efc054eb",
        role: "strategy_session_inbound",
      },
      { templateAssistantId: "598e8e6f-16de-432a-bdd7-6b1e89bb708e", role: "ifc_inbound" },
      {
        templateAssistantId: "cae508c6-3654-4b58-a900-c0425761053e",
        role: "strategy_session_no_show",
      },
      {
        templateAssistantId: "36c6f565-d0a7-4f90-8097-70159182e354",
        role: "strategy_session_follow_up",
      },
      { templateAssistantId: "be073b09-3cf2-4beb-a0f9-edf9c41ec058", role: "quiz_follow_up" },
      { templateAssistantId: "4045cabf-eec4-4deb-a4a7-2a5a289ba351", role: "opt_in_follow_up" },
      { templateAssistantId: "07d477e4-5a17-4e7f-b082-fed89b46710d", role: "ifc_no_show" },
      { templateAssistantId: "4c2831e2-d56d-48d5-a7a4-8fd92ed20b69", role: "ifc_follow_up" },
      { templateAssistantId: "a39ecd07-a23a-49eb-a3ad-7674efeafe71", role: "discovery_no_show" },
      { templateAssistantId: "f64f39e0-e016-409f-8cca-aeb754074de8", role: "discovery_follow_up" },
      { templateAssistantId: "a46ad64d-59c7-4b6e-9f1c-850baa8c715e", role: "active_nurturing" },
    ],
    squad: { templateSquadId: "da489d4c-3795-4a4d-a9ce-3afae8bc6377" },
    namePrefix: "NPC CI ",
  },
  identity: { denylist: NPC_DENYLIST },
};

/**
 * The CRM-DEPENDENT line: NPC's GoHighLevel stack — the org-B copies of
 * NPC's assistants (cloned from org A on 18 Aug 2026) and the GoHighLevel
 * scenarios their tools call (HANDOFF.md §01 "Source GHL Make scenarios").
 *
 * Registered DISABLED, with the reason it cannot yet be copied faithfully: its
 * booking scenario (5978179) carries an unresolved private-token placeholder
 * and no CFG reader, and every run of it errored (OPEN_QUESTIONS C1). Its
 * delete-event scenarios are invalid and are not carried (C2). Everything
 * else — the per-clone org, the GHL key gate, the OAuth grant for Make's
 * GoHighLevel modules, the copy and the line switch — is built and tested.
 */
export const DEPENDENT_TEMPLATE_SEED: StackManifest = {
  manifestVersion: 1,
  label: "NPC — GoHighLevel stack",
  make: {
    zone: "us2",
    teamId: 2731020,
    hooks: [
      { role: "availability", templateHookId: 2704985 },
      { role: "create_booking", templateHookId: 2704984 },
      { role: "resolve_contact", templateHookId: 2705107 },
      { role: "get_call_context", templateHookId: 2705106 },
      { role: "context_inject", templateHookId: 2704945 },
    ],
    dataStores: [{ role: "ghl_contact_ids", templateStoreId: 133627, records: "none" }],
    scenarios: [
      { role: "availability", templateScenarioId: 5978159, hookRole: "availability" },
      { role: "create_booking", templateScenarioId: 5978179, hookRole: "create_booking" },
      { role: "resolve_contact", templateScenarioId: 5978434, hookRole: "resolve_contact" },
      { role: "get_call_context", templateScenarioId: 5978425, hookRole: "get_call_context" },
      { role: "context_inject", templateScenarioId: 5978051, hookRole: "context_inject" },
    ],
    connections: {
      shared: [],
      tenantOwned: [
        { templateConnectionId: 10496865, label: "The head's GoHighLevel location (NPC)" },
      ],
      slotsByApp: {
        highlevel: {
          slot: "ghl",
          appName: "highlevel",
          appVersion: 1,
          appModules: ["searchContacts", "createAContact"],
          label: "GoHighLevel location",
          grantedBy: "stack",
        },
      },
    },
    cfg: null,
  },
  vapi: {
    tools: [
      { templateToolId: "3d407940-f697-404c-a6d4-0137e79a0d9f", hookRole: "availability" },
      { templateToolId: "7d6b6d41-0059-44a9-a9c5-fdc0c8c6d218", hookRole: "create_booking" },
      { templateToolId: "05dd96f7-12e5-4d24-85dc-c2c43172bd1e", hookRole: "resolve_contact" },
      { templateToolId: "2c726b9d-bcd5-4334-b1a2-0e871554d9f9", hookRole: "get_call_context" },
      { templateToolId: "76dad303-a7fa-4e61-b933-c365b721b0cf", hookRole: "context_inject" },
      { templateToolId: "838edbad-fc35-444b-865f-64b622af0121", hookRole: null },
    ],
    excludedTools: [
      {
        templateToolId: "bf4b9260-0168-4beb-8a1b-52b5c4788f15",
        reason:
          "transfer_to_human redirects a Twilio call through a scenario and store shared with NPC's production; a clone gets one with its own number (OPEN_QUESTIONS C3).",
      },
      {
        functionName: "ghl_delete_event_npc*",
        reason:
          "The five GoHighLevel delete-event tools call scenarios that are inactive, marked invalid, and only ever emailed the admin; a dependent clone sends cancellations to a person (OPEN_QUESTIONS C2).",
      },
    ],
    assistants: [
      { templateAssistantId: "b834610e-469e-4f9f-9130-01a1fa751064", role: "inbound" },
      {
        templateAssistantId: "fdb1ecde-e884-4650-abd3-8c19a2a006dd",
        role: "opt_in_follow_up_inbound",
      },
      {
        templateAssistantId: "f958ec93-6f41-4507-a7b1-f8c8d54e775e",
        role: "strategy_session_inbound",
      },
      { templateAssistantId: "ed0aa90f-e5ea-439d-b086-f694cf5f978d", role: "ifc_inbound" },
      {
        templateAssistantId: "5aa70a8e-01fb-4bcb-b275-6822b4e7e3da",
        role: "strategy_session_no_show",
      },
      {
        templateAssistantId: "f8abe39e-0944-4a53-afa6-95ac1852f892",
        role: "strategy_session_follow_up",
      },
      { templateAssistantId: "044329e5-4709-49f9-81f7-d1e25ea28213", role: "quiz_follow_up" },
      { templateAssistantId: "9b4f7438-35b1-4d87-809a-03e56c2f9144", role: "opt_in_follow_up" },
      { templateAssistantId: "209964e0-9b0c-48b1-a190-9b462de21462", role: "ifc_no_show" },
      { templateAssistantId: "55685df0-3ab8-4b8b-8695-6640e4e06fc1", role: "ifc_follow_up" },
      { templateAssistantId: "9013efd8-c662-4466-99f9-bb9597b44cfb", role: "discovery_no_show" },
      { templateAssistantId: "d3f63417-ffdc-4505-91e8-f6ad6cd9841d", role: "discovery_follow_up" },
      { templateAssistantId: "66d3e994-32c4-4d38-90af-2351078ad0f7", role: "active_nurturing" },
    ],
    squad: { templateSquadId: "13c37e4c-3289-4d0f-98f2-b16e2258c945" },
    namePrefix: "NPC ",
  },
  identity: { denylist: NPC_DENYLIST },
};

export const DEPENDENT_TEMPLATE_DISABLED_REASON =
  "The GoHighLevel booking template (Make 5978179) carries an unresolved private-token placeholder and no CFG reader, and every run of it errored. A dependent clone's stack is built once that template reads the stack's CFG (OPEN_QUESTIONS.md C1).";
