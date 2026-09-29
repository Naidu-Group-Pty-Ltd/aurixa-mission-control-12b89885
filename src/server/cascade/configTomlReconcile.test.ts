import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CLONE_OWNED_MARKER,
  declarationsLostBy,
  CONFIG_TOML_PATH,
  declaredFunctionCount,
  dropFunctionBlocks,
  functionBlocksIn,
  reconcileConfigToml,
} from "./configTomlReconcile.pure";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";
import { stripComments } from "../sourceComments.pure";

const PRIME_REF = "dduzbchuswwbefdunfct";
const CLONE_REF = "umrtusxohxjxzodxorim";

/*
  Shaped like the real files: a top-level `project_id`, the local-development
  tables that are identical on both sides, then the `[functions.*]` blocks that
  are the whole point. The prime declares one function the clone has never
  heard of, and declares it `verify_jwt = false` — which is the case that costs
  something, because an omitted block is read by the CLI as `true`.
*/
const preamble = (ref: string) => `project_id = "${ref}"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public", "aml"]

[auth]
site_url = "http://127.0.0.1:3000"
enable_signup = false
`;

const PRIME = `${preamble(PRIME_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false

[functions.planning-data-service]
verify_jwt = false
`;

const CLONE = `${preamble(CLONE_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false
`;

describe("reconciling a clone's config.toml", () => {
  it("carries prime's file and puts the clone's own project_id back", () => {
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: CLONE, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The one line that must not travel.
    expect(r.merged).toContain(`project_id = "${CLONE_REF}"`);
    expect(r.merged).not.toContain(PRIME_REF);
    expect(r.ownRef).toBe(CLONE_REF);
    expect(r.changed).toBe(true);

    // The declaration the clone was missing, at the value prime gives it. An
    // omitted block is read by the CLI as `verify_jwt = true`, so this is the
    // difference between a service being reachable and answering 401.
    expect(r.merged).toContain("[functions.planning-data-service]");
    expect(declaredFunctionCount(CLONE)).toBe(2);
    expect(declaredFunctionCount(r.merged)).toBe(3);
  });

  it("carries everything else in the file too, not only the function blocks", () => {
    // The reconcile is not a per-key policy. Whatever prime changes outside the
    // functions — the exposed schema list, the storage limit, a setting that
    // does not exist yet — arrives, because the only thing held back is the
    // one line that is this deployment's identity.
    const primeWider = PRIME.replace(
      'schemas = ["public", "graphql_public", "aml"]',
      'schemas = ["public", "graphql_public", "aml", "billing"]',
    );
    const r = reconcileConfigToml({
      primeToml: primeWider,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.merged).toContain('"billing"');
    expect(r.merged).toContain(`project_id = "${CLONE_REF}"`);
  });

  it("reports no change when the clone already matches", () => {
    // A clone whose file is already prime's-with-its-own-id must produce no
    // write at all, or every cascade would commit an identical file for ever.
    const already = PRIME.replace(PRIME_REF, CLONE_REF);
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: already, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.merged).toBe(already);
  });

  it("keeps the clone's own formatting of the line", () => {
    const spaced = CLONE.replace(
      `project_id = "${CLONE_REF}"`,
      `project_id   =    "${CLONE_REF}"`,
    );
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: spaced, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.merged).toContain(`project_id   =    "${CLONE_REF}"`);
  });
});

