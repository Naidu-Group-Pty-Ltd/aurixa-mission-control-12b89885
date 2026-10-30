import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A clone's reference copy can be run for that clone, from its own page.
 *
 * The hourly pass takes the clone that has waited longest, and the fleet
 * card's "Seed a waiting clone" seeds whichever clone is waiting. When the
 * allow-list gains a table, every clone owes it, so the one an operator is
 * finishing could wait hours behind the rest. Measured 30 Oct 2026 on
 * `tutorial-demo-orrimere-c158c7`: `dashboard_modules` held 0 of the prime's
 * 45 rows, and its two staff accounts could not be created with any module.
 */
const card = () => readFileSync("src/components/clone-backend-card.tsx", "utf8");
const engine = () => readFileSync("src/server/reference-data.server.ts", "utf8");
const fn = () => readFileSync("src/server/reference-data.functions.ts", "utf8");

describe("the clone page copies reference data to its own clone", () => {
  it("names this clone, through the same server function the fleet card uses", () => {
    const src = card();
    expect(src).toMatch(
      /import \{ syncCloneReferenceData \} from "@\/server\/reference-data\.functions"/,
    );
    expect(src).toMatch(/useServerFn\(syncCloneReferenceData\)/);
    expect(src).toMatch(/seedReference\(\{ data: \{ cloneId \} \}\)/);
    // The server function takes the clone and never a table: the allow-list decides.
    expect(fn()).toMatch(/\.\.\.\(data\.cloneId \? \{ cloneId: data\.cloneId \} : \{\}\)/);
    expect(fn()).not.toMatch(/tables:\s*data\./);
  });

  it("is offered on a ready backend only, the one state the copy reads", () => {
    expect(engine()).toMatch(/\.eq\("status", "ready"\)/);
    expect(card()).toMatch(
      /backend\.status === "ready" && \(\s*<Button[\s\S]*?onClick=\{handleSeedReference\}/,
    );
  });

  it("says when the run did not reach the clone, rather than reporting it complete", () => {
    const src = card();
    const at = src.indexOf("const handleSeedReference");
    const handler = src.slice(at, src.indexOf("setSeeding(false);", at));
    // The engine answers ok with an error for a run that could not start.
    expect(handler).toMatch(/else if \(result\.error\) \{\s*toast\.error\(result\.error\)/);
    expect(handler.indexOf("result.error")).toBeLessThan(handler.indexOf("result.done"));
    expect(engine()).toMatch(
      /if \(opts\?\.cloneId\) \{\s*return \{\s*\.\.\.EMPTY,\s*cloneId: opts\.cloneId,\s*error:/,
    );
  });

  it("the fleet card does not read a run that could not start as nothing waiting", () => {
    const src = readFileSync("src/components/reference-data-sync-card.tsx", "utf8");
    const at = src.indexOf("const handleSync");
    const handler = src.slice(at, src.indexOf("setSyncing(false);", at));
    expect(handler.indexOf("result.error")).toBeGreaterThan(-1);
    expect(handler.indexOf("result.error")).toBeLessThan(
      handler.indexOf("No clone is waiting for reference data"),
    );
  });
});
