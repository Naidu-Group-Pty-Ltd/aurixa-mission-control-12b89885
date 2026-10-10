import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Blueprint } from "./voiceAutomationBlueprint.pure";
import {
  allModules,
  collectBlueprintRefs,
  composeCfgRecord,
  findCfgReader,
  findTemplateResidue,
  rewriteScenario,
  type RewriteContext,
} from "./voiceStackMake.pure";
import {
  DEPENDENT_TEMPLATE_SEED,
  INDEPENDENT_TEMPLATE_SEED,
  type StackManifest,
} from "./voiceStackTemplate.pure";

const FIX = join(__dirname, "fixtures", "voice-stack");
const read = (p: string) => JSON.parse(readFileSync(join(FIX, p), "utf8")) as Blueprint;
const independent = Object.fromEntries(
  readdirSync(join(FIX, "independent"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), read(`independent/${f}`)]),
);

/** A clone's ids: template id + 9_000_000, so a leftover template id is easy to see. */
function cloneMaps(m: StackManifest) {
  const hooks = new Map(m.make.hooks.map((h) => [h.templateHookId, h.templateHookId + 9_000_000]));
  const stores = new Map(
    m.make.dataStores.map((s) => [s.templateStoreId, s.templateStoreId + 9_000_000]),
  );
  return { hooks, stores };
}

function ctxFor(m: StackManifest, over: Partial<RewriteContext> = {}): RewriteContext {
  const { hooks, stores } = cloneMaps(m);
  const cfgStore = m.make.dataStores.find((s) => s.isCfg);
  return {
    name: "Acme - voice - test",
    hooks,
    dataStores: stores,
    hookUrls: new Map(),
    connections: m.make.connections,
    clonesConnections: {},
    secretPlaceholders: m.make.cfg?.secretPlaceholders ?? {},
    cfg:
      cfgStore && m.make.cfg
        ? { templateStoreId: cfgStore.templateStoreId, key: m.make.cfg.key }
        : null,
    ...over,
  };
}

function identityOf(m: StackManifest) {
  return {
    hookIds: m.make.hooks.map((h) => h.templateHookId),
    dataStoreIds: m.make.dataStores.map((s) => s.templateStoreId),
    tenantOwnedConnectionIds: m.make.connections.tenantOwned.map((c) => c.templateConnectionId),
    hookUrls: [],
  };
}

describe("every scenario of the independent line copies with nothing of the head's left", () => {
  it("has all nine of the manifest's scenarios as fixtures", () => {
    expect(Object.keys(independent).sort()).toEqual(
      [
        "adapter",
        "availability",
        "contact",
        "context_inject",
        "create_booking",
        "get_call_context",
        "loader",
        "manage_booking",
        "notifier",
      ].sort(),
    );
  });

  for (const [name, bp] of Object.entries(independent)) {
    it(`${name}: every hook, store and connection is accounted for, and the result carries no template id`, () => {
      const r = rewriteScenario(bp, ctxFor(INDEPENDENT_TEMPLATE_SEED));
      expect(r.problems).toEqual([]);
      expect(findTemplateResidue(r.blueprint, identityOf(INDEPENDENT_TEMPLATE_SEED))).toEqual([]);
      expect(r.blueprint.name).toBe("Acme - voice - test");
      // The template is untouched.
      expect(collectBlueprintRefs(bp).hookIds.every((h) => h < 9_000_000)).toBe(true);
    });
  }

  it("re-binds the head's own connections by APP and keeps only Aurixa's shared classifier", () => {
    const adapter = rewriteScenario(independent.adapter, ctxFor(INDEPENDENT_TEMPLATE_SEED));
    // The head's adapter runs its Outlook-CALENDAR module on its MAIL connection:
    // by app, that module waits on the tenant's Outlook calendar, never its mailbox.
    expect(adapter.awaitingSlots).toEqual(["google_calendar", "outlook_calendar"]);
    const notifier = rewriteScenario(independent.notifier, ctxFor(INDEPENDENT_TEMPLATE_SEED));
    expect(notifier.awaitingSlots).toEqual(["outlook_mail"]);
    const availability = rewriteScenario(
      independent.availability,
      ctxFor(INDEPENDENT_TEMPLATE_SEED),
    );
    expect(availability.sharedKept).toEqual([10496826]);
    expect(availability.awaitingSlots).toEqual([]);
  });

  it("binds the clone's own grant where it exists", () => {
    const r = rewriteScenario(
      independent.notifier,
      ctxFor(INDEPENDENT_TEMPLATE_SEED, { clonesConnections: { outlook_mail: 77 } }),
    );
    expect(r.awaitingSlots).toEqual([]);
    const conns = allModules(r.blueprint)
      .map((m) => (m.parameters as Record<string, unknown> | null)?.__IMTCONN__)
      .filter((c) => c !== undefined);
    expect(conns).toEqual([77, 77]);
  });

  it("finds each CFG reader (module 2 reads `default` from the CFG store)", () => {
    for (const n of [
      "adapter",
      "availability",
      "create_booking",
      "manage_booking",
      "notifier",
      "loader",
    ]) {
      expect(findCfgReader(independent[n], 168061, "default")).toBe(2);
    }
    expect(findCfgReader(independent.get_call_context, 168061, "default")).toBeNull();
  });
});

