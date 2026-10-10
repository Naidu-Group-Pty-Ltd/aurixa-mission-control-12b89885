/**
 * Copying one of a line head's Make scenarios into a tenant's stack — the
 * rewrite, and the refusal of anything it could not account for. No I/O.
 *
 * ## What a scenario names that is not its own
 *
 * A Make blueprint refers to the world four ways, and every one of them points
 * at the HEAD's objects until it is rewritten:
 *
 *   - `parameters.hook`        the webhook that triggers it;
 *   - `parameters.datastore`   every data store it reads or writes;
 *   - `parameters.__IMTCONN__` every account it acts through;
 *   - strings anywhere         hook URLs it calls, and `{{SECRET:NAME}}`
 *                              placeholders standing in for a credential.
 *
 * Each is rewritten from a map, and each rewrite is total or the scenario is
 * held: a template id left in a tenant's copy is a tenant's agent writing into
 * the head's business, which reads, from the tenant's side, exactly like a
 * working agent. After the rewrite `findTemplateResidue` reads the result
 * again for every template id and URL, independently of the rewrite, so a gap
 * in the rewrite cannot also be a gap in the check.
 *
 * ## Connections are re-bound by APP
 *
 * A connection the template marks shared (Aurixa's own platform account) is
 * kept. One the template marks as the head's own is never kept: the module is
 * re-bound to the clone's grant for that module's APP, or left unbound and
 * reported as waiting (`awaitingSlots`). Never by the template connection's id
 * — the head binds its mail connection into a calendar module.
 *
 * ## Credentials never become text
 *
 * A `{{SECRET:NAME}}` placeholder is replaced by a reference to the stack's
 * own CFG record (`{{<reader>.<field>}}`), read at run time by the scenario's
 * existing `datastore:GetRecord` of that record. A scenario with no such
 * reader is held, never given the credential as a literal: a blueprint is
 * exported, logged and shown in Make's designer, and a token in one is the
 * hardcoded key the head's old launcher still carries (OPEN_QUESTIONS C1).
 *
 * Pure: every function returns new data; the input is never mutated.
 */

import type { Blueprint, BlueprintModule } from "./voiceAutomationBlueprint.pure";
import type { ManifestConnections } from "./voiceStackTemplate.pure";

// ─── Walking a blueprint ─────────────────────────────────────────────────

/** Every module, depth first, routes and error handlers included. */
export function allModules(bp: Blueprint): BlueprintModule[] {
  const out: BlueprintModule[] = [];
  const walk = (flow: BlueprintModule[] | undefined) => {
    for (const m of flow ?? []) {
      out.push(m);
      for (const r of m.routes ?? []) walk(r.flow);
      if (Array.isArray(m.onerror)) walk(m.onerror);
    }
  };
  walk(bp.flow);
  return out;
}

const HOOK_URL = /https:\/\/hook\.[a-z0-9]+\.make\.com\/[A-Za-z0-9]+/g;
const SECRET_PLACEHOLDER = /\{\{\s*SECRET:([A-Za-z0-9_]+)\s*\}\}/g;

/** Every string in a value, with a function to replace it. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

function eachString(value: unknown, fn: (s: string) => void): void {
  mapStrings(value, (s) => {
    fn(s);
    return s;
  });
}

export type BlueprintRefs = {
  hookIds: number[];
  dataStoreIds: number[];
  connectionIds: number[];
  /** `__IMT*` parameters other than connections (keys, keychains): never carried. */
  otherImtRefs: { moduleId: number; parameter: string }[];
  hookUrls: string[];
  secretPlaceholders: string[];
  /** The Make app of each module that acts through a connection, by connection id. */
  appsByConnection: Record<number, string[]>;
  /** Make modules per app (for a credential request covering every module used). */
  modulesByApp: Record<string, string[]>;
};

export function appOf(module: string): string {
  const i = module.indexOf(":");
  return i < 0 ? module : module.slice(0, i);
}

