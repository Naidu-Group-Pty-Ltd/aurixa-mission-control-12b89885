/**
 * Every cascade a person starts asks the second-operator gate, on the server.
 *
 * ## What this is here to make impossible
 *
 * `cascade_events.requires_approval` defaults to false and nothing in the
 * database computes it, so an insert that does not name it is ungated, and the
 * engine's gate (`isBlockedByApproval`) reads the stored false and runs. On
 * 27 Oct 2026 three operator paths wrote their own events that way:
 * `approveAndDeploy`, the fleet manager's bulk apply (whose auto-merge across
 * the fleet's four clones is past `AUTO_MERGE_THRESHOLD`) and the bulk cascade
 * card, the last two from the browser. Each ran with one operator where the
 * same push from `/cascades` waited for two.
 *
 * So: no page inserts a cascade event at all (a page renders the server's
 * answer: `fireCascade` and `useLaunchCascade`), and every server insert names
 * `requires_approval`, except the two automatic lanes named below with why.
 *
 * Asserted on the source, as the drain's other contracts are, because the
 * property is where an insert is and what it says, over the whole tree.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "@/server/sourceComments.pure";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** The argument of the call whose open paren ends at `from`, balanced. */
function argumentAt(source: string, from: number): string {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") depth -= 1;
    i += 1;
  }
  return source.slice(from, i - 1).trim();
}

/** The object literal an identifier is declared as, following a rest-spread to its source. */
function definitionOf(source: string, name: string, depth = 0): string {
  const literal = new RegExp(String.raw`(?:const|let) ${name}\b[^=]*=\s*\{[\s\S]*?\n\s*\};`).exec(
    source,
  );
  if (literal) return literal[0];
  const rest = new RegExp(String.raw`\.\.\.${name}\s*\}\s*=\s*([A-Za-z_$][\w$]*)`).exec(source);
  return rest && depth < 3 ? definitionOf(source, rest[1], depth + 1) : "";
}

type Site = { file: string; arg: string; source: string };

const sites: Site[] = [];
for (const file of walk("src")) {
  const source = stripComments(readFileSync(file, "utf8"));
  for (const m of source.matchAll(/from\("cascade_events"\)\s*\.insert\(/g)) {
    sites.push({ file, arg: argumentAt(source, (m.index ?? 0) + m[0].length), source });
  }
}

/** A page or component, not a server route: what runs in the browser. */
const inBrowser = (file: string) =>
  file.startsWith("src/components/") ||
  (file.startsWith("src/routes/") && !/\/(hooks|api)\.[^/]+$/.test(file));

/**
 * The two lanes that mint events with no person behind them, and so take the
 * gate's own answer for an automatic origin (`assessBlastRadius`): no approval.
 */
const AUTOMATIC: Record<string, { arg: RegExp; why: string }> = {
  "src/routes/hooks.cascade-drain.tsx": {
    arg: /^\{\s*id: newId,\s*\.\.\.redeliveryEvent\(/,
    why: "head redelivery: `redeliveryEvent` writes `requires_approval: false` itself",
  },
  "src/server/custodian.server.ts": {
    arg: /^plan\.event$/,
    why: "the custodian re-queues one dropped clone of an event that already ran",
  },
};

describe("every cascade event is created where the gate is asked", () => {
  it("finds the inserts it is about", () => {
    // A rename of the table or the call shape would leave nothing to judge.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("is never created by a page", () => {
    expect(sites.filter((s) => inBrowser(s.file)).map((s) => s.file)).toEqual([]);
  });

  it("names requires_approval at every server insert but the two automatic lanes", () => {
    for (const site of sites) {
      const automatic = AUTOMATIC[site.file];
      if (automatic && automatic.arg.test(site.arg)) continue;
      // An identifier is judged by the object it names, in the same file, and a
      // row built as the rest of another (`...legacyRow } = eventRow`) by that one.
      const named = /^[A-Za-z_$][\w$]*$/.test(site.arg)
        ? definitionOf(site.source, site.arg)
        : site.arg;
      expect(named, `${site.file}: ${site.arg.slice(0, 80)}`).toContain("requires_approval");
    }
  });

  it("and each automatic lane is what it says", () => {
    const redelivery = stripComments(
      readFileSync("src/server/cascade/headRedelivery.pure.ts", "utf8"),
    );
    expect(redelivery).toMatch(
      /export function redeliveryEvent\([\s\S]*?requires_approval: false,/,
    );
    const requeue = stripComments(
      readFileSync("src/server/cascade/requeueDroppedClone.pure.ts", "utf8"),
    );
    expect(requeue).toMatch(/clone_ids: \[facts\.cloneId\]/);
    for (const [file, { arg }] of Object.entries(AUTOMATIC)) {
      expect(
        sites.some((s) => s.file === file && arg.test(s.arg)),
        file,
      ).toBe(true);
    }
  });
});

describe("the operator paths that wrote their own events go through the server's flow", () => {
  it("approveAndDeploy asks the gate, and says what it delivers", () => {
    const fn = stripComments(readFileSync("src/server/ai-detect-modules.functions.ts", "utf8"));
    expect(fn).toContain("const blast = assessBlastRadius(mode, data.cloneIds.length);");
    expect(fn).toContain("requires_approval: blast.requiresApproval,");
    expect(fn).not.toContain("Module approval deploy:");
  });

  it("the fleet manager and the bulk card fire through fireCascade", () => {
    for (const file of ["src/routes/fleet-manager.tsx", "src/components/bulk-cascade-card.tsx"]) {
      const page = stripComments(readFileSync(file, "utf8"));
      expect(page, file).toContain('scope: "selected"');
      expect(page, file).toMatch(/fireCascadeFn\(/);
    }
  });
});
