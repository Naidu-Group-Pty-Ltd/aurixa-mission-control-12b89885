import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripNonCode } from "@/server/cascade/heldFileStaleness.pure";

/**
 * The defect this closes was not in an algorithm. It was a STRING — two
 * readers reaching into a blob for `payload.status ?? payload.health`, keys
 * `CloneHealth` has never carried — and it drew 0.00% in destructive red on a
 * fleet answering HTTP 200 in under 50 ms, for as long as the surface has
 * existed.
 *
 * A test of the arithmetic could not have caught it. These are the properties
 * that make it un-reintroducible.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const SRC = sourceFiles("src").map((path) => ({
  path,
  code: stripNonCode(readFileSync(path, "utf8")),
}));
const migrations = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join("supabase/migrations", f), "utf8"))
  .join("\n");

describe("an SLO reads a column, never a payload", () => {
  it("nothing anywhere resolves an uptime status out of a health payload", () => {
    // The exact expression that shipped, and the near-misses it invites.
    const forbidden = [/payload\.status/, /payload\.health\b/, /payload\?\.\s*status/];
    for (const { path, code } of SRC) {
      for (const pattern of forbidden) {
        expect(code, `${path} reaches into a payload for a status`).not.toMatch(pattern);
      }
    }
  });

  it("exactly one module turns the probe into columns", () => {
    // Reading `health.uptime.status` off a TYPED `CloneHealth` is fine and
    // several surfaces do it — a wrong field there is a compile error. What
    // could not be caught that way was the extraction into the series, so
    // there is exactly one of those, in the module that defines the type.
    const writers = SRC.filter(({ code }) =>
      /from\(\s*"clone_health_history"\s*\)\s*\.insert\(/.test(code),
    );
    expect(writers.map((w) => w.path)).toEqual(["src/server/clone-health.server.ts"]);
  });
});

describe("the cache is not a history, and neither is asked to be the other", () => {
  it("`clone_health_snapshots` keeps its one-row-per-clone key", () => {
    // Widening the cache instead of adding a series would have broken
    // `readCachedCloneHealth` and the `onConflict: "clone_id"` upsert under it.
    expect(migrations).toMatch(/clone_id\s+UUID\s+NOT NULL\s+UNIQUE\s+REFERENCES/i);
    expect(migrations).not.toMatch(/DROP\s+CONSTRAINT[^\n]*clone_health_snapshots_clone_id_key/i);
  });

  it("nothing reads a windowed series out of the cache any more", () => {
    // A history-shaped read against a table holding one row per clone: it
    // returned one row, or zero, whatever window it asked for.
    for (const { path, code } of SRC) {
      if (!code.includes("clone_health_snapshots")) continue;
      const windowed = /clone_health_snapshots[\s\S]{0,400}?\.(gte|lte)\(\s*"probed_at"/;
      expect(code, `${path} reads the cache as a series`).not.toMatch(windowed);
    }
  });

  it("the series is aggregated in the database, never counted in a function", () => {
    // 78,000 rows over the widest window this page offers; 1.3 million at
    // fifty clones.
    for (const { path, code } of SRC) {
      // A `.delete(...).select("id")` is a RETURNING projection, not a read of
      // the series — the prune uses one to report how many rows it removed.
      const readsRaw =
        /from\(\s*"clone_health_history"\s*\)((?:(?!\.delete\()[\s\S]){0,160}?)\.select\(/;
      expect(code, `${path} selects raw probe rows`).not.toMatch(readsRaw);
    }
    expect(migrations).toContain("CREATE OR REPLACE VIEW public.clone_health_daily");
  });

  it("the view does not become a way around RLS", () => {
    expect(migrations).toMatch(
      /CREATE OR REPLACE VIEW public\.clone_health_daily\s*\n\s*WITH \(security_invoker = on\)/,
    );
  });
});

describe("the surfaces read through the server", () => {
  const timeline = SRC.find((f) => f.path.endsWith("clone-health-timeline.tsx"))!;

  it("the sparkline no longer queries a table from the browser", () => {
    // RLS FILTERS rather than erroring, so the browser read returned [] with
    // HTTP 200 and the component's `return null` drew the same nothing for a
    // clone with no probes, a clone whose read was refused, and a clone this
    // card was never meant to draw for.
    expect(timeline.code).not.toContain("supabase.from(");
    expect(timeline.code).not.toContain('from "@/integrations/supabase/client"');
  });

  it("it says which of those it is instead of rendering nothing", () => {
    expect(timeline.code).toContain("could not be read");
    expect(timeline.code).toContain("No probes recorded");
  });

  it("a day that measured nothing is drawn as a gap, not a floor", () => {
    expect(timeline.code).toContain("connectNulls={false}");
  });
});

describe("the series is the scheduled cadence and nothing else", () => {
  it("exactly one caller records a sample, and it is the cron", () => {
    // An SLO over an irregular cadence is not a measurement. Three callers
    // probe on demand — the health card's Refresh, the /health dashboard, a
    // forced fleet walk — and those are taken at moments a person chose, which
    // in practice means when somebody already suspected a problem.
    const recorders = SRC.filter(({ code }) => /recordSample:\s*true/.test(code));
    expect(recorders.map((r) => r.path)).toEqual(["src/routes/hooks.warm-health.tsx"]);
  });

  it("it defaults to off, so a new caller joins the series only on purpose", () => {
    const writer = SRC.find((f) => f.path.endsWith("clone-health.server.ts"))!;
    expect(writer.code).toContain("if (opts.recordSample)");
  });

  it("the table grants no INSERT, so the cadence is an access control", () => {
    // The cache beside it grants operators `FOR ALL`. This one grants SELECT
    // and nothing else: the only writer is the service role.
    const policies = migrations.match(/CREATE POLICY[^;]*clone_health_history[^;]*;/gi) ?? [];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p, `a non-SELECT policy on the series: ${p}`).toMatch(/FOR SELECT/i);
    }
  });
});

describe("the retention prune rides a job that is proven to run", () => {
  it("it is in the five-minute health pass, not a cron of its own", () => {
    const hook = SRC.find((f) => f.path.endsWith("hooks.warm-health.tsx"))!;
    expect(hook.code).toContain("clone_health_history");
    expect(hook.code).toContain("HEALTH_HISTORY_RETENTION_DAYS");
    // Six pg_cron jobs in this platform's history were never scheduled at all,
    // silently. A seventh for housekeeping is not worth that risk.
    expect(migrations).not.toMatch(/cron\.schedule\(\s*\n?\s*'clone-health-prune'/);
  });

  it("a failed prune is reported rather than swallowed", () => {
    const hook = SRC.find((f) => f.path.endsWith("hooks.warm-health.tsx"))!;
    expect(hook.code).toMatch(/pruned/);
    expect(hook.code).toMatch(/error \? `failed/);
  });
});
