import { describe, expect, it } from "vitest";
import {
  DEPENDENT_TEMPLATE_SEED,
  excludes,
  INDEPENDENT_TEMPLATE_SEED,
  judgeStackProvision,
  validateManifest,
  type ProvisionFacts,
  type StackManifest,
} from "./voiceStackTemplate.pure";

describe("the two seeded templates", () => {
  it("both validate", () => {
    expect(validateManifest(INDEPENDENT_TEMPLATE_SEED)).toMatchObject({ ok: true });
    expect(validateManifest(DEPENDENT_TEMPLATE_SEED)).toMatchObject({ ok: true });
  });

  it("never let a line's tenant inherit the head's own accounts", () => {
    for (const m of [INDEPENDENT_TEMPLATE_SEED, DEPENDENT_TEMPLATE_SEED]) {
      const shared = m.make.connections.shared.map((c) => c.templateConnectionId);
      // The head's mailbox, calendar placeholder and GoHighLevel location are never shared.
      expect(shared).not.toContain(10496840);
      expect(shared).not.toContain(10496865);
    }
    expect(
      DEPENDENT_TEMPLATE_SEED.make.connections.tenantOwned.map((c) => c.templateConnectionId),
    ).toEqual([10496865]);
  });

  it("never carry transfer_to_human, and the dependent line drops the broken delete-event tools by name", () => {
    for (const m of [INDEPENDENT_TEMPLATE_SEED, DEPENDENT_TEMPLATE_SEED]) {
      expect(m.vapi.tools.map((t) => t.templateToolId)).not.toContain(
        "bf4b9260-0168-4beb-8a1b-52b5c4788f15",
      );
    }
    const drop = DEPENDENT_TEMPLATE_SEED.vapi.excludedTools.find((t) => t.functionName);
    expect(
      drop &&
        excludes(drop, {
          id: "90dc98c2-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          functionName: "ghl_delete_event_npc_3_1",
        }),
    ).toBe(true);
    expect(drop && excludes(drop, { id: "x", functionName: "ghl_create_booking" })).toBe(false);
  });

  it("the independent line's CFG secret is minted, never copied", () => {
    const cfg = INDEPENDENT_TEMPLATE_SEED.make.cfg!;
    expect(cfg.mintSecrets).toEqual(["adapter_secret"]);
    expect(cfg.copyFields).not.toContain("adapter_secret");
  });
});

describe("what a manifest may not say", () => {
  const bad = (patch: (m: StackManifest) => void) => {
    const m = JSON.parse(JSON.stringify(INDEPENDENT_TEMPLATE_SEED)) as StackManifest;
    patch(m);
    const r = validateManifest(m);
    return r.ok ? [] : r.problems.map((p) => p.path);
  };

  it("a copy field may not be a secret", () => {
    expect(bad((m) => m.make.cfg!.copyFields.push("adapter_secret"))).toContain(
      "make.cfg.copyFields",
    );
  });
  it("the CFG store is composed, never copied", () => {
    expect(bad((m) => (m.make.dataStores[0].records = "copy"))).toContain(
      "make.dataStores[0].records",
    );
  });
  it("a connection is shared OR the head's, never both", () => {
    expect(
      bad((m) =>
        m.make.connections.shared.push({ templateConnectionId: 10496840, label: "x" }),
      ).some((p) => p.startsWith("make.connections")),
    ).toBe(true);
  });
  it("a scenario names a hook that exists, and no hook starts two scenarios", () => {
    expect(bad((m) => (m.make.scenarios[0].hookRole = "nope"))).toContain(
      "make.scenarios[0].hookRole",
    );
    expect(bad((m) => (m.make.scenarios[1].hookRole = "adapter"))).toContain(
      "make.scenarios[1].hookRole",
    );
  });
  it("a tool may not be both carried and excluded", () => {
    expect(
      bad((m) =>
        m.vapi.excludedTools.push({
          templateToolId: m.vapi.tools[0].templateToolId,
          reason: "because so",
        }),
      ),
    ).toContain("vapi.excludedTools[1]");
  });
});

describe("the gate", () => {
  const ready: ProvisionFacts = {
    crmMode: "independent",
    isLineHead: false,
    conversionOpen: false,
    template: { crmMode: "independent", enabled: true, disabledReason: null, manifestValid: true },
    makeConfigured: true,
    aurixaVapiConfigured: true,
    encryptionEnabled: true,
    custodyActive: true,
    backendProjectRef: "abcdefghijklmnopqrst",
    ghl: null,
  };

  it("opens for an independent clone with everything in place", () => {
    expect(judgeStackProvision(ready)).toEqual([]);
  });

  it("ALWAYS requires the dependent line's GoHighLevel key, then its verification", () => {
    const dep = {
      ...ready,
      crmMode: "dependent" as const,
      template: { ...ready.template!, crmMode: "dependent" as const },
    };
    expect(judgeStackProvision(dep).map((b) => b.code)).toEqual(["ghl_credentials_missing"]);
    expect(judgeStackProvision({ ...dep, ghl: { verified: false } }).map((b) => b.code)).toEqual([
      "ghl_credentials_unverified",
    ]);
    expect(judgeStackProvision({ ...dep, ghl: { verified: true } })).toEqual([]);
  });

  it("answers every block at once, not the first", () => {
    const blocks = judgeStackProvision({
      ...ready,
      isLineHead: true,
      makeConfigured: false,
      custodyActive: false,
      backendProjectRef: null,
    }).map((b) => b.code);
    expect(blocks).toEqual([
      "clone_is_line_head",
      "make_not_configured",
      "vapi_org_not_active",
      "no_backend",
    ]);
  });

  it("refuses a clone whose line is unrecorded, before anything else", () => {
    expect(judgeStackProvision({ ...ready, crmMode: null }).map((b) => b.code)).toEqual([
      "crm_mode_unrecorded",
    ]);
  });

  it("waits out an open conversion, and says why a disabled template is off", () => {
    expect(judgeStackProvision({ ...ready, conversionOpen: true }).map((b) => b.code)).toEqual([
      "conversion_open",
    ]);
    const off = judgeStackProvision({
      ...ready,
      template: { ...ready.template!, enabled: false, disabledReason: "C1" },
    });
    expect(off).toEqual([{ code: "template_disabled", message: "C1" }]);
  });
});
