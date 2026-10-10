import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyReplacements,
  callLogCredentialPayload,
  collectAssistantRefs,
  denylistResidue,
  findDenylisted,
  prepareAssistant,
  prepareSquad,
  prepareTool,
  renameFor,
  validateReplacements,
  VAPI_NAME_MAX,
  type IdMaps,
  type VapiObject,
} from "./voiceStackVapi.pure";
import { INDEPENDENT_TEMPLATE_SEED } from "./voiceStackTemplate.pure";

const FIX = join(__dirname, "fixtures", "voice-stack", "vapi");
const read = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8")) as VapiObject;

const DENY = INDEPENDENT_TEMPLATE_SEED.identity.denylist;
const REPLACEMENTS = [
  { from: "Naidu Property Consulting Services", to: "Acme Realty" },
  { from: "Naidu Property Consulting", to: "Acme Realty" },
  { from: "NPC Services", to: "Acme Realty" },
  { from: "npcservices.com.au", to: "acmerealty.com.au" },
  { from: "Naidu", to: "Acme" },
  { from: "NPC", to: "Acme" },
];
const substitute = (s: string) => applyReplacements(s, REPLACEMENTS);

/** Clone ids: the template id with its first block replaced, so a leftover is visible. */
const cloneId = (id: string) => `c0ffee00${id.slice(8)}`;
function mapOf(ids: string[]): Map<string, string> {
  return new Map(ids.map((i) => [i.toLowerCase(), cloneId(i)]));
}

describe("identity", () => {
  it("replaces longest first, and NPC as a word — never inside npc_ci_ function names", () => {
    expect(substitute("Angela from Naidu Property Consulting Services speaking")).toBe(
      "Angela from Acme Realty speaking",
    );
    expect(substitute("call npc_ci_check_availability for NPC")).toBe(
      "call npc_ci_check_availability for Acme",
    );
  });

  it("finds the head's words that remain", () => {
    expect(findDenylisted("Welcome to NPC", DENY)).toEqual(["NPC"]);
    expect(findDenylisted("see npcservices.com.au", DENY)).toEqual([
      "npcservices",
      "npcservices.com.au",
    ]);
    expect(findDenylisted("npc_ci_check_availability", DENY)).toEqual([]);
  });

  it("refuses a replacement that still carries the head, or names a word twice", () => {
    expect(validateReplacements([{ from: "NPC", to: "NPC Realty" }], DENY)).toMatchObject({
      ok: false,
    });
    expect(
      validateReplacements(
        [
          { from: "NPC", to: "A" },
          { from: "npc", to: "B" },
        ],
        DENY,
      ),
    ).toMatchObject({ ok: false });
    expect(validateReplacements(REPLACEMENTS, DENY)).toMatchObject({ ok: true });
  });

  it("renames within Vapi's 40 characters, the template's prefix replaced by the clone's label", () => {
    expect(renameFor("NPC CI Inbound Agent", "NPC CI ", "Acme Realty")).toBe(
      "Acme Realty Inbound Agent",
    );
    const long = renameFor(
      "NPC CI Strategy Session Phone No Show",
      "NPC CI ",
      "Acme Realty Partners Pty Ltd",
    );
    expect(long.length).toBeLessThanOrEqual(VAPI_NAME_MAX);
    expect(long).toBe("Acme Realty Strategy Session Phone No");
    expect(long.endsWith(" ")).toBe(false);
  });
});

