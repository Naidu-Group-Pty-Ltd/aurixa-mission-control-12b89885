import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BUILD_IDENTITY_TARGETS,
  DEPENDABOT_CONFIG_PATH,
  IDENTITY_GUARD_SPEC_PATH,
  RESOLVER_MODULE_CANDIDATES,
  SHIPPED_BACKEND_PAIR_PATHS,
} from "@/server/clone-repo-retarget.server";
import { stripComments } from "@/server/sourceComments.pure";
import { judgeWait } from "./deploymentState.pure";
import {
  decideProjectCreation,
  readRetargetRecord,
  type ProjectCreationFacts,
} from "./projectCreationGate.pure";

const CLEAN_RETARGET = {
  ok: true,
  actions: [
    { target: "vars.SUPABASE_PROJECT_REF", status: "rewritten" },
    { target: "public/lead-magnet-embed.html", status: "rewritten" },
    { target: ".env.example", status: "rewritten" },
    { target: "src/integrations/supabase/supabaseTarget.pure.ts", status: "rewritten" },
  ],
};

/** A brand-new clone whose backend has finished: the case the gate exists to let through. */
const fresh = (backend: Partial<NonNullable<ProjectCreationFacts["backend"]>> = {}) =>
  ({
    hasProject: false,
    envSyncedAt: null,
    lastDeployedAt: null,
    backend: {
      status: "ready",
      hasUrl: true,
      hasAnonKey: true,
      retarget: readRetargetRecord(CLEAN_RETARGET, BUILD_IDENTITY_TARGETS),
      ...backend,
    },
  }) satisfies ProjectCreationFacts;

describe("a clone already past its first build", () => {
  it("is never held, whatever its backend says — the live clones are this row", () => {
    // Measured 27 Oct 2026: all four live deployments record a project, a
    // synced environment and a finished build. Each alone is enough.
    for (const past of [
      { hasProject: true },
      { envSyncedAt: "2026-10-20T04:43:05Z" },
      { lastDeployedAt: "2026-10-22T15:52:01Z" },
    ]) {
      for (const backend of [
        null,
        { status: "failed", hasUrl: false, hasAnonKey: false, retarget: { recorded: false } },
        { status: "migrating", hasUrl: true, hasAnonKey: true, retarget: { recorded: false } },
      ] as const) {
        const decision = decideProjectCreation({ ...fresh(), backend, ...past });
        expect(decision).toEqual({ kind: "proceed", why: "past_first_build" });
      }
    }
  });
});

describe("a new clone waits for its backend", () => {
  it("while the backend is still being built, without the clock failing it", () => {
    for (const status of ["pending", "provisioning", "migrating", "seeding_admin"]) {
      const decision = decideProjectCreation(fresh({ status, hasUrl: false, hasAnonKey: false }));
      expect(decision.kind).toBe("wait");
      if (decision.kind !== "wait") return;
      expect(decision.dependency).toEqual({
        name: "the clone's Supabase backend",
        state: "progressing",
      });
      expect(decision.detail).toContain(`backend: ${status}`);
      // Ten hours into a healthy provisioning run is still a wait.
      const verdict = judgeWait({
        statusSince: "2026-10-27T00:00:00Z",
        now: Date.parse("2026-10-27T10:00:00Z"),
        stuckHours: 6,
        dependency: decision.dependency,
      });
      expect(verdict.kind).toBe("waiting");
    }
  });

  it("and stops at once when the backend has given up", () => {
    const decision = decideProjectCreation(fresh({ status: "failed" }));
    expect(decision.kind).toBe("wait");
    if (decision.kind !== "wait") return;
    expect(decision.dependency?.state).toBe("terminal");
    const verdict = judgeWait({
      statusSince: new Date().toISOString(),
      now: Date.now(),
      stuckHours: 6,
      dependency: decision.dependency,
    });
    expect(verdict.kind).toBe("stuck");
  });

  it("names no dependency when no backend was ever requested, so the clock judges it", () => {
    const decision = decideProjectCreation({ ...fresh(), backend: null });
    expect(decision).toMatchObject({ kind: "wait", dependency: null });
    if (decision.kind !== "wait") return;
    expect(decision.detail).toMatch(/No backend has been requested/);
    // The drain's old message sent an operator to a flag nothing reads.
    expect(decision.detail).not.toMatch(/dedicated-backend flag/);
  });
});

describe("a ready backend that cannot give a build its own identity", () => {
  it("is refused when it has published no URL or no key", () => {
    for (const missing of [{ hasUrl: false }, { hasAnonKey: false }]) {
      const decision = decideProjectCreation(fresh(missing));
      expect(decision.kind).toBe("refuse");
      if (decision.kind !== "refuse") return;
      expect(decision.reason).toMatch(/Re-run backend provisioning/);
    }
  });

  it("is refused when no retarget is recorded, because the repository may name another backend", () => {
    const decision = decideProjectCreation(fresh({ retarget: { recorded: false } }));
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reason).toMatch(/no repository retarget is recorded/);
  });

  it("is refused, naming the files, when the retarget left a shipped file unresolved", () => {
    const stored = {
      ok: false,
      actions: [
        { target: "public/lead-magnet-embed.html", status: "failed", detail: "409" },
        { target: ".env.example", status: "rewritten" },
      ],
    };
    const decision = decideProjectCreation(
      fresh({ retarget: readRetargetRecord(stored, BUILD_IDENTITY_TARGETS) }),
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reason).toContain("public/lead-magnet-embed.html");
    expect(decision.reason).not.toContain(".env.example");
  });
});

