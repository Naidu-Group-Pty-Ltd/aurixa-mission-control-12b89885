import { describe, expect, it } from "vitest";
import {
  CRM_PROVIDER_ENV,
  CRM_ROUTER_PATH,
  ROUTED_CRM_FUNCTION_NAMES,
  SECURITY_BASELINE_PATH,
  classify,
  isSpecPath,
  readingFor,
  routingRuleReaches,
} from "./ionSpecies.pure";
import { orphanSpecHold, permeate, strandedSubjects, subjectsNamedBy } from "./membrane.pure";
import type { Membrane } from "./membrane.pure";
import {
  FLEET_MEMBRANES,
  PRIME_REPO,
  membraneInto,
  membranesTouching,
  resolveMembrane,
} from "./fleetMembranes.pure";
import {
  reportableHeld,
  approvableHeld,
  backendRefsIn,
} from "@/server/cascade/syncExclusions.pure";

/**
 * Verbatim from npc-crm-independent-6505dc `src/components/clients/
 * ClientConversationsTab.tsx`, which is byte-identical to the prime's copy
 * and carries four of the names measured on 21 Sep 2026.
 */
const BREACHED_TSX = `
import { supabase } from "@/integrations/supabase/client";
export function ClientConversationsTab() {
  const load = () => supabase.functions.invoke('ghl-conversations', { body: {} });
  const msgs = () => supabase.functions.invoke('ghl-messages', { body: {} });
  const send = () => supabase.functions.invoke('send-ghl-message', { body: {} });
  const sync = () => supabase.functions.invoke('sync-ghl-conversations', { body: {} });
  return null;
}
`;

/** The same component as the clone's own architecture says it must be written. */
const ROUTED_TSX = `
import { crmFunction } from "@/lib/crm/crmProvider";
export function ClientConversationsTab() {
  const send = () => supabase.functions.invoke(crmFunction("sendMessage"), { body: {} });
  return null;
}
`;

describe("what a chunk is", () => {
  it("reads a GoHighLevel invocation, and names every one it found", () => {
    const r = readingFor(
      classify({ path: "src/components/x.tsx", text: BREACHED_TSX }),
      "routed_crm_name",
    );
    // Two of the four names in that file, and only two.
    //
    // `ClientConversationsTab.tsx` on the CRM-independent clone spells
    // `'ghl-conversations'` and `'ghl-messages'` TODAY, green, because they
    // are React Query cache keys — `queryKey: ['ghl-messages', ...]` — that
    // never reach a network call. The clone's own guard does not name them
    // and must not: holding that file would have held a live source file on
    // every pass for a cache key.
    expect(r?.tokens).toEqual(["send-ghl-message", "sync-ghl-conversations"]);
  });

  it("is silent about the same component written through the routing table", () => {
    const r = readingFor(
      classify({ path: "src/components/x.tsx", text: ROUTED_TSX }),
      "routed_crm_name",
    );
    expect(r).toBeNull();
  });

  it("does not mistake a filename or a guard for a call", () => {
    // `useGHLCalendar.tsx` is a filename, `ghlAffordancesAvailable` is the
    // guard that makes this survivable. A `ghl-` prefix rule flags both, and a
    // boundary whose refusals are mostly noise is one nobody reads.
    const text = `import { ghlAffordancesAvailable } from "./useGHLCalendar";\n// see ghl-calendar docs\n`;
    expect(
      readingFor(classify({ path: "src/hooks/useGHLCalendar.tsx", text }), "routed_crm_name"),
    ).toBeNull();
  });

  it("knows the baseline, the declarations and a spec by their path alone", () => {
    expect(
      readingFor(classify({ path: SECURITY_BASELINE_PATH, text: "{}" }), "security_baseline"),
    ).not.toBeNull();
    expect(
      readingFor(classify({ path: "supabase/config.toml", text: "" }), "function_declaration"),
    ).not.toBeNull();
    expect(
      readingFor(classify({ path: "src/lib/reports/__tests__/a.spec.ts", text: "" }), "spec"),
    ).not.toBeNull();
  });

  it("reads nothing out of a binary file", () => {
    // Asking a PNG whether it invokes an edge function asks a question of
    // characters that were never there.
    expect(classify({ path: "public/emblem.png", text: null })).toEqual([]);
  });

  it("recognises both spec spellings this fleet uses", () => {
    expect(isSpecPath("src/lib/reports/__tests__/riskRegister.spec.ts")).toBe(true);
    expect(isSpecPath("src/server/cascade/carrierRefresh.test.ts")).toBe(true);
    expect(isSpecPath("src/server/cascade/carrierRefresh.pure.ts")).toBe(false);
  });
});