describe("what the rewrite refuses", () => {
  const bp = (
    params: Record<string, unknown>,
    mapper: Record<string, unknown> = {},
  ): Blueprint => ({
    name: "t",
    flow: [
      { id: 1, module: "gateway:CustomWebHook", parameters: { hook: 2911143 } },
      {
        id: 2,
        module: "datastore:GetRecord",
        parameters: { datastore: 168061 },
        mapper: { key: "default" },
      },
      { id: 3, module: "http:ActionSendData", parameters: params, mapper },
    ],
  });

  it("a connection the template does not declare is named, never carried", () => {
    const r = rewriteScenario(bp({ __IMTCONN__: 999 }), ctxFor(INDEPENDENT_TEMPLATE_SEED));
    expect(r.problems.map((p) => p.code)).toEqual(["undeclared_connection"]);
  });

  it("a hook URL with no clone counterpart is named", () => {
    const r = rewriteScenario(
      bp({}, { url: "https://hook.us2.make.com/abcdefghij" }),
      ctxFor(INDEPENDENT_TEMPLATE_SEED),
    );
    expect(r.problems.map((p) => p.code)).toEqual(["unmapped_hook_url"]);
  });

  it("a hook URL with one is replaced", () => {
    const r = rewriteScenario(
      bp({}, { url: "https://hook.us2.make.com/abcdefghij" }),
      ctxFor(INDEPENDENT_TEMPLATE_SEED, {
        hookUrls: new Map([
          ["https://hook.us2.make.com/abcdefghij", "https://hook.us2.make.com/zzzzzzzzzz"],
        ]),
      }),
    );
    expect(r.problems).toEqual([]);
    expect(JSON.stringify(r.blueprint)).toContain("zzzzzzzzzz");
    expect(JSON.stringify(r.blueprint)).not.toContain("abcdefghij");
  });

  it("a credential placeholder becomes a CFG reference where the scenario reads CFG — never a literal", () => {
    const m: StackManifest = {
      ...INDEPENDENT_TEMPLATE_SEED,
      make: {
        ...INDEPENDENT_TEMPLATE_SEED.make,
        cfg: {
          ...INDEPENDENT_TEMPLATE_SEED.make.cfg!,
          secretFields: ["adapter_secret", "ghl_pit_token"],
          secretPlaceholders: { GHL_PIT_TOKEN_BOOKING: "ghl_pit_token" },
        },
      },
    };
    const withReader = rewriteScenario(
      bp(
        {},
        { headers: [{ name: "Authorization", value: "Bearer {{SECRET:GHL_PIT_TOKEN_BOOKING}}" }] },
      ),
      ctxFor(m),
    );
    expect(withReader.problems).toEqual([]);
    expect(JSON.stringify(withReader.blueprint)).toContain("Bearer {{2.ghl_pit_token}}");

    const noReader: Blueprint = {
      name: "t",
      flow: [
        { id: 1, module: "gateway:CustomWebHook", parameters: { hook: 2911143 } },
        {
          id: 3,
          module: "http:ActionSendData",
          parameters: {},
          mapper: { auth: "{{SECRET:GHL_PIT_TOKEN_BOOKING}}" },
        },
      ],
    };
    const r = rewriteScenario(noReader, ctxFor(m));
    expect(r.problems.map((p) => p.code)).toEqual(["secret_placeholder_without_cfg_reader"]);
    expect(findTemplateResidue(r.blueprint, identityOf(m)).map((x) => x.kind)).toEqual([
      "secret_placeholder",
    ]);
  });

  it("an undeclared placeholder is named", () => {
    const r = rewriteScenario(bp({}, { k: "{{SECRET:OTHER}}" }), ctxFor(INDEPENDENT_TEMPLATE_SEED));
    expect(r.problems.map((p) => p.code)).toEqual(["undeclared_secret_placeholder"]);
  });

  it("a keychain or other __IMT reference is never carried", () => {
    const r = rewriteScenario(bp({ __IMTKEY__: 5 }), ctxFor(INDEPENDENT_TEMPLATE_SEED));
    expect(r.problems.map((p) => p.code)).toEqual(["undeclared_reference"]);
  });

  it("a hook or store outside the manifest is named", () => {
    const stray: Blueprint = {
      name: "t",
      flow: [
        { id: 1, module: "gateway:CustomWebHook", parameters: { hook: 1234 } },
        { id: 2, module: "datastore:AddRecord", parameters: { datastore: 4321 } },
      ],
    };
    expect(
      rewriteScenario(stray, ctxFor(INDEPENDENT_TEMPLATE_SEED)).problems.map((p) => p.code),
    ).toEqual(["unmapped_hook", "unmapped_data_store"]);
  });
});

