import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CLONE_OWNED_MARKER,
  declarationsLostBy,
  CONFIG_TOML_PATH,
  declaredFunctionCount,
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
