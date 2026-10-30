/**
 * No forwarded platform value goes over what a clone's ledger records as its
 * own (owner decision D6, 30 Oct 2026: a key is withdrawn only when the client
 * brings its own).
 *
 * Before this, a repair and the per-clone push read no ledger at all: each
 * wrote Mission Control's value back over the client's key (`set`) or over a
 * key minted for the clone (`minted`), and recorded it `inherited`, which
 * restarts the recharge. Driven here through the real planners, with the
 * ledger read shaped the way supabase-js answers one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provisioning = vi.hoisted(() => ({ setCloneSecretValues: vi.fn() }));
vi.mock("./backend-provisioning.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend-provisioning.server")>()),
  setCloneSecretValues: provisioning.setCloneSecretValues,
}));
const target = vi.hoisted(() => ({ resolveCloneSecretTarget: vi.fn() }));
vi.mock("./cloneAllowedOrigins.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloneAllowedOrigins.server")>()),
  ...target,
}));
const ledgerWrites = vi.hoisted(() => ({ recordSecretLedger: vi.fn(async () => null) }));
vi.mock("./secretLedger.server", () => ledgerWrites);

const { planCloneSecrets } = await import("./backend-provisioning.server");
const { ledgerStatusForShell } = await import("./cloneEmailIdentity.pure");
const { describeKeptForwards, keptFromForward, readForwardLedger, NEVER_FORWARDED_OVER } =
  await import("./cloneSecretForward.pure");
const { pushCloneSecretForwards, reconcileCloneSecretForwards } =
  await import("./cloneSecretForward.server");

const CLONE = "11111111-1111-4111-8111-111111111111";
const REF = "orrimereorrimereorri";

/** A ledger read that answered, as supabase-js returns one. */
const rows = (r: Array<{ name: string; status: string }>) => ({
  data: r,
  error: null,
  count: null,
  status: 200,
  statusText: "OK",
});
/** A ledger read that failed, as supabase-js returns one: no rows, and the error. */
const failed = {
  data: null,
  error: {
    message: "canceling statement due to statement timeout",
    details: null,
    hint: null,
    code: "57014",
  },
  count: null,
  status: 500,
  statusText: "Internal Server Error",
};

/** Shaped like every clone's ledger on 30 Oct 2026, with one key the client brought and one taken off. */
const LEDGER = rows([
  { name: "PERPLEXITY_API_KEY", status: "set" }, // the client brought its own
  { name: "OPENAI_API_KEY", status: "minted" },
  { name: "OPENROUTER_API_KEY", status: "minted" },
  { name: "FIRECRAWL_API_KEY", status: "inherited" },
  { name: "GOOGLE_MAPS_API_KEY", status: "withheld" },
  { name: "ANTHROPIC_API_KEY", status: "federated" },
  { name: "GAMMA_API_KEY", status: "authorised_no_value" },
]);

const gen = () => "GENERATED";

describe("reading what the ledger keeps from a forward", () => {
  it("keeps the clone's own, the minted, the withheld and the federated, and nothing else", () => {
    const ledger = readForwardLedger(LEDGER);
    expect(ledger.read).toBe(true);
    if (!ledger.read) return;
    expect([...ledger.kept.keys()].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "PERPLEXITY_API_KEY",
    ]);
    expect(ledger.kept.get("PERPLEXITY_API_KEY")).toMatchObject({ status: "set" });
    expect(ledger.kept.has("FIRECRAWL_API_KEY")).toBe(false);
    expect([...NEVER_FORWARDED_OVER.keys()]).toEqual(["set", "minted", "withheld", "federated"]);
  });

  it("never reads a failed read as an empty ledger", () => {
    expect(readForwardLedger(failed)).toEqual({
      read: false,
      why: "canceling statement due to statement timeout",
    });
    expect(readForwardLedger({ data: null, error: null })).toMatchObject({ read: false });
    // An empty ledger that answered is an empty ledger.
    expect(readForwardLedger(rows([]))).toEqual({ read: true, kept: new Map() });
  });

  it("with the ledger unread, keeps every name, as the fleet sweep and the push stand down", () => {
    // A name the project does not hold may be one taken off it on purpose.
    const ledger = readForwardLedger(failed);
    const names = ["PERPLEXITY_API_KEY", "FIRECRAWL_API_KEY", "GOOGLE_MAPS_API_KEY"];
    const kept = keptFromForward({ names, ledger });
    expect([...kept.keys()]).toEqual(names);
    expect(kept.get("GOOGLE_MAPS_API_KEY")).toContain(
      "the secret ledger could not be read (canceling statement due to statement timeout)",
    );
  });

  it("says so in the status line, by what was actually kept", () => {
    const read = readForwardLedger(LEDGER);
    expect(describeKeptForwards({ kept: [], ledger: read })).toBeNull();
    expect(
      describeKeptForwards({ kept: ["OPENAI_API_KEY", "PERPLEXITY_API_KEY"], ledger: read }),
    ).toBe(
      "No platform value written over 2 forwarded name(s) this clone's ledger keeps: " +
        "OPENAI_API_KEY (minted), PERPLEXITY_API_KEY (set)",
    );
    const unread = readForwardLedger(failed);
    expect(
      describeKeptForwards({ kept: ["PERPLEXITY_API_KEY", "GAMMA_API_KEY"], ledger: unread }),
    ).toBe(
      "Secret ledger unreadable (canceling statement due to statement timeout): no platform " +
        "value was written, and the forward sweeps deliver what is missing once the ledger reads",
    );
  });
});

