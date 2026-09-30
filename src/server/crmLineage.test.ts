import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRM_MODES,
  CRM_MODE_COPY,
  CRM_PARENT_COLUMN,
  crmModeLabel,
  isCrmMode,
  oppositeCrmMode,
} from "@/lib/crmMode.pure";
import {
  crmChildFields,
  describeCrmPlacement,
  judgeCrmParent,
  type CrmParentRow,
} from "./crmLineage.pure";
import { ensureTemplateRepository, readCrmLineageRoots } from "./crmLineage.server";

const CD_ID = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";
const CRM_ID = "e97f18ab-a3e3-4350-a0c9-d3f8584d6243";
const PRIME_SHA = "a".repeat(40);

function row(overrides: Partial<CrmParentRow> = {}): CrmParentRow {
  return {
    id: CRM_ID,
    name: "NPC CRM Independent",
    github_owner: "Naidu-Group-Pty-Ltd",
    github_repo: "npc-crm-independent-6505dc",
    github_url: "https://github.com/Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc",
    default_branch: "main",
    last_synced_sha: PRIME_SHA,
    crm_mode: "independent",
    sync_scope: "modules",
    parent_clone_id: null,
    ...overrides,
  };
}

describe("crmMode vocabulary", () => {
  it("names exactly two modes and recognises only them", () => {
    expect(CRM_MODES).toEqual(["dependent", "independent"]);
    expect(isCrmMode("dependent")).toBe(true);
    expect(isCrmMode("independent")).toBe(true);
    for (const bad of ["", "Dependent", "ghl", "native", null, undefined, 1, {}]) {
      expect(isCrmMode(bad)).toBe(false);
    }
  });

  it("flips each mode to the other", () => {
    expect(oppositeCrmMode("dependent")).toBe("independent");
    expect(oppositeCrmMode("independent")).toBe("dependent");
  });

  it("maps each mode to a distinct prime_config column", () => {
    expect(CRM_PARENT_COLUMN.dependent).toBe("crm_dependent_parent_clone_id");
    expect(CRM_PARENT_COLUMN.independent).toBe("crm_independent_parent_clone_id");
  });

  it("labels an unrecorded mode as its own state rather than a default", () => {
    expect(crmModeLabel(null)).toBe("CRM not recorded");
    expect(crmModeLabel(undefined)).toBe("CRM not recorded");
    expect(crmModeLabel("something-else")).toBe("CRM not recorded");
    expect(crmModeLabel("dependent")).toBe("CRM dependent (GoHighLevel)");
    expect(crmModeLabel("independent")).toBe("CRM independent (Native CRM)");
  });

  it("the prime_config columns named here are the ones the migration adds", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../supabase/migrations/20260928100000_clone_crm_mode.sql"),
      "utf8",
    );
    for (const column of Object.values(CRM_PARENT_COLUMN)) {
      expect(sql).toContain(`column:prime_config.${column}`);
    }
    for (const mode of CRM_MODES) {
      expect(sql).toContain(`check:clones.crm_mode=${mode}`);
    }
  });
});

describe("judgeCrmParent", () => {
  it("refuses a failed read as unreadable — never as an absent parent", () => {
    const j = judgeCrmParent({
      mode: "independent",
      parentId: CRM_ID,
      parent: null,
      readFailed: true,
      readError: "connection reset",
    });
    expect(j.ok).toBe(false);
    if (!j.ok) {
      expect(j.kind).toBe("unreadable");
      expect(j.reason).toContain("connection reset");
      expect(j.reason).toContain("Nothing was created");
    }
  });

  it("refuses a line with no recorded parent", () => {
    const j = judgeCrmParent({
      mode: "dependent",
      parentId: null,
      parent: null,
      readFailed: false,
    });
    expect(j.ok).toBe(false);
    if (!j.ok) expect(j.kind).toBe("unset");
  });

  it("refuses a recorded parent that no longer exists", () => {
    const j = judgeCrmParent({
      mode: "dependent",
      parentId: CD_ID,
      parent: null,
      readFailed: false,
    });
    expect(j.ok).toBe(false);
    if (!j.ok) {
      expect(j.kind).toBe("missing");
      expect(j.reason).toContain(CD_ID);
    }
  });

  it("refuses a parent that runs the other CRM", () => {
    const j = judgeCrmParent({
      mode: "dependent",
      parentId: CRM_ID,
      parent: row({ crm_mode: "independent" }),
      readFailed: false,
    });
    expect(j.ok).toBe(false);
    if (!j.ok) {
      expect(j.kind).toBe("wrong_mode");
      expect(j.reason).toContain("CRM independent (Native CRM)");
    }
  });

  it("refuses a parent whose mode nobody recorded", () => {
    const j = judgeCrmParent({
      mode: "independent",
      parentId: CRM_ID,
      parent: row({ crm_mode: null }),
      readFailed: false,
    });
    expect(j.ok).toBe(false);
    if (!j.ok) {
      expect(j.kind).toBe("wrong_mode");
      expect(j.reason).toContain("CRM not recorded");
    }
  });

  it("refuses a parent with no repository or branch to copy", () => {
    for (const broken of [
      { github_owner: null },
      { github_repo: "   " },
      { default_branch: null },
    ] satisfies Partial<CrmParentRow>[]) {
      const j = judgeCrmParent({
        mode: "independent",
        parentId: CRM_ID,
        parent: row(broken),
        readFailed: false,
      });
      expect(j.ok).toBe(false);
      if (!j.ok) expect(j.kind).toBe("no_repository");
    }
  });

  it("accepts a parent of the chosen line, trimmed", () => {
    const j = judgeCrmParent({
      mode: "independent",
      parentId: CRM_ID,
      parent: row({ github_owner: " Naidu-Group-Pty-Ltd ", default_branch: " main " }),
      readFailed: false,
    });
    expect(j).toEqual({
      ok: true,
      parent: {
        id: CRM_ID,
        name: "NPC CRM Independent",
        githubOwner: "Naidu-Group-Pty-Ltd",
        githubRepo: "npc-crm-independent-6505dc",
        defaultBranch: "main",
        lastSyncedSha: PRIME_SHA,
        mode: "independent",
      },
    });
  });

  it("names a parent with no name by its repository", () => {
    const j = judgeCrmParent({
      mode: "independent",
      parentId: CRM_ID,
      parent: row({ name: null }),
      readFailed: false,
    });
    expect(j.ok && j.parent.name).toBe("npc-crm-independent-6505dc");
  });
});