describe("the two parents have different membranes, which is the point", () => {
  const dependent = resolveMembrane(PRIME_REPO, "npc-client-dashboard");
  const independent = resolveMembrane(PRIME_REPO, "npc-crm-independent-6505dc");
  const chunk = { path: "src/components/clients/ClientConversationsTab.tsx", text: BREACHED_TSX };

  it("admits GoHighLevel into the deployment whose CRM that is", () => {
    expect(permeate(dependent, chunk).kind).toBe("crosses");
  });

  it("refuses it into the deployment that routes through crmFunction()", () => {
    const v = permeate(independent, chunk);
    expect(v.kind).toBe("blocked");
    if (v.kind !== "blocked") throw new Error("unreachable");
    expect(v.held.note).toContain("send-ghl-message");
    expect(v.held.note).toContain("crmFunction()");
  });

  it("names the permitted form, not only the prohibition", () => {
    // A rule with no demonstrated alternative is one somebody routes around.
    const v = permeate(independent, chunk);
    if (v.kind !== "blocked") throw new Error("unreachable");
    expect(v.held.note).toContain("src/lib/crm/crmProvider.ts");
  });

  it("lets the routed version through the closed channel", () => {
    // The channel refuses a SPECIES, not a file. Written correctly, the same
    // component crosses — otherwise this is an exclusion wearing a new name.
    expect(permeate(independent, { path: chunk.path, text: ROUTED_TSX }).kind).toBe("crosses");
  });

  it("is bounded to the browser layer, because the clone keeps all 37 functions", () => {
    // Measured: npc-crm-independent holds 37 `ghl-*` edge functions and calls
    // them when configured to. Closing the channel over `supabase/functions/**`
    // would refuse the clone its own code.
    const edge = { path: "supabase/functions/ghl-calendar/index.ts", text: BREACHED_TSX };
    expect(permeate(independent, edge).kind).toBe("crosses");
  });

  it("produces an ordinary held row the pull request already reports", () => {
    const v = permeate(independent, chunk);
    if (v.kind !== "blocked") throw new Error("unreachable");
    expect(reportableHeld([v.held])).toHaveLength(1);
    expect(approvableHeld([v.held])).toHaveLength(1);
  });
});

