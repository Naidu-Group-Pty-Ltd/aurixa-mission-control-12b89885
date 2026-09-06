import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  planMissionControlLink,
  decideMissionControlLinkRepair,
  resolveMissionControlOrigin,
  cloneWebhookUrl,
  isMissionControlWebhookUrl,
  agencyNameFor,
  isLinkKeyLive,
  CLONE_WEBHOOK_EVENTS,
  DEFAULT_MISSION_CONTROL_ORIGIN,
  MISSION_CONTROL_LINK_KEY_LABEL,
  MISSION_CONTROL_LINK_REPAIR_COOLDOWN_MS,
  type LinkKeyFact,
  type MissionControlLinkFacts,
} from "./missionControlLink.pure";

const NOW = Date.parse("2026-09-06T06:00:00.000Z");
const REF = "umrtusxohxjxzodxorim";
const key = (over: Partial<LinkKeyFact> = {}): LinkKeyFact => ({
  id: "k1",
  label: MISSION_CONTROL_LINK_KEY_LABEL,
  revokedAt: null,
  revokeAt: null,
  deliveredProjectRef: REF,
  deliveredEnvAt: "2026-09-06T05:00:00.000Z",
  ...over,
});
const facts = (over: Partial<MissionControlLinkFacts> = {}): MissionControlLinkFacts => ({
  projectRef: REF,
  cloneName: "NPC Test",
  keys: [],
  endpoints: [],
  now: NOW,
  ...over,
});

describe("resolveMissionControlOrigin", () => {
  it("takes PUBLIC_APP_URL when it is an https origin, and the custom domain otherwise", () => {
    expect(resolveMissionControlOrigin({ PUBLIC_APP_URL: "https://mc.example.com/" })).toBe("https://mc.example.com");
    expect(resolveMissionControlOrigin({ PUBLIC_APP_URL: "mc.example.com" })).toBe("https://mc.example.com");
    expect(resolveMissionControlOrigin({})).toBe(DEFAULT_MISSION_CONTROL_ORIGIN);
    expect(resolveMissionControlOrigin({ PUBLIC_APP_URL: "http://localhost:3000" })).toBe(DEFAULT_MISSION_CONTROL_ORIGIN);
    expect(resolveMissionControlOrigin({ PUBLIC_APP_URL: "not a url" })).toBe(DEFAULT_MISSION_CONTROL_ORIGIN);
  });

  it("never the lovable.app origin by default — it answers the hooks 401", () => {
    expect(DEFAULT_MISSION_CONTROL_ORIGIN).not.toContain("lovable.app");
  });
});

describe("the clone's receiver", () => {
  it("is the clone's own mission-control-webhook function, recognised by shape", () => {
    expect(cloneWebhookUrl(REF)).toBe(`https://${REF}.supabase.co/functions/v1/mission-control-webhook`);
    expect(isMissionControlWebhookUrl(cloneWebhookUrl(REF))).toBe(true);
    // The endpoint that existed pointed at a misspelt prime hostname.
    expect(isMissionControlWebhookUrl("https://command-centre.npc.services.com.au")).toBe(false);
    expect(isMissionControlWebhookUrl("https://evil.example/functions/v1/mission-control-webhook")).toBe(false);
  });

  it("subscribes to every event the receiver handles", () => {
    expect([...CLONE_WEBHOOK_EVENTS].sort()).toEqual(
      ["tokens.alert", "tokens.balance.updated", "tokens.key.revoked", "tokens.key.rotated"].sort(),
    );
  });
});

