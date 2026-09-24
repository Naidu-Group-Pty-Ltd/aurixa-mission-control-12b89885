/**
 * The lateral boundary between the two parents, asserted against the files
 * that were actually there when it was built.
 *
 * Every fixture below is the SHAPE of a file measured on 23 Sep 2026 in one
 * parent and absent from the other — the reminders fix, the backend-isolation
 * scripts, the registry-prune workflow, the CRM routing layer, the native-CRM
 * migration. Refs and hosting ids are synthetic: the test asserts what a
 * reading does with a shape, and no real identifier needs to live in it.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classify,
  edgeFunctionOf,
  isCrmRoutingLayerPath,
  isMigrationPath,
  readingFor,
} from "./ionSpecies.pure";
import { permeate } from "./membrane.pure";
import { FLEET_MEMBRANES, PRIME_REPO, resolveMembrane } from "./fleetMembranes.pure";
import {
  CRM_DEPENDENT_PARENT,
  CRM_INDEPENDENT_PARENT,
  FLEET_LATERALS,
  lateralMembrane,
  lateralsTouching,
  otherSide,
} from "./lateralMembranes.pure";

const DEP = CRM_DEPENDENT_PARENT;
const IND = CRM_INDEPENDENT_PARENT;
const INTO_IND = lateralMembrane(DEP, IND)!;
const INTO_DEP = lateralMembrane(IND, DEP)!;

/** Synthetic, in the shapes the measured files carry them. */
const OWN_REF = "abcdefghijklmnopqrst";
const OTHER_REF = "zyxwvutsrqponmlkjihg";
const KNOWN = [OWN_REF, OTHER_REF];
const VERCEL_PROJECT = "prj_AbCdEfGhIjKlMnOpQrStUvWxYz12";
const VERCEL_TEAM = "team_AbCdEfGhIjKlMnOpQrStUvWx";

/** The shape of `src/lib/reminders/priority.pure.ts` on the dependent parent. */
const REMINDERS_FIX = `
export type ReminderPriority = "high" | "medium" | "low";
export function priorityOf(dueAt: string, now: Date): ReminderPriority {
  const days = (Date.parse(dueAt) - now.getTime()) / 86_400_000;
  return days < 1 ? "high" : days < 7 ? "medium" : "low";
}
`;

/** The shape of `scripts/clone-backend/02-deploy-functions.py`: refs as bare strings. */
const DEPLOY_SCRIPT = `
import os, requests
PRIME  = '${OTHER_REF}'
TARGET = '${OWN_REF}'
def deploy(fn):
    requests.post(f"https://api.supabase.com/v1/projects/{TARGET}/functions/deploy", json={"slug": fn})
`;

/** The shape of `.github/workflows/vcr-prune.yml`: hosting ids as defaults. */
const PRUNE_WORKFLOW = `
on:
  workflow_dispatch:
    inputs:
      team_id:
        default: "${VERCEL_TEAM}"
      project_id:
        default: "${VERCEL_PROJECT}"
jobs:
  prune:
    runs-on: ubuntu-latest
    env:
      PROJECT_ID: \${{ inputs.project_id || '${VERCEL_PROJECT}' }}
`;

/** A browser-layer call to a routed GoHighLevel function, the way the dependent writes it. */
const GHL_CALL = `
import { supabase } from "@/integrations/supabase/client";
export const send = () => supabase.functions.invoke('send-ghl-message', { body: {} });
`;

/** The species a blocked verdict was refused on, read from the row the pull request prints. */
function blockedOn(v: ReturnType<typeof permeate>): string | null {
  if (v.kind !== "blocked") return null;
  return /· (\w+) channel closed\)$/.exec(v.held.pattern)?.[1] ?? null;
}

