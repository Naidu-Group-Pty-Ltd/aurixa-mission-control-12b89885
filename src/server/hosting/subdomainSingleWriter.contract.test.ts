/**
 * One writer of a clone's NAME.
 *
 * ## The defect
 *
 * `clones.subdomain` had two writers on the creation path and they disagreed.
 * `provisionCloneCore` reserved a name through `allocateSubdomain`; the New
 * Clone wizard then called `requestCloneSubdomain` from the browser, a few
 * lines later, and wrote a different string straight onto the row. The
 * browser's write was second, so it won. Measured on the live fleet,
 * 19 Sep 2026:
 *
 *   slug                          subdomain
 *   npc-crm-independent-6505dc →  npc-crm-independent
 *   npc-test-76b3b3            →  npc-test
 *
 * Both names are reasonable, which is precisely what made it invisible for two
 * clones and four months. What went with the losing write was not the string
 * but the RULES: the taken-set check, `subdomain_status`'s deliberate
 * `awaiting_deployment`, and the operator's own typed choice, which reached
 * the second writer and never the allocator.
 *
 * ## Why this is a source scan
 *
 * The whole 4,200-test suite passed before the fix and passed after it. A
 * second writer is an ABSENCE — of coordination — and an absence type-checks,
 * lints, builds and ships. The only thing that can see it is a rule stated over
 * the source.
 *
 * ## The rule, and the distinction it turns on
 *
 * Writing a NAME and clearing one are different acts. Allocation has to be
 * single-writer because it depends on what every other clone holds; a detach
 * depends on nothing and completes in whichever place observed the DNS record
 * go. So this asserts the first and deliberately says nothing about the second.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");


/**
 * The one module allowed to decide what a clone is called.
 *
 * A path rather than a name, because a file that merely *imports* the allocator
 * is not the allocator.
 */
const ALLOCATOR = "src/server/hosting/subdomainAllocation.server.ts";

/**
 * Every module under `src/` that writes a NAME into `clones.subdomain`.
 *
 * `subdomain: null` is excluded by the pattern: that is a detach, and the rule
 * here is about allocation. A write is recognised by the field landing in an
 * update/upsert object on the `clones` table, which is how both writers of the
 * original defect were spelled.
 */