export function collectBlueprintRefs(bp: Blueprint): BlueprintRefs {
  const hooks = new Set<number>();
  const stores = new Set<number>();
  const conns = new Set<number>();
  const other: { moduleId: number; parameter: string }[] = [];
  const urls = new Set<string>();
  const secrets = new Set<string>();
  const appsByConnection: Record<number, Set<string>> = {};
  const modulesByApp: Record<string, Set<string>> = {};
  for (const m of allModules(bp)) {
    const params = (m.parameters ?? {}) as Record<string, unknown>;
    if (typeof params.hook === "number") hooks.add(params.hook);
    if (typeof params.datastore === "number") stores.add(params.datastore);
    for (const [k, v] of Object.entries(params)) {
      if (k === "__IMTCONN__") {
        if (typeof v === "number") {
          conns.add(v);
          (appsByConnection[v] ??= new Set()).add(appOf(m.module));
          (modulesByApp[appOf(m.module)] ??= new Set()).add(
            m.module.slice(m.module.indexOf(":") + 1),
          );
        }
      } else if (k.startsWith("__IMT") && v !== null && v !== undefined && v !== "") {
        other.push({ moduleId: m.id, parameter: k });
      }
    }
    eachString({ mapper: m.mapper, filter: m.filter, parameters: m.parameters }, (s) => {
      for (const u of s.matchAll(HOOK_URL)) urls.add(u[0]);
      for (const p of s.matchAll(SECRET_PLACEHOLDER)) secrets.add(p[1]);
    });
  }
  return {
    hookIds: [...hooks].sort((a, b) => a - b),
    dataStoreIds: [...stores].sort((a, b) => a - b),
    connectionIds: [...conns].sort((a, b) => a - b),
    otherImtRefs: other,
    hookUrls: [...urls].sort(),
    secretPlaceholders: [...secrets].sort(),
    appsByConnection: Object.fromEntries(
      Object.entries(appsByConnection).map(([k, v]) => [k, [...v].sort()]),
    ),
    modulesByApp: Object.fromEntries(
      Object.entries(modulesByApp).map(([k, v]) => [k, [...v].sort()]),
    ),
  };
}

/** The module id of the `datastore:GetRecord` that reads `key` from `storeId`, if the scenario has one. */
export function findCfgReader(bp: Blueprint, storeId: number, key: string): number | null {
  for (const m of allModules(bp)) {
    if (m.module !== "datastore:GetRecord") continue;
    const params = (m.parameters ?? {}) as Record<string, unknown>;
    const mapper = (m.mapper ?? {}) as Record<string, unknown>;
    if (params.datastore === storeId && mapper.key === key) return m.id;
  }
  return null;
}

// ─── The rewrite ─────────────────────────────────────────────────────────

export type RewriteProblem = {
  code:
    | "unmapped_hook"
    | "unmapped_data_store"
    | "undeclared_connection"
    | "no_slot_for_app"
    | "undeclared_reference"
    | "unmapped_hook_url"
    | "undeclared_secret_placeholder"
    | "secret_placeholder_without_cfg_reader";
  moduleId: number | null;
  detail: string;
};

export type RewriteContext = {
  /** The name the clone's copy is created under. */
  name: string;
  hooks: ReadonlyMap<number, number>;
  dataStores: ReadonlyMap<number, number>;
  hookUrls: ReadonlyMap<string, string>;
  connections: ManifestConnections;
  /** The clone's own grants, by slot. A slot with no grant leaves its modules unbound. */
  clonesConnections: Readonly<Record<string, number | undefined>>;
  /** `{{SECRET:NAME}}` → the CFG field the clone's value lives in. */
  secretPlaceholders: Readonly<Record<string, string>>;
  /** The TEMPLATE's CFG store and key, to find the scenario's own reader. */
  cfg: { templateStoreId: number; key: string } | null;
};

export type RewriteResult = {
  blueprint: Blueprint;
  problems: RewriteProblem[];
  /** Slots this scenario's modules wait on (unbound until the clone's grant exists). */
  awaitingSlots: string[];
  /** Shared connections kept, named so the build report can say so. */
  sharedKept: number[];
};

