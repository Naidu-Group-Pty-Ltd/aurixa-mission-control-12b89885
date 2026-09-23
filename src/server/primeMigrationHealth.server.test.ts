/**
 * The survey pass, exercised on what it FETCHES and what it refuses to say.
 *
 * Two properties carry this module and neither is visible in a verdict:
 *
 *   - it is BOUNDED — twenty-five bodies at most, four in flight — because
 *     the alternative is hundreds of requests to draw one table;
 *   - a read that failed is reported as one, never as a clean empty corpus.
 *
 * So the blob loads are captured and the assertions are about that transcript
 * and about the notes, rather than about a survey the module computed.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  WITHHELD_ROWS,
  type PrimeLedgerReading,
  type WithheldRow,
} from "./primeMigrationLedger.pure";

const state = vi.hoisted(() => ({
  /** Every migration id whose body was asked for, in order. */
  loaded: [] as string[],
  /** How many loads are in flight at the same moment, and the highest seen. */
  inFlight: 0,
  peak: 0,
  files: [] as Array<{ id: string; name: string; path: string }>,
  bodies: new Map<string, string>(),
  sizes: new Map<string, number>(),
  loadThrows: null as null | ((id: string) => Error | null),
  sourceNull: false,
  corpusThrows: null as null | Error,
  ledger: null as unknown,
  runnable: null as string[] | null,
  withdrawal: { state: "absent", excluded: [], unmatched: [] } as {
    state: "absent" | "read" | "unreadable";
    why?: string;
    excluded: Array<{ id: string; name: string; path: string }>;
    unmatched: string[];
  },
}));

vi.mock("./github-app.server", () => ({ getAppOctokit: () => ({}) }));