describe("planMissionControlLink — minted where delivered, never rotated on a repair", () => {
  it("mints when no live key has been delivered to this project", () => {
    const plan = planMissionControlLink(facts());
    expect(plan.mintKey).toBe(true);
    expect(plan.revokeKeyIds).toEqual([]);
  });

  it("leaves a live delivered key alone", () => {
    const plan = planMissionControlLink(facts({ keys: [key()] }));
    expect(plan.mintKey).toBe(false);
    expect(plan.why[0]).toMatch(/never rotated/);
  });

  it("a key delivered to a repository file only is not a delivered key", () => {
    // Every auto-provisioned key sat like this: live, unused, delivered nowhere.
    const plan = planMissionControlLink(
      facts({ keys: [key({ label: "auto-provisioned", deliveredProjectRef: null, deliveredEnvAt: null })] }),
    );
    expect(plan.mintKey).toBe(true);
    // ...and it is not this step's to revoke.
    expect(plan.revokeKeyIds).toEqual([]);
  });

  it("revokes ITS OWN undelivered or elsewhere-delivered keys when a new one lands", () => {
    const plan = planMissionControlLink(
      facts({
        keys: [
          key({ id: "undelivered", deliveredEnvAt: null }),
          key({ id: "old-project", deliveredProjectRef: "otherref00000000000" }),
          key({ id: "operator", label: "operator-issued", deliveredProjectRef: null, deliveredEnvAt: null }),
          key({ id: "already-gone", deliveredEnvAt: null, revokedAt: "2026-09-01T00:00:00.000Z" }),
        ],
      }),
    );
    expect(plan.mintKey).toBe(true);
    expect(plan.revokeKeyIds.sort()).toEqual(["old-project", "undelivered"]);
  });

  it("a key scheduled to revoke in the past is not live", () => {
    expect(isLinkKeyLive(key({ revokeAt: new Date(NOW - 1000).toISOString() }), NOW)).toBe(false);
    expect(isLinkKeyLive(key({ revokeAt: new Date(NOW + 1000).toISOString() }), NOW)).toBe(true);
    expect(isLinkKeyLive(key({ revokedAt: "2026-09-01T00:00:00.000Z" }), NOW)).toBe(false);
  });

  it("creates the endpoint when the clone has none of the right shape, leaving an operator's alone", () => {
    const plan = planMissionControlLink(
      facts({ endpoints: [{ id: "op", url: "https://ops.example/hook", isActive: true, events: ["tokens.alert"] }] }),
    );
    expect(plan.endpoint.action).toBe("create");
    expect(plan.endpoint.url).toBe(cloneWebhookUrl(REF));
    expect(plan.endpoint.events).toEqual([...CLONE_WEBHOOK_EVENTS]);
  });

  it("re-points, re-activates and extends its own endpoint, and reuses one that is right", () => {
    const right = { id: "e", url: cloneWebhookUrl(REF), isActive: true, events: [...CLONE_WEBHOOK_EVENTS] };
    expect(planMissionControlLink(facts({ endpoints: [right] })).endpoint.action).toBe("reuse");
    const moved = planMissionControlLink(facts({ endpoints: [{ ...right, url: cloneWebhookUrl("oldref0000000000000a") }] }));
    expect(moved.endpoint.action).toBe("update");
    expect(moved.endpoint.changes[0]).toMatch(/re-pointed/);
    const off = planMissionControlLink(facts({ endpoints: [{ ...right, isActive: false }] }));
    expect(off.endpoint.changes).toEqual(["re-activated"]);
    const partial = planMissionControlLink(facts({ endpoints: [{ ...right, events: ["tokens.alert"] }] }));
    expect(partial.endpoint.action).toBe("update");
    expect(partial.endpoint.events.sort()).toEqual([...CLONE_WEBHOOK_EVENTS].sort());
  });

  it("names the agency from the clone's name and says when it cannot", () => {
    expect(planMissionControlLink(facts()).agencyName).toBe("NPC Test");
    expect(agencyNameFor("  Preflight   Property Group ")).toBe("Preflight Property Group");
    const nameless = planMissionControlLink(facts({ cloneName: "  " }));
    expect(nameless.agencyName).toBeNull();
    expect(nameless.why.some((w) => w.includes("MISSION_CONTROL_AGENCY_NAME"))).toBe(true);
  });
});

