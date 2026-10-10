import { describe, expect, it } from "vitest";
import {
  MAX_STEP_ATTEMPTS,
  planStackSteps,
  readStack,
  retryDelayMs,
  runnableSteps,
  uniqueNames,
  type Discovery,
  type LedgerRow,
  type PlanStep,
} from "./voiceStackPlan.pure";
import { DEPENDENT_TEMPLATE_SEED, INDEPENDENT_TEMPLATE_SEED } from "./voiceStackTemplate.pure";

const discovery: Discovery = {
  tools: Object.fromEntries(
    INDEPENDENT_TEMPLATE_SEED.vapi.tools.map((t) => [t.templateToolId, "fn"]),
  ),
  files: ["1e87753e-6c9e-427f-8e72-95c24c0dcea6"],
  structuredOutputs: ["929cc802-0273-4190-8871-103a078b3542"],
  scorecards: ["4b17b93c-01fd-4f61-b34b-f4272ac15085"],
  stackSlots: [],
};

const row = (
  k: string,
  status: LedgerRow["status"],
  over: Partial<LedgerRow> = {},
): [string, LedgerRow] => [
  k,
  {
    step_key: k,
    status,
    external_id: null,
    external_ref: null,
    payload_sha: null,
    detail: null,
    attempts: 0,
    next_attempt_at: null,
    ...over,
  },
];

function doneAll(steps: PlanStep[], except: string[] = []): Map<string, LedgerRow> {
  return new Map(steps.filter((s) => !except.includes(s.key)).map((s) => row(s.key, "done")));
}

describe("the plan", () => {
  it("reads the template first, and plans nothing else until it has", () => {
    expect(
      planStackSteps(INDEPENDENT_TEMPLATE_SEED, "independent", null).map((s) => s.key),
    ).toEqual(["discover"]);
  });

  const steps = planStackSteps(INDEPENDENT_TEMPLATE_SEED, "independent", discovery);
  const keys = steps.map((s) => s.key);

  it("has one step per object, every key unique", () => {
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.startsWith("make_hook:"))).toHaveLength(9);
    expect(keys.filter((k) => k.startsWith("make_scenario:"))).toHaveLength(9);
    expect(keys.filter((k) => k.startsWith("vapi_assistant:"))).toHaveLength(13);
    expect(keys).toContain("make_records:code_library");
    expect(keys).toContain("voice_automation_register");
  });

  it("only ever depends on a step planned BEFORE it", () => {
    const at = new Map(keys.map((k, i) => [k, i]));
    for (const s of steps) for (const a of s.after) expect(at.get(a)!).toBeLessThan(at.get(s.key)!);
  });

  it("switches nothing on until the whole stack exists, and verifies last", () => {
    const activate = steps.find((s) => s.key === "make_activate:adapter")!;
    expect(activate.after).toContain("vapi_squad");
    expect(activate.after).toContain("make_cfg_assistants");
    expect(activate.after).toContain("make_scenario:manage_booking");
    expect(keys[keys.length - 1]).toBe("verify");
  });

  it("asks the tenant for the dependent line's GoHighLevel grant as its own step", () => {
    const dep = planStackSteps(DEPENDENT_TEMPLATE_SEED, "dependent", {
      ...discovery,
      stackSlots: ["ghl"],
    });
    expect(dep.map((s) => s.key)).toContain("make_connection_request:ghl");
    expect(dep.map((s) => s.key)).not.toContain("voice_automation_register");
    expect(dep.map((s) => s.key)).not.toContain("make_cfg");
  });
});