describe("a spec travels with its subject or not at all", () => {
  const membrane = resolveMembrane(PRIME_REPO, "npc-crm-independent-6505dc");
  const SPEC = `
    const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20261126090000_x.sql'), 'utf8');
    const SRC = read('supabase/functions/market-sales-ingest/index.ts');
    const DOC = read('docs/reports/SCORING_V2_METHODOLOGY.md');
    expect(DOC).toContain('4.1.0');
  `;
  const specPath = "src/lib/reports/__tests__/openDataGrowthWiring.spec.ts";

  it("reads the subjects a spec names", () => {
    expect(subjectsNamedBy(SPEC)).toEqual([
      "docs/reports/SCORING_V2_METHODOLOGY.md",
      "supabase/functions/market-sales-ingest/index.ts",
      "supabase/migrations/20261126090000_x.sql",
    ]);
  });

  it("ignores a directory, which is not a file any delivery carries", () => {
    // The 21 measured specs also name `scripts/template-library`. Treating it
    // as a subject strands every one of them on a path nothing ever writes.
    expect(subjectsNamedBy(`read('scripts/template-library')`)).toEqual([]);
  });

  it("strands the spec on the two subjects measured on 21 Sep 2026", () => {
    const stranded = strandedSubjects({
      specPath,
      specText: SPEC,
      primeSha: new Map([
        ["supabase/functions/market-sales-ingest/index.ts", "new"],
        ["docs/reports/SCORING_V2_METHODOLOGY.md", "new"],
        ["supabase/migrations/20261126090000_x.sql", "same"],
      ]),
      cloneSha: new Map([
        ["supabase/functions/market-sales-ingest/index.ts", "old"],
        ["docs/reports/SCORING_V2_METHODOLOGY.md", "old"],
        ["supabase/migrations/20261126090000_x.sql", "same"],
      ]),
      crossing: new Set([specPath]),
    });
    expect(stranded).toEqual([
      "docs/reports/SCORING_V2_METHODOLOGY.md",
      "supabase/functions/market-sales-ingest/index.ts",
    ]);
  });

  it("says nothing when the subject travels with it", () => {
    const stranded = strandedSubjects({
      specPath,
      specText: SPEC,
      primeSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "new"]]),
      cloneSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "old"]]),
      crossing: new Set([specPath, "supabase/functions/market-sales-ingest/index.ts"]),
    });
    expect(stranded).toEqual([]);
  });

  it("says nothing when the subject did not change upstream", () => {
    // An unchanged subject cannot contradict an updated spec.
    const stranded = strandedSubjects({
      specPath,
      specText: SPEC,
      primeSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "same"]]),
      cloneSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "same"]]),
      crossing: new Set([specPath]),
    });
    expect(stranded).toEqual([]);
  });

  it("says nothing about a subject the clone never had", () => {
    // A spec for a feature that is not installed is a different defect, and
    // holding the spec for it would be a guess about scope.
    const stranded = strandedSubjects({
      specPath,
      specText: SPEC,
      primeSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "new"]]),
      cloneSha: new Map(),
      crossing: new Set([specPath]),
    });
    expect(stranded).toEqual([]);
  });

  it("changes nothing when a tree could not be listed", () => {
    // A tree that could not be read is not a tree with nothing in it.
    expect(
      strandedSubjects({
        specPath,
        specText: SPEC,
        primeSha: null,
        cloneSha: new Map(),
        crossing: new Set(),
      }),
    ).toEqual([]);
  });

  it("has no opinion about a file that is not a spec", () => {
    expect(
      strandedSubjects({
        specPath: "src/lib/reports/thing.ts",
        specText: SPEC,
        primeSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "new"]]),
        cloneSha: new Map([["supabase/functions/market-sales-ingest/index.ts", "old"]]),
        crossing: new Set(),
      }),
    ).toEqual([]);
  });

  it("names what is missing, and caps the list so a row stays readable", () => {
    const hold = orphanSpecHold({
      membrane,
      specPath,
      stranded: ["a/1.ts", "b/2.ts", "c/3.ts", "d/4.ts", "e/5.ts"],
    });
    expect(hold.note).toContain("a/1.ts, b/2.ts, c/3.ts");
    expect(hold.note).toContain("and 2 more");
    expect(hold.reason).toBe("manual_reconcile");
    expect(reportableHeld([hold])).toHaveLength(1);
  });
});

