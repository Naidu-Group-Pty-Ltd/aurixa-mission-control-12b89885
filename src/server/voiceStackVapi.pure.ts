/**
 * Copying a line head's Vapi agents into a tenant's own org — the payloads,
 * and the refusal of anything that would carry the head with them. No I/O.
 *
 * ## What an assistant names that is not its own
 *
 * A Vapi object names other objects by id, and every id is scoped to the ORG
 * it was created in: a tool id, a knowledge-base file id, a structured output,
 * a scorecard, a credential. In a tenant's org none of the head's ids resolve,
 * and a payload carrying one is refused by Vapi at best and, where Vapi does
 * not check, binds an assistant to nothing. So every id is remapped from what
 * this build created in the clone's org, or the payload is held with the path
 * of the id named. Credential ids are never carried: a tenant's org holds its
 * own (the call-log credential is created there).
 *
 * ## Where the calls go
 *
 * Every function tool's `server.url` is one of the head's Make hooks; in a
 * tenant's copy it becomes the clone's hook for the same role, and a URL the
 * manifest does not name holds the tool. Every assistant reports its calls to
 * the CLONE's own `vapi-call-webhook`, through the credential created in the
 * clone's org — never the head's server block, which carries the prime's
 * webhook secret.
 *
 * ## Whose business the agents speak for
 *
 * The head's prompts introduce the head's business. A tenant's copy is given
 * the operator's replacements (business name, site, number) and then read
 * again for every word on the template's deny-list; one remaining word holds
 * the assistant. Substitution never touches an id, a URL, a model, a voice or
 * an enum: only prose.
 *
 * Pure: tested beside it.
 */

export type VapiObject = Record<string, unknown>;

/** Fields Vapi owns on every object; never sent back on a create. */
const SERVER_MANAGED = new Set([
  "id",
  "orgId",
  "createdAt",
  "updatedAt",
  "isServerUrlSecretSet",
  "isDeleted",
]);

