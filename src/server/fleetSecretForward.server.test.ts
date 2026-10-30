/**
 * The fleet sweep takes a stray value off a name the clone must not hold, and
 * stamps the row as what it is.
 *
 * A `federated` name is removed through the same channel as a `withheld` one
 * (`NOT_ON_THE_PROJECT`), and was stamped `withheld` on the way out. That is
 * the status `FEDERATED` exists to stay apart from: `decideWorkspaceProvision`
 * reads `withheld` as a person taking the credential off, `federationComplete`
 * needs the row to read `federated`, and the rating moves a `withheld` name's
 * calls from `inherited` to `brokered`. One stray value, put on the project by
 * anyone, ended the clone's attribution in silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const provisioning = vi.hoisted(() => ({
  listProjectSecretNames: vi.fn(),
  deleteCloneSecretValues: vi.fn(async () => ({ ok: true as const })),
  setCloneSecretValues: vi.fn(),
}));
vi.mock("./backend-provisioning.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend-provisioning.server")>()),
  ...provisioning,
}));
const target = vi.hoisted(() => ({ resolveCloneSecretTarget: vi.fn() }));
vi.mock("./cloneAllowedOrigins.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloneAllowedOrigins.server")>()),
  ...target,
}));
vi.mock("./secretLedger.server", () => ({ recordSecretLedger: vi.fn(async () => null) }));

const { pushFleetSecretForwards, FEDERATED, WITHHELD } =
  await import("./fleetSecretForward.server");

const CLONE = "11111111-1111-4111-8111-111111111111";
const REF = "orrimereorrimereorri";

let upserts: Array<Record<string, unknown>>;

function fakeSupabase(ledger: Array<{ name: string; status: string }>) {
  const from = (table: string) => {
    const result = () => {
      if (table === "prime_secret_forwards") {
        return { data: [{ name: "ANTHROPIC_API_KEY", inherit: true }], error: null };
      }
      if (table === "clone_backend_secrets") return { data: ledger, error: null };
      if (table === "clones") return { data: { crm_mode: null }, error: null };
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) q[m] = () => q;
    q.maybeSingle = async () => result();
    q.upsert = async (rows: Array<Record<string, unknown>>) => {
      upserts.push(...rows);
      return { error: null };
    };
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return q;
  };
  return { from } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  upserts = [];
  // Mission Control holds the organisation key, so the sweep would forward it if it could.
  vi.stubEnv("ANTHROPIC_API_KEY", "aurixa-organisation-key");
  target.resolveCloneSecretTarget.mockResolvedValue({
    cloneId: CLONE,
    cloneName: "Orrimere",
    projectRef: REF,
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a stray value on a name the clone must not hold", () => {
  it("is removed, and a federated row stays federated while a withheld one stays withheld", async () => {
    provisioning.listProjectSecretNames.mockResolvedValue(["AIRTABLE_TOKEN", "ANTHROPIC_API_KEY"]);
    const res = await pushFleetSecretForwards(
      fakeSupabase([
        { name: "ANTHROPIC_API_KEY", status: "federated" },
        { name: "AIRTABLE_TOKEN", status: "withheld" },
      ]),
      CLONE,
    );

    expect(provisioning.deleteCloneSecretValues).toHaveBeenCalledWith(REF, [
      "AIRTABLE_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    const byName = new Map(upserts.map((r) => [r.name, r]));
    expect(byName.get("ANTHROPIC_API_KEY")).toMatchObject({ status: FEDERATED, last_error: null });
    expect(typeof byName.get("ANTHROPIC_API_KEY")?.last_set_at).toBe("string");
    expect(byName.get("AIRTABLE_TOKEN")).toMatchObject({ status: WITHHELD });
    // And the organisation key is not forwarded back over the federation.
    expect(provisioning.setCloneSecretValues).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, removed: ["AIRTABLE_TOKEN", "ANTHROPIC_API_KEY"] });
  });

  it("writes no row when the project holds nothing it must not", async () => {
    provisioning.listProjectSecretNames.mockResolvedValue([]);
    await pushFleetSecretForwards(
      fakeSupabase([{ name: "ANTHROPIC_API_KEY", status: "federated" }]),
      CLONE,
    );
    expect(provisioning.deleteCloneSecretValues).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
  });
});
