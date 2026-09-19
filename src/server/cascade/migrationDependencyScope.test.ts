import { describe, it, expect } from "vitest";
import {
  holeRelationNames,
  mentionsAny,
  scopeHoles,
  MAX_SCOPING_BYTES,
  type HoleEvidence,
} from "./migrationDependencyScope.pure";

/** The hole, abridged from 20261202090000_builder_marketplace_ranking.sql. */
const BUILDER_MARKETPLACE_RANKING = `
  ALTER TABLE public.builder_network_stock_items
    ADD COLUMN IF NOT EXISTS rank_item_score numeric,
    ADD COLUMN IF NOT EXISTS rank_builder_band text;
  CREATE INDEX IF NOT EXISTS builder_network_stock_items_rank_idx
    ON public.builder_network_stock_items (rank_item_score DESC);
  CREATE OR REPLACE VIEW public.builder_network_stock_ranked AS SELECT 1;
  ALTER TABLE public.builder_network_inbound_events
    ADD COLUMN IF NOT EXISTS rank_applied_at timestamptz;
  CREATE OR REPLACE FUNCTION public.builder_network_apply_stock_ranks(n integer)
    RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;
`;

/** One of the three it withheld, abridged from 20261203010000. */
const REFRESH_ACTIVE_MASTERS = `
  UPDATE public.report_templates rt
     SET page_plan = tle.page_plan
    FROM public.template_library_entries tle
   WHERE tle.entry_id = rt.entry_id AND rt.is_active;
`;

function hole(over: Partial<HoleEvidence> = {}): HoleEvidence {
  return {
    id: "20261202090000",
    readable: true,
    creates: holeRelationNames(BUILDER_MARKETPLACE_RANKING),
    ...over,
  };
}

describe("holeRelationNames", () => {
  it("names the relations the builder-marketplace hole creates or alters", () => {
    const names = holeRelationNames(BUILDER_MARKETPLACE_RANKING);
    expect(names).toContain("builder_network_stock_items");
    expect(names).toContain("builder_network_inbound_events");
    expect(names).toContain("builder_network_stock_ranked");
    expect(names).toContain("builder_network_apply_stock_ranks");
  });

  it("reports a column's TABLE, since a dependant names the table", () => {
    expect(holeRelationNames(BUILDER_MARKETPLACE_RANKING)).not.toContain("rank_item_score");
  });

  it("declares nothing for a policy rewrite, which is what keeps rollback scripts blocking", () => {
    // The two rollback_*_rls_policies.sql files in this corpus create no
    // relation at all. `scopeHoles` must treat that as opaque, not as safe.
    const rollback = `
      DROP POLICY IF EXISTS p ON public.clients;
      CREATE POLICY p ON public.clients USING (true) WITH CHECK (true);
      GRANT SELECT ON public.clients TO public;
    `;
    expect(holeRelationNames(rollback)).toEqual([]);
  });

  it("drops names too short to be distinctive", () => {
    expect(holeRelationNames("CREATE TABLE public.ab (id int);")).toEqual([]);
  });
});

describe("mentionsAny", () => {
  it("finds a name on an identifier boundary", () => {
    expect(mentionsAny("select * from builder_network_stock_items", ["builder_network_stock_items"])).toBe(
      "builder_network_stock_items",
    );
    expect(mentionsAny("FROM Public.Builder_Network_Stock_Items x", ["builder_network_stock_items"])).toBe(
      "builder_network_stock_items",
    );
  });

  it("does not match a longer identifier that merely contains it", () => {
    expect(mentionsAny("insert into report_templates_archive", ["report_templates"])).toBeNull();
    expect(mentionsAny("select x_report_templates", ["report_templates"])).toBeNull();
  });

  it("is null on an empty name set rather than matching everything", () => {
    expect(mentionsAny("anything at all", [])).toBeNull();
  });
});

describe("scopeHoles", () => {
  it("sends a candidate with no holes ahead of it", () => {
    expect(scopeHoles(REFRESH_ACTIVE_MASTERS, [])).toEqual({ act: "send" });
  });

  it("sends the template-library refresh past the builder-marketplace hole", () => {
    // The measured case: three template-library migrations withheld behind a
    // builder-marketplace one with no object in common.
    expect(scopeHoles(REFRESH_ACTIVE_MASTERS, [hole()])).toEqual({ act: "send" });
  });

  it("holds a candidate that names something the hole creates", () => {
    const dependant = `
      SELECT public.builder_network_apply_stock_ranks(100);
    `;
    const decision = scopeHoles(dependant, [hole()]);
    expect(decision).toEqual({
      act: "blocked",
      blockedBy: ["20261202090000"],
      why: "references",
    });
  });

  it("holds a candidate whose SQL could not be read at all", () => {
    // null is what an oversize refusal, a GitHub 403 and an unknown id all
    // resolve to — every one of them keeps the prefix barrier.
    const decision = scopeHoles(null, [hole()]);
    expect(decision.act).toBe("blocked");
    if (decision.act !== "blocked") throw new Error("unreachable");
    expect(decision.why).toBe("indeterminate");
  });

  it("holds on a hole it could not read, and names only that hole", () => {
    const decision = scopeHoles(REFRESH_ACTIVE_MASTERS, [
      hole(),
      hole({ id: "20261204000000", readable: false, creates: [] }),
    ]);
    expect(decision).toEqual({
      act: "blocked",
      blockedBy: ["20261204000000"],
      why: "indeterminate",
    });
  });

  it("holds on a hole that declares no relation, which is the rollback-script case", () => {
    const decision = scopeHoles(REFRESH_ACTIVE_MASTERS, [
      hole({ id: "20250101000000_rollback_rls_policies", creates: [] }),
    ]);
    expect(decision.act).toBe("blocked");
    if (decision.act !== "blocked") throw new Error("unreachable");
    expect(decision.why).toBe("indeterminate");
    expect(decision.blockedBy).toEqual(["20250101000000_rollback_rls_policies"]);
  });

  it("finds a dependency written inside a dollar-quoted body", () => {
    // `stripSqlNoise` removes dollar-quoted BODIES before the extractor reads
    // them, which is right for finding what a file CREATES and would be wrong
    // here — a function body calling the hole's function is a dependency.
    // This pins the behaviour either way so a change to it is a decision.
    const dependant = `
      CREATE OR REPLACE FUNCTION public.nightly() RETURNS void AS $$
      BEGIN PERFORM public.builder_network_apply_stock_ranks(10); END;
      $$ LANGUAGE plpgsql;
    `;
    expect(scopeHoles(dependant, [hole()]).act).toBe("blocked");
  });

  it("keeps a ceiling small enough to refuse the 41 MB seeds and pass every DDL file", () => {
    expect(MAX_SCOPING_BYTES).toBeLessThan(41_000_000);
    expect(MAX_SCOPING_BYTES).toBeGreaterThan(100_000);
  });
});
