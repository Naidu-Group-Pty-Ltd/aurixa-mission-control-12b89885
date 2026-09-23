// Deploying a build package into a client's VAPI org - pure, with the VAPI API
// injected, so every path (create, re-run, a failed file, a read-back that
// disagrees, a rollback) is exercised in tests against a fake org.
//
//   tools -> knowledge-base file (upload, wait for `done`) -> assistants
//     -> squad -> phone number (optional) -> read-back verification
//
// Rules the recipe book learned live, and this enforces:
//
// - KB_TEXT_PLAIN: the knowledge base is uploaded as text/plain `.txt`, and is
//   not used until VAPI's parser reports `done`; `failed` stops the deploy.
// - KB_BOTH_LOCATIONS: the file id goes in the inline query tool AND in
//   model.knowledgeBase; verification checks both.
// - PATCH_WHOLE_MODEL: VAPI replaces `model` wholesale on PATCH, so an update
//   always sends the whole model...
// - KEEP_UNMANAGED_INLINE_TOOLS: ...and carries over inline tools the Studio
//   did not put there, rather than silently deleting somebody's work.
// - READBACK_NOT_HTTP_STATUS: a 200 is not proof. Every assistant is read back
//   and compared with what was meant.
//
// Secrets never enter a stored package: placeholders are resolved here, in
// memory, for the request being made. The ledger stores a HASH of the resolved
// payload, so a rotated secret is a changed payload and is re-written.
import { sha256Hex, stableStringify, type BuildPackage } from "./package.pure.ts";

export type LedgerKind = "tool" | "kb_file" | "assistant" | "squad" | "phone";

export interface LedgerEntry {
  kind: LedgerKind;
  key: string;
  vapiId: string;
  payloadSha: string;
  adopted?: boolean;
}

export interface VapiApi {
  /** null on 404. */
  get(path: string): Promise<Record<string, any> | null>;
  post(path: string, body: unknown): Promise<Record<string, any>>;
  patch(path: string, body: unknown): Promise<Record<string, any>>;
  uploadTextFile(fileName: string, mimetype: string, text: string): Promise<Record<string, any>>;
}

export interface DeploySecrets {
  tenantWebhookUrl: string;
  tenantWebhookSecret: string;
  callLogUrl: string;
  callLogSecret: string;
  makeTransferUrl: string | null;
}

export type StepStatus = "ok" | "skipped" | "planned" | "failed";

export interface DeployStep {
  kind: LedgerKind | "verify";
  key: string;
  action: "create" | "update" | "unchanged" | "upload" | "wait" | "verify" | "bind";
  status: StepStatus;
  detail: string;
  vapiId?: string;
}

export interface VerificationRow {
  agentKey: string;
  assistantId: string | null;
  checks: Record<string, boolean>;
}

export interface DeployInput {
  pkg: BuildPackage;
  ledger: LedgerEntry[];
  api: VapiApi;
  secrets: DeploySecrets;
  mode: "dry_run" | "apply";
  phoneNumberId?: string | null;
  /** Called after every VAPI write that created or changed something, so its id is never lost. */
  onLedger: (entry: LedgerEntry) => Promise<void>;
  onStep?: (step: DeployStep) => Promise<void> | void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  kbPollMs?: number;
}

export type DeployOutcome =
  | { status: "succeeded"; steps: DeployStep[]; verification: VerificationRow[] }
  | { status: "continue"; steps: DeployStep[] }
  | { status: "failed"; steps: DeployStep[]; error: string; verification?: VerificationRow[] };

export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployError";
  }
}

const TOKEN = /\{\{(tool|assistant|kb|config|secret):([a-z0-9_]+)\}\}/g;