describe("the dependent line's GoHighLevel contact resolver", () => {
  const bp = read("dependent/resolve_contact.json");

  it("names GoHighLevel's modules under the slot the tenant's OAuth grant fills", () => {
    const refs = collectBlueprintRefs(bp);
    expect(refs.connectionIds).toEqual([10496865]);
    expect(refs.modulesByApp.highlevel).toEqual(["createAContact", "searchContacts"]);
  });

  it("never carries the head's GoHighLevel location: modules wait on the clone's own grant", () => {
    const r = rewriteScenario(bp, ctxFor(DEPENDENT_TEMPLATE_SEED));
    expect(r.problems).toEqual([]);
    expect(r.awaitingSlots).toEqual(["ghl"]);
    expect(findTemplateResidue(r.blueprint, identityOf(DEPENDENT_TEMPLATE_SEED))).toEqual([]);
    expect(JSON.stringify(r.blueprint)).not.toContain("10496865");
    expect(JSON.stringify(r.blueprint)).not.toContain('"datastore":133627');
  });

  it("binds the clone's grant once authorised", () => {
    const r = rewriteScenario(
      bp,
      ctxFor(DEPENDENT_TEMPLATE_SEED, { clonesConnections: { ghl: 4242 } }),
    );
    expect(r.awaitingSlots).toEqual([]);
    expect(JSON.stringify(r.blueprint)).toContain('"__IMTCONN__":4242');
  });
});

describe("the CFG record a tenant starts with", () => {
  it("is composed — managed settings, minted secret, own hook URLs, remapped assistants, GHL fields", () => {
    const { record, unmappedAssistants } = composeCfgRecord({
      managed: { provider: "internal", business_name: "Acme" },
      minted: { adapter_secret: "s".repeat(48) },
      hookUrlFields: {
        adapter_url: "https://hook.us2.make.com/clone1",
        notifier_url: "https://hook.us2.make.com/clone2",
      },
      carried: {
        outbound_assistants: JSON.stringify({
          strategy: "cae508c6-3654-4b58-a900-c0425761053e",
          quiz: "be073b09-3cf2-4beb-a0f9-edf9c41ec058",
        }),
      },
      assistantMapField: "outbound_assistants",
      assistantIds: new Map([
        ["cae508c6-3654-4b58-a900-c0425761053e", "11111111-1111-4111-8111-111111111111"],
      ]),
      ghl: null,
      updatedAt: "2026-10-11T00:00:00.000Z",
    });
    expect(record.adapter_url).toBe("https://hook.us2.make.com/clone1");
    expect(JSON.parse(record.outbound_assistants as string)).toEqual({
      strategy: "11111111-1111-4111-8111-111111111111",
      quiz: "",
    });
    expect(unmappedAssistants).toEqual(["be073b09-3cf2-4beb-a0f9-edf9c41ec058"]);
    expect(record.updated_at).toBe("2026-10-11T00:00:00.000Z");
  });
});
