/**
 * What the prime has retired, read off its own decommission workflows.
 *
 * The fixtures are the prime's two workflows byte for byte, copied from
 * `npc-property-dashbord@d72032e1` on 27 Oct 2026. A reader proved only
 * against a list written for the test would prove nothing about the file it
 * reads in production.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DECOMMISSION_WORKFLOW_PATH,
  assembleRetiredRegister,
  functionDirectoriesIn,
  readRetiredList,
  retiredCandidatesIn,
  retiredFunctionsToDelete,
  type DeployedFunction,
} from "./retiredFunctions.pure";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/retired-functions/${name}.yml.txt`, import.meta.url), "utf8");

const RETIRED_FUNCTIONS = fixture("decommission-retired-functions");
const BUILDER_PORTAL = fixture("decommission-builder-portal-functions");

const RETIRED_PATH = ".github/workflows/decommission-retired-functions.yml";
const BUILDER_PATH = ".github/workflows/decommission-builder-portal-functions.yml";

/** A list in the workflows' own shape, around whatever line a test needs. */
const workflow = (line: string, deletes = true) =>
  [
    "name: Decommission something",
    "jobs:",
    "  decommission:",
    "    steps:",
    "      - run: |",
    `          ${line}`,
    deletes
      ? '          for fn in $RETIRED; do supabase functions delete "$fn" --project-ref "$PROJECT_REF"; done'
      : "          echo nothing",
  ].join("\n");

describe("the prime's two decommission workflows, as they stand", () => {
  it("reads every name the retired-functions workflow deletes, and nothing from its header", () => {
    // Its header lists the same names under "# RETIRED:" with their reasons;
    // only the assignment is the list.
    expect(RETIRED_FUNCTIONS).toContain("# RETIRED:");
    expect(readRetiredList(RETIRED_FUNCTIONS)).toEqual({
      kind: "list",
      names: [
        "street-view",
        "manage-partner-agreements",
        "finance-portal-agreements",
        "agreement-centre-render",
        "mc-wallet-diag",
        "mc-diag-tmp",
      ],
    });
  });

  it("reads all twenty-eight of the builder portal's, and neither of the two it keeps", () => {
    const reading = readRetiredList(BUILDER_PORTAL);
    expect(reading.kind).toBe("list");
    const names = reading.kind === "list" ? reading.names : [];
    expect(names).toHaveLength(28);
    expect(names).toContain("builder-portal-login");
    expect(names).toContain("builder-portal-reset-password");
    // Listed although no directory ever carried it: the deployment exists.
    expect(names).toContain("builder-stock-inpaint-probe");
    // "builder-stock-marketplace … and builder-network-inbound … are NOT in
    // the list and stay deployed."
    expect(names).not.toContain("builder-stock-marketplace");
    expect(names).not.toContain("builder-network-inbound");
  });

  it("finds both by the prime's own pattern for a decommission workflow", () => {
    expect(DECOMMISSION_WORKFLOW_PATH.test(RETIRED_PATH)).toBe(true);
    expect(DECOMMISSION_WORKFLOW_PATH.test(BUILDER_PATH)).toBe(true);
    expect(DECOMMISSION_WORKFLOW_PATH.test(".github/workflows/decommission-old.yaml")).toBe(true);
    expect(DECOMMISSION_WORKFLOW_PATH.test(".github/workflows/deploy-supabase-functions.yml")).toBe(
      false,
    );
    expect(DECOMMISSION_WORKFLOW_PATH.test(".github/workflows/old/decommission-x.yml")).toBe(false);
    expect(DECOMMISSION_WORKFLOW_PATH.test("docs/decommission-x.yml")).toBe(false);
  });
});