/** Replace every placeholder in a payload; an unresolvable one is a deploy error, never an empty string. */
export function resolvePlaceholders(
  value: unknown,
  lookup: (ns: string, key: string) => string | null,
): unknown {
  if (typeof value === "string") {
    return value.replace(TOKEN, (_m, ns: string, key: string) => {
      const v = lookup(ns, key);
      if (v == null || v === "") throw new DeployError(`nothing to put in {{${ns}:${key}}}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, lookup));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, lookup)]));
  }
  return value;
}

const MAX_KB_POLLS_PER_TICK = 60;

/** VAPI refuses these on a PATCH; they are fixed at creation. */
const TOOL_IMMUTABLE = ["type"];

export async function executeDeploy(input: DeployInput): Promise<DeployOutcome> {
  const { pkg, api, secrets, mode } = input;
  const steps: DeployStep[] = [];
  const ledger = new Map(input.ledger.map((e) => [`${e.kind}:${e.key}`, { ...e }]));
  const dry = mode === "dry_run";
  const pollMs = input.kbPollMs ?? 3000;

  const step = async (s: DeployStep) => {
    steps.push(s);
    await input.onStep?.(s);
  };
  const record = async (e: LedgerEntry) => {
    ledger.set(`${e.kind}:${e.key}`, e);
    await input.onLedger(e);
  };
  const outOfTime = () => input.now() >= input.deadline;

  const lookup = (ns: string, key: string): string | null => {
    if (ns === "tool") return ledger.get(`tool:${key}`)?.vapiId ?? (dry ? `<new tool ${key}>` : null);
    if (ns === "assistant") return ledger.get(`assistant:${key}`)?.vapiId ?? (dry ? `<new assistant ${key}>` : null);
    if (ns === "kb") return ledger.get("kb_file:kb")?.vapiId ?? (dry ? "<new knowledge base file>" : null);
    if (ns === "config" && key === "tenant_webhook_url") return secrets.tenantWebhookUrl;
    if (ns === "config" && key === "call_log_url") return secrets.callLogUrl;
    if (ns === "secret" && key === "tenant_webhook") return secrets.tenantWebhookSecret;
    if (ns === "secret" && key === "call_log") return secrets.callLogSecret;
    if (ns === "secret" && key === "make_transfer_url") return secrets.makeTransferUrl;
    return null;
  };

  /** Create or update one object; returns its id. */
  const upsert = async (
    kind: LedgerKind,
    key: string,
    path: string,
    body: Record<string, any>,
    merge?: (remote: Record<string, any>, body: Record<string, any>) => Record<string, any>,
  ): Promise<string | null> => {
    const sha = await sha256Hex(stableStringify(body));
    const known = ledger.get(`${kind}:${key}`);
    if (known) {
      const remote = await api.get(`${path}/${known.vapiId}`);
      if (remote && known.payloadSha === sha) {
        await step({ kind, key, action: "unchanged", status: "skipped", detail: "matches what was last written", vapiId: known.vapiId });
        return known.vapiId;
      }
      if (remote) {
        if (dry) {
          await step({ kind, key, action: "update", status: "planned", detail: "would update", vapiId: known.vapiId });
          return known.vapiId;
        }
        const patchBody = merge ? merge(remote, body) : body;
        const updated = await api.patch(`${path}/${known.vapiId}`, stripImmutable(kind, patchBody));
        await record({ ...known, payloadSha: sha });
        await step({ kind, key, action: "update", status: "ok", detail: "updated", vapiId: String(updated.id ?? known.vapiId) });
        return known.vapiId;
      }
      // Deleted in VAPI since it was written: create it again rather than
      // PATCH a ghost.
    }
    if (dry) {
      await step({ kind, key, action: "create", status: "planned", detail: known ? "missing in VAPI; would recreate" : "would create" });
      return null;
    }
    const created = await api.post(path, body);
    if (!created?.id) throw new DeployError(`VAPI did not return an id for the new ${kind} ${key}`);
    await record({ kind, key, vapiId: String(created.id), payloadSha: sha, adopted: false });
    await step({ kind, key, action: "create", status: "ok", detail: "created", vapiId: String(created.id) });
    return String(created.id);
  };

  try {
    // 1. Tools.
    for (const t of pkg.tools) {
      if (outOfTime()) return { status: "continue", steps };
      const body = resolvePlaceholders(t.payload, lookup) as Record<string, any>;
      await upsert("tool", t.key, "/tool", body);
    }

    // 2. The knowledge-base file.
    if (pkg.kb) {
      const known = ledger.get("kb_file:kb");
      let fileId = known && known.payloadSha === pkg.kb.sha256 ? known.vapiId : null;
      if (!fileId) {
        if (dry) {
          await step({ kind: "kb_file", key: "kb", action: "upload", status: "planned", detail: `would upload ${pkg.kb.fileName} (${pkg.kb.bytes} bytes, text/plain)` });
        } else {
          const up = await api.uploadTextFile(pkg.kb.fileName, pkg.kb.mimetype, pkg.kb.text);
          if (!up?.id) throw new DeployError("VAPI did not return an id for the knowledge-base file");
          fileId = String(up.id);
          // Recorded BEFORE waiting: a tick that runs out while VAPI parses
          // must find this file next time, not upload a second copy.
          await record({ kind: "kb_file", key: "kb", vapiId: fileId, payloadSha: pkg.kb.sha256 });
          await step({ kind: "kb_file", key: "kb", action: "upload", status: "ok", detail: `uploaded ${pkg.kb.fileName}`, vapiId: fileId });
        }
      }
      if (fileId) {
        // Bounded by the deadline, and by a poll count as a backstop for a
        // clock that does not move.
        for (let polls = 0; ; polls++) {
          const f = await api.get(`/file/${fileId}`);
          const status = String(f?.status ?? "missing");
          if (status === "done") {
            await step({ kind: "kb_file", key: "kb", action: "wait", status: "ok", detail: "parsed (status done)", vapiId: fileId });
            break;
          }
          if (status === "failed" || status === "missing") {
            throw new DeployError(`VAPI could not parse the knowledge-base file (status ${status}); nothing was pointed at it`);
          }
          if (outOfTime() || polls >= MAX_KB_POLLS_PER_TICK) return { status: "continue", steps };
          await input.sleep(pollMs);
        }
      }
    }

    // 3. Assistants.
    const kbToolName = pkg.agents.length ? kbInlineName(pkg) : null;
    for (const a of pkg.agents) {
      if (outOfTime()) return { status: "continue", steps };
      const body = resolvePlaceholders(a.assistant, lookup) as Record<string, any>;
      await upsert("assistant", a.key, "/assistant", body, (remote, next) => keepUnmanagedInlineTools(remote, next, kbToolName));
    }

    // 4. The squad.
    if (pkg.squad) {
      if (outOfTime()) return { status: "continue", steps };
      const body = resolvePlaceholders(pkg.squad.payload, lookup) as Record<string, any>;
      await upsert("squad", "main", "/squad", body);
    }

    // 5. A phone number, when one was named.
    if (input.phoneNumberId) {
      const target = pkg.squad
        ? { squadId: ledger.get("squad:main")?.vapiId ?? null, assistantId: null }
        : { assistantId: ledger.get(`assistant:${pkg.agents.find((x) => x.direction === "inbound")?.key}`)?.vapiId ?? null, squadId: null };
      const phone = await api.get(`/phone-number/${input.phoneNumberId}`);
      if (!phone) throw new DeployError(`phone number ${input.phoneNumberId} was not found in this VAPI org`);
      if (dry) {
        await step({ kind: "phone", key: input.phoneNumberId, action: "bind", status: "planned", detail: "would route this number to the fleet" });
      } else {
        await api.patch(`/phone-number/${input.phoneNumberId}`, target);
        await record({ kind: "phone", key: input.phoneNumberId, vapiId: input.phoneNumberId, payloadSha: await sha256Hex(stableStringify(target)) });
        await step({ kind: "phone", key: input.phoneNumberId, action: "bind", status: "ok", detail: "routed to the fleet", vapiId: input.phoneNumberId });
      }
    }

    if (dry) return { status: "succeeded", steps, verification: [] };

    // 6. Read everything back.
    const verification = await verifyDeployment(pkg, ledger, api);
    await step({
      kind: "verify",
      key: "all",
      action: "verify",
      status: verification.every((v) => Object.values(v.checks).every(Boolean)) ? "ok" : "failed",
      detail: `${verification.length} assistant(s) read back`,
    });
    const bad = verification.filter((v) => !Object.values(v.checks).every(Boolean));
    if (bad.length) {
      return {
        status: "failed",
        steps,
        verification,
        error: `read-back disagreed on ${bad.map((b) => `${b.agentKey} (${Object.entries(b.checks).filter(([, ok]) => !ok).map(([k]) => k).join(", ")})`).join("; ")}`,
      };
    }
    return { status: "succeeded", steps, verification };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    steps.push({ kind: "verify", key: "error", action: "verify", status: "failed", detail: message });
    return { status: "failed", steps, error: message };
  }
}

function stripImmutable(kind: LedgerKind, body: Record<string, any>): Record<string, any> {
  if (kind !== "tool") return body;
  const out = { ...body };
  for (const k of TOOL_IMMUTABLE) delete out[k];
  return out;
}

function kbInlineName(pkg: BuildPackage): string | null {
  for (const a of pkg.agents) {
    const tools = (a.assistant.model as { tools?: Array<{ type?: string; function?: { name?: string } }> })?.tools ?? [];
    const q = tools.find((t) => t.type === "query");
    if (q?.function?.name) return q.function.name;
  }
  return null;
}

/** The whole model, plus any inline tool on the live assistant that the Studio does not manage. */
export function keepUnmanagedInlineTools(
  remote: Record<string, any>,
  next: Record<string, any>,
  managedKbName: string | null,
): Record<string, any> {
  const ours = new Set(
    ((next.model?.tools ?? []) as Array<{ function?: { name?: string } }>).map((t) => t.function?.name).filter(Boolean),
  );
  if (managedKbName) ours.add(managedKbName);
  const kept = ((remote.model?.tools ?? []) as Array<{ function?: { name?: string } }>).filter(
    (t) => !t.function?.name || !ours.has(t.function.name),
  );
  if (!kept.length) return next;
  return { ...next, model: { ...next.model, tools: [...(next.model?.tools ?? []), ...kept] } };
}

/** Read every assistant (and the squad) back and compare with the package. */
export async function verifyDeployment(pkg: BuildPackage, ledger: Map<string, LedgerEntry>, api: VapiApi): Promise<VerificationRow[]> {
  const fileId = ledger.get("kb_file:kb")?.vapiId ?? null;
  const rows: VerificationRow[] = [];
  const squad = pkg.squad && ledger.get("squad:main") ? await api.get(`/squad/${ledger.get("squad:main")!.vapiId}`) : null;
  const squadIds = new Set(((squad?.members ?? []) as Array<{ assistantId?: string }>).map((m) => m.assistantId));

  for (const a of pkg.agents) {
    const id = ledger.get(`assistant:${a.key}`)?.vapiId ?? null;
    const remote = id ? await api.get(`/assistant/${id}`) : null;
    const expectedToolIds = new Set(
      ((a.assistant.model as { toolIds?: string[] }).toolIds ?? []).map((t) => ledger.get(`tool:${t.replace(/^\{\{tool:|\}\}$/g, "")}`)?.vapiId),
    );
    const model = remote?.model ?? {};
    const prompt = (model.messages ?? []).find((m: { role?: string }) => m.role === "system")?.content ?? "";
    const wantsKb = Boolean(pkg.kb) && a.toolKeys.includes("kb_query");
    const inlineQuery = (model.tools ?? []).find((t: { type?: string }) => t.type === "query");
    const checks: Record<string, boolean> = {
      exists: Boolean(remote),
      system_prompt: remote ? (await sha256Hex(String(prompt))) === a.systemPromptSha256 : false,
      tool_ids: remote ? sameSet(new Set(model.toolIds ?? []), expectedToolIds) : false,
      first_message_mode: remote?.firstMessageMode === (a.assistant as { firstMessageMode?: string }).firstMessageMode,
      server_url: Boolean(remote?.server?.url) && !String(remote?.server?.url).includes("{{"),
    };
    if (wantsKb) {
      checks.kb_query_tool = Boolean(inlineQuery?.knowledgeBases?.[0]?.fileIds?.includes(fileId));
      checks.kb_model = Boolean(model.knowledgeBase?.fileIds?.includes(fileId));
    }
    if (pkg.squad && pkg.squad.payload && JSON.stringify(pkg.squad.payload).includes(`{{assistant:${a.key}}}`)) {
      checks.squad_member = Boolean(id && squadIds.has(id));
    }
    rows.push({ agentKey: a.key, assistantId: id, checks });
  }
  return rows;
}

function sameSet(a: Set<unknown>, b: Set<unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