/** Keys whose string values are never prose, so never substituted or deny-listed. */
const NOT_PROSE = new Set([
  "id",
  "orgId",
  "url",
  "provider",
  "model",
  "voiceId",
  "type",
  "role",
  "language",
  "name", // a function name the prompts call; assistant/squad names are renamed separately
  "assistantName",
  "credentialId",
  "toolId",
  "fileId",
  "squadId",
  "assistantId",
  "phoneNumberId",
  "structuredOutputId",
  "scorecardId",
  "endpoint",
  "method",
  "headerName",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObj(v: unknown): v is VapiObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function stripManaged(o: VapiObject): VapiObject {
  const out: VapiObject = {};
  for (const [k, v] of Object.entries(o)) if (!SERVER_MANAGED.has(k)) out[k] = v;
  return out;
}

// ─── Identity ────────────────────────────────────────────────────────────

export type Replacement = { from: string; to: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A short alphabetic term ("NPC") is matched as a whole word; anything else as a substring. */
function termRegex(term: string, flags = "gi"): RegExp {
  const t = term.trim();
  return /^[A-Za-z]{2,6}$/.test(t)
    ? new RegExp(`\\b${escapeRe(t)}\\b`, flags)
    : new RegExp(escapeRe(t), flags);
}

export function validateReplacements(
  list: unknown,
  denylist: readonly string[],
): { ok: true; replacements: Replacement[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(list))
    return { ok: false, problems: ["replacements must be a list of { from, to }"] };
  const out: Replacement[] = [];
  const seen = new Set<string>();
  for (const [i, r] of list.entries()) {
    const from = typeof r?.from === "string" ? r.from.trim() : "";
    const to = typeof r?.to === "string" ? r.to.trim() : "";
    if (from.length < 2) problems.push(`#${i + 1}: "from" must be at least two characters`);
    if (to.length > 200) problems.push(`#${i + 1}: "to" is too long`);
    if (/[{}<>]/.test(to))
      problems.push(`#${i + 1}: "to" may not contain braces or angle brackets`);
    const found = findDenylisted(to, denylist);
    if (found.length > 0) problems.push(`#${i + 1}: "to" still contains ${found.join(", ")}`);
    const key = from.toLowerCase();
    if (seen.has(key)) problems.push(`#${i + 1}: "${from}" is replaced twice`);
    seen.add(key);
    if (from.length >= 2) out.push({ from, to });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, replacements: out };
}

/** Apply replacements longest-first, so "NPC Services" is replaced before "NPC". */
export function applyReplacements(text: string, replacements: readonly Replacement[]): string {
  const ordered = [...replacements].sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of ordered) out = out.replace(termRegex(r.from), () => r.to);
  return out;
}

export function findDenylisted(text: string, denylist: readonly string[]): string[] {
  const hits: string[] = [];
  for (const term of denylist) if (term.trim() && termRegex(term, "i").test(text)) hits.push(term);
  return hits;
}

/** Every prose string in a value, rewritten. Keys in NOT_PROSE and every UUID are left alone. */
export function substituteProse(
  value: unknown,
  fn: (s: string) => string,
  key: string | null = null,
): unknown {
  if (typeof value === "string") {
    if (key !== null && NOT_PROSE.has(key)) return value;
    if (UUID.test(value) || /^https?:\/\//.test(value)) return value;
    return fn(value);
  }
  if (Array.isArray(value)) return value.map((v) => substituteProse(v, fn, key));
  if (isObj(value)) {
    const out: VapiObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteProse(v, fn, k);
    return out;
  }
  return value;
}

export type DenyResidue = { path: string; term: string };

/** Every deny-listed word left in a payload's prose, with where. */
export function denylistResidue(
  value: unknown,
  denylist: readonly string[],
  path = "",
  key: string | null = null,
): DenyResidue[] {
  if (typeof value === "string") {
    if (key !== null && NOT_PROSE.has(key) && key !== "name") return [];
    return findDenylisted(value, denylist).map((term) => ({ path: path || "(root)", term }));
  }
  if (Array.isArray(value))
    return value.flatMap((v, i) => denylistResidue(v, denylist, `${path}[${i}]`, key));
  if (isObj(value))
    return Object.entries(value).flatMap(([k, v]) =>
      denylistResidue(v, denylist, path ? `${path}.${k}` : k, k),
    );
  return [];
}

// ─── Names ───────────────────────────────────────────────────────────────

/** Vapi caps assistant and squad names at 40 characters. */
export const VAPI_NAME_MAX = 40;

/**
 * The tenant's name for a template object: the template's own prefix replaced
 * by the clone's label, cut to Vapi's limit without leaving a dangling word.
 */
export function renameFor(templateName: string, namePrefix: string, cloneLabel: string): string {
  const clean = cloneLabel.replace(/\s+/g, " ").trim();
  // At most 16 characters of label, cut at a word where the label runs over.
  const cutLabel =
    clean.length <= 16 ? clean : clean.slice(0, 17).replace(/\s+\S*$/, "") || clean.slice(0, 16);
  const label = cutLabel.trim() || "Clone";
  const rest =
    namePrefix && templateName.startsWith(namePrefix)
      ? templateName.slice(namePrefix.length)
      : templateName;
  const full = `${label} ${rest}`.replace(/\s+/g, " ").trim();
  if (full.length <= VAPI_NAME_MAX) return full;
  const cut = full.slice(0, VAPI_NAME_MAX);
  const space = cut.lastIndexOf(" ");
  return (space > label.length ? cut.slice(0, space) : cut).trim();
}

// ─── What an assistant refers to ─────────────────────────────────────────

export type AssistantRefs = {
  toolIds: string[];
  fileIds: string[];
  structuredOutputIds: string[];
  scorecardIds: string[];
  credentialIds: string[];
  /** Any other org-scoped id, with its path. A voice's own id is global and not counted. */
  unknown: { path: string; value: string }[];
};

const REF_KEYS: Record<string, keyof Omit<AssistantRefs, "unknown">> = {
  toolIds: "toolIds",
  toolId: "toolIds",
  fileIds: "fileIds",
  fileId: "fileIds",
  structuredOutputIds: "structuredOutputIds",
  structuredOutputId: "structuredOutputIds",
  scorecardIds: "scorecardIds",
  scorecardId: "scorecardIds",
  credentialIds: "credentialIds",
  credentialId: "credentialIds",
};

export function collectAssistantRefs(a: VapiObject): AssistantRefs {
  const r: AssistantRefs = {
    toolIds: [],
    fileIds: [],
    structuredOutputIds: [],
    scorecardIds: [],
    credentialIds: [],
    unknown: [],
  };
  const walk = (v: unknown, path: string, key: string | null) => {
    if (typeof v === "string") {
      if (!UUID.test(v)) return;
      const bucket = key ? REF_KEYS[key] : undefined;
      if (bucket) r[bucket].push(v.toLowerCase());
      // A voice id (Cartesia's are UUIDs) is a global catalogue id, not an org object.
      else if (
        !path.startsWith("voice") &&
        !/(^|\.)voice(\.|\[|$)/.test(path) &&
        !SERVER_MANAGED.has(key ?? "")
      )
        r.unknown.push({ path, value: v });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`, key));
      return;
    }
    if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, k);
  };
  walk(a, "", null);
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    toolIds: uniq(r.toolIds),
    fileIds: uniq(r.fileIds),
    structuredOutputIds: uniq(r.structuredOutputIds),
    scorecardIds: uniq(r.scorecardIds),
    credentialIds: uniq(r.credentialIds),
    unknown: r.unknown,
  };
}

// ─── Payloads ────────────────────────────────────────────────────────────

export type PayloadProblem = { code: string; path: string; detail: string };

export type Prepared = { payload: VapiObject; problems: PayloadProblem[]; warnings: string[] };

export type IdMaps = {
  tools: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, string>;
  structuredOutputs: ReadonlyMap<string, string>;
  scorecards: ReadonlyMap<string, string>;
};

const lower = (m: ReadonlyMap<string, string>, id: string) =>
  m.get(id.toLowerCase()) ?? m.get(id) ?? null;

function remapIdArray(
  arr: unknown,
  map: ReadonlyMap<string, string>,
  path: string,
  problems: PayloadProblem[],
  opts: { drop?: ReadonlySet<string>; dropped?: string[] } = {},
): unknown {
  if (!Array.isArray(arr)) return arr;
  const out: string[] = [];
  for (const [i, id] of arr.entries()) {
    if (typeof id !== "string") continue;
    if (opts.drop?.has(id.toLowerCase())) {
      opts.dropped?.push(id.toLowerCase());
      continue;
    }
    const to = lower(map, id);
    if (to) out.push(to);
    else problems.push({ code: "unmapped_reference", path: `${path}[${i}]`, detail: id });
  }
  return out;
}

/** Remap every id under the keys REF_KEYS knows, everywhere in an object. Credential ids are removed. */
function remapRefs(
  v: unknown,
  maps: IdMaps,
  path: string,
  problems: PayloadProblem[],
  excludedTools: ReadonlySet<string>,
  dropped: string[],
): unknown {
  if (Array.isArray(v))
    return v.map((x, i) => remapRefs(x, maps, `${path}[${i}]`, problems, excludedTools, dropped));
  if (!isObj(v)) return v;
  const out: VapiObject = {};
  for (const [k, x] of Object.entries(v)) {
    const p = path ? `${path}.${k}` : k;
    if (k === "credentialIds" || k === "credentialId") continue; // the tenant's org holds its own
    if (k === "toolIds")
      out[k] = remapIdArray(x, maps.tools, p, problems, { drop: excludedTools, dropped });
    else if (k === "fileIds") out[k] = remapIdArray(x, maps.files, p, problems);
    else if (k === "structuredOutputIds")
      out[k] = remapIdArray(x, maps.structuredOutputs, p, problems);
    else if (k === "scorecardIds") out[k] = remapIdArray(x, maps.scorecards, p, problems);
    else if (
      (k === "fileId" || k === "structuredOutputId" || k === "scorecardId" || k === "toolId") &&
      typeof x === "string"
    ) {
      const map =
        k === "fileId"
          ? maps.files
          : k === "structuredOutputId"
            ? maps.structuredOutputs
            : k === "scorecardId"
              ? maps.scorecards
              : maps.tools;
      const to = lower(map, x);
      if (to) out[k] = to;
      else problems.push({ code: "unmapped_reference", path: p, detail: x });
    } else out[k] = remapRefs(x, maps, p, problems, excludedTools, dropped);
  }
  return out;
}

export type ToolContext = {
  /** Template hook URL → the clone's hook URL. */
  hookUrls: ReadonlyMap<string, string>;
  substitute: (s: string) => string;
};

/** A template tool, as the clone's org should receive it. */
export function prepareTool(template: VapiObject, ctx: ToolContext): Prepared {
  const problems: PayloadProblem[] = [];
  const payload = stripManaged(clone(template));
  delete payload.credentialId;
  const server = payload.server;
  if (isObj(server)) {
    const url = typeof server.url === "string" ? server.url : null;
    const to = url ? ctx.hookUrls.get(url) : null;
    if (!to)
      problems.push({ code: "unmapped_server_url", path: "server.url", detail: url ?? "(none)" });
    const next: VapiObject = { ...(to ? { url: to } : {}) };
    if (typeof server.timeoutSeconds === "number") next.timeoutSeconds = server.timeoutSeconds;
    // Headers and credentials are the head's; a tenant's hook needs none.
    payload.server = next;
  }
  const substituted = substituteProse(payload, ctx.substitute) as VapiObject;
  return { payload: substituted, problems, warnings: [] };
}

export type AssistantContext = {
  maps: IdMaps;
  /** Template tool ids (lower case) the clone does not get. */
  excludedTools: ReadonlySet<string>;
  /** Function names of the excluded tools, to warn where a prompt still asks for one. */
  excludedFunctionNames: readonly string[];
  rename: (templateName: string) => string;
  substitute: (s: string) => string;
  callLog: { url: string; credentialId: string };
};

/** A template assistant, as the clone's org should receive it. */
export function prepareAssistant(template: VapiObject, ctx: AssistantContext): Prepared {
  const problems: PayloadProblem[] = [];
  const warnings: string[] = [];
  const dropped: string[] = [];
  let payload = stripManaged(clone(template));
  delete payload.credentials;
  payload = remapRefs(payload, ctx.maps, "", problems, ctx.excludedTools, dropped) as VapiObject;

  // Any other org-scoped id left after the remap is one nothing accounts for.
  for (const u of collectAssistantRefs(payload).unknown) {
    problems.push({ code: "unknown_reference", path: u.path, detail: u.value });
  }

  payload.name = ctx.rename(typeof template.name === "string" ? template.name : "Assistant");
  payload.server = { url: ctx.callLog.url, credentialId: ctx.callLog.credentialId };
  payload.serverMessages = ["status-update", "end-of-call-report"];
  delete payload.serverUrl;
  delete payload.serverUrlSecret;

  payload = substituteProse(payload, ctx.substitute) as VapiObject;

  if (dropped.length > 0) {
    const prose = JSON.stringify(payload.model ?? {});
    for (const fn of ctx.excludedFunctionNames) {
      if (fn && prose.includes(fn))
        warnings.push(
          `The prompt still mentions ${fn}, which this clone does not get; review the instruction.`,
        );
    }
  }
  return { payload, problems, warnings };
}

export type SquadContext = {
  /** Template assistant id → clone assistant id. */
  assistants: ReadonlyMap<string, string>;
  /** Template assistant NAME → clone assistant name (destinations name assistants). */
  names: ReadonlyMap<string, string>;
  rename: (templateName: string) => string;
  substitute: (s: string) => string;
};

export function prepareSquad(template: VapiObject, ctx: SquadContext): Prepared {
  const problems: PayloadProblem[] = [];
  const base = stripManaged(clone(template));
  const name = ctx.rename(typeof template.name === "string" ? template.name : "Squad");
  // Members name assistants by id, and handoffs name them by id AND by name
  // (`assistantOverrides["tools:append"][].destinations[]`). Every one of
  // either, wherever it sits, is the clone's — or the squad is held.
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`));
    if (!isObj(v)) return v;
    const out: VapiObject = {};
    for (const [k, x] of Object.entries(v)) {
      const p = path ? `${path}.${k}` : k;
      if (k === "assistantId" && typeof x === "string") {
        const to = lower(ctx.assistants, x);
        if (to) out[k] = to;
        else problems.push({ code: "unmapped_member", path: p, detail: x });
      } else if (k === "assistantName" && typeof x === "string") {
        const to = ctx.names.get(x);
        if (to) out[k] = to;
        else problems.push({ code: "unmapped_destination", path: p, detail: x });
      } else if (k === "credentialId" || k === "credentialIds") {
        continue;
      } else out[k] = walk(x, p);
    }
    return out;
  };
  const payload = walk(base, "") as VapiObject;
  payload.name = name;
  const substituted = substituteProse(payload, ctx.substitute) as VapiObject;
  for (const u of collectAssistantRefs(substituted).unknown) {
    if (!/assistantId$/.test(u.path))
      problems.push({ code: "unknown_reference", path: u.path, detail: u.value });
  }
  return { payload: substituted, problems, warnings: [] };
}

/** The custom credential the clone's assistants send their call reports with. */
export function callLogCredentialPayload(name: string, secret: string): VapiObject {
  return {
    provider: "custom-credential",
    name: name.slice(0, VAPI_NAME_MAX),
    authenticationPlan: {
      type: "bearer",
      token: secret,
      headerName: "x-vapi-secret",
      bearerPrefixEnabled: false,
    },
  };
}

/** A structured output or a scorecard, as the clone's org should receive it. */
export function prepareSimpleCopy(
  template: VapiObject,
  substitute: (s: string) => string,
): VapiObject {
  const payload = stripManaged(clone(template));
  delete payload.credentialId;
  delete payload.credentialIds;
  return substituteProse(payload, substitute) as VapiObject;
}

/** The function name a tool exposes to the model, if it has one. */
export function functionNameOf(tool: VapiObject): string | null {
  const fn = tool.function;
  return isObj(fn) && typeof fn.name === "string" ? fn.name : null;
}
