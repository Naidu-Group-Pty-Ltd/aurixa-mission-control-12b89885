import { describe, expect, it } from "vitest";
import { declaredFunctionSourcesOwed } from "./declaredFunctionSources.pure";

const toml = [
  'project_id = "abc"',
  "",
  "[functions.agent-realtime-session]",
  "verify_jwt = true",
  "",
  "[functions.crm-calendar]",
  "verify_jwt = true",
  "",
  "[functions.urban-centre-register-ingest]",
  "verify_jwt = false",
  "",
].join("\n");

const prime = new Map([
  ["supabase/functions/agent-realtime-session/index.ts", "p1"],
  ["supabase/functions/urban-centre-register-ingest/index.ts", "p2"],
  ["supabase/functions/urban-centre-register-ingest/deno.json", "p3"],
  ["supabase/functions/_shared/x.ts", "p4"],
]);

describe("a declared function travels with its source", () => {
  it("owes prime's files for every declared function the clone has no directory for", () => {
    const clone = new Map([["supabase/functions/crm-calendar/index.ts", "c1"]]);
    expect(declaredFunctionSourcesOwed({ toml, prime, clone, delivering: new Set() })).toEqual([
      "supabase/functions/agent-realtime-session/index.ts",
      "supabase/functions/urban-centre-register-ingest/deno.json",
      "supabase/functions/urban-centre-register-ingest/index.ts",
    ]);
  });

  it("owes nothing for a directory the clone holds or this pass already writes", () => {
    const clone = new Map([
      ["supabase/functions/crm-calendar/index.ts", "c1"],
      ["supabase/functions/agent-realtime-session/index.ts", "c2"],
    ]);
    const delivering = new Set(["supabase/functions/urban-centre-register-ingest/index.ts"]);
    expect(declaredFunctionSourcesOwed({ toml, prime, clone, delivering })).toEqual([]);
  });

  it("owes nothing prime does not hold either (a clone-only function stays the clone's)", () => {
    const clone = new Map<string, string>();
    const owed = declaredFunctionSourcesOwed({
      toml,
      prime: new Map(),
      clone,
      delivering: new Set(),
    });
    expect(owed).toEqual([]);
  });
});