export function rewriteScenario(template: Blueprint, ctx: RewriteContext): RewriteResult {
  const bp = JSON.parse(JSON.stringify(template)) as Blueprint;
  const problems: RewriteProblem[] = [];
  const awaiting = new Set<string>();
  const sharedKept = new Set<number>();
  const shared = new Set(ctx.connections.shared.map((c) => c.templateConnectionId));
  const owned = new Set(ctx.connections.tenantOwned.map((c) => c.templateConnectionId));

  const reader = ctx.cfg ? findCfgReader(template, ctx.cfg.templateStoreId, ctx.cfg.key) : null;

  for (const m of allModules(bp)) {
    const params = (m.parameters ?? null) as Record<string, unknown> | null;
    if (params) {
      if (typeof params.hook === "number") {
        const to = ctx.hooks.get(params.hook);
        if (to) params.hook = to;
        else
          problems.push({ code: "unmapped_hook", moduleId: m.id, detail: `hook ${params.hook}` });
      }
      if (typeof params.datastore === "number") {
        const to = ctx.dataStores.get(params.datastore);
        if (to) params.datastore = to;
        else
          problems.push({
            code: "unmapped_data_store",
            moduleId: m.id,
            detail: `data store ${params.datastore}`,
          });
      }
      if (typeof params.__IMTCONN__ === "number") {
        const id = params.__IMTCONN__;
        const app = appOf(m.module);
        if (shared.has(id)) {
          sharedKept.add(id);
        } else if (owned.has(id)) {
          const slot = ctx.connections.slotsByApp[app];
          if (!slot) {
            problems.push({
              code: "no_slot_for_app",
              moduleId: m.id,
              detail: `${m.module} acts through the head's connection ${id} and no tenant grant is declared for app "${app}"`,
            });
          } else {
            const own = ctx.clonesConnections[slot.slot];
            if (typeof own === "number" && own > 0) params.__IMTCONN__ = own;
            else {
              delete params.__IMTCONN__;
              awaiting.add(slot.slot);
            }
          }
        } else {
          problems.push({
            code: "undeclared_connection",
            moduleId: m.id,
            detail: `${m.module} acts through connection ${id}, which the template declares neither shared nor the head's own`,
          });
        }
      }
      for (const [k, v] of Object.entries(params)) {
        if (
          k !== "__IMTCONN__" &&
          k.startsWith("__IMT") &&
          v !== null &&
          v !== undefined &&
          v !== ""
        )
          problems.push({
            code: "undeclared_reference",
            moduleId: m.id,
            detail: `${m.module} parameter ${k}`,
          });
      }
    }

    const rewriteString = (s: string): string => {
      let out = s.replace(HOOK_URL, (url) => {
        const to = ctx.hookUrls.get(url);
        if (to) return to;
        problems.push({ code: "unmapped_hook_url", moduleId: m.id, detail: url });
        return url;
      });
      out = out.replace(SECRET_PLACEHOLDER, (whole, name: string) => {
        const field = ctx.secretPlaceholders[name];
        if (!field) {
          problems.push({ code: "undeclared_secret_placeholder", moduleId: m.id, detail: name });
          return whole;
        }
        if (reader === null) {
          problems.push({
            code: "secret_placeholder_without_cfg_reader",
            moduleId: m.id,
            detail: `${name} would have to be written into the blueprint as text; the scenario does not read the stack's CFG record`,
          });
          return whole;
        }
        return `{{${reader}.${field}}}`;
      });
      return out;
    };
    if (m.mapper !== undefined)
      m.mapper = mapStrings(m.mapper, rewriteString) as Record<string, unknown> | null;
    if (m.filter !== undefined) m.filter = mapStrings(m.filter, rewriteString);
    if (m.parameters)
      m.parameters = mapStrings(m.parameters, rewriteString) as Record<string, unknown>;
  }

  bp.name = ctx.name;
  return {
    blueprint: bp,
    problems: dedupeProblems(problems),
    awaitingSlots: [...awaiting].sort(),
    sharedKept: [...sharedKept].sort((a, b) => a - b),
  };
}