vi.mock("./prime-backend.server", () => ({
  MAX_MIGRATION_BYTES: 8 * 1024 * 1024,
  resolvePrimeSource: async () =>
    state.sourceNull
      ? null
      : { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" },
  openPrimeMigrationCorpus: async () => {
    if (state.corpusThrows) throw state.corpusThrows;
    return {
      metas: state.files,
      sourceSha: "abc1234def",
      withdrawal: state.withdrawal,
      // The pass hands FILES, never bare versions; these fixtures key by version
      // because none of the files a body is read for shares one.
      sizeOf: (ref: string | { id: string }) =>
        state.sizes.get(typeof ref === "string" ? ref : ref.id) ?? null,
      loadSql: async (ref: string | { id: string }) => {
        const id = typeof ref === "string" ? ref : ref.id;
        state.loaded.push(id);
        state.inFlight += 1;
        state.peak = Math.max(state.peak, state.inFlight);
        // A turn of the event loop, so overlapping loads really overlap.
        await new Promise((r) => setTimeout(r, 1));
        state.inFlight -= 1;
        const boom = state.loadThrows?.(id);
        if (boom) throw boom;
        const sql = state.bodies.get(id);
        if (sql === undefined) throw new Error(`no body for ${id}`);
        return sql;
      },
    };
  },
}));

vi.mock("./primeMigrationLedger.server", () => ({
  buildPrimeLedgerAssessment: async () => ({
    assessment: { reading: state.ledger, runnableVersions: state.runnable },
    repo: { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" },
    primeRef: "dduzbchuswwbefdunfct",
    headSha: "abc1234def",
  }),
}));

import {
  readPrimeCorpusHealth,
  SURVEY_LIMIT,
  BODY_CONCURRENCY,
} from "./primeMigrationHealth.server";
import { OversizedMigrationError } from "./oversizedMigration.pure";

const supabase = {} as never;

const reading = (over: Partial<PrimeLedgerReading> = {}): PrimeLedgerReading => ({
  standing: "holding",
  tone: "warn",
  headline: "The prime is holding migrations back.",
  remedy: "Apply them.",
  corpusCount: state.files.length,
  ledgerCount: 100,
  runnableCount: 0,
  withheldCount: over.withheld?.length ?? 0,
  neverApplied: 0,
  skewSuspected: 0,
  bodyUnread: 0,
  runnableByBody: 0,
  ledgerBodyCount: 0,
  frontier: null,
  unmatchedLedgerRows: 0,
  withheld: [],
  ...over,
});

const row = (id: string, name = `${id}_thing.sql`): WithheldRow => ({
  id,
  name,
  reason: "never_applied",
  nearestPrimeVersion: null,
  skewSeconds: null,
});

/** `n` migrations, each with a body, newest last in corpus order. */
function corpusOf(n: number, sql = "create table if not exists public.t (id int);") {
  state.files = [];
  for (let i = 0; i < n; i++) {
    const id = String(20260101000000 + i);
    state.files.push({ id, name: `${id}_thing.sql`, path: `supabase/migrations/${id}_thing.sql` });
    state.bodies.set(id, sql);
  }
}

beforeEach(() => {
  state.withdrawal = { state: "absent", excluded: [], unmatched: [] };
  state.loaded = [];
  state.inFlight = 0;
  state.peak = 0;
  state.files = [];
  state.bodies = new Map();
  state.sizes = new Map();
  state.loadThrows = null;
  state.sourceNull = false;
  state.corpusThrows = null;
  state.runnable = [];
  state.ledger = reading();
});

describe("the pass is bounded", () => {
  it("reads at most SURVEY_LIMIT bodies however many the reading hands it", async () => {
    /*
      The reading is handed MORE rows than the limit on purpose. Today
      `WITHHELD_ROWS` caps it at the same number, so a test that fed exactly
      the cap would pass with the module's own `.slice` deleted — it would be
      asserting a property of the fixture, the trap this repository paid for
      on a 35-character `recommendation.headline`. The slice exists so the two
      constants can drift without this pass becoming unbounded, and that is
      what is measured here.
    */
    corpusOf(SURVEY_LIMIT + 20);
    const withheld = state.files.map((f) => row(f.id, f.name));
    state.ledger = reading({ withheld, withheldCount: withheld.length });

    const health = await readPrimeCorpusHealth(supabase);

    expect(state.loaded).toHaveLength(SURVEY_LIMIT);
    expect(health.surveys).toHaveLength(SURVEY_LIMIT);
    // …and the total is still exact, so the page cannot imply the corpus is small.
    expect(health.withheldCount).toBe(SURVEY_LIMIT + 20);
    expect(health.notes.join(" ")).toContain(`${SURVEY_LIMIT + 20} migrations are withheld`);
  });

  it("reads exactly the list the ledger reading carries", () => {
    // Equal by construction: this surveys the rows that reading carries, so a
    // smaller limit leaves rows on the page unread and a larger one fetches
    // bodies nothing draws. Nothing else enforced it.
    expect(SURVEY_LIMIT).toBe(WITHHELD_ROWS);
  });

  it("never has more than BODY_CONCURRENCY blob reads in flight", async () => {
    corpusOf(12);
    state.ledger = reading({
      withheld: state.files.map((f) => row(f.id, f.name)),
      withheldCount: 12,
    });

    await readPrimeCorpusHealth(supabase);

    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(BODY_CONCURRENCY);
  });

  it("keeps the surveys in the order the ledger listed them", async () => {
    corpusOf(6);
    const withheld = state.files.map((f) => row(f.id, f.name)).reverse();
    state.ledger = reading({ withheld, withheldCount: 6 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.surveys.map((s) => s.id)).toEqual(withheld.map((w) => w.id));
  });
});

describe("a read that failed is never a clean corpus", () => {
  it("says the listing failed rather than drawing no files", async () => {
    state.corpusThrows = new Error("403 from GitHub");
    state.ledger = reading({ withheld: [row("20260101000000")], withheldCount: 1 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.facts).toBeNull();
    expect(health.surveys).toEqual([]);
    expect(health.notes.join(" ")).toContain("403 from GitHub");
  });

  it("says the prime is not configured rather than reporting zero migrations", async () => {
    state.sourceNull = true;
    const health = await readPrimeCorpusHealth(supabase);

    expect(health.repo).toBeNull();
    expect(health.facts).toBeNull();
    expect(health.notes.join(" ")).toContain("No prime repository is configured");
  });

  it("carries a null withheld count through rather than a zero", async () => {
    state.ledger = reading({ standing: "unreadable", withheldCount: null, withheld: [] });
    state.runnable = null;
    corpusOf(3);

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.withheldCount).toBeNull();
    expect(health.notes.join(" ")).toContain("could not be established");
  });

  it("reports one unreadable body without losing the rest of the pass", async () => {
    corpusOf(3);
    const ids = state.files.map((f) => f.id);
    state.loadThrows = (id) => (id === ids[1] ? new Error("blob fetch failed") : null);
    state.ledger = reading({ withheld: ids.map((id) => row(id)), withheldCount: 3 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.surveys).toHaveLength(3);
    expect(health.surveys[1].standing).toBe("unknown");
    expect(health.surveys[1].idempotency.reading).toBe("unreadable");
    expect(health.surveys[0].standing).not.toBe("unknown");
    expect(health.surveys[2].standing).not.toBe("unknown");
  });

  it("reads a body past the ceiling as too large rather than as a failure", async () => {
    corpusOf(1);
    const id = state.files[0].id;
    state.loadThrows = () => new OversizedMigrationError(id, 9_000_000, 8 * 1024 * 1024);
    state.ledger = reading({ withheld: [row(id)], withheldCount: 1 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.surveys[0].standing).toBe("too_large");
  });
});

describe("what it knows without opening anything", () => {
  it("counts duplicate versions, undos and oversize files from the listing alone", async () => {
    corpusOf(3);
    const [a, b] = state.files;
    // A second file on `a`'s version, and an undo.
    state.files.push({
      id: a.id,
      name: `${a.id}_other.sql`,
      path: `supabase/migrations/${a.id}_other.sql`,
    });
    state.files.push({
      id: "20260201000000",
      name: "20260201000000_rollback_rls.sql",
      path: "supabase/migrations/20260201000000_rollback_rls.sql",
    });
    state.sizes.set(b.id, 9 * 1024 * 1024);
    state.ledger = reading({ withheld: [], withheldCount: 0 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(state.loaded).toEqual([]);
    expect(health.facts?.collisions.map((c) => c.version)).toEqual([a.id]);
    expect(health.facts?.rollbackScripts).toEqual(["20260201000000_rollback_rls.sql"]);
    expect(health.facts?.oversize.map((f) => f.id)).toEqual([b.id]);
    // Every other file carried no size, and an unknown size is not a small one.
    expect(health.facts?.sizeUnknown).toBe(4);
  });
});

describe("what sits in front of a withheld file", () => {
  it("counts the earlier migrations the prime has not run", async () => {
    corpusOf(4);
    const ids = state.files.map((f) => f.id);
    // The prime ran the first two; the last two are withheld.
    state.runnable = [ids[0], ids[1]];
    state.ledger = reading({ withheld: [row(ids[3]), row(ids[2])], withheldCount: 2 });

    const health = await readPrimeCorpusHealth(supabase);

    const last = health.surveys.find((s) => s.id === ids[3])!;
    expect(last.blockedByCount).toBe(1);
    expect(last.standing).toBe("blocked");

    const third = health.surveys.find((s) => s.id === ids[2])!;
    expect(third.blockedByCount).toBe(0);
    expect(third.standing).toBe("needs_a_trial_run");
  });

  it("says unknown rather than none when the prime's position could not be read", async () => {
    corpusOf(2);
    state.runnable = null;
    state.ledger = reading({ withheld: [row(state.files[1].id)], withheldCount: 1 });

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.surveys[0].blockedByCount).toBeNull();
    expect(health.surveys[0].standing).toBe("unknown");
  });
});

describe("the prime's declared withdrawals", () => {
  it("says so on the page when the manifest could not be used", async () => {
    corpusOf(2);
    state.withdrawal = {
      state: "unreadable",
      why: "MIGRATION_WITHDRAWN.json is not valid JSON",
      excluded: [],
      unmatched: [],
    };

    const health = await readPrimeCorpusHealth(supabase);

    const text = health.notes.join(" ");
    expect(text).toMatch(/could not be used/);
    expect(text).toMatch(/not valid JSON/);
  });

  it("names the files it keeps off every clone", async () => {
    corpusOf(2);
    const file = {
      id: "20260728120000",
      name: "20260728120000_aml_verification_checks.sql",
      path: "supabase/migrations/20260728120000_aml_verification_checks.sql",
    };
    state.withdrawal = { state: "read", excluded: [file], unmatched: [] };

    const health = await readPrimeCorpusHealth(supabase);

    expect(health.notes.join(" ")).toContain("20260728120000_aml_verification_checks.sql");
  });

  it("says nothing when the prime declares nothing", async () => {
    corpusOf(2);
    const health = await readPrimeCorpusHealth(supabase);
    expect(health.notes.join(" ")).not.toMatch(/MIGRATION_WITHDRAWN/);
  });
});