describe("a repair or re-provision, through the real planner", () => {
  /** Every name the snapshot carries, and Mission Control holding a value for each forwarded one. */
  const NAMES = [
    "PERPLEXITY_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "FIRECRAWL_API_KEY",
    "GOOGLE_MAPS_API_KEY",
    "ANTHROPIC_API_KEY",
    "GAMMA_API_KEY",
    "TURNSTILE_SECRET_KEY",
  ];
  const INHERITED: Record<string, string> = {
    PERPLEXITY_API_KEY: "aurixa-perplexity",
    OPENAI_API_KEY: "aurixa-openai",
    FIRECRAWL_API_KEY: "aurixa-firecrawl",
    GOOGLE_MAPS_API_KEY: "aurixa-maps",
    ANTHROPIC_API_KEY: "aurixa-anthropic",
  };
  const AUTHORISED = new Set([...Object.keys(INHERITED), "OPENROUTER_API_KEY", "GAMMA_API_KEY"]);
  const plan = (read: Parameters<typeof readForwardLedger>[0]) => {
    const ledger = readForwardLedger(read);
    return planCloneSecrets(NAMES, INHERITED, gen, null, undefined, undefined, AUTHORISED, {
      // The Turnstile identity wrote its own secret: decided by `settled`, as before.
      settled: new Map([["TURNSTILE_SECRET_KEY", "2026-10-29T22:11:49.645Z"]]),
      kept: keptFromForward({ names: NAMES, ledger }),
    });
  };
  const rowOf = (
    results: Map<string, { status: Parameters<typeof ledgerStatusForShell>[0] }>,
    n: string,
  ) => ledgerStatusForShell(results.get(n)!.status);

  it("writes Mission Control's value only where the ledger does not keep the name", () => {
    const { toWrite, results } = plan(LEDGER);
    expect(toWrite.map((w) => w.name)).toEqual(["FIRECRAWL_API_KEY"]);
    for (const n of [
      "PERPLEXITY_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(results.get(n)).toMatchObject({ status: "kept_clone_value", success: true });
      // And the row that records the clone's own stands: no ledger row is written.
      expect(rowOf(results, n)).toBeNull();
    }
    expect(results.get("FIRECRAWL_API_KEY")).toMatchObject({ status: "inherited" });
  });

  it("keeps a minted row even where Mission Control holds no value for the name", () => {
    // Without this, the row became `authorised_no_value`, and the next sweep read the name as owed.
    const { results } = plan(LEDGER);
    expect(results.get("OPENROUTER_API_KEY")).toMatchObject({ status: "kept_clone_value" });
    expect(rowOf(results, "OPENROUTER_API_KEY")).toBeNull();
    // A name the ledger does not keep still says what it is.
    expect(results.get("GAMMA_API_KEY")).toMatchObject({ status: "authorised_no_value" });
  });

  it("leaves Turnstile to the step that owns it", () => {
    const { results } = plan(LEDGER);
    expect(results.get("TURNSTILE_SECRET_KEY")).toMatchObject({ status: "set" });
  });

  it("with the ledger unread, writes no forwarded value and no row it cannot vouch for", () => {
    // Not over a value the project holds, nor onto one it does not: that may be
    // a name taken off it on purpose. The sweeps deliver it once the ledger reads.
    const { toWrite, results } = plan(failed);
    expect(toWrite).toEqual([]);
    for (const n of [...Object.keys(INHERITED), "OPENROUTER_API_KEY", "GAMMA_API_KEY"]) {
      expect(results.get(n)).toMatchObject({ status: "kept_clone_value", success: true });
      expect(results.get(n)?.error).toContain("the secret ledger could not be read");
      // No row: the one there may be the clone's own.
      expect(rowOf(results, n)).toBeNull();
    }
    // Turnstile is still decided by the step that owns it.
    expect(results.get("TURNSTILE_SECRET_KEY")).toMatchObject({ status: "set" });
  });
});

/** Mission Control's own tables, as the per-clone push reads them. */
function fakeSupabase(opts: {
  forwards: Array<{ clone_id: string; name: string }>;
  ledger: { data: Array<Record<string, unknown>> | null; error: unknown };
}) {
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const result = () => {
      if (table === "clone_secret_forwards") {
        return {
          data: opts.forwards.filter((r) => filters.every(([c, v]) => (r as never)[c] === v)),
          error: null,
        };
      }
      if (table === "prime_secret_forwards") return { data: [], error: null };
      if (table === "clones") return { data: { crm_mode: null }, error: null };
      if (table === "clone_backend_secrets") return opts.ledger;
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "order", "in"]) q[m] = () => q;
    q.eq = (c: string, v: unknown) => {
      filters.push([c, v]);
      return q;
    };
    q.maybeSingle = async () => result();
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return q;
  };
  return { from } as never;
}