describe("what it refuses", () => {
  const refusal = (over: Partial<Parameters<typeof reconcileConfigToml>[0]>) =>
    reconcileConfigToml({
      primeToml: PRIME,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
      ...over,
    });

  it("refuses when the file and the registry disagree about the project", () => {
    // Two sources naming different databases is exactly when a reconcile must
    // stop: it has no basis for deciding which one is the deployment's real
    // backend, and picking wrong repoints it.
    const r = refusal({ ownRef: "aaaaaaaaaaaaaaaaaaaa" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("disagree");
    expect(r.reason).toContain(CLONE_REF);
  });

  it("proceeds where no backend is registered, because null is not a disagreement", () => {
    // An unprovisioned clone is an ordinary state. The file is still the
    // authority on what it says, and refusing here would freeze the config of
    // every clone whose backend row has not been written yet.
    const r = refusal({ ownRef: null });
    expect(r.ok).toBe(true);
  });

  it("refuses a clone file with no project_id", () => {
    const r = refusal({ cloneToml: CLONE.replace(/^project_id.*$/m, "") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("this clone's config.toml");
  });

  it("refuses a clone file with two, rather than letting TOML's last-wins decide", () => {
    const r = refusal({ cloneToml: `project_id = "zzzzzzzzzzzzzzzzzzzz"\n${CLONE}` });
    expect(r.ok).toBe(false);
  });

  it("refuses a prime file with no project_id", () => {
    const r = refusal({ primeToml: PRIME.replace(/^project_id.*$/m, "") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("prime's config.toml");
  });

  it("refuses a value that is not a project ref", () => {
    const r = refusal({ cloneToml: CLONE.replace(CLONE_REF, "not-a-ref") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("twenty lowercase letters");
  });

  it("never reads a project_id from inside a table", () => {
    // `project_id` is a top-level key. A same-named key under some future
    // `[table]` is a different setting, and reading it as this one is how a
    // parser that is nearly right writes the wrong database name.
    const nested = `${CLONE}\n[some_future_table]\nproject_id = "qqqqqqqqqqqqqqqqqqqq"\n`;
    const r = reconcileConfigToml({ primeToml: PRIME, cloneToml: nested, ownRef: CLONE_REF });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ownRef).toBe(CLONE_REF);
  });

  it("refuses when the result would name another tenant's project by any other route", () => {
    // The second, independent check. `backendRefsIn` reads a project URL and a
    // JWT `ref` claim — shapes a bare TOML assignment does not have — so it is
    // blind to the substitution above and catches what that one cannot.
    // config.toml has never carried either; if one appears, it needs a person.
    const primeWithUrl = PRIME.replace(
      "[api]",
      `api_url = "https://${PRIME_REF}.supabase.co"\n\n[api]`,
    );
    const r = reconcileConfigToml({
      primeToml: primeWithUrl,
      cloneToml: CLONE,
      ownRef: CLONE_REF,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(PRIME_REF);
  });
});

describe("how it sits beside the exclusion it does not remove", () => {
  it("config.toml is still a protected exclusion, and stays one", () => {
    // This module does not lift the exclusion — the path is still withheld
    // from the ordinary write path, and this is a separate, single-file act
    // with its own read-back. If the exclusion ever went, prime's project_id
    // would travel by the plain route and none of the guards above would run.
    const entry = DEFAULT_MIRROR_EXCLUSIONS.find((e) => e.pattern === CONFIG_TOML_PATH);
    expect(entry, "config.toml must remain in DEFAULT_MIRROR_EXCLUSIONS").toBeDefined();
    expect(entry!.reason).toBe("protected");
  });

  it("the engine performs the reconcile", () => {
    // A pure module nothing calls is a rule that does not exist.
    const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
    expect(engine).toContain("reconcileConfigToml");
    expect(engine).toContain("CONFIG_TOML_PATH");
  });
});

/*
  A clone that is NOT a mirror.

  Every fixture above is one: prime is a superset, so "prime's file with one
  line put back" loses nothing. `npc-crm-independent` owns three functions
  prime has never had — measured 20 Sep 2026, 416 declarations against prime's
  413 — and all three are `verify_jwt = false`, one of them an inbound webhook
  whose caller holds no Supabase JWT. Taking prime's file wholesale dropped
  every one of them.

  `[edge_runtime]` sits after the blocks on purpose: a block has to end at the
  next section of ANY kind, not only at the next `[functions.*]`.
*/
const CRM_CLONE = `${preamble(CLONE_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.crm-inbound-message]
verify_jwt = false

[functions.crm-send-message]
verify_jwt = false

[edge_runtime]
policy = "oneshot"
`;

describe("a clone that owns functions the prime does not", () => {
  const reconciled = () =>
    reconcileConfigToml({ primeToml: PRIME, cloneToml: CRM_CLONE, ownRef: CLONE_REF });

  it("keeps the clone's own declarations, which prime has no opinion about", () => {
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const names = new Set(functionBlocksIn(v.merged).map((b) => b.name));
    expect(names.has("crm-inbound-message")).toBe(true);
    expect(names.has("crm-send-message")).toBe(true);
  });

  it("keeps what they DECLARE, which is the thing that costs something", () => {
    // Surviving as a bare header would be no better than being dropped: an
    // omitted verify_jwt inside a present block still reads as `true`.
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const blocks = functionBlocksIn(v.merged);
    for (const name of ["crm-inbound-message", "crm-send-message"]) {
      const block = blocks.find((b) => b.name === name);
      expect(block?.text, name).toContain("verify_jwt = false");
    }
  });

  it("still lets prime win every name the two share", () => {
    // The clone declares `aml-cases` too. Carrying the clone's copy of a name
    // prime also declares would freeze exactly what the reconcile exists to
    // thaw.
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(functionBlocksIn(v.merged).filter((b) => b.name === "aml-cases")).toHaveLength(1);
    // Prime declares `planning-data-service`; the clone has never heard of it.
    expect(v.merged).toContain("[functions.planning-data-service]");
  });

  it("names what it carried, so the pull request can say so", () => {
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward.sort()).toEqual(["crm-inbound-message", "crm-send-message"]);
    expect(declaredFunctionCount(v.merged)).toBe(declaredFunctionCount(PRIME) + 2);
  });

  it("carries nothing, and says so, for a clone that is a mirror", () => {
    const v = reconcileConfigToml({ primeToml: PRIME, cloneToml: CLONE, ownRef: CLONE_REF });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual([]);
    expect(v.merged).not.toContain(CLONE_OWNED_MARKER);
  });

  it("is idempotent — a second pass over its own output adds nothing", () => {
    // The marker is a comment, so on re-read it is absorbed into the body of
    // the prime-owned block above it and dropped with it. If that stopped
    // being true the file would grow a marker and a duplicate block on every
    // cascade, for ever.
    const first = reconciled();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = reconcileConfigToml({
      primeToml: PRIME,
      cloneToml: first.merged,
      ownRef: CLONE_REF,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.merged).toBe(first.merged);
    expect(second.changed).toBe(false);
    expect(second.carriedForward.sort()).toEqual(["crm-inbound-message", "crm-send-message"]);
  });

  it("does not disturb the rest of the clone's file", () => {
    const v = reconciled();
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // `[edge_runtime]` is the clone's, sits after its blocks, and is not a
    // function declaration — it must not be swept up by the carry-forward.
    expect(functionBlocksIn(v.merged).some((b) => b.text.includes("oneshot"))).toBe(false);
    expect(v.ownRef).toBe(CLONE_REF);
  });
});

describe("reading function blocks", () => {
  it("ends a block at the next section of any kind", () => {
    const blocks = functionBlocksIn(
      ["[functions.a]", "verify_jwt = false", "", "[edge_runtime]", "policy = \"oneshot\""].join(
        "\n",
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(["[functions.a]", "verify_jwt = false"].join("\n"));
  });

  it("reproduces a name declared twice rather than silently halving it", () => {
    // TOML says last wins. This reader is not resolving the file, it is
    // letting the clone's text survive a rewrite, so both are reported.
    const blocks = functionBlocksIn(
      ["[functions.a]", "verify_jwt = false", "", "[functions.a]", "verify_jwt = true"].join("\n"),
    );
    expect(blocks.map((b) => b.name)).toEqual(["a", "a"]);
  });
});

describe("the read-back on the declarations", () => {
  /*
    This is the guard that turns a broken composition into a REFUSAL instead of
    a file that quietly gates three functions closed. It cannot be reached
    through `reconcileConfigToml` on valid input — with the carry-forward
    working, nothing is ever lost — so it is exercised directly, and its wiring
    was proved by execution rather than asserted: planting the pre-fix composer
    back made the reconcile refuse and name the clone's own functions.
  */
  it("names a declaration the candidate dropped", () => {
    const candidate = PRIME; // prime's file, exactly what the old composer wrote
    expect(declarationsLostBy(CRM_CLONE, candidate).sort()).toEqual([
      "crm-inbound-message",
      "crm-send-message",
    ]);
  });

  it("finds nothing to report on what the reconcile actually produces", () => {
    const v = reconcileConfigToml({ primeToml: PRIME, cloneToml: CRM_CLONE, ownRef: CLONE_REF });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(declarationsLostBy(CRM_CLONE, v.merged)).toEqual([]);
  });

  it("is consulted by the reconcile rather than re-implemented beside it", () => {
    // The likeliest regression here is somebody simplifying the call away,
    // which no behavioural test above can see.
    const src = stripComments(readFileSync("src/server/cascade/configTomlReconcile.pure.ts", "utf8"));
    const body = src.slice(src.indexOf("export function reconcileConfigToml"));
    expect(body).toContain("declarationsLostBy(cloneToml, merged)");
    // And that it refuses on ANY loss. A threshold is the other way this
    // control goes quiet while still looking present.
    expect(body).toContain("if (lost.length > 0)");
  });
});

describe("the marker is prose, and prose may not read as a declaration", () => {
  /**
   * THE CLONE'S OWN RATCHET, transcribed from
   * `src/lib/security/auditRemediation.spec.ts` on every clone in this fleet.
   *
   * Restated here rather than imported because it lives in a different
   * repository, and it is the rule that matters: unanchored, and `[^[]*?`
   * runs through prose, so anything shaped like `[functions.NAME] … verify_jwt
   * = true` counts — comment or not.
   */
  const RATCHET = /\[functions\.([A-Za-z0-9_-]+)\][^[]*?verify_jwt\s*=\s*(true|false)/gs;

  const ratchetCount = (toml: string) => [...toml.matchAll(RATCHET)].length;

  it("counts nothing inside the marker itself", () => {
    // It read `[functions.X]` until 21 Sep 2026 and this was 1.
    expect(ratchetCount(CLONE_OWNED_MARKER)).toBe(0);
  });

  it("makes the two counting rules agree on a reconciled file", () => {
    // The property that actually matters, asserted end to end rather than on
    // the string: `declaredFunctionCount` anchors to the line and was never
    // fooled, so a disagreement here is prose being read as a declaration.
    // CRM_CLONE, because only a clone that owns functions prime does not
    // causes the marker to be written at all — on a mirror there is no prose
    // to be misread and the assertion would pass vacuously.
    const verdict = reconcileConfigToml({
      primeToml: PRIME,
      cloneToml: CRM_CLONE,
      ownRef: CLONE_REF,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.merged).toContain(CLONE_OWNED_MARKER);
    expect(verdict.carriedForward.length).toBeGreaterThan(0);
    expect(ratchetCount(verdict.merged)).toBe(declaredFunctionCount(verdict.merged));
  });

  it("still says what an omitted block means, which is why it is written at all", () => {
    // Narrowing the placeholder must not cost the warning. An omitted block
    // is read as `verify_jwt = true`, and that is the whole point of the line.
    expect(CLONE_OWNED_MARKER).toContain("verify_jwt = true");
    expect(CLONE_OWNED_MARKER).toContain("omitted");
    expect(CLONE_OWNED_MARKER).toContain("functions.");
  });

  it("uses a placeholder the ratchet's character class cannot start on", () => {
    // Stated as the defect rather than as the fix: any placeholder drawn from
    // [A-Za-z0-9_-] brings the phantom back, whatever it is called.
    const placeholder = CLONE_OWNED_MARKER.match(/\[functions\.(.{1,20}?)\]/)?.[1];
    expect(placeholder).toBeDefined();
    expect(placeholder).not.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/*
  What the prime keeps for itself.

  The prime declares the GoHighLevel account migration's functions; no clone
  receives them (the owner's decision, 27 Sep 2026). Two of them stand in for
  twenty-eight here. The first carries a comment written against it, the
  second ends the file, and `didit-webhook` has a comment AFTER its last key —
  which belongs to whatever follows, not to the block the removal takes.
*/
const PRIME_ONLY = ["migration-dispatcher", "migration-job-control"];

const PRIME_WITH_MIGRATION = `${preamble(PRIME_REF)}
[functions.aml-cases]
verify_jwt = true

# Invoked by pg_cron with a signed header, never by a browser.
[functions.migration-dispatcher]
verify_jwt = false

[functions.didit-webhook]
verify_jwt = false
# Didit signs every delivery; the handler checks it.

[functions.migration-job-control]
verify_jwt = true
`;

/** A mirror as every clone is today: prime's file with its own project_id. */
const MIRROR_WITH_MIGRATION = PRIME_WITH_MIGRATION.replace(PRIME_REF, CLONE_REF);

describe("a clone that does not hold what the prime keeps for itself", () => {
  const withheldReconcile = (cloneToml = MIRROR_WITH_MIGRATION) =>
    reconcileConfigToml({
      primeToml: PRIME_WITH_MIGRATION,
      cloneToml,
      ownRef: CLONE_REF,
      withheld: PRIME_ONLY,
    });

  it("writes prime's file without those declarations, and nothing else removed", () => {
    // Stated as the whole file, because the property is what the removal does
    // NOT take: a comment beside a block, the blank line between two others.
    const v = withheldReconcile();
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.merged).toBe(`${preamble(CLONE_REF)}
[functions.aml-cases]
verify_jwt = true

[functions.didit-webhook]
verify_jwt = false
# Didit signs every delivery; the handler checks it.
`);
    expect(v.withheldDropped).toEqual(PRIME_ONLY);
    expect(v.changed).toBe(true);
    expect(declaredFunctionCount(v.merged)).toBe(declaredFunctionCount(PRIME_WITH_MIGRATION) - 2);
  });

  it("keeps every declaration for a clone that still holds the feature", () => {
    // The tree decides, never the register alone: until its removal pull
    // request a clone holds all twenty-eight directories, the engine passes
    // an empty set, and the file must be exactly what it was before this.
    const without = reconcileConfigToml({
      primeToml: PRIME_WITH_MIGRATION,
      cloneToml: MIRROR_WITH_MIGRATION,
      ownRef: CLONE_REF,
    });
    const empty = reconcileConfigToml({
      primeToml: PRIME_WITH_MIGRATION,
      cloneToml: MIRROR_WITH_MIGRATION,
      ownRef: CLONE_REF,
      withheld: [],
    });
    expect(without.ok && empty.ok).toBe(true);
    if (!without.ok || !empty.ok) return;
    expect(empty.merged).toBe(without.merged);
    expect(empty.merged).toBe(MIRROR_WITH_MIGRATION);
    expect(empty.withheldDropped).toEqual([]);
    expect(empty.changed).toBe(false);
  });

  it("does not report the clone's own copies as declarations it lost", () => {
    // The clone declared them (it is a mirror), and the result does not. The
    // read-back would ordinarily refuse that as a gate silently closed — and
    // here there is no gate, because the clone holds no directory behind it.
    const v = withheldReconcile();
    expect(v.ok).toBe(true);
    expect(declarationsLostBy(MIRROR_WITH_MIGRATION, v.ok ? v.merged : "").sort()).toEqual(
      PRIME_ONLY,
    );
  });

  it("never carries the clone's own block for one of them forward", () => {
    // A clone whose config still declares a prime-only function that the
    // prime has since stopped declaring must not keep it as "its own": it
    // holds no directory for it either.
    const primeWithout = PRIME_WITH_MIGRATION.replace(
      "\n[functions.migration-job-control]\nverify_jwt = true\n",
      "",
    );
    const v = reconcileConfigToml({
      primeToml: primeWithout,
      cloneToml: MIRROR_WITH_MIGRATION,
      ownRef: CLONE_REF,
      withheld: PRIME_ONLY,
    });
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual([]);
    expect(v.merged).not.toContain("migration-job-control");
    expect(v.merged).not.toContain(CLONE_OWNED_MARKER);
    // Only what prime declared is reported as dropped from prime's file.
    expect(v.withheldDropped).toEqual(["migration-dispatcher"]);
  });

  it("still carries what the clone owns, beside what it does not hold", () => {
    // The CRM clone is both at once: three functions of its own, and none of
    // the twenty-eight.
    const crmWithMigration = `${MIRROR_WITH_MIGRATION}
[functions.crm-inbound-message]
verify_jwt = false
`;
    const v = withheldReconcile(crmWithMigration);
    expect(v.ok, v.ok ? "" : v.reason).toBe(true);
    if (!v.ok) return;
    expect(v.carriedForward).toEqual(["crm-inbound-message"]);
    expect(v.withheldDropped).toEqual(PRIME_ONLY);
    const names = functionBlocksIn(v.merged).map((b) => b.name);
    expect(names).toEqual(["aml-cases", "didit-webhook", "crm-inbound-message"]);
    expect(v.merged).toContain(CLONE_OWNED_MARKER);
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

  it("reports only the names the prime actually declared", () => {
    const v = reconcileConfigToml({
      primeToml: PRIME_WITH_MIGRATION,
      cloneToml: MIRROR_WITH_MIGRATION,
      ownRef: CLONE_REF,
      withheld: [...PRIME_ONLY, "ghl-account-preview"],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.withheldDropped).toEqual(PRIME_ONLY);
  });

  it("refuses a result that still declares one, rather than writing it", () => {
    // `[functions.x] # note` is not a header to this module's reader, so the
    // removal cannot see it — while the clone's inventory generator counts
    // it. The read-back is asked of the OUTPUT, by the loosest reading.
    const annotated = PRIME_WITH_MIGRATION.replace(
      "[functions.migration-job-control]",
      "[functions.migration-job-control] # prime-only",
    );
    const v = reconcileConfigToml({
      primeToml: annotated,
      cloneToml: MIRROR_WITH_MIGRATION,
      ownRef: CLONE_REF,
      withheld: PRIME_ONLY,
    });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("still declares migration-job-control");
  });
});

describe("taking a function's blocks out of a config.toml", () => {
  const names = (...n: string[]) => new Set(n);

  it("returns the file untouched when nothing is named", () => {
    expect(dropFunctionBlocks(PRIME_WITH_MIGRATION, names())).toBe(PRIME_WITH_MIGRATION);
  });

  it("takes a comment written against the block with it", () => {
    const out = dropFunctionBlocks(PRIME_WITH_MIGRATION, names("migration-dispatcher"));
    expect(out).not.toContain("Invoked by pg_cron");
    expect(out).toContain("[functions.migration-job-control]");
  });

  it("leaves a comment after another block's last key where it is", () => {
    const out = dropFunctionBlocks(PRIME_WITH_MIGRATION, names("migration-job-control"));
    expect(out).toContain("# Didit signs every delivery; the handler checks it.\n");
  });

  it("leaves blank-separated blocks blank-separated", () => {
    const out = dropFunctionBlocks(PRIME_WITH_MIGRATION, names(...PRIME_ONLY));
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toContain("verify_jwt = true\n\n[functions.didit-webhook]");
  });

  it("keeps how the file ends, with or without a trailing newline", () => {
    const withNewline = dropFunctionBlocks(PRIME_WITH_MIGRATION, names("migration-job-control"));
    expect(withNewline.endsWith("checks it.\n")).toBe(true);
    const bare = PRIME_WITH_MIGRATION.replace(/\n$/, "");
    const withoutNewline = dropFunctionBlocks(bare, names("migration-job-control"));
    expect(withoutNewline.endsWith("checks it.")).toBe(true);
  });

  it("removes a block with no blank line on either side without touching its neighbours", () => {
    const tight = [
      "[functions.a]",
      "verify_jwt = true",
      "[functions.migration-dispatcher]",
      "verify_jwt = false",
      "[functions.b]",
      "verify_jwt = false",
    ].join("\n");
    expect(dropFunctionBlocks(tight, names("migration-dispatcher"))).toBe(
      ["[functions.a]", "verify_jwt = true", "[functions.b]", "verify_jwt = false"].join("\n"),
    );
  });

  it("ends a block at the next section of any kind", () => {
    const toml = [
      "[functions.migration-dispatcher]",
      "verify_jwt = false",
      "",
      "[edge_runtime]",
      'policy = "oneshot"',
      "",
    ].join("\n");
    expect(dropFunctionBlocks(toml, names("migration-dispatcher"))).toBe(
      ["[edge_runtime]", 'policy = "oneshot"', ""].join("\n"),
    );
  });

  it("does not take a function whose name only begins like a withheld one", () => {
    const toml = "[functions.migration-dispatcher-v2]\nverify_jwt = false\n";
    expect(dropFunctionBlocks(toml, names("migration-dispatcher"))).toBe(toml);
  });
});

describe("how the engine passes the withheld set", () => {
  const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

  it("reads it off the clone's tree before the first pump runs", () => {
    const decided = engine.indexOf("withheldFunctions = withheldPrimeOnlyFunctions(");
    const pump = engine.indexOf("reconcileConfigToml({");
    expect(decided).toBeGreaterThan(-1);
    expect(pump).toBeGreaterThan(decided);
  });

  it("hands it to the config pump", () => {
    const at = engine.indexOf("reconcileConfigToml({");
    const call = engine.slice(at, engine.indexOf("})", at));
    expect(call).toContain("withheld: declarationsWithheld");
  });

  it("builds the pump's set FROM it, adding only what a conversion retires", () => {
    const at = engine.indexOf("const declarationsWithheld: string[] =");
    const decl = engine.slice(at, engine.indexOf(";", at));
    expect(at).toBeGreaterThan(-1);
    expect(decl).toContain("...withheldFunctions");
    expect(decl).toContain("...retiredByConversion");
    expect(decl).toContain(": withheldFunctions");
  });

  it("never computes it on a notification pass, which reads nothing", () => {
    const decl = engine.indexOf("let withheldFunctions: string[] = [];");
    const first = engine.indexOf("withheldFunctions = withheldPrimeOnlyFunctions(");
    expect(engine.slice(decl, first)).toContain('if (mode !== "notify") {');
  });
});