describe("a new clone whose backend has published everything", () => {
  it("proceeds", () => {
    expect(decideProjectCreation(fresh())).toEqual({ kind: "proceed", why: "backend_published" });
  });

  it("proceeds when the only failures are ones no build reads", () => {
    // `ok` is false for any failed step. A CI guard that is not wired, or a
    // Dependabot config that could not be deleted, changes nothing a bundle
    // inlines, and holding a customer's first deployment for it would trade a
    // CI chore for an outage.
    const stored = {
      ok: false,
      actions: [
        ...CLEAN_RETARGET.actions,
        { target: IDENTITY_GUARD_SPEC_PATH, status: "failed" },
        { target: DEPENDABOT_CONFIG_PATH, status: "failed" },
      ],
    };
    expect(
      decideProjectCreation(
        fresh({ retarget: readRetargetRecord(stored, BUILD_IDENTITY_TARGETS) }),
      ),
    ).toEqual({ kind: "proceed", why: "backend_published" });
  });
});

describe("reading a stored retarget", () => {
  it("reads nothing readable as nothing recorded, never as nothing failed", () => {
    for (const stored of [null, undefined, "x", 3, {}, { actions: "no" }, { ok: true }]) {
      expect(readRetargetRecord(stored, BUILD_IDENTITY_TARGETS)).toEqual({ recorded: false });
    }
  });

  it("reports each unresolved build-identity file once, and nothing else", () => {
    const stored = {
      actions: [
        { target: ".env.example", status: "failed" },
        { target: ".env.example", status: "failed" },
        { target: "supabase/config.toml", status: "failed" },
        { target: "public/lead-magnet-embed.html", status: "unchanged" },
        null,
        { status: "failed" },
      ],
    };
    expect(readRetargetRecord(stored, BUILD_IDENTITY_TARGETS)).toEqual({
      recorded: true,
      unresolved: [".env.example"],
    });
  });

  it("holds the retarget's own refusal to half-write the pair", () => {
    // What step 6 records when it was given no anon key: every pair file and
    // the joined resolver target, `failed`. A build from that repository still
    // ships whoever's pair it inherited.
    const noKey = {
      ok: false,
      actions: [...SHIPPED_BACKEND_PAIR_PATHS, RESOLVER_MODULE_CANDIDATES.join(" | ")].map(
        (target) => ({ target, status: "failed" }),
      ),
    };
    const reading = readRetargetRecord(noKey, BUILD_IDENTITY_TARGETS);
    expect(reading.recorded && reading.unresolved.length).toBe(
      SHIPPED_BACKEND_PAIR_PATHS.length + 1,
    );
  });

  it("takes its targets from the module that names them", () => {
    for (const path of [...SHIPPED_BACKEND_PAIR_PATHS, ...RESOLVER_MODULE_CANDIDATES]) {
      expect(BUILD_IDENTITY_TARGETS).toContain(path);
    }
    expect(BUILD_IDENTITY_TARGETS).toContain(RESOLVER_MODULE_CANDIDATES.join(" | "));
  });
});

describe("the drain consults the gate, and the project is created holding the pair", () => {
  const drain = stripComments(readFileSync("src/routes/hooks.deployment-drain.tsx", "utf8"));
  const stepOf = (status: string, next: string) =>
    drain.slice(drain.indexOf(`case "${status}": {`), drain.indexOf(`case "${next}": {`));

  it("decides before `pending` advances, and a refusal fails rather than retries", () => {
    const pending = stepOf("pending", "creating_project");
    const gate = pending.indexOf("decideProjectCreation(");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(pending.indexOf('kind: "advance"'));
    expect(pending).toContain("readRetargetRecord(backend.repo_retarget, BUILD_IDENTITY_TARGETS)");
    // Each verdict is acted on by a guard of its own, word for word: a
    // condition that merely mentions the verdict can be made unreachable and
    // still read as present (found by planting `&& false` in the refusal).
    expect(pending).toMatch(
      /if \(gate\.kind === "wait"\) \{\s*return \{\s*kind: "wait",\s*seconds: \d+,\s*detail: gate\.detail,\s*dependency: gate\.dependency,\s*\};\s*\}/,
    );
    expect(pending).toMatch(
      /if \(gate\.kind === "refuse"\) \{\s*return \{ kind: "error", error: gate\.reason, retryable: false \};\s*\}/,
    );
    // The facts that keep a live clone from being parked are read off the row.
    expect(pending).toContain("hasProject: Boolean(row.project_id)");
    expect(pending).toContain("envSyncedAt: row.env_synced_at");
    expect(pending).toContain("lastDeployedAt: row.last_deployed_at");
  });

  it("claims and loads the columns the gate reads", () => {
    const claim = drain.slice(drain.indexOf("async function claim("));
    expect(claim.slice(0, claim.indexOf("return (claimed"))).toMatch(
      /env_synced_at, last_deployed_at/,
    );
    expect(drain).toMatch(
      /\.select\("supabase_url, supabase_project_ref, anon_key, status, repo_retarget"\)/,
    );
  });

  it("creates the project with the pair, and a new project leaves no stale digest behind", () => {
    const creating = stepOf("creating_project", "linking_repo");
    expect(creating).toMatch(/createOrAdoptProject\(\{[\s\S]*env: envAtCreation/);
    expect(creating.indexOf("buildCloneEnv(")).toBeLessThan(
      creating.indexOf("createOrAdoptProject("),
    );
    expect(creating).toContain("...(res.adopted ? {} : { env_digest: null })");
  });
});
