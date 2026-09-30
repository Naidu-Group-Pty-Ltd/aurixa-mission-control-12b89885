/**
 * Where one clone reads from, for the proposal repair and the dry run.
 *
 * These two callers used to read prime unconditionally. With lineage on that
 * was a live hazard for NPC Test and Preflight: a repair of either's
 * conflicted proposal would have force-pushed the prime's tree over a branch
 * built from the Client Dashboard's. `resolveCloneReadSource` is the network
 * half of `resolveCascadeSource` for one clone, and these tests drive it and
 * `prepareProposalRebuild` through fakes of the two clients they touch.
 */
import { describe, expect, it } from "vitest";
import { prepareProposalRebuild, resolveCloneReadSource } from "@/server/cascade-engine.server";

const PRIME = {
  github_owner: "Naidu-Group-Pty-Ltd",
  github_repo: "npc-property-dashbord",
  default_branch: "main",
  cascade_follows_lineage: true,
};

const PRIME_SHA = "a".repeat(40);
const PARENT_HEAD = "b".repeat(40);

const CD = {
  id: "cd",
  name: "NPC Client Dashboard",
  github_owner: "Naidu-Group-Pty-Ltd",
  github_repo: "npc-client-dashboard",
  default_branch: "main",
  last_synced_sha: PRIME_SHA,
};

type Row = Record<string, unknown>;

/** A Supabase double answering `.from(t).select(..).eq("id", v).maybeSingle()` and `.limit(1).maybeSingle()`. */
function fakeSupabase(tables: Record<string, Row[]>, failing: Set<string> = new Set()) {
  const reads: string[] = [];
  const from = (table: string) => {
    let filterId: string | null = null;
    const query = {
      select: () => query,
      eq: (_col: string, value: string) => {
        filterId = value;
        return query;
      },
      limit: () => query,
      maybeSingle: async () => {
        reads.push(table);
        if (failing.has(table)) return { data: null, error: { message: `${table} unreadable` } };
        const rows = tables[table] ?? [];
        const row = filterId === null ? rows[0] : rows.find((r) => r.id === filterId);
        return { data: row ?? null, error: null };
      },
    };
    return query;
  };
  return { client: { from } as never, reads };
}

/** An Octokit double whose `getBranch` answers from a map, or throws. */
function fakeOctokit(heads: Record<string, string>) {
  const asked: string[] = [];
  return {
    client: {
      repos: {
        getBranch: async ({
          owner,
          repo,
          branch,
        }: {
          owner: string;
          repo: string;
          branch: string;
        }) => {
          asked.push(`${owner}/${repo}@${branch}`);
          const sha = heads[`${owner}/${repo}`];
          if (!sha) throw new Error("Not Found");
          return { data: { commit: { sha } } };
        },
      },
    } as never,
    asked,
  };
}

describe("resolveCloneReadSource", () => {
  it("reads prime at the promised commit when the clone records no parent", async () => {
    const sb = fakeSupabase({});
    const gh = fakeOctokit({});
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: null,
      primeSha: PRIME_SHA,
    });
    expect(source).toEqual({
      kind: "read",
      ref: { owner: PRIME.github_owner, repo: PRIME.github_repo, branch: "main" },
      sha: PRIME_SHA,
    });
    // Nothing to ask: no parent row, no parent branch.
    expect(sb.reads).toEqual([]);
    expect(gh.asked).toEqual([]);
  });

  it("reads prime for every clone while lineage is off, whatever the clone records", async () => {
    const sb = fakeSupabase({ clones: [CD] });
    const gh = fakeOctokit({ "Naidu-Group-Pty-Ltd/npc-client-dashboard": PARENT_HEAD });
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: { ...PRIME, cascade_follows_lineage: false },
      parentCloneId: "cd",
      primeSha: PRIME_SHA,
    });
    expect(source.kind).toBe("read");
    expect(source.kind === "read" && source.ref.repo).toBe(PRIME.github_repo);
    expect(source.kind === "read" && source.provenance).toBeUndefined();
    expect(sb.reads).toEqual([]);
  });

  it("reads the parent's HEAD, labelled as the parent, delivering prime's commit", async () => {
    const sb = fakeSupabase({ clones: [CD] });
    const gh = fakeOctokit({ "Naidu-Group-Pty-Ltd/npc-client-dashboard": PARENT_HEAD });
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: "cd",
      primeSha: PRIME_SHA,
    });
    expect(source).toEqual({
      kind: "read",
      ref: { owner: CD.github_owner, repo: CD.github_repo, branch: "main" },
      // The parent's own head: that is the tree the child copies…
      sha: PARENT_HEAD,
      // …while the ledger records prime's commit, and the labels the parent.
      provenance: { label: "NPC Client Dashboard", deliveredSha: PRIME_SHA },
    });
  });

  it("holds while the parent carries an older prime commit", async () => {
    const sb = fakeSupabase({ clones: [{ ...CD, last_synced_sha: "c".repeat(40) }] });
    const gh = fakeOctokit({ "Naidu-Group-Pty-Ltd/npc-client-dashboard": PARENT_HEAD });
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: "cd",
      primeSha: PRIME_SHA,
    });
    expect(source.kind).toBe("hold");
    // A hold asks GitHub nothing.
    expect(gh.asked).toEqual([]);
  });

  it("holds, never falls back to prime, when the parent row cannot be read", async () => {
    const sb = fakeSupabase({ clones: [CD] }, new Set(["clones"]));
    const gh = fakeOctokit({});
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: "cd",
      primeSha: PRIME_SHA,
    });
    expect(source.kind).toBe("hold");
    expect(source.kind === "hold" && source.why).toMatch(/Could not read this clone's parent/);
  });

  it("holds when the recorded parent does not exist", async () => {
    const sb = fakeSupabase({ clones: [] });
    const gh = fakeOctokit({});
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: "gone",
      primeSha: PRIME_SHA,
    });
    expect(source.kind).toBe("hold");
  });

  it("holds when the parent's branch cannot be read — a source that cannot be read is not empty", async () => {
    const sb = fakeSupabase({ clones: [CD] });
    const gh = fakeOctokit({});
    const source = await resolveCloneReadSource({
      supabase: sb.client,
      octokit: gh.client,
      prime: PRIME,
      parentCloneId: "cd",
      primeSha: PRIME_SHA,
    });
    expect(source).toEqual({
      kind: "hold",
      why: "Could not read parent Naidu-Group-Pty-Ltd/npc-client-dashboard@main: Not Found",
    });
    expect(gh.asked).toEqual(["Naidu-Group-Pty-Ltd/npc-client-dashboard@main"]);
  });
});