describe("decideMissionControlLinkRepair", () => {
  const base = { projectRef: REF, ledgerStatus: null, lastError: null, updatedAt: null, now: NOW };
  it("skips a clone with no backend", () => {
    expect(decideMissionControlLinkRepair({ ...base, projectRef: null })).toEqual({ act: false, reason: "no_backend" });
  });
  it("STILL acts on a ledger that says set — the delivery record decides", () => {
    expect(decideMissionControlLinkRepair({ ...base, ledgerStatus: "set" }).act).toBe(true);
  });
  it("cools off after a failed attempt, then retries", () => {
    const recent = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(decideMissionControlLinkRepair({ ...base, ledgerStatus: "failed", lastError: "x", updatedAt: recent })).toEqual({
      act: false,
      reason: "cooling_off",
    });
    const old = new Date(NOW - MISSION_CONTROL_LINK_REPAIR_COOLDOWN_MS - 1000).toISOString();
    expect(decideMissionControlLinkRepair({ ...base, ledgerStatus: "failed", lastError: "x", updatedAt: old }).act).toBe(true);
  });
});

describe("the link is written endpoint first, in one request, and the key is never logged", () => {
  const server = () => readFileSync("src/server/cloneMissionControlLink.server.ts", "utf8");
  const functions = () => readFileSync("src/lib/backend-provisioning.functions.ts", "utf8");

  it("endpoint row, then key row, then ONE environment write, then the delivery stamp", () => {
    const s = server();
    // The write verb is asserted on the slice, not spelled in a needle: the
    // discarded-errors guard reads a `.insert(` literal here as a write.
    // Six-space indent: the write inside the branch, not the read above it.
    const endpoint = s.indexOf('.from("token_webhook_endpoints")\n      ');
    const keyRow = s.indexOf('.from("clone_api_keys")\n      ');
    const env = s.indexOf("setCloneSecretValues(");
    const stamp = s.indexOf("delivered_env_at: nowIso");
    expect(endpoint).toBeGreaterThan(-1);
    expect(s.slice(endpoint, endpoint + 80)).toContain("insert(");
    expect(keyRow).toBeGreaterThan(endpoint);
    expect(s.slice(keyRow, keyRow + 80)).toContain("insert(");
    expect(env).toBeGreaterThan(keyRow);
    expect(stamp).toBeGreaterThan(env);
    expect(s.match(/setCloneSecretValues\(/g)?.length).toBe(1);
  });

  it("the key is recorded against the ref it was delivered to", () => {
    expect(server()).toMatch(/delivered_project_ref: projectRef/);
  });

  it("the raw key reaches the values map and nothing else", () => {
    const s = server();
    for (const line of s.split("\n").filter((l) => /console\.(error|warn|log)/.test(l))) {
      expect(line).not.toMatch(/minted\.raw|\.values|webhookSecret/);
    }
    const event = s
      .slice(s.indexOf("async function recordEvent"), s.indexOf("export type MissionControlLinkReconcileResult"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(event).not.toMatch(/raw|secret|values/i);
    const outcome = s.slice(s.indexOf("export type MissionControlLinkOutcome"), s.indexOf("export type EnsureMissionControlLinkResult"));
    expect(outcome).not.toMatch(/raw|secret|value/i);
  });

  it("provisioning supplies the linker from the module that holds the database client", () => {
    const f = functions();
    expect(f).toMatch(/linkMissionControl: async \(ref: string\) =>/);
    expect(f).toMatch(/ensureCloneMissionControlLink\(supabase, input\.cloneId, ref, input\.cloneName/);
    // And tells the batch what the identity steps already wrote.
    expect(f).toMatch(/settledSecrets\.TURNSTILE_SECRET_KEY = turnstileIdentity\.secret_written_at/);
    expect(f).toMatch(/settledSecrets\.REQUIRE_TURNSTILE = turnstileIdentity\.fail_closed_at/);
    expect(f).toMatch(/settledSecrets\.RESEND_API_KEY = emailIdentity\.key_written_at/);
  });

  it("the deployment drain re-derives the config when a domain goes live", () => {
    const d = readFileSync("src/routes/hooks.deployment-drain.tsx", "utf8");
    const origins = d.indexOf("applyCloneAllowedOrigins(admin, row.clone_id");
    const derived = d.indexOf("applyCloneDerivedConfig(admin, row.clone_id");
    expect(origins).toBeGreaterThan(-1);
    expect(derived).toBeGreaterThan(origins);
  });
});