describe("a list read with certainty, or refused by name", () => {
  it("takes a double-quoted list, as the prime's own summary does", () => {
    expect(readRetiredList(workflow('RETIRED="a-fn b-fn"'))).toEqual({
      kind: "list",
      names: ["a-fn", "b-fn"],
    });
  });

  it("refuses a second assignment, even one commented out", () => {
    const twice = workflow("RETIRED='a-fn'") + "\n# RETIRED='b-fn'\n";
    const reading = readRetiredList(twice);
    expect(reading).toEqual({
      kind: "refused",
      why: "it assigns RETIRED 2 times, so which list it deletes cannot be told from its text",
    });
  });

  it("refuses a list it would have to guess the end of", () => {
    for (const line of [
      "RETIRED='a-fn",
      "RETIRED=a-fn",
      "RETIRED='a-fn' # and more",
      "RETIRED=$(cat list)",
    ]) {
      expect(readRetiredList(workflow(line)).kind, line).toBe("refused");
    }
    // A list split over two lines.
    expect(readRetiredList(workflow("RETIRED='a-fn\n          b-fn'")).kind).toBe("refused");
  });

  it("refuses a list holding something no function is called", () => {
    expect(readRetiredList(workflow("RETIRED='a-fn $EXTRA ../b'"))).toEqual({
      kind: "refused",
      why: 'its RETIRED list holds "$EXTRA", "../b", which no function is called',
    });
    expect(readRetiredList(workflow("RETIRED='   '"))).toEqual({
      kind: "refused",
      why: "its RETIRED list names nothing",
    });
  });

  it("refuses a list the file does not delete as functions, and passes over a file with neither", () => {
    expect(readRetiredList(workflow("RETIRED='a-bucket'", false))).toEqual({
      kind: "refused",
      why: "it states a RETIRED list but deletes nothing with `supabase functions delete`, so its names are not known to be functions",
    });
    expect(readRetiredList(workflow("echo retiring a bucket", false))).toEqual({
      kind: "not_functions",
    });
    expect(readRetiredList(workflow("echo no list here"))).toEqual({
      kind: "refused",
      why: "it deletes functions but states no RETIRED list",
    });
  });

  it("names each function once", () => {
    expect(readRetiredList(workflow("RETIRED='a-fn b-fn a-fn'"))).toEqual({
      kind: "list",
      names: ["a-fn", "b-fn"],
    });
  });
});

describe("what a tree still carries", () => {
  it("is every directory under supabase/functions/ holding any file at all", () => {
    expect(
      [
        ...functionDirectoriesIn([
          "supabase/functions/listings-cache/index.ts",
          // No entrypoint: still source, and the prime's workflow refuses on it.
          "supabase/functions/half-removed/README.md",
          "supabase/functions/_shared/cors.ts",
          "supabase/functions/import_map.json",
          "supabase/migrations/20260101000000_x.sql",
          "src/functions/not-this/index.ts",
        ]),
      ].sort(),
    ).toEqual(["_shared", "half-removed", "listings-cache"]);
  });
});