describe("prepareProposalRebuild", () => {
  const NPC_TEST = {
    id: "nt",
    name: "NPC Test",
    github_owner: "Naidu-Group-Pty-Ltd",
    github_repo: "npc-test-76b3b3",
    default_branch: "main",
    sync_scope: "mirror",
    parent_clone_id: "cd",
    crm_mode: "dependent",
  };

  it("rebuilds a routed child from its parent, carrying the clone's recorded CRM", async () => {
    const sb = fakeSupabase({ prime_config: [PRIME], clones: [NPC_TEST, CD] });
    const gh = fakeOctokit({ "Naidu-Group-Pty-Ltd/npc-client-dashboard": PARENT_HEAD });
    const prepared = await prepareProposalRebuild({
      supabase: sb.client,
      octokit: gh.client,
      cloneId: "nt",
      sourceSha: PRIME_SHA,
    });
    expect(prepared.kind).toBe("ready");
    if (prepared.kind !== "ready") return;
    expect(prepared.rebuild.source.ref.repo).toBe("npc-client-dashboard");
    expect(prepared.rebuild.source.sha).toBe(PARENT_HEAD);
    expect(prepared.rebuild.source.provenance?.deliveredSha).toBe(PRIME_SHA);
    expect(prepared.rebuild.clone).toEqual({
      id: "nt",
      name: "NPC Test",
      github_owner: "Naidu-Group-Pty-Ltd",
      github_repo: "npc-test-76b3b3",
      default_branch: "main",
      sync_scope: "mirror",
      crm_mode: "dependent",
    });
  });

  it("answers a hold, rather than throwing, when the parent has not taken the promised commit", async () => {
    const sb = fakeSupabase({
      prime_config: [PRIME],
      clones: [NPC_TEST, { ...CD, last_synced_sha: "c".repeat(40) }],
    });
    const gh = fakeOctokit({});
    const prepared = await prepareProposalRebuild({
      supabase: sb.client,
      octokit: gh.client,
      cloneId: "nt",
      sourceSha: PRIME_SHA,
    });
    expect(prepared.kind).toBe("hold");
  });

  it("reads a clone whose deployment has no crm_mode column yet as unrecorded", async () => {
    const { crm_mode: _omit, ...unmigrated } = NPC_TEST;
    void _omit;
    const sb = fakeSupabase({ prime_config: [PRIME], clones: [unmigrated, CD] });
    const gh = fakeOctokit({ "Naidu-Group-Pty-Ltd/npc-client-dashboard": PARENT_HEAD });
    const prepared = await prepareProposalRebuild({
      supabase: sb.client,
      octokit: gh.client,
      cloneId: "nt",
      sourceSha: PRIME_SHA,
    });
    expect(prepared.kind === "ready" && prepared.rebuild.clone.crm_mode).toBeNull();
  });

  it("refuses loudly when the clone cannot be read at all", async () => {
    const sb = fakeSupabase({ prime_config: [PRIME] }, new Set(["clones"]));
    const gh = fakeOctokit({});
    await expect(
      prepareProposalRebuild({
        supabase: sb.client,
        octokit: gh.client,
        cloneId: "nt",
        sourceSha: PRIME_SHA,
      }),
    ).rejects.toThrow(/Could not read clone nt/);
  });
});