function dedupeProblems(ps: RewriteProblem[]): RewriteProblem[] {
  const seen = new Set<string>();
  return ps.filter((p) => {
    const k = `${p.code}|${p.moduleId}|${p.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ─── The independent check ───────────────────────────────────────────────

export type TemplateIdentity = {
  hookIds: readonly number[];
  dataStoreIds: readonly number[];
  /** The head's own connections: shared ones are allowed and not listed here. */
  tenantOwnedConnectionIds: readonly number[];
  hookUrls: readonly string[];
};

export type Residue = {
  kind: "hook" | "data_store" | "connection" | "hook_url" | "secret_placeholder";
  detail: string;
};

/**
 * Read a rewritten blueprint for anything of the template's. Deliberately not
 * the rewrite's own bookkeeping: it walks the result fresh, so a rewrite that
 * forgot a parameter is caught here rather than trusted.
 */
export function findTemplateResidue(bp: Blueprint, t: TemplateIdentity): Residue[] {
  const refs = collectBlueprintRefs(bp);
  const out: Residue[] = [];
  for (const h of refs.hookIds)
    if (t.hookIds.includes(h)) out.push({ kind: "hook", detail: String(h) });
  for (const d of refs.dataStoreIds)
    if (t.dataStoreIds.includes(d)) out.push({ kind: "data_store", detail: String(d) });
  for (const c of refs.connectionIds)
    if (t.tenantOwnedConnectionIds.includes(c)) out.push({ kind: "connection", detail: String(c) });
  for (const u of refs.hookUrls)
    if (t.hookUrls.includes(u)) out.push({ kind: "hook_url", detail: u });
  for (const s of refs.secretPlaceholders) out.push({ kind: "secret_placeholder", detail: s });
  return out;
}

// ─── The CFG record a tenant's stack starts with ─────────────────────────

/**
 * Compose the CFG record for a tenant's stack. The template's record is never
 * copied — it holds the head's secret — so the record is BUILT: the managed
 * settings (from voice automation's own compiler), the secrets minted for this
 * clone, the URLs of this clone's own hooks, the non-secret fields carried
 * from the template (with any assistant ids remapped), and, on the dependent
 * line, the tenant's GoHighLevel key and location.
 */
export function composeCfgRecord(input: {
  managed: Record<string, unknown>;
  minted: Record<string, string>;
  hookUrlFields: Record<string, string>;
  carried: Record<string, unknown>;
  assistantMapField: string | null;
  assistantIds: ReadonlyMap<string, string>;
  ghl: Record<string, string> | null;
  updatedAt: string;
}): { record: Record<string, unknown>; unmappedAssistants: string[] } {
  const record: Record<string, unknown> = { ...input.managed };
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(input.carried)) {
    if (input.assistantMapField && k === input.assistantMapField) {
      record[k] = remapAssistantValues(v, input.assistantIds, unmapped);
    } else {
      record[k] = v;
    }
  }
  Object.assign(record, input.hookUrlFields, input.minted, input.ghl ?? {});
  record.updated_at = input.updatedAt;
  return { record, unmappedAssistants: [...new Set(unmapped)].sort() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function remapAssistantValues(
  v: unknown,
  ids: ReadonlyMap<string, string>,
  unmapped: string[],
): unknown {
  if (typeof v === "string") {
    // The CFG map is stored as text in Make; its values are assistant ids.
    if (UUID.test(v)) {
      const to = ids.get(v.toLowerCase());
      if (!to) unmapped.push(v);
      return to ?? "";
    }
    const trimmed = v.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.stringify(remapAssistantValues(JSON.parse(trimmed), ids, unmapped));
      } catch {
        return v;
      }
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => remapAssistantValues(x, ids, unmapped));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = remapAssistantValues(x, ids, unmapped);
    return out;
  }
  return v;
}

/** A scenario's name in a tenant's stack: the clone's label, then the role. */
export function scenarioNameFor(cloneLabel: string, roleTitle: string): string {
  const label = cloneLabel.replace(/\s+/g, " ").trim().slice(0, 60) || "Clone";
  return `${label} - voice - ${roleTitle}`.slice(0, 120);
}