describe("one tick", () => {
  const steps = planStackSteps(INDEPENDENT_TEMPLATE_SEED, "independent", discovery);
  const now = Date.parse("2026-10-11T00:00:00Z");

  it("runs the first step on an empty ledger, then whatever its completion unlocks", () => {
    expect(runnableSteps(steps, new Map(), now).map((s) => s.key)).toEqual(["discover"]);
    const after = runnableSteps(steps, new Map([row("discover", "done")]), now).map((s) => s.key);
    expect(after).toContain("make_folder");
    expect(after).toContain("clone_call_log_secret");
    expect(after).not.toContain("make_hook:adapter");
  });

  it("never re-runs a done step, and waits out a back-off", () => {
    const ledger = new Map([
      row("discover", "done"),
      row("make_folder", "failed", {
        attempts: 1,
        next_attempt_at: new Date(now + 60_000).toISOString(),
      }),
    ]);
    expect(runnableSteps(steps, ledger, now).map((s) => s.key)).not.toContain("make_folder");
    expect(runnableSteps(steps, ledger, now + 120_000).map((s) => s.key)).toContain("make_folder");
  });

  it("stops retrying after the last attempt", () => {
    const ledger = new Map([
      row("discover", "done"),
      row("make_folder", "failed", { attempts: MAX_STEP_ATTEMPTS }),
    ]);
    expect(runnableSteps(steps, ledger, now).map((s) => s.key)).not.toContain("make_folder");
    expect(
      readStack(steps, ledger, { blocked: false, parked: false, discovered: true }).failed[0]
        .exhausted,
    ).toBe(true);
  });

  it("backs off 2, 4, 8 minutes, capped at six hours", () => {
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(3)).toBe(480_000);
    expect(retryDelayMs(30)).toBe(6 * 3_600_000);
  });
});

describe("the stack's status is derived", () => {
  const steps = planStackSteps(DEPENDENT_TEMPLATE_SEED, "dependent", {
    ...discovery,
    stackSlots: ["ghl"],
  });
  const flags = { blocked: false, parked: false, discovered: true };

  it("is live only when every step is done", () => {
    expect(readStack(steps, doneAll(steps), flags).status).toBe("live");
  });

  it("is waiting on a connection — not failed — when the only open steps wait on the tenant's grant", () => {
    const ledger = doneAll(
      steps,
      steps
        .filter(
          (s) =>
            s.kind === "make_activate" ||
            s.key === "verify" ||
            s.kind === "make_connection_request",
        )
        .map((s) => s.key),
    );
    ledger.set(...row("make_connection_request:ghl", "waiting"));
    for (const s of steps.filter((x) => x.kind === "make_activate"))
      ledger.set(...row(s.key, "waiting"));
    expect(readStack(steps, ledger, flags).status).toBe("awaiting_connections");
  });

  it("puts a block, a park and a failure ahead of progress", () => {
    expect(readStack(steps, new Map(), { ...flags, blocked: true }).status).toBe(
      "awaiting_requirements",
    );
    expect(readStack(steps, doneAll(steps), { ...flags, parked: true }).status).toBe("parked");
    const failing = doneAll(steps, ["verify"]);
    failing.set(...row("verify", "failed", { attempts: MAX_STEP_ATTEMPTS }));
    expect(readStack(steps, failing, flags).status).toBe("failed");
    expect(readStack(steps, new Map(), flags).status).toBe("ready");
  });

  it("is still building, not failed, while a failed step has a retry to come", () => {
    const retrying = doneAll(steps, ["verify"]);
    retrying.set(...row("verify", "failed", { attempts: 1 }));
    const reading = readStack(steps, retrying, flags);
    expect(reading.status).toBe("provisioning");
    expect(reading.failed).toEqual([expect.objectContaining({ key: "verify", exhausted: false })]);
  });
});

describe("assistant names in the tenant's org", () => {
  it("are unique even where two truncate to the same name", () => {
    const names = uniqueNames(
      [
        { key: "a", name: "Acme Realty Strategy Session Phone", role: "no_show" },
        { key: "b", name: "Acme Realty Strategy Session Phone", role: "follow_up" },
        { key: "c", name: "Acme Realty Inbound", role: "inbound" },
      ],
      40,
    );
    expect(new Set(names.values()).size).toBe(3);
    for (const n of names.values()) expect(n.length).toBeLessThanOrEqual(40);
    expect(names.get("c")).toBe("Acme Realty Inbound");
  });
});
