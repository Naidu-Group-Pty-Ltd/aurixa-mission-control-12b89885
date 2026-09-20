/**
 * The standing answer to "whose database is each deployment shipping?"
 *
 * The reasoning is in `cascade/backendIdentityReading.pure.ts`. This file is
 * the two impure halves: what each clone's own project ref IS (the database),
 * and what its repository SAYS it is (GitHub).
 *
 * Read on demand rather than on a schedule. There is no column for it and
 * deliberately so — a stored verdict is a claim about a repository as it was
 * at some past moment, and this one exists precisely because a wrong value sat
 * unnoticed for weeks. A reading nobody asked for is a reading nobody checks.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  IDENTITY_PROBE_PATHS,
  readBackendIdentity,
  type BackendIdentityReading,
  type ProbedFile,
} from "./cascade/backendIdentityReading.pure";

type SupabaseLike = SupabaseClient<Database>;

export type FleetIdentityRow = {
  cloneId: string;
  name: string;
  slug: string;
  githubOwner: string;
  githubRepo: string;
  reading: BackendIdentityReading;
};

export type FleetIdentity = {
  rows: FleetIdentityRow[];
  totals: { own: number; foreign: number; no_backend: number; unreadable: number };
  probedAt: string;
};

/**
 * Read one repository's identity files.
 *
 * A 404 is `absent` and anything else is `error`. That distinction is the
 * whole reason this is not a single try/catch: a repository that does not
 * carry the embed is a different fact from one this installation cannot read,
 * and only the second must stop the answer being clean.
 */
async function probeRepo(args: {
  installationId: string | null;
  owner: string;
  repo: string;
  branch?: string;
}): Promise<ProbedFile[]> {
  const octokit = getAppOctokit(args.installationId ?? undefined);
  return Promise.all(
    IDENTITY_PROBE_PATHS.map(async (path): Promise<ProbedFile> => {
      try {
        const res = await octokit.repos.getContent({
          owner: args.owner,
          repo: args.repo,
          path,
          ...(args.branch ? { ref: args.branch } : {}),
        });
        const data = res.data as { type?: string; content?: string };
        if (data.type !== "file" || typeof data.content !== "string") {
          return { path, kind: "absent" };
        }
        return {
          path,
          kind: "read",
          content: Buffer.from(data.content, "base64").toString("utf8"),
        };
      } catch (e) {
        const status = (e as { status?: number })?.status;
        if (status === 404) return { path, kind: "absent" };
        return { path, kind: "error", message: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

export async function getFleetBackendIdentity(supabase: SupabaseLike): Promise<FleetIdentity> {
  const { data: clones, error } = await supabase
    .from("clones")
    .select("id, name, slug, github_owner, github_repo, default_branch, github_app_installation_id")
    .order("name");
  if (error) throw new Error(`Could not read the clone list: ${error.message}`);

  const list = clones ?? [];
  const ids = list.map((c) => c.id);

  // One query for every backend rather than one per clone. A clone with no
  // row here reads `no_backend`, which is a real state and not an error.
  const refByClone = new Map<string, string | null>();
  if (ids.length > 0) {
    const { data: backends } = await supabase
      .from("clone_backends")
      .select("clone_id, supabase_project_ref")
      .in("clone_id", ids);
    for (const b of backends ?? []) refByClone.set(b.clone_id, b.supabase_project_ref);
  }

  const rows: FleetIdentityRow[] = await Promise.all(
    list.map(async (c) => {
      const files = await probeRepo({
        installationId: c.github_app_installation_id,
        owner: c.github_owner,
        repo: c.github_repo,
        branch: c.default_branch ?? undefined,
      });
      return {
        cloneId: c.id,
        name: c.name,
        slug: c.slug,
        githubOwner: c.github_owner,
        githubRepo: c.github_repo,
        reading: readBackendIdentity({ ownRef: refByClone.get(c.id) ?? null, files }),
      };
    }),
  );

  const totals = { own: 0, foreign: 0, no_backend: 0, unreadable: 0 };
  for (const r of rows) totals[r.reading.verdict]++;

  return { rows, totals, probedAt: new Date().toISOString() };
}