describe("the register, put together at one commit", () => {
  const register = assembleRetiredRegister({
    readAt: "Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1abcd",
    workflows: [
      { path: BUILDER_PATH, reading: readRetiredList(BUILDER_PORTAL) },
      { path: RETIRED_PATH, reading: readRetiredList(RETIRED_FUNCTIONS) },
      {
        path: ".github/workflows/decommission-broken.yml",
        reading: readRetiredList(workflow("RETIRED=x")),
      },
      { path: ".github/workflows/decommission-buckets.yml", reading: { kind: "not_functions" } },
    ],
    primeTreePaths: [
      "supabase/functions/builder-stock-marketplace/index.ts",
      "supabase/functions/builder-network-inbound/index.ts",
    ],
  });

  it("holds every name either list retires, each with the workflow that retires it", () => {
    expect(register.retiredBy.size).toBe(34);
    expect(register.retiredBy.get("street-view")).toBe(RETIRED_PATH);
    expect(register.retiredBy.get("builder-portal-login")).toBe(BUILDER_PATH);
  });

  it("carries a refused workflow by name and leaves out one that is not this register's", () => {
    expect(register.unreadable).toEqual([
      {
        path: ".github/workflows/decommission-broken.yml",
        why: "its RETIRED list is not the single-line, quoted list the prime's own summary reads",
      },
    ]);
  });

  it("keeps the first workflow, in path order, for a name two of them retire", () => {
    const both = assembleRetiredRegister({
      readAt: "x@y",
      workflows: [
        {
          path: ".github/workflows/decommission-z.yml",
          reading: { kind: "list", names: ["a-fn"] },
        },
        {
          path: ".github/workflows/decommission-a.yml",
          reading: { kind: "list", names: ["a-fn"] },
        },
      ],
      primeTreePaths: [],
    });
    expect(both.retiredBy.get("a-fn")).toBe(".github/workflows/decommission-a.yml");
  });

  /** A dependent clone's project as read on 27 Oct 2026: its 28 retired functions and two it keeps. */
  const dependentClone: DeployedFunction[] = [
    ...[
      "street-view",
      "builder-portal-login",
      "builder-portal-logout",
      "builder-portal-verify",
      "builder-portal-accept-invite",
      "builder-portal-forgot-password",
      "builder-portal-reset-password",
      "builder-portal-change-password",
      "builder-portal-projects",
      "builder-portal-inventory",
      "builder-portal-transactions",
      "builder-portal-construction",
      "builder-portal-delivery",
      "builder-portal-collaboration",
      "builder-portal-workspace",
      "builder-portal-stock",
      "builder-stock-image-settler",
      "builder-document-processor",
      "builder-stock-link-callback",
    ].map((slug) => ({ slug, verifyJwt: false })),
    ...[
      "builder-portal-invite",
      "builder-portal-admin",
      "builder-projects-admin",
      "builder-inventory-admin",
      "builder-transactions-admin",
      "builder-construction-admin",
      "builder-delivery-admin",
      "builder-collaboration-admin",
      "builder-workspace-admin",
    ].map((slug) => ({ slug, verifyJwt: true })),
    { slug: "builder-stock-marketplace", verifyJwt: false },
    { slug: "builder-network-inbound", verifyJwt: false },
    { slug: "listings-cache", verifyJwt: true },
  ];

  it("finds the measured clone's twenty-eight, and only those", () => {
    const candidates = retiredCandidatesIn(dependentClone, register);
    expect(candidates).toHaveLength(28);
    expect(candidates.map((c) => c.slug)).not.toContain("builder-stock-marketplace");
    expect(candidates.map((c) => c.slug)).not.toContain("listings-cache");
  });

  it("orders them for the cap: the nineteen anybody can call first, then the nine behind a JWT", () => {
    const { found, kept } = retiredFunctionsToDelete(
      retiredCandidatesIn(dependentClone, register),
      register,
      // As measured: the prime runs neither the portal nor Street View any more.
      {
        primeRuns: new Set(["listings-cache", "builder-stock-marketplace"]),
        cloneCarries: new Set(["listings-cache", "builder-stock-marketplace"]),
      },
    );
    expect(kept).toEqual([]);
    expect(found).toHaveLength(28);
    const open = found.slice(0, 19).map((f) => f.slug);
    expect(open).toEqual([...open].sort());
    expect(open).toContain("builder-portal-login");
    expect(open).toContain("builder-portal-reset-password");
    expect(open).toContain("street-view");
    expect(found.slice(19).map((f) => f.slug)).toEqual([
      "builder-collaboration-admin",
      "builder-construction-admin",
      "builder-delivery-admin",
      "builder-inventory-admin",
      "builder-portal-admin",
      "builder-portal-invite",
      "builder-projects-admin",
      "builder-transactions-admin",
      "builder-workspace-admin",
    ]);
    expect(found[0].reason).toBe(
      `retired by the prime's ${BUILDER_PATH}, which has deleted it from the prime's own project, ` +
        "and no tree carries its source; it answers without a JWT",
    );
  });

  it("never reads a list that did not say as one that says anybody can call it", () => {
    const { found } = retiredFunctionsToDelete(
      [{ slug: "street-view" }, { slug: "mc-diag-tmp", verifyJwt: false }],
      register,
      { primeRuns: new Set(), cloneCarries: new Set() },
    );
    expect(found.map((f) => f.slug)).toEqual(["mc-diag-tmp", "street-view"]);
    expect(found[1].reason).not.toContain("without a JWT");
  });

  it("keeps one the prime's own project still runs, until the prime's decommission has deleted it there", () => {
    // Merging a name onto a RETIRED list is not the decision; dispatching the
    // workflow is. A clone never loses a function the prime still serves.
    const { found, kept } = retiredFunctionsToDelete(
      [
        { slug: "street-view", verifyJwt: false },
        { slug: "builder-portal-login", verifyJwt: false },
      ],
      register,
      { primeRuns: new Set(["builder-portal-login"]), cloneCarries: new Set() },
    );
    expect(found.map((f) => f.slug)).toEqual(["street-view"]);
    expect(kept).toEqual([
      {
        slug: "builder-portal-login",
        why:
          "the prime's own project still runs it: it goes from the clones once the prime's " +
          `${BUILDER_PATH} has been dispatched and has deleted it there`,
      },
    ]);
  });

  it("keeps one the prime's tree still carries, and one the clone's own tree still carries", () => {
    const revived = assembleRetiredRegister({
      readAt: "prime@abc",
      workflows: [{ path: RETIRED_PATH, reading: readRetiredList(RETIRED_FUNCTIONS) }],
      primeTreePaths: ["supabase/functions/street-view/index.ts"],
    });
    const { found, kept } = retiredFunctionsToDelete(
      [
        { slug: "street-view", verifyJwt: false },
        { slug: "mc-diag-tmp", verifyJwt: false },
        { slug: "mc-wallet-diag", verifyJwt: false },
      ],
      revived,
      { primeRuns: new Set(), cloneCarries: new Set(["mc-diag-tmp"]) },
    );
    expect(found.map((f) => f.slug)).toEqual(["mc-wallet-diag"]);
    expect(kept).toEqual([
      {
        slug: "mc-diag-tmp",
        why:
          "the clone's own tree still carries supabase/functions/mc-diag-tmp/, and the clone's lane would deploy it again: " +
          "it goes once the source has left the clone's repository",
      },
      {
        slug: "street-view",
        why:
          "the prime's tree still carries supabase/functions/street-view/ at prime@abc, so it is retired on paper only: " +
          "the next deploy would bring it back",
      },
    ]);
  });
});
