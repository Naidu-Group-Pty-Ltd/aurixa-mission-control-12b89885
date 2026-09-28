import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SECURITY_REGISTRY_PATH,
  entriesLostBy,
  reconcileSecurityRegistry,
  serialiseSecurityRegistry,
} from "./securityRegistryReconcile.pure";
import { stripComments } from "../sourceComments.pure";

/*
  Shaped like the real files, which are written two-space with every non-ASCII
  character escaped. The em dash in a note is not decoration here: it is the
  character that made `JSON.stringify` alone reformat 96 KB of file.
*/
const entry = (cls: string, note: string) =>
  ({ verify_jwt: false, exposure_class: cls, owner: "x", reviewed: true, notes: note }) as const;

const PRIME = serialiseSecurityRegistry({
  $comment: "Edge Function security registry (EDGE-001).",
  functions: {
    "aml-cases": entry("human-authenticated", "Shared — prime's wording."),
    "didit-webhook": entry("webhook", "Shared."),
  },
});

const CLONE = serialiseSecurityRegistry({
  $comment: "Edge Function security registry (EDGE-001).",
  functions: {
    "aml-cases": entry("human-authenticated", "Shared — the clone's older wording."),
    "crm-calendar": entry("human-authenticated", "Native CRM calendar."),
    "crm-send-message": entry("webhook", "Native CRM outbound."),
  },
});

describe("reconciling a clone's security registry", () => {
  const reconciled = () => reconcileSecurityRegistry({ primeJson: PRIME, cloneJson: CLONE });

  it("keeps the entries prime has no opinion about", () => {
    const v = reconciled();
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    const fns = JSON.parse(v.merged).functions;
    expect(Object.keys(fns).sort()).toEqual([
      "aml-cases",
      "crm-calendar",
      "crm-send-message",
      "didit-webhook",
    ]);
    expect(v.carriedForward.sort()).toEqual(["crm-calendar", "crm-send-message"]);
  });

  it("lets prime win a name the two share, which is what carries a changed class", () => {
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(JSON.parse(v.merged).functions["aml-cases"].notes).toContain("prime's wording");
  });

  it("writes the file in the shape it was already in", () => {
    // Byte-exactness is why this module serialises rather than patching text:
    // `JSON.stringify` emits a literal em dash where both live files escape it.
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toContain("\\u2014");
    expect(v.merged.endsWith("}\n")).toBe(true);
    expect(v.merged).not.toContain("—");
  });

  it("carries nothing, and changes nothing, for a clone that already matches", () => {
    const v = reconcileSecurityRegistry({ primeJson: PRIME, cloneJson: PRIME });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual([]);
    expect(v.changed).toBe(false);
  });

  it("is idempotent — a second pass over its own output adds nothing", () => {
    const first = reconciled();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reconcileSecurityRegistry({ primeJson: PRIME, cloneJson: first.merged });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.merged).toBe(first.merged);
    expect(second.changed).toBe(false);
  });
});

