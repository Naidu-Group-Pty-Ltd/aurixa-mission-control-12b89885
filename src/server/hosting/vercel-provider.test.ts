import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneEnvVar } from "./envPolicy.pure";
import { VercelError } from "./vercel-client";
import { vercelProvider } from "./vercel-provider";

/** The provider's only route to Vercel. */
const api = vi.hoisted(() => ({
  getProjectByName: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock("./vercel-client", async (importActual) => {
  const actual = await importActual<typeof import("./vercel-client")>();
  return { ...actual, vercelApi: api, defaultTeamId: () => "team_x" };
});

const PAIR: CloneEnvVar[] = [
  {
    key: "VITE_SUPABASE_URL",
    value: "https://plisdzywzleljorrphxv.supabase.co",
    publicToBundle: true,
    targets: ["production", "preview", "development"],
  },
  {
    key: "VITE_SUPABASE_PUBLISHABLE_KEY",
    value: "eyJhbGciOiJIUzI1NiJ9.eyJyZWYiOiJwbGlzZHp5d3psZWxqb3JycGh4diJ9.sig",
    publicToBundle: true,
    targets: ["production", "preview", "development"],
  },
];

const input = (env?: CloneEnvVar[]) => ({
  cloneId: "c1",
  name: "npc-new",
  repo: { owner: "Naidu-Group-Pty-Ltd", name: "npc-new", defaultBranch: "main" },
  ...(env ? { env } : {}),
});

beforeEach(() => {
  api.getProjectByName.mockReset();
  api.createProject.mockReset();
});

describe("creating a clone's project", () => {
  it("publishes the pair in the same call as the git link that starts the first build", async () => {
    api.getProjectByName.mockResolvedValue(null);
    api.createProject.mockResolvedValue({ id: "prj_1", name: "npc-new" });

    const res = await vercelProvider.createOrAdoptProject(input(PAIR));

    expect(res.adopted).toBe(false);
    expect(api.createProject).toHaveBeenCalledTimes(1);
    const [body, team] = api.createProject.mock.calls[0];
    expect(team).toBe("team_x");
    expect(body.gitRepository).toEqual({ type: "github", repo: "Naidu-Group-Pty-Ltd/npc-new" });
    // Shaped as `syncEnv` writes them, so `syncing_env` upserts over these
    // rows rather than beside them.
    expect(body.environmentVariables).toEqual(
      PAIR.map((v) => ({ key: v.key, value: v.value, type: "encrypted", target: v.targets })),
    );
  });

  it("sends no environment at all when it was given none", async () => {
    api.getProjectByName.mockResolvedValue(null);
    api.createProject.mockResolvedValue({ id: "prj_1", name: "npc-new" });
    await vercelProvider.createOrAdoptProject(input([]));
    await vercelProvider.createOrAdoptProject(input());
    for (const [body] of api.createProject.mock.calls) {
      expect(body).not.toHaveProperty("environmentVariables");
    }
  });

  it("never writes to a project it adopts — `syncing_env` owns what that one holds", async () => {
    api.getProjectByName.mockResolvedValue({ id: "prj_live", name: "npc-new" });
    const res = await vercelProvider.createOrAdoptProject(input(PAIR));
    expect(res).toMatchObject({ adopted: true, projectId: "prj_live" });
    expect(api.createProject).not.toHaveBeenCalled();
  });

  it("adopts the winner of a creation race rather than failing", async () => {
    api.getProjectByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "prj_raced", name: "npc-new" });
    api.createProject.mockRejectedValue(new VercelError("conflict", 409, "conflict"));
    const res = await vercelProvider.createOrAdoptProject(input(PAIR));
    expect(res).toMatchObject({ adopted: true, projectId: "prj_raced" });
  });
});