describe("the registry describes the fleet as it is", () => {
  it("covers every edge the fleet actually has", () => {
    const edges = FLEET_MEMBRANES.map((m) => `${m.from}→${m.to}`).sort();
    expect(edges).toEqual([
      "npc-client-dashboard→npc-test-76b3b3",
      "npc-client-dashboard→preflight-property-group",
      "npc-property-dashbord→npc-client-dashboard",
      "npc-property-dashbord→npc-crm-independent-6505dc",
    ]);
  });

  it("gives an unknown edge the standing organs and no new opinion", () => {
    // A clone provisioned tomorrow must behave exactly as every clone behaved
    // yesterday. A membrane that closed on an unknown edge would stop the
    // fleet rather than filter it.
    const m = resolveMembrane(PRIME_REPO, "somebody-new");
    expect(m.channels.every((c) => c.state !== "closed")).toBe(true);
    expect(m.standing.length).toBeGreaterThan(0);
    expect(permeate(m, { path: "src/x.tsx", text: BREACHED_TSX }).kind).toBe("crosses");
  });

  it("names the organs that already run, both kinds", () => {
    const m = resolveMembrane(PRIME_REPO, "npc-client-dashboard");
    const pumps = m.standing.filter((o) => o.kind === "pump").map((o) => o.name);
    const channels = m.standing.filter((o) => o.kind === "channel").map((o) => o.name);
    // The pumps are the three reconcilers: each ADDS something prime's file
    // did not contain, which is what makes them active rather than filters.
    expect(pumps).toEqual([
      "reconcileConfigToml",
      "reconcileSecurityRegistry",
      "reconcileDeployWorkflow",
    ]);
    expect(channels).toContain("backendIdentityHold");
    expect(channels).toContain("securityInventoryHold");
    expect(channels).toContain("judgingWorkflowHold");
    expect(channels).toContain("withholdReferencedDeletions");
  });

  it("finds both boundaries a parent sits on", () => {
    const t = membranesTouching("npc-client-dashboard");
    expect(t.inbound?.from).toBe(PRIME_REPO);
    expect(t.outbound.map((m) => m.to).sort()).toEqual([
      "npc-test-76b3b3",
      "preflight-property-group",
    ]);
  });

  it("carries BOTH columns of the routing table and nothing else", () => {
    // Transcribed from `crmIndependence.spec.ts` on the clone, which is the
    // authority — that spec is what turns its CI red. Both columns, because
    // spelling `crm-send-message` outside `crmFunction()` bypasses the switch
    // exactly as spelling `send-ghl-message` does.
    expect([...ROUTED_CRM_FUNCTION_NAMES].sort()).toEqual([
      "crm-calendar",
      "crm-send-message",
      "ghl-calendar",
      "send-ghl-message",
      "sync-ghl-conversations",
      "update-ghl-opportunity-stage",
    ]);
  });

  it("names no function the authority leaves out", () => {
    // The prime invokes 24 distinct `ghl-*` names under src/. Widening to
    // those would hold files the clone's own CI passes, on a fleet whose
    // signature failure is stalling for reasons nobody stated.
    for (const notGuarded of [
      "ghl-conversations",
      "ghl-messages",
      "ghl-pipelines",
      "ghl-side",
      "backfill-notes-to-ghl",
    ]) {
      expect(ROUTED_CRM_FUNCTION_NAMES).not.toContain(notGuarded);
    }
  });
});