function writersOfCloneSubdomain(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      // Only where the write is against `clones`: `edge_provisioning_jobs`
      // carries a `subdomain` in its payload and is not this table.
      for (const m of src.matchAll(/from\(\s*["']clones["']\s*\)[\s\S]{0,400}?\)/g)) {
        const block = m[0];
        if (!/\.(update|upsert|insert)\s*\(/.test(block)) continue;
        // A name, never a clearing. `subdomain: null` is a detach.
        if (/\bsubdomain:\s*(?!null\b)[A-Za-z_$"'`]/.test(block)) {
          out.push(rel);
          break;
        }
      }
    }
  };
  walk("src");
  return [...new Set(out)];
}

describe("a clone's name has exactly one writer", () => {
  it("is written in the allocator and nowhere else", () => {
    expect(writersOfCloneSubdomain()).toEqual([ALLOCATOR]);
  });

  it("the allocator is the only place that reads the taken set", () => {
    // The check that makes single-writing worth anything. A second writer that
    // read it too would still be a second writer, but a writer that does NOT
    // read it is the specific failure this closes.
    const src = stripComments(read(ALLOCATOR));
    expect(src).toMatch(/takenSubdomains\s*\(/);
    expect(src).toMatch(/allocateSubdomain\s*\(/);
  });
});

describe("the creation path asks for the name once", () => {
  const WIZARD = stripComments(read("src", "routes", "clones.new.tsx"));
  const CORE = stripComments(read("src", "server", "clone-provisioning.server.ts"));

  it("the wizard sends its subdomain decision as an input, not a second call", () => {
    expect(WIZARD).toMatch(/subdomain:\s*subdomainEnabled\s*\?/);
  });

  it("the wizard no longer calls requestCloneSubdomain at all", () => {
    // Anchored on the identifier rather than on a call shape: the import, the
    // hook and the call were three lines and any one of them coming back is
    // the defect coming back.
    expect(WIZARD).not.toContain("requestCloneSubdomain");
  });

  it("provisioning reserves through the single writer", () => {
    expect(CORE).toMatch(/await\s+provisionCloneSubdomain\s*\(/);
    // And never through the half of it that skips the enqueue: a caller that
    // reserves without asking for the record leaves a name in a status nothing
    // advances.
    expect(CORE).not.toMatch(/await\s+reserveCloneSubdomain\s*\(/);
  });

  it("an explicit decline is honoured, and an absent preference is not a decline", () => {
    // `undefined` means "derive one from the slug" — what the agreement path
    // has always had. `null` means the operator unticked the box, which used
    // to reserve a subdomain anyway because the block ran unconditionally.
    expect(CORE).toMatch(/if\s*\(\s*data\.subdomain\s*!==\s*null\s*\)/);
  });

  it("hands the reserved name back rather than letting a caller guess it", () => {
    expect(CORE).toMatch(/subdomainFqdn:\s*reservedFqdn/);
    expect(WIZARD).toMatch(/result\.subdomainFqdn/);
  });
});

describe("a name a person typed is not silently changed", () => {
  const REQUEST = stripComments(read("src", "server", "subdomain-hosting.functions.ts"));

  it("the operator-facing route refuses a suffix rather than taking it", () => {
    expect(REQUEST).toMatch(/refuseIfSuffixed:\s*true/);
  });

  it("and it goes through the same writer, not its own update", () => {
    expect(REQUEST).toMatch(/await\s+provisionCloneSubdomain\s*\(/);
  });

  it("a refused reservation is rolled back, never left standing", () => {
    // Without this, an operator told "taken" still ends up with `acme-2` on the
    // row — the worst outcome of the three, because it is a name nobody knows.
    const src = stripComments(read(ALLOCATOR));
    const refusal = src.slice(src.indexOf("refuseIfSuffixed && reservation.suffixed"));
    expect(refusal.slice(0, refusal.indexOf('reason: "subdomain_taken"'))).toMatch(
      /subdomain:\s*null/,
    );
  });
});

describe("a refused rename leaves the clone on the name it had", () => {
  const source = readFileSync(new URL("./subdomainAllocation.server.ts", import.meta.url), "utf8");
  // Line comments only — a block-comment strip deletes real code from any
  // source carrying `/*` inside one, measured elsewhere in this repo.
  const bare = source.replace(/\/\/[^\n]*/g, " ");

  it("reads the prior name BEFORE the reservation overwrites it", () => {
    /*
      `reserveCloneSubdomain` writes its allocation onto the row, so by the
      time `refuseIfSuffixed` decides to refuse, the clone's previous name is
      already gone. Reading it inside the refusal branch would read the
      allocation, not the name being protected.
    */
    const readAt = bare.indexOf("const { data: priorRow }");
    const reserveAt = bare.indexOf("const reservation = await reserveCloneSubdomain(");
    expect(readAt, "expected the prior-name read").toBeGreaterThan(-1);
    expect(reserveAt).toBeGreaterThan(readAt);
  });

  it("the rollback restores rather than clears", () => {
    // It wrote three NULLs unconditionally — right for a clone that had no
    // name, and data loss for one that did: a rename refused because the new
    // name was taken detached the clone from the valid hostname it was
    // already serving on.
    const branch = bare.slice(bare.indexOf("if (input.refuseIfSuffixed"));
    const undo = branch.slice(0, branch.indexOf('.eq("id", input.cloneId)'));
    expect(undo).toContain("const restore = prior");
    expect(undo).toContain("subdomain: prior.subdomain");
    expect(undo, "the update writes the restore, not a literal").toMatch(/\.update\(restore\)/);
  });

  it("a clone with no prior name still clears, which is the unchanged case", () => {
    const branch = bare.slice(bare.indexOf("if (input.refuseIfSuffixed"));
    expect(branch).toMatch(/\{ subdomain: null, subdomain_fqdn: null, subdomain_status: null \}/);
  });

  it("and the refusal word is still the one the pre-submit check uses", () => {
    // Two words for one refusal would break the agreement between the surface
    // that checks before submitting and the surface that refuses on submit —
    // which is the property this reason exists for.
    const branch = bare.slice(bare.indexOf("if (input.refuseIfSuffixed"));
    const words = [...branch.matchAll(/reason:\s*"(subdomain_taken[a-z_]*)"/g)].map((m) => m[1]);
    expect(new Set(words)).toEqual(new Set(["subdomain_taken"]));
  });
});