describe("crmChildFields", () => {
  const judged = judgeCrmParent({
    mode: "independent",
    parentId: CRM_ID,
    parent: row(),
    readFailed: false,
  });
  if (!judged.ok) throw new Error("fixture parent must judge ok");
  const parent = judged.parent;

  it("records the parent, a mirror scope and the mode", () => {
    const f = crmChildFields(parent, "main");
    expect(f.parent_clone_id).toBe(CRM_ID);
    expect(f.sync_scope).toBe("mirror");
    expect(f.crm_mode).toBe("independent");
  });

  it("carries the parent's PRIME revision, never a commit of the parent's repository", () => {
    expect(crmChildFields(parent).last_synced_sha).toBe(PRIME_SHA);
    expect(crmChildFields({ ...parent, lastSyncedSha: null }).last_synced_sha).toBeNull();
  });

  it("uses the created repository's branch where one was read back", () => {
    expect(crmChildFields(parent, "trunk").default_branch).toBe("trunk");
    expect(crmChildFields(parent, "  ").default_branch).toBe("main");
    expect(crmChildFields(parent, null).default_branch).toBe("main");
  });

  it("describes the placement in operator words", () => {
    const text = describeCrmPlacement(parent);
    expect(text).toContain(CRM_MODE_COPY.independent.title);
    expect(text).toContain("Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc");
  });
});

describe("ensureTemplateRepository", () => {
  function fake(opts: { isTemplate?: boolean; getThrows?: Error; updateThrows?: Error }) {
    const calls: string[] = [];
    return {
      calls,
      client: {
        repos: {
          async get(args: { owner: string; repo: string }) {
            calls.push(`get ${args.owner}/${args.repo}`);
            if (opts.getThrows) throw opts.getThrows;
            return { data: { is_template: opts.isTemplate } };
          },
          async update(args: { owner: string; repo: string; is_template: boolean }) {
            calls.push(`update ${args.owner}/${args.repo} ${args.is_template}`);
            if (opts.updateThrows) throw opts.updateThrows;
            return {};
          },
        },
      },
    };
  }
  const ref = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-client-dashboard" };

  it("costs one read when the flag is already set", async () => {
    const f = fake({ isTemplate: true });
    expect(await ensureTemplateRepository(f.client, ref)).toEqual({ ok: true, changed: false });
    expect(f.calls).toEqual(["get Naidu-Group-Pty-Ltd/npc-client-dashboard"]);
  });

  it("sets the flag when it is absent and says it changed something", async () => {
    const f = fake({ isTemplate: false });
    expect(await ensureTemplateRepository(f.client, ref)).toEqual({ ok: true, changed: true });
    expect(f.calls).toEqual([
      "get Naidu-Group-Pty-Ltd/npc-client-dashboard",
      "update Naidu-Group-Pty-Ltd/npc-client-dashboard true",
    ]);
  });

  it("refuses by name when the repository cannot be read", async () => {
    const f = fake({ getThrows: new Error("Not Found") });
    const r = await ensureTemplateRepository(f.client, ref);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Not Found");
    expect(f.calls).toHaveLength(1);
  });

  it("refuses with the manual remedy when the App cannot set the flag", async () => {
    const f = fake({ isTemplate: false, updateThrows: new Error("Resource not accessible") });
    const r = await ensureTemplateRepository(f.client, ref);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("Resource not accessible");
      expect(r.reason).toContain("Template repository");
    }
  });
});