describe("the boundary joins the two parents and nobody else", () => {
  it("is declared once, between the two deployments the prime feeds directly", () => {
    expect(FLEET_LATERALS).toHaveLength(1);
    const [boundary] = FLEET_LATERALS;
    expect([...boundary.sides].sort()).toEqual([DEP, IND].sort());
    // Both sides are real vertical destinations of the prime. A lateral
    // boundary between repositories the fleet does not have would draw a
    // membrane nothing crosses and a lane that reads nothing.
    for (const side of boundary.sides) {
      expect(FLEET_MEMBRANES.some((m) => m.from === PRIME_REPO && m.to === side)).toBe(true);
    }
  });

  it("gives each direction the membrane of the side being ENTERED", () => {
    // What may enter a deployment is a fact about that deployment.
    expect(INTO_IND.from).toBe(DEP);
    expect(INTO_IND.to).toBe(IND);
    expect(INTO_DEP.from).toBe(IND);
    expect(INTO_DEP.to).toBe(DEP);
    const [boundary] = FLEET_LATERALS;
    for (const [to, membrane] of Object.entries(boundary.toward)) {
      expect(membrane.to).toBe(to);
      expect(membrane.from).toBe(otherSide(boundary, to));
    }
  });

  it("answers nothing for a pair no boundary joins — never a default", () => {
    // A vertical edge nobody described gets the default membrane, because a
    // clone provisioned tomorrow must behave as every clone did yesterday.
    // Sideways, yesterday nothing moved, so an unknown pair carries nothing.
    expect(lateralMembrane(DEP, DEP)).toBeNull();
    expect(lateralMembrane(DEP, "npc-test-76b3b3")).toBeNull();
    expect(lateralMembrane("npc-test-76b3b3", "preflight-property-group")).toBeNull();
    expect(lateralMembrane(PRIME_REPO, DEP)).toBeNull();
  });

  it("finds the boundary from either side, and from no child", () => {
    expect(lateralsTouching(DEP)).toHaveLength(1);
    expect(lateralsTouching(IND)).toHaveLength(1);
    expect(lateralsTouching("npc-test-76b3b3")).toEqual([]);
    expect(lateralsTouching(PRIME_REPO)).toEqual([]);
    const [boundary] = FLEET_LATERALS;
    expect(otherSide(boundary, DEP)).toBe(IND);
    expect(otherSide(boundary, IND)).toBe(DEP);
    expect(otherSide(boundary, PRIME_REPO)).toBeNull();
  });

  it("records against a fixed uuid, because the ledger's entity column is one", () => {
    const [boundary] = FLEET_LATERALS;
    expect(boundary.ledgerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("the CRM line the vertical membranes draw holds sideways too", () => {
  const verticalInto = (repo: string) => resolveMembrane(PRIME_REPO, repo);
  const stateOf = (channels: typeof INTO_IND.channels, species: string) =>
    channels.find((c) => c.species === species)?.state;

  it("keeps a routed name out of the independent's browser layer, exactly as the prime's edge does", () => {
    expect(stateOf(INTO_IND.channels, "routed_crm_name")).toBe("closed");
    expect(stateOf(verticalInto(IND).channels, "routed_crm_name")).toBe("closed");
    const inbound = INTO_IND.channels.find((c) => c.species === "routed_crm_name")!;
    expect(inbound.within).toBe("src/**");

    const v = permeate(INTO_IND, { path: "src/components/clients/Send.tsx", text: GHL_CALL });
    expect(v.kind).toBe("blocked");
  });

  it("admits the same call into the dependent, which is what that deployment is supposed to say", () => {
    expect(stateOf(INTO_DEP.channels, "routed_crm_name")).toBe("open");
    expect(stateOf(verticalInto(DEP).channels, "routed_crm_name")).toBe("open");
    expect(
      permeate(INTO_DEP, { path: "src/components/clients/Send.tsx", text: GHL_CALL }).kind,
    ).toBe("crosses");
  });

  it("never lets the routing layer into the deployment that holds no routing table", () => {
    for (const path of [
      "src/lib/crm/crmProvider.ts",
      "src/lib/crm/__tests__/crmIndependence.spec.ts",
      "supabase/functions/_shared/crm/nativeOutbound.pure.ts",
      "docs/crm/CRM_INDEPENDENCE.md",
    ]) {
      const v = permeate(INTO_DEP, { path, text: "export {};" });
      expect(blockedOn(v), path).toBe("crm_routing_layer");
      if (v.kind === "blocked") expect(v.held.reason, path).toBe("protected");
    }
  });

  it("names a native crm-* function as the routing layer, not as a function to bring across", () => {
    // A native function is both, and `permeate` reports the first closed
    // channel it trips. Named as an edge function, the operator would be
    // told to carry it with its declaration — the remedy for a file that
    // must never arrive at all.
    expect(INTO_DEP.channels[0].species).toBe("crm_routing_layer");
    const v = permeate(INTO_DEP, {
      path: "supabase/functions/crm-send-message/index.ts",
      text: "Deno.serve(() => new Response('ok'));",
    });
    expect(blockedOn(v)).toBe("crm_routing_layer");
  });

  it("leaves the routing layer open into the deployment whose architecture it is", () => {
    expect(stateOf(INTO_IND.channels, "crm_routing_layer")).toBe("open");
  });
});

describe("what never crosses in either direction", () => {
  it.each([
    ["into the independent", () => INTO_IND],
    ["into the dependent", () => INTO_DEP],
  ])("%s: a migration is another database's history", (_label, into) => {
    const v = permeate(into(), {
      path: "supabase/migrations/20261205000000_native_crm_tables.sql",
      text: "create table crm_messages (id uuid primary key);",
    });
    expect(blockedOn(v)).toBe("migration");
    if (v.kind === "blocked") expect(v.held.reason).toBe("protected");
  });

  it.each([
    ["into the independent", () => INTO_IND],
    ["into the dependent", () => INTO_DEP],
  ])("%s: a function's source travels without its declaration", (_label, into) => {
    const v = permeate(into(), {
      path: "supabase/functions/reminders-digest/index.ts",
      text: "Deno.serve(() => new Response('ok'));",
    });
    expect(blockedOn(v)).toBe("edge_function");
  });

  it("does not mistake the shared directory for a function", () => {
    // `_shared/` is imported by functions and deployed with none of its own.
    expect(edgeFunctionOf("supabase/functions/_shared/crm/crmProvider.ts")).toBeNull();
    expect(edgeFunctionOf("supabase/functions/import_map.json")).toBeNull();
    expect(edgeFunctionOf("supabase/functions/reminders-digest/index.ts")).toBe("reminders-digest");
    expect(
      permeate(INTO_IND, {
        path: "supabase/functions/_shared/reminders.pure.ts",
        text: "export {};",
      }).kind,
    ).toBe("crosses");
  });

  it("holds the dependent's deploy script on the refs it names bare", () => {
    const path = "scripts/clone-backend/02-deploy-functions.py";
    const v = permeate(INTO_IND, { path, text: DEPLOY_SCRIPT, knownRefs: KNOWN });
    expect(blockedOn(v)).toBe("backend_ref");
    expect([...(readingFor(v.readings, "backend_ref")?.tokens ?? [])].sort()).toEqual(
      [...KNOWN].sort(),
    );
  });

  it("could not have seen them without the fleet's own list — which is why it is passed", () => {
    // The anchored shapes are a shipped file's. A script names a project as
    // a bare string, and a bare twenty-letter word is only safe to match
    // when it is a ref this fleet is known to own.
    const path = "scripts/clone-backend/02-deploy-functions.py";
    expect(permeate(INTO_IND, { path, text: DEPLOY_SCRIPT }).kind).toBe("crosses");
  });

  it("holds a document that names a project by URL, in either direction", () => {
    const text = `Calls target \`https://${OTHER_REF}.supabase.co\` — the prime itself.`;
    for (const into of [INTO_IND, INTO_DEP]) {
      const v = permeate(into, { path: "docs/BACKEND_ISOLATION.md", text });
      expect(blockedOn(v)).toBe("backend_ref");
    }
  });

  it("holds the registry-prune workflow on the hosting ids it defaults to", () => {
    const v = permeate(INTO_IND, { path: ".github/workflows/vcr-prune.yml", text: PRUNE_WORKFLOW });
    expect(blockedOn(v)).toBe("hosting_ref");
    expect(readingFor(v.readings, "hosting_ref")?.tokens).toEqual(
      [VERCEL_PROJECT, VERCEL_TEAM].sort(),
    );
  });

  it("lets the reminders fix cross, which is the work this boundary exists to carry", () => {
    for (const into of [INTO_IND, INTO_DEP]) {
      expect(
        permeate(into, {
          path: "src/lib/reminders/priority.pure.ts",
          text: REMINDERS_FIX,
          knownRefs: KNOWN,
        }).kind,
      ).toBe("crosses");
    }
  });
});

describe("the new species are facts about the vertical lane too, and change nothing there", () => {
  // The readings are added to `classify`, which every membrane asks. A
  // vertical membrane declares no channel on any of them, and `permeate`
  // enforces only what a membrane declares — so the prime's cascade must
  // carry exactly what it carried before. Asserted, not assumed.
  it.each([
    ["supabase/migrations/20261205000000_native_crm_tables.sql", "create table t ();"],
    ["supabase/functions/crm-send-message/index.ts", "Deno.serve(() => new Response('ok'));"],
    ["src/lib/crm/crmProvider.ts", "export const x = 1;"],
    [".github/workflows/vcr-prune.yml", PRUNE_WORKFLOW],
  ])("%s crosses every vertical edge it crossed yesterday", (path, text) => {
    for (const m of FLEET_MEMBRANES) {
      expect(permeate(m, { path, text }).kind, `${m.from}→${m.to}`).toBe("crosses");
    }
  });
});

describe("the readings themselves", () => {
  it("places the routing layer by its four roots and nothing near them", () => {
    expect(isCrmRoutingLayerPath("src/lib/crm/crmProvider.ts")).toBe(true);
    expect(isCrmRoutingLayerPath("src/lib/crm/__tests__/nativeInbound.test.ts")).toBe(true);
    expect(isCrmRoutingLayerPath("supabase/functions/crm-calendar/index.ts")).toBe(true);
    expect(isCrmRoutingLayerPath("supabase/functions/_shared/crm/nativeOutbound.pure.ts")).toBe(
      true,
    );
    expect(isCrmRoutingLayerPath("docs/crm/CRM_INDEPENDENCE.md")).toBe(true);
    // A sibling whose name merely starts the same way is not the layer.
    expect(isCrmRoutingLayerPath("src/lib/crmUtils.ts")).toBe(false);
    expect(isCrmRoutingLayerPath("supabase/functions/ghl-conversations/index.ts")).toBe(false);
    expect(isCrmRoutingLayerPath("docs/crmNotes.md")).toBe(false);
  });

  it("reads a migration by its directory", () => {
    expect(isMigrationPath("supabase/migrations/20261205000000_native_crm_tables.sql")).toBe(true);
    expect(isMigrationPath("supabase/seed.sql")).toBe(false);
  });

  it("reads a path species without reading the text, so a binary still carries one", () => {
    const readings = classify({ path: "supabase/functions/og-image/font.ttf", text: null });
    expect(readingFor(readings, "edge_function")).not.toBeNull();
  });

  it("reads no hosting id out of prose or a short token", () => {
    const at = (text: string) => readingFor(classify({ path: "a.yml", text }), "hosting_ref");
    expect(at("the prj_ prefix names a project")).toBeNull();
    expect(at("prj_short")).toBeNull();
    expect(at(`id: ${VERCEL_PROJECT}`)?.tokens).toEqual([VERCEL_PROJECT]);
  });

  it("matches a known ref as a whole token only", () => {
    const at = (text: string) =>
      readingFor(classify({ path: "a.py", text, knownRefs: [OWN_REF] }), "backend_ref");
    expect(at(`TARGET = '${OWN_REF}'`)?.tokens).toEqual([OWN_REF]);
    expect(at(`x${OWN_REF}`)).toBeNull();
    expect(at(`${OWN_REF}9`)).toBeNull();
    // A value that is not the shape of a ref is never treated as one, whoever
    // supplied it — the list is a fact about the fleet, not a pattern.
    expect(
      readingFor(classify({ path: "a.py", text: "the word", knownRefs: ["the"] }), "backend_ref"),
    ).toBeNull();
  });
});

describe("every channel explains itself, and every organ is where it says", () => {
  it("names a reason and a note on every channel in both directions", () => {
    for (const into of [INTO_IND, INTO_DEP]) {
      for (const c of into.channels) {
        expect(c.note.length, `${into.to}:${c.species}`).toBeGreaterThan(40);
        expect(c.within.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares each species once per direction", () => {
    for (const into of [INTO_IND, INTO_DEP]) {
      const species = into.channels.map((c) => c.species);
      expect(new Set(species).size).toBe(species.length);
    }
  });

  it("declares the same species in both directions, so the band draws one pore per species", () => {
    const a = INTO_IND.channels.map((c) => c.species).sort();
    const b = INTO_DEP.channels.map((c) => c.species).sort();
    expect(a).toEqual(b);
  });

  it("names only organs that exist where it says they run", () => {
    const files = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.add(name);
      }
    };
    walk("src/server/cascade");
    walk("src/lib/cascade");
    const [boundary] = FLEET_LATERALS;
    for (const organ of boundary.standing) {
      expect(organ.kind).toBe("channel");
      if (organ.where.endsWith(".ts")) {
        expect(files.has(organ.where), organ.name).toBe(true);
      }
    }
    expect(existsSync("src/server/cascade/lateralExchange.pure.ts")).toBe(true);
  });
});