describe("what it refuses", () => {
  it("refuses a file it could not reproduce byte for byte", () => {
    // A duplicated key is the case that matters: `JSON.parse` keeps the last
    // and drops the first, so re-serialising would DELETE a defect the clone's
    // own checker exists to catch.
    const duplicated = PRIME.replace('"didit-webhook"', '"aml-cases"');
    const v = reconcileSecurityRegistry({ primeJson: duplicated, cloneJson: CLONE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("byte for byte");
  });

  it("refuses invalid JSON rather than writing a guess", () => {
    const v = reconcileSecurityRegistry({ primeJson: "{ not json", cloneJson: CLONE });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("not valid JSON");
  });

  it("refuses a document with no `functions` object", () => {
    const v = reconcileSecurityRegistry({
      primeJson: serialiseSecurityRegistry({ $comment: "x" }),
      cloneJson: CLONE,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("no `functions` object");
  });

  it("says which side is at fault", () => {
    const bad = reconcileSecurityRegistry({ primeJson: PRIME, cloneJson: "{ not json" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toContain("this clone");
  });
});

describe("the read-back on the entries", () => {
  it("names an entry a candidate dropped", () => {
    expect(entriesLostBy(CLONE, PRIME).sort()).toEqual(["crm-calendar", "crm-send-message"]);
  });

  it("finds nothing to report on what the reconcile produces", () => {
    const v = reconcileSecurityRegistry({ primeJson: PRIME, cloneJson: CLONE });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(entriesLostBy(CLONE, v.merged)).toEqual([]);
  });

  it("is consulted by the reconcile rather than re-implemented beside it", () => {
    const src = stripComments(
      readFileSync("src/server/cascade/securityRegistryReconcile.pure.ts", "utf8"),
    );
    const body = src.slice(src.indexOf("export function reconcileSecurityRegistry"));
    expect(body).toContain("entriesLostBy(args.cloneJson, merged)");
    expect(body).toContain("if (lost.length > 0)");
  });
});

describe("how the engine uses it", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("replaces the copy the repository invariant already put in the tree", () => {
    // `supabase/functions-registry/**` is an invariant, so prime's registry is
    // in `treeEntries` before this step runs. Pushing the reconciled blob
    // without removing that one leaves two entries for one path.
    const at = engine.indexOf("reconcileSecurityRegistry({");
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 2000);
    expect(block).toContain("dropFromTree(SECURITY_REGISTRY_PATH)");
  });

  it("withholds prime's copy on a refusal rather than letting it stand", () => {
    const at = engine.indexOf("reconcileSecurityRegistry({");
    const block = engine.slice(at, at + 2000);
    const drop = block.indexOf("dropFromTree(SECURITY_REGISTRY_PATH)");
    const refuse = block.indexOf("if (!verdict.ok)", drop);
    expect(drop).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(drop);
  });

  it("never fails the pass on it", () => {
    const at = engine.indexOf("reconcileSecurityRegistry({");
    expect(engine.slice(Math.max(0, at - 600), at)).toContain("try {");
  });

  it("names the path in one place", () => {
    expect(SECURITY_REGISTRY_PATH).toBe("supabase/functions-registry/SECURITY_REGISTRY.json");
    expect(engine).not.toContain('"supabase/functions-registry/SECURITY_REGISTRY.json"');
  });
});

/*
  What the prime keeps for itself (`primeOnlyFeatures.pure.ts`). Its entries
  sit BETWEEN two ordinary ones on purpose: the merged registry keeps prime's
  key order, and a removal that rebuilt the object would move the second one.
*/
const PRIME_WITH_MIGRATION = serialiseSecurityRegistry({
  $comment: "Edge Function security registry (EDGE-001).",
  functions: {
    "aml-cases": entry("human-authenticated", "Shared — prime's wording."),
    "migration-dispatcher": entry("internal", "Prime-only."),
    "migration-job-control": entry("human-authenticated", "Prime-only."),
    "didit-webhook": entry("webhook", "Shared."),
  },
});
const MIRROR_WITH_MIGRATION = PRIME_WITH_MIGRATION;
const PRIME_ONLY = ["migration-dispatcher", "migration-job-control"];

describe("a clone that does not hold what the prime keeps for itself", () => {
  const withheldReconcile = (cloneJson = MIRROR_WITH_MIGRATION) =>
    reconcileSecurityRegistry({
      primeJson: PRIME_WITH_MIGRATION,
      cloneJson,
      withheld: PRIME_ONLY,
    });

  it("takes prime's entries for them out, and keeps prime's order for the rest", () => {
    const v = withheldReconcile();
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(JSON.parse(v.merged).functions)).toEqual(["aml-cases", "didit-webhook"]);
    expect(v.withheldDropped).toEqual(PRIME_ONLY);
    expect(v.changed).toBe(true);
  });

  it("writes it in the same byte-exact shape as every other result", () => {
    const v = withheldReconcile();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(serialiseSecurityRegistry(JSON.parse(v.merged))).toBe(v.merged);
    expect(v.merged).not.toContain("migration-");
  });

  it("does not refuse over the clone's own entries for them", () => {
    // A mirror holds all of prime's entries, these included, and the result
    // does not. The read-back ordinarily refuses that — the clone's checker
    // would demand the entry for a function on disk — and there is no
    // function on disk here.
    const v = withheldReconcile();
    expect(v.ok).toBe(true);
    expect(entriesLostBy(MIRROR_WITH_MIGRATION, v.ok ? v.merged : "").sort()).toEqual(PRIME_ONLY);
  });

  it("never carries the clone's own entry for one of them forward", () => {
    const primeWithout = serialiseSecurityRegistry({
      $comment: "Edge Function security registry (EDGE-001).",
      functions: {
        "aml-cases": entry("human-authenticated", "Shared — prime's wording."),
        "didit-webhook": entry("webhook", "Shared."),
      },
    });
    const v = reconcileSecurityRegistry({
      primeJson: primeWithout,
      cloneJson: MIRROR_WITH_MIGRATION,
      withheld: PRIME_ONLY,
    });
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual([]);
    expect(v.withheldDropped).toEqual([]);
    expect(Object.keys(JSON.parse(v.merged).functions)).toEqual(["aml-cases", "didit-webhook"]);
  });

  it("still carries what the clone owns, beside what it does not hold", () => {
    const crm = serialiseSecurityRegistry({
      $comment: "Edge Function security registry (EDGE-001).",
      functions: {
        ...JSON.parse(MIRROR_WITH_MIGRATION).functions,
        "crm-send-message": entry("webhook", "Native CRM outbound."),
      },
    });
    const v = withheldReconcile(crm);
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual(["crm-send-message"]);
    expect(Object.keys(JSON.parse(v.merged).functions)).toEqual([
      "aml-cases",
      "didit-webhook",
      "crm-send-message",
    ]);
  });

  it("changes nothing for a clone that still holds the feature", () => {
    const v = reconcileSecurityRegistry({
      primeJson: PRIME_WITH_MIGRATION,
      cloneJson: MIRROR_WITH_MIGRATION,
      withheld: [],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toBe(MIRROR_WITH_MIGRATION);
    expect(v.changed).toBe(false);
    expect(v.withheldDropped).toEqual([]);
  });

  it("is idempotent — a second pass over its own output removes nothing more", () => {
    const first = withheldReconcile();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = withheldReconcile(first.merged);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.merged).toBe(first.merged);
    expect(second.changed).toBe(false);
  });

  it("is handed the set by the engine", () => {
    const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
    const at = engine.indexOf("reconcileSecurityRegistry({");
    expect(engine.slice(at, engine.indexOf("})", at))).toContain("withheld: withheldFunctions");
  });
});
