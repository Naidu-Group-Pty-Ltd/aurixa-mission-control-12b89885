import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPENDENT_TEMPLATE_DISABLED_REASON,
  DEPENDENT_TEMPLATE_SEED,
  INDEPENDENT_TEMPLATE_SEED,
} from "./voiceStackTemplate.pure";

// The migration that registers the two lines' templates carries the manifests
// as JSON. Two copies of one manifest is how a seed and its code come to
// disagree, so this holds them to each other.
const SQL = readFileSync(
  join(__dirname, "..", "..", "supabase", "migrations", "20261011090000_clone_voice_stacks.sql"),
  "utf8",
);

function manifests(): unknown[] {
  return [...SQL.matchAll(/\$manifest\$([\s\S]*?)\$manifest\$/g)].map((m) => JSON.parse(m[1]));
}

describe("the template seed migration", () => {
  it("registers exactly the code's two manifests", () => {
    expect(manifests()).toEqual([INDEPENDENT_TEMPLATE_SEED, DEPENDENT_TEMPLATE_SEED]);
  });

  it("registers the dependent line disabled, with the code's reason", () => {
    const reason = /\$reason\$([\s\S]*?)\$reason\$/.exec(SQL)?.[1];
    expect(reason).toBe(DEPENDENT_TEMPLATE_DISABLED_REASON);
  });

  it("never overwrites a template an operator has edited", () => {
    expect(SQL.match(/on conflict \(crm_mode\) do nothing/g)).toHaveLength(2);
  });

  it("closes every table to browsers: grants revoked, RLS on, no policy", () => {
    expect(SQL).not.toMatch(/create policy/i);
    for (const t of [
      "clone_vapi_custody",
      "clone_ghl_voice_credentials",
      "voice_stack_templates",
      "clone_voice_stacks",
      "clone_voice_stack_ledger",
    ]) {
      expect(SQL).toContain(`alter table public.${t} enable row level security;`);
      expect(SQL).toContain(`revoke all on public.${t} from anon, authenticated;`);
    }
  });
});