describe("readCrmLineageRoots", () => {
  type Result = { data: unknown; error: { message: string } | null };
  function client(cfg: Result, clones: Result) {
    const seen: { table: string; ids?: string[] }[] = [];
    const supabase = {
      from(table: string) {
        const entry: { table: string; ids?: string[] } = { table };
        seen.push(entry);
        const chain = {
          select() {
            return chain;
          },
          limit() {
            return chain;
          },
          async maybeSingle() {
            return cfg;
          },
          in(_col: string, ids: string[]) {
            entry.ids = ids;
            return Promise.resolve(clones);
          },
        };
        return chain;
      },
    };
    return { supabase: supabase as never, seen };
  }

  it("judges both lines from one config read and one clones read", async () => {
    const { supabase, seen } = client(
      {
        data: { crm_dependent_parent_clone_id: CD_ID, crm_independent_parent_clone_id: CRM_ID },
        error: null,
      },
      {
        data: [
          row(),
          row({
            id: CD_ID,
            name: "NPC Client Dashboard",
            github_repo: "npc-client-dashboard",
            crm_mode: "dependent",
          }),
        ],
        error: null,
      },
    );
    const roots = await readCrmLineageRoots(supabase);
    expect(roots.dependent.ok && roots.dependent.parent.githubRepo).toBe("npc-client-dashboard");
    expect(roots.independent.ok && roots.independent.parent.githubRepo).toBe(
      "npc-crm-independent-6505dc",
    );
    expect(seen.map((s) => s.table)).toEqual(["prime_config", "clones"]);
    expect(seen[1].ids?.sort()).toEqual([CD_ID, CRM_ID].sort());
  });

  it("reports a failed config read as unreadable on both lines", async () => {
    const { supabase } = client(
      { data: null, error: { message: "timeout" } },
      {
        data: [],
        error: null,
      },
    );
    const roots = await readCrmLineageRoots(supabase);
    for (const mode of CRM_MODES) {
      const j = roots[mode];
      expect(j.ok).toBe(false);
      if (!j.ok) expect(j.kind).toBe("unreadable");
    }
  });

  it("reports a failed clones read as unreadable, not missing", async () => {
    const { supabase } = client(
      {
        data: { crm_dependent_parent_clone_id: CD_ID, crm_independent_parent_clone_id: null },
        error: null,
      },
      { data: null, error: { message: "permission denied" } },
    );
    const roots = await readCrmLineageRoots(supabase);
    expect(!roots.dependent.ok && roots.dependent.kind).toBe("unreadable");
    // The line with nothing recorded is unset whatever the clones read did.
    expect(!roots.independent.ok && roots.independent.kind).toBe("unset");
  });

  it("does not read clones at all when no line names a parent", async () => {
    const { supabase, seen } = client(
      {
        data: { crm_dependent_parent_clone_id: null, crm_independent_parent_clone_id: null },
        error: null,
      },
      { data: [], error: null },
    );
    const roots = await readCrmLineageRoots(supabase);
    expect(seen.map((s) => s.table)).toEqual(["prime_config"]);
    expect(!roots.dependent.ok && roots.dependent.kind).toBe("unset");
    expect(!roots.independent.ok && roots.independent.kind).toBe("unset");
  });
});

describe("provisionCloneCore — the CRM parent is the source", () => {
  const src = readFileSync(resolve(__dirname, "clone-provisioning.server.ts"), "utf8");

  it("judges the parent before any repository is created", () => {
    const judge = src.indexOf("readCrmParent(supabase, data.crmMode)");
    const fork = src.indexOf("octokit.repos.createFork");
    const template = src.indexOf("octokit.repos.createUsingTemplate");
    expect(judge).toBeGreaterThan(0);
    expect(judge).toBeLessThan(fork);
    expect(judge).toBeLessThan(template);
  });

  it("creates from the chosen source, never the prime by name", () => {
    expect(src).toContain("template_owner: source.owner");
    expect(src).toContain("template_repo: source.repo");
    expect(src).not.toMatch(/template_owner:\s*prime\.github_owner/);
    expect(src).not.toMatch(
      /owner:\s*prime\.github_owner,\s*\n\s*repo:\s*prime\.github_repo,\s*\n\s*organization/,
    );
  });

  it("writes the lineage in the clone insert itself", () => {
    const at = src.search(/\.from\("clones"\)\s*\n\s*\.insert\(\{/);
    expect(at).toBeGreaterThan(-1);
    const insert = src.slice(at);
    const end = insert.indexOf(".select()");
    const body = insert.slice(0, end);
    expect(body).toContain("parent_clone_id: lineage.parent_clone_id");
    expect(body).toContain("sync_scope: lineage.sync_scope");
    expect(body).toContain("crm_mode: lineage.crm_mode");
  });

  it("does not run the prime-sourced module cascade for a CRM child", () => {
    expect(src).toMatch(/if \(data\.method !== "clone" && githubUrl && !lineage\)/);
  });
});