describe("the per-clone push", () => {
  const forwards = ["GOHIGHLEVEL_API_KEY", "GOHIGHLEVEL_LOCATION_ID", "API2PDF_API_KEY"].map(
    (name) => ({ clone_id: CLONE, name }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOHIGHLEVEL_API_KEY", "aurixa-ghl");
    vi.stubEnv("GOHIGHLEVEL_LOCATION_ID", "aurixa-location");
    vi.stubEnv("API2PDF_API_KEY", "aurixa-api2pdf");
    target.resolveCloneSecretTarget.mockResolvedValue({
      cloneId: CLONE,
      cloneName: "Orrimere",
      projectRef: REF,
    });
    provisioning.setCloneSecretValues.mockImplementation(
      async (_ref: string, entries: Array<{ name: string }>) => ({
        ok: true,
        written: entries.map((e) => e.name),
        unchanged: [],
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("never sends Mission Control's value over the client's own or a minted one", async () => {
    const res = await pushCloneSecretForwards(
      fakeSupabase({
        forwards,
        ledger: rows([
          { name: "GOHIGHLEVEL_API_KEY", status: "set" },
          { name: "GOHIGHLEVEL_LOCATION_ID", status: "inherited" },
          { name: "API2PDF_API_KEY", status: "minted" },
        ]),
      }),
      CLONE,
    );
    expect(provisioning.setCloneSecretValues).toHaveBeenCalledTimes(1);
    const sent = provisioning.setCloneSecretValues.mock.calls[0][1] as Array<{ name: string }>;
    expect(sent.map((e) => e.name)).toEqual(["GOHIGHLEVEL_LOCATION_ID"]);
    // Only what was sent is recorded `inherited`.
    expect(ledgerWrites.recordSecretLedger).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ names: ["GOHIGHLEVEL_LOCATION_ID"], status: "inherited" }),
    );
    expect(res).toMatchObject({ ok: true, written: ["GOHIGHLEVEL_LOCATION_ID"] });
    if (!res.ok) return;
    expect(res.kept.map((k) => k.name)).toEqual(["GOHIGHLEVEL_API_KEY", "API2PDF_API_KEY"]);
    expect(res.note).toBe(
      "No platform value written over 2 forwarded name(s) this clone's ledger keeps: " +
        "GOHIGHLEVEL_API_KEY (set), API2PDF_API_KEY (minted)",
    );
  });

  it("sends nothing, and says so, when every authorised name is the clone's own", async () => {
    const res = await pushCloneSecretForwards(
      fakeSupabase({
        forwards: forwards.slice(0, 1),
        ledger: rows([{ name: "GOHIGHLEVEL_API_KEY", status: "set" }]),
      }),
      CLONE,
    );
    expect(provisioning.setCloneSecretValues).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, written: [], unchanged: [] });
    if (res.ok) expect(res.kept).toHaveLength(1);
  });

  it("forwards nothing when the ledger cannot be read, and says why", async () => {
    const res = await pushCloneSecretForwards(fakeSupabase({ forwards, ledger: failed }), CLONE);
    expect(provisioning.setCloneSecretValues).not.toHaveBeenCalled();
    expect(ledgerWrites.recordSecretLedger).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, reason: "unreadable" });
    if (!res.ok) {
      expect(res.error).toContain("canceling statement due to statement timeout");
      expect(res.error).toContain("a failed read is not an empty ledger");
    }
  });

  it("the reconcile does not push a clone for a name the push would only keep", async () => {
    const supabase = fakeSupabase({
      forwards: [{ clone_id: CLONE, name: "API2PDF_API_KEY" }],
      ledger: rows([{ clone_id: CLONE, name: "API2PDF_API_KEY", status: "minted" } as never]),
    });
    const out = await reconcileCloneSecretForwards(supabase);
    expect(out).toMatchObject({ considered: 1, pushed: 0, refused: [] });
    expect(target.resolveCloneSecretTarget).not.toHaveBeenCalled();
  });
});