describe("a template assistant, copied into the tenant's org", () => {
  const template = read("assistant_9b4f7438.json");
  const refs = collectAssistantRefs(template);

  it("classifies every id it carries by what it is — none unknown", () => {
    expect(refs.unknown).toEqual([]);
    expect(refs.toolIds).toHaveLength(5);
    expect(refs.fileIds).toEqual(["1e87753e-6c9e-427f-8e72-95c24c0dcea6"]);
    expect(refs.structuredOutputIds).toHaveLength(3);
    expect(refs.scorecardIds).toEqual(["4b17b93c-01fd-4f61-b34b-f4272ac15085"]);
  });

  const maps: IdMaps = {
    tools: mapOf(refs.toolIds.filter((t) => !t.startsWith("bf4b9260"))),
    files: mapOf(refs.fileIds),
    structuredOutputs: mapOf(refs.structuredOutputIds),
    scorecards: mapOf(refs.scorecardIds),
  };
  const ctx = {
    maps,
    excludedTools: new Set(["bf4b9260-0168-4beb-8a1b-52b5c4788f15"]),
    excludedFunctionNames: ["transfer_to_human"],
    rename: (n: string) => renameFor(n, "NPC CI ", "Acme Realty"),
    substitute,
    callLog: {
      url: "https://abcdefghijklmnop.supabase.co/functions/v1/vapi-call-webhook",
      credentialId: "99999999-9999-4999-8999-999999999999",
    },
  };

  it("remaps every org-scoped id, drops the excluded tool, and reports to the clone's own Call Logs", () => {
    const r = prepareAssistant(template, ctx);
    expect(r.problems).toEqual([]);
    const p = r.payload as {
      model: { toolIds: string[] };
      server: unknown;
      serverMessages: unknown;
      name: string;
    };
    expect(p.model.toolIds.every((t) => t.startsWith("c0ffee00"))).toBe(true);
    expect(p.model.toolIds).toHaveLength(4);
    expect(p.server).toEqual(ctx.callLog);
    expect(p.serverMessages).toEqual(["status-update", "end-of-call-report"]);
    expect(p.name.startsWith("Acme Realty")).toBe(true);
    const all = JSON.stringify(r.payload);
    for (const id of [
      ...refs.toolIds,
      ...refs.fileIds,
      ...refs.structuredOutputIds,
      ...refs.scorecardIds,
    ])
      expect(all).not.toContain(id);
  });

  it("speaks for the tenant: nothing of the head's business remains", () => {
    const r = prepareAssistant(template, ctx);
    expect(denylistResidue(r.payload, DENY)).toEqual([]);
  });

  it("is held, naming the path, where an id has no counterpart in the tenant's org", () => {
    const r = prepareAssistant(template, { ...ctx, maps: { ...maps, scorecards: new Map() } });
    expect(r.problems).toEqual([
      {
        code: "unmapped_reference",
        path: "artifactPlan.scorecardIds[0]",
        detail: "4b17b93c-01fd-4f61-b34b-f4272ac15085",
      },
    ]);
  });

  it("without replacements, the head's words are found and named", () => {
    const r = prepareAssistant(template, { ...ctx, substitute: (s) => s });
    const residue = denylistResidue(r.payload, DENY);
    expect(residue.length).toBeGreaterThan(0);
    expect(residue.map((x) => x.term)).toContain("Naidu Property Consulting");
  });

  it("warns where a prompt still asks for a tool the clone does not get", () => {
    const inbound = read("assistant_b834610e.json");
    const r = prepareAssistant(inbound, {
      ...ctx,
      maps: {
        ...maps,
        tools: mapOf(
          collectAssistantRefs(inbound).toolIds.filter((t) => !t.startsWith("bf4b9260")),
        ),
      },
    });
    expect(r.problems).toEqual([]);
    expect(r.warnings.join(" ")).toContain("transfer_to_human");
  });
});

describe("a template tool", () => {
  const tool = read("tool_npc_ci_check_availability.json");
  const url = (tool.server as { url: string }).url;

  it("calls the clone's own hook for the same role, with no header or credential of the head's", () => {
    const r = prepareTool(
      {
        ...tool,
        server: { url, timeoutSeconds: 30, headers: { "x-secret": "head" } },
        credentialId: "x",
      },
      { hookUrls: new Map([[url, "https://hook.us2.make.com/tenantclone"]]), substitute },
    );
    expect(r.problems).toEqual([]);
    expect(r.payload.server).toEqual({
      url: "https://hook.us2.make.com/tenantclone",
      timeoutSeconds: 30,
    });
    expect(r.payload.credentialId).toBeUndefined();
    expect(denylistResidue(r.payload, DENY)).toEqual([]);
    expect((r.payload.function as { name: string }).name).toBe("npc_ci_check_availability");
  });

  it("is held when its server is not one of the template's hooks", () => {
    const r = prepareTool(tool, { hookUrls: new Map(), substitute });
    expect(r.problems.map((p) => p.code)).toEqual(["unmapped_server_url"]);
  });
});

describe("the squad", () => {
  const squad = read("squad.json");
  const ids = INDEPENDENT_TEMPLATE_SEED.vapi.assistants.map((a) => a.templateAssistantId);
  const names = new Map([
    ["NPC CI Opt In Follow Up Inbound", "Acme Realty Opt In Follow Up Inbound"],
    ["NPC CI Strategy Session Inbound", "Acme Realty Strategy Session Inbound"],
    ["NPC CI IFC Inbound", "Acme Realty IFC Inbound"],
  ]);

  it("remaps members and handoff destinations by id and by name", () => {
    const r = prepareSquad(squad, {
      assistants: mapOf(ids),
      names,
      rename: (n) => renameFor(n, "NPC CI ", "Acme Realty"),
      substitute,
    });
    expect(r.problems).toEqual([]);
    const s = JSON.stringify(r.payload);
    for (const id of ids) expect(s).not.toContain(id);
    expect(s).toContain("Acme Realty IFC Inbound");
    expect(s).not.toContain("NPC CI");
    expect((r.payload as { name: string }).name).toBe("Acme Realty Sales Force");
  });

  it("is held when a destination names an assistant the clone has none of", () => {
    const r = prepareSquad(squad, {
      assistants: mapOf(ids),
      names: new Map(),
      rename: (n) => n,
      substitute,
    });
    expect(r.problems.some((p) => p.code === "unmapped_destination")).toBe(true);
  });
});

describe("the call-log credential", () => {
  it("is a bearer credential sending x-vapi-secret with no prefix, named within Vapi's limit", () => {
    const c = callLogCredentialPayload(
      "Acme Realty call logs — a very long name indeed",
      "s".repeat(40),
    );
    expect(c).toMatchObject({
      provider: "custom-credential",
      authenticationPlan: {
        type: "bearer",
        headerName: "x-vapi-secret",
        bearerPrefixEnabled: false,
      },
    });
    expect((c.name as string).length).toBeLessThanOrEqual(VAPI_NAME_MAX);
  });
});