describe("the routing rule reaches exactly what the clone's guard reaches", () => {
  it("does not reach outside src/", () => {
    expect(routingRuleReaches("supabase/functions/send-ghl-message/index.ts")).toBe(false);
    expect(routingRuleReaches("docs/notes.md")).toBe(false);
    expect(routingRuleReaches("src/components/x.tsx")).toBe(true);
  });

  it("exempts the routing table itself", () => {
    // It IS the routing table. Holding it would hold the very file a provider
    // change has to deliver.
    expect(CRM_ROUTER_PATH).toBe("src/lib/crm/crmProvider.ts");
    expect(routingRuleReaches(CRM_ROUTER_PATH)).toBe(false);
  });

  it("exempts a test, by the rule rather than by a list of paths", () => {
    // The authority's own words: a test that NAMES a function is not a
    // surface that CALLS one. The rule is about runtime.
    expect(routingRuleReaches("src/lib/sync/__tests__/ghlConversationMap.test.ts")).toBe(false);
    expect(routingRuleReaches("src/lib/crm/__tests__/crmIndependence.spec.ts")).toBe(false);
    expect(routingRuleReaches("src/pages/Conversations.spec.tsx")).toBe(false);
  });

  it("so the router and a test carry no reading at all", () => {
    const named = "const f = 'send-ghl-message';";
    expect(
      readingFor(classify({ path: CRM_ROUTER_PATH, text: named }), "routed_crm_name"),
    ).toBeNull();
    expect(
      readingFor(classify({ path: "src/x/__tests__/a.test.ts", text: named }), "routed_crm_name"),
    ).toBeNull();
    expect(
      readingFor(classify({ path: "src/pages/Conversations.tsx", text: named }), "routed_crm_name"),
    ).not.toBeNull();
  });

  it("reads the switch itself as the same species", () => {
    // A surface that reads VITE_CRM_PROVIDER has bypassed the one module that
    // decides, which is why the authority guards it by the same rule.
    const r = readingFor(
      classify({ path: "src/pages/Conversations.tsx", text: 'env["VITE_CRM_PROVIDER"]' }),
      "routed_crm_name",
    );
    expect(r?.tokens).toEqual([CRM_PROVIDER_ENV]);
  });

  it("matches the authority's quoting character for character", () => {
    const single = readingFor(
      classify({ path: "src/a.ts", text: "invoke('send-ghl-message')" }),
      "routed_crm_name",
    );
    const double = readingFor(
      classify({ path: "src/a.ts", text: 'invoke("send-ghl-message")' }),
      "routed_crm_name",
    );
    expect(single?.tokens).toEqual(["send-ghl-message"]);
    expect(double?.tokens).toEqual(["send-ghl-message"]);

    // Backticks are deliberately NOT matched: the clone's guard does not
    // match them, and the one place this fleet writes a function name in a
    // template literal it writes the NAME as a variable —
    // `${SUPABASE_URL}/functions/v1/${functionName}` — which no literal rule
    // can see. Matching them here would hold a file its own CI passes.
    const backtick = readingFor(
      classify({ path: "src/a.ts", text: "// see `send-ghl-message` for why" }),
      "routed_crm_name",
    );
    expect(backtick).toBeNull();
  });
});

describe("a channel's scope is a glob, not a prefix", () => {
  const CLOSED = resolveMembrane(PRIME_REPO, "npc-crm-independent-6505dc");
  const NAMED = "const f = 'send-ghl-message';";

  it("reaches every depth under src/", () => {
    for (const p of ["src/a.ts", "src/lib/deep/nested/a.ts", "src/pages/Conversations.tsx"]) {
      expect(permeate(CLOSED, { path: p, text: NAMED }).kind).toBe("blocked");
    }
  });

  it("does not reach a sibling directory whose name merely starts the same way", () => {
    // Held TWICE over, which is worth saying because it means this assertion
    // does not pin the glob: `routingRuleReaches` requires the literal `src/`
    // before a routed name is even a species here, so replacing the glob with
    // a prefix test leaves this case passing. The glob is pinned below, on a
    // species that carries no path gate of its own.
    expect(permeate(CLOSED, { path: "src-generated/a.ts", text: NAMED }).kind).toBe("crosses");
    expect(routingRuleReaches("src-generated/a.ts")).toBe(false);
  });

  it("scopes by the glob itself, on a species with no path gate", () => {
    // `backend_ref` fires on any twenty-letter token wherever it appears, so
    // this asks the channel's `within` and nothing else. A prefix test —
    // `path.startsWith("src")` — closes `src-generated/` and would be caught
    // here; the glob does not.
    const SCOPED: Membrane = {
      from: "a",
      to: "b",
      label: "a → b",
      rationale: "fixture",
      channels: [
        {
          species: "backend_ref",
          state: "closed",
          within: "src/**",
          reason: "manual_reconcile",
          note: "fixture",
        },
      ],
      standing: [],
    };
    const REF = 'const url = "https://abcdefghijklmnopqrst.supabase.co";';

    expect(permeate(SCOPED, { path: "src/a.ts", text: REF }).kind).toBe("blocked");
    expect(permeate(SCOPED, { path: "src/lib/deep/a.ts", text: REF }).kind).toBe("blocked");
    expect(permeate(SCOPED, { path: "src-generated/a.ts", text: REF }).kind).toBe("crosses");
    expect(permeate(SCOPED, { path: "supabase/config.toml", text: REF }).kind).toBe("crosses");
  });

  it("a channel scoped to ** reaches every root", () => {
    const EVERYWHERE: Membrane = {
      from: "a",
      to: "b",
      label: "a → b",
      rationale: "fixture",
      channels: [
        {
          species: "backend_ref",
          state: "closed",
          within: "**",
          reason: "manual_reconcile",
          note: "fixture",
        },
      ],
      standing: [],
    };
    const REF = 'const url = "https://abcdefghijklmnopqrst.supabase.co";';
    for (const path of ["src/a.ts", "supabase/config.toml", "docs/x.md", "a.ts"]) {
      expect(permeate(EVERYWHERE, { path, text: REF }).kind).toBe("blocked");
    }
  });

  it("does not reach the edge functions, which are where these functions LIVE", () => {
    // The clone keeps all 37 GoHighLevel functions and calls them when
    // configured to. Closing their own source would hold the feature itself.
    expect(
      permeate(CLOSED, { path: "supabase/functions/send-ghl-message/index.ts", text: NAMED }).kind,
    ).toBe("crosses");
  });

  it("asks nothing of a binary chunk", () => {
    expect(permeate(CLOSED, { path: "src/a.png", text: null }).kind).toBe("crosses");
  });
});

