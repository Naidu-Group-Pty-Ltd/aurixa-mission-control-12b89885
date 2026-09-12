import { describe, expect, it } from "vitest";
import { assessSqlDestructiveness, stripSqlLiterals } from "./destructive-sql";

describe("stripSqlLiterals", () => {
  it("removes line comments, block comments, strings and dollar-quoted bodies", () => {
    const sql = [
      "-- DROP TABLE in a comment",
      "SELECT 'DROP TABLE users', /* TRUNCATE x */ 1;",
      "DO $fn$ TRUNCATE hidden $fn$;",
    ].join("\n");
    const stripped = stripSqlLiterals(sql);
    expect(stripped).not.toMatch(/DROP TABLE/);
    expect(stripped).not.toMatch(/TRUNCATE/);
    expect(stripped).toMatch(/SELECT/);
  });

  it("survives an escaped quote inside a string", () => {
    const stripped = stripSqlLiterals(
      "SELECT 'it''s a DROP TABLE trap'; DELETE FROM t WHERE id = 1;",
    );
    expect(stripped).not.toMatch(/DROP TABLE/);
    expect(stripped).toMatch(/DELETE FROM t/);
  });
});

describe("assessSqlDestructiveness", () => {
  it("passes the shape of an ordinary additive migration", () => {
    const sql = `
      CREATE TABLE IF NOT EXISTS public.widgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE public.widgets ADD COLUMN IF NOT EXISTS color TEXT;
      CREATE INDEX IF NOT EXISTS widgets_name_idx ON public.widgets(name);
      GRANT SELECT, INSERT ON public.widgets TO authenticated;
      ALTER TABLE public.widgets ENABLE ROW LEVEL SECURITY;
      UPDATE public.widgets SET color = 'blue' WHERE color IS NULL;
    `;
    const result = assessSqlDestructiveness(sql);
    expect(result.destructive).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.statementCount).toBeGreaterThan(3);
  });

  it("accepts the house drop-and-recreate trigger idiom", () => {
    const sql = `
      DROP TRIGGER IF EXISTS trg_widgets_updated ON public.widgets;
      CREATE TRIGGER trg_widgets_updated BEFORE UPDATE ON public.widgets
        FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    `;
    expect(assessSqlDestructiveness(sql).destructive).toBe(false);
  });

  it.each([
    ["DROP TABLE public.users;", "drops a table"],
    ["DROP SCHEMA analytics CASCADE;", "drops a schema"],
    ["TRUNCATE public.audit_log;", "truncates a table"],
    ["ALTER TABLE public.users DROP COLUMN email;", "drops a column"],
    ["DELETE FROM public.users;", "DELETE without WHERE"],
    ["UPDATE public.users SET plan = NULL;", "UPDATE without WHERE"],
    ["ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;", "disables row-level security"],
    [
      'DROP POLICY "users read own" ON public.users;',
      "drops a row-level-security policy without recreating it",
    ],
    ["GRANT ALL ON public.users TO anon;", "grants privileges to anon/public"],
    ["DROP FUNCTION public.compute_totals(uuid);", "drops a function without recreating it"],
  ])("flags %s", (sql, reason) => {
    const result = assessSqlDestructiveness(sql);
    expect(result.destructive).toBe(true);
    expect(result.findings.map((f) => f.reason)).toContain(reason);
  });

  describe("DROP POLICY", () => {
    it("accepts the drop-and-recreate idiom for the same policy on the same table", () => {
      // Verbatim from 20261102000000_builder_design_images.sql on the prime —
      // the one finding that parked all sixteen pending migrations.
      const sql = `
        ALTER TABLE public.builder_design_images ENABLE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS builder_design_images_service ON public.builder_design_images;
        CREATE POLICY builder_design_images_service ON public.builder_design_images
          AS PERMISSIVE FOR ALL TO service_role
          USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
      `;
      expect(assessSqlDestructiveness(sql).destructive).toBe(false);
    });

    it("still flags a drop whose recreate names a DIFFERENT policy", () => {
      // The access boundary moved: a kind-only test would wave this through.
      const sql = `
        DROP POLICY IF EXISTS widgets_owner_only ON public.widgets;
        CREATE POLICY widgets_anyone ON public.widgets FOR ALL TO authenticated USING (true);
      `;
      const result = assessSqlDestructiveness(sql);
      expect(result.destructive).toBe(true);
      expect(result.findings.map((f) => f.reason)).toContain(
        "drops a row-level-security policy without recreating it",
      );
    });

    it("still flags a drop whose recreate names the same policy on a DIFFERENT table", () => {
      const sql = `
        DROP POLICY p_service ON public.widgets;
        CREATE POLICY p_service ON public.gadgets FOR ALL TO service_role USING (true);
      `;
      expect(assessSqlDestructiveness(sql).destructive).toBe(true);
    });

    it("matches through quoting and case the way Postgres does", () => {
      const sql = `
        DROP POLICY IF EXISTS "Users Read Own" ON Public.Users;
        CREATE POLICY "Users Read Own" ON PUBLIC.USERS FOR SELECT TO authenticated USING (true);
      `;
      expect(assessSqlDestructiveness(sql).destructive).toBe(false);
    });

    it("does not treat a bare table name as the same table as a qualified one", () => {
      // Conservative by design: costs one approval, never an access boundary.
      const sql = `
        DROP POLICY p ON widgets;
        CREATE POLICY p ON public.widgets FOR ALL TO service_role USING (true);
      `;
      expect(assessSqlDestructiveness(sql).destructive).toBe(true);
    });

    it("flags a DROP POLICY it cannot parse rather than exempting it", () => {
      const sql = "DROP POLICY ON;";
      const result = assessSqlDestructiveness(sql);
      expect(result.destructive).toBe(true);
      expect(result.findings.map((f) => f.reason)).toContain("drops a row-level-security policy");
    });

    it("pairs each drop with its own recreate across a multi-policy script", () => {
      const sql = `
        DROP POLICY IF EXISTS a_read ON public.a;
        CREATE POLICY a_read ON public.a FOR SELECT TO authenticated USING (true);
        DROP POLICY IF EXISTS b_read ON public.b;
        CREATE POLICY b_write ON public.b FOR INSERT TO authenticated WITH CHECK (true);
      `;
      const result = assessSqlDestructiveness(sql);
      expect(result.destructive).toBe(true);
      expect(
        result.findings.filter(
          (f) => f.reason === "drops a row-level-security policy without recreating it",
        ).length,
      ).toBe(1);
    });
  });

  it("does not flag destructive keywords hidden in literals or comments", () => {
    const sql = `
      -- This migration replaces the old DROP TABLE approach
      INSERT INTO public.notes (body) VALUES ('remember: never TRUNCATE prod');
    `;
    expect(assessSqlDestructiveness(sql).destructive).toBe(false);
  });

  it("flags every offending statement, not just the first", () => {
    const sql = `
      DROP TABLE a;
      DROP TABLE b;
      DELETE FROM c;
    `;
    const result = assessSqlDestructiveness(sql);
    expect(result.findings.length).toBe(3);
  });

  it("treats a DELETE with a WHERE clause as safe", () => {
    expect(
      assessSqlDestructiveness("DELETE FROM public.sessions WHERE expires_at < now();").destructive,
    ).toBe(false);
  });
});