describe("a subject absent from the clone is out of scope, not stranded", () => {
  const PRIME = new Map([
    ["src/lib/reports/x.ts", "aaa"],
    ["src/lib/reports/__tests__/x.spec.ts", "sss"],
    ["src/lib/never/here.ts", "nnn"],
  ]);

  it("holds the measured case: present on the clone, stale, and not crossing", () => {
    // The 20 Sep evidence, in its own words: "Both subjects EXIST on the
    // clone, at their older versions; both are outside its installed-module
    // globs, so the specs arrived and the subjects did not."
    const stranded = strandedSubjects({
      specPath: "src/lib/reports/__tests__/x.spec.ts",
      specText: 'readFileSync("src/lib/reports/x.ts")',
      primeSha: PRIME,
      cloneSha: new Map([["src/lib/reports/x.ts", "OLD"]]),
      crossing: new Set(["src/lib/reports/__tests__/x.spec.ts"]),
    });
    expect(stranded).toEqual(["src/lib/reports/x.ts"]);
  });

  it("says nothing when the subject is crossing beside it", () => {
    expect(
      strandedSubjects({
        specPath: "src/lib/reports/__tests__/x.spec.ts",
        specText: 'readFileSync("src/lib/reports/x.ts")',
        primeSha: PRIME,
        cloneSha: new Map([["src/lib/reports/x.ts", "OLD"]]),
        crossing: new Set(["src/lib/reports/__tests__/x.spec.ts", "src/lib/reports/x.ts"]),
      }),
    ).toEqual([]);
  });

  it("says nothing when the clone's copy already agrees with prime's", () => {
    expect(
      strandedSubjects({
        specPath: "src/lib/reports/__tests__/x.spec.ts",
        specText: 'readFileSync("src/lib/reports/x.ts")',
        primeSha: PRIME,
        cloneSha: new Map([["src/lib/reports/x.ts", "aaa"]]),
        crossing: new Set(),
      }),
    ).toEqual([]);
  });

  it("declines a subject the clone does not hold at all, and that is deliberate", () => {
    // A path the clone has never had is outside its module scope. Holding on
    // it would hold the spec FOREVER with no act an operator can perform:
    // widening the scope is a configuration decision with its own review, and
    // a contract test names repository paths as DATA — this repository's own
    // 21 specs name 176 distinct paths between them. Every one of those would
    // become a permanent hold.
    //
    // The case the evidence shows is the stale one, and that is the one this
    // channel acts on.
    expect(
      strandedSubjects({
        specPath: "src/lib/reports/__tests__/x.spec.ts",
        specText: 'readFileSync("src/lib/never/here.ts")',
        primeSha: PRIME,
        cloneSha: new Map([["src/lib/reports/x.ts", "aaa"]]),
        crossing: new Set(),
      }),
    ).toEqual([]);
  });

  it("changes nothing when a tree could not be listed", () => {
    // A read that FAILED is not a tree that is EMPTY. With no evidence about
    // what differs, the conservative answer is to carry on exactly as before.
    for (const [prime, clone] of [
      [null, new Map()],
      [PRIME, null],
      [null, null],
    ] as const) {
      expect(
        strandedSubjects({
          specPath: "src/lib/reports/__tests__/x.spec.ts",
          specText: 'readFileSync("src/lib/reports/x.ts")',
          primeSha: prime,
          cloneSha: clone,
          crossing: new Set(),
        }),
      ).toEqual([]);
    }
  });

  it("is silent on a file that is not a spec at all", () => {
    expect(
      strandedSubjects({
        specPath: "src/lib/reports/x.ts",
        specText: 'readFileSync("src/lib/reports/y.ts")',
        primeSha: new Map([["src/lib/reports/y.ts", "aaa"]]),
        cloneSha: new Map([["src/lib/reports/y.ts", "OLD"]]),
        crossing: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("what a spec is read as naming", () => {
  it("takes a quoted repository path", () => {
    expect(subjectsNamedBy('readFileSync("src/a/b.ts")')).toEqual(["src/a/b.ts"]);
    expect(subjectsNamedBy("import x from 'supabase/functions/a/index.ts'")).toEqual([
      "supabase/functions/a/index.ts",
    ]);
  });

  it("takes no URL, because a URL is not a path in this repository", () => {
    expect(subjectsNamedBy('fetch("https://cdn.example.com/src/a/b.ts")')).toEqual([]);
  });

  it("takes no glob, because a glob names a set and not a subject", () => {
    expect(subjectsNamedBy('glob("src/**/*.ts")')).toEqual([]);
    expect(subjectsNamedBy('glob("src/lib/*.spec.ts")')).toEqual([]);
  });

  it("takes nothing from a root this fleet does not ship", () => {
    expect(subjectsNamedBy('readFileSync("node_modules/x/index.js")')).toEqual([]);
    expect(subjectsNamedBy('readFileSync("dist/a.js")')).toEqual([]);
  });

  it("takes the SEGMENT form, which is how 33 of the prime's specs name theirs", () => {
    // The live case from the 20 Sep incident, verbatim in shape:
    //   const DOC = readFileSync(join(ROOT, "docs", "reports", "X.md"), "utf8");
    // The whole-literal rule returns [] for every one of those files, so the
    // channel was blind to an instance of the exact failure it refuses.
    expect(
      subjectsNamedBy('readFileSync(join(ROOT, "docs", "reports", "SCORING_V2_METHODOLOGY.md"))'),
    ).toEqual(["docs/reports/SCORING_V2_METHODOLOGY.md"]);
    expect(subjectsNamedBy("join(R, 'supabase', 'functions', 'report-qa', 'index.ts')")).toEqual([
      "supabase/functions/report-qa/index.ts",
    ]);
  });

  it("reads both forms in one file without double-counting", () => {
    const text = `
      readFileSync("src/lib/a.ts");
      readFileSync(join(ROOT, "src", "lib", "a.ts"));
      readFileSync(join(ROOT, "docs", "b.md"));
    `;
    expect(subjectsNamedBy(text)).toEqual(["docs/b.md", "src/lib/a.ts"]);
  });

  it("takes no relative walk, because it names no repository path", () => {
    // `join(__dirname, "..", "..", "a.ts")` opens on no known root.
    expect(subjectsNamedBy('readFileSync(join(__dirname, "..", "..", "a.ts"))')).toEqual([]);
  });

  it("takes no directory, because a subject is a file", () => {
    // The last segment must carry an extension, or a `readdirSync` walk
    // becomes a subject that can never be compared.
    expect(subjectsNamedBy('readdirSync(join(ROOT, "src", "lib", "crm"))')).toEqual([]);
  });
});

describe("a project ref is read in the shipped shapes, not as any long word", () => {
  const AT = (text: string) => readingFor(classify({ path: "src/a.ts", text }), "backend_ref");

  it("reads a project URL", () => {
    expect(AT('const u = "https://abcdefghijklmnopqrst.supabase.co";')?.tokens).toEqual([
      "abcdefghijklmnopqrst",
    ]);
  });

  it("reads the ref claim inside an anon key", () => {
    // The URL and the key travel together: a URL from one project with a key
    // from another authenticates to nothing, so both halves are seen.
    expect(AT('{"ref":"zyxwvutsrqponmlkjihg","role":"anon"}')?.tokens).toEqual([
      "zyxwvutsrqponmlkjihg",
    ]);
  });

  it("reads NOTHING from a bare twenty-letter word", () => {
    // The detector was unanchored once, under a header claiming it matched
    // the same shape `backendRefsIn` does. It did not. Inert then, because no
    // membrane declares a channel on this species — and a trap for whoever
    // added the first one.
    expect(AT('const s = "abcdefghijklmnopqrst";')).toBeNull();
    expect(AT("// see abcdefghijklmnopqrst for why")).toBeNull();
    expect(AT("const abcdefghijklmnopqrst = 1;")).toBeNull();
  });

  it("agrees with the shipped rule on the same input", () => {
    // Not a restatement of the regex: the SHIPPED function is imported and
    // asked the same question. Two copies of one rule is how the two come to
    // disagree, and this is the assertion that notices.
    for (const text of [
      'const u = "https://abcdefghijklmnopqrst.supabase.co";',
      '{"ref":"zyxwvutsrqponmlkjihg"}',
      'const s = "abcdefghijklmnopqrst";',
      "nothing here at all",
    ]) {
      const mine = AT(text)?.tokens ?? [];
      expect([...mine].sort()).toEqual([...backendRefsIn(text)].sort());
    }
  });
});

describe("the edge into a repository is decided by that repository", () => {
  it("gives a lineage-routed child its PARENT'S edge, whatever ref the caller held", () => {
    // `cascade-dryrun` and `regenerateCloneProposal` build `primeRef` from
    // `prime.github_*` and resolve no lineage. Under the old keying both
    // asked for a prime→child edge this fleet does not have and fell through
    // to the default — printing an edge that does not exist into a held row
    // the repair path persists.
    for (const child of ["npc-test-76b3b3", "preflight-property-group"]) {
      const m = membraneInto(child, PRIME_REPO);
      expect(m.from).toBe("npc-client-dashboard");
      expect(m.to).toBe(child);
    }
  });

  it("agrees with the live path on a clone parented by prime", () => {
    for (const direct of ["npc-client-dashboard", "npc-crm-independent-6505dc"]) {
      expect(membraneInto(direct, PRIME_REPO)).toBe(resolveMembrane(PRIME_REPO, direct));
    }
  });

  it("falls back to the caller's own upstream for a repository nobody has described", () => {
    // Never a refusal: a clone provisioned tomorrow must behave exactly as
    // every clone behaved yesterday.
    const m = membraneInto("brand-new-clone", "npc-client-dashboard");
    expect(m.from).toBe("npc-client-dashboard");
    expect(m.to).toBe("brand-new-clone");
    expect(m.channels.some((c) => c.state === "closed")).toBe(false);
    expect(m.standing.length).toBeGreaterThan(0);
  });

  it("every membrane in the registry is reachable through it", () => {
    // A registry entry nothing can resolve is a rule written and never applied.
    for (const m of FLEET_MEMBRANES) {
      expect(membraneInto(m.to, m.from)).toBe(m);
    }
  });

  it("no repository is the destination of two edges", () => {
    // `membranesTouching` takes the FIRST match. Two inbound edges would make
    // the answer depend on declaration order, which is the "a path belongs to
    // exactly one workspace" defect in another costume.
    const seen = new Set<string>();
    for (const m of FLEET_MEMBRANES) {
      expect(seen.has(m.to), `${m.to} is the destination of two membranes`).toBe(false);
      seen.add(m.to);
    }
  });
});
