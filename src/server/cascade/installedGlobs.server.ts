/**
 * What a module-scoped clone has installed, as the globs a delivery may touch.
 *
 * Read in ONE place because two lanes now ask it. The vertical cascade has
 * always read it inline; the lateral lane needs the same answer for the same
 * clone, and a second reader is how the two would come to disagree about
 * which files a deployment is offered — a library pin honoured by one lane and
 * not the other is a file one lane writes and the other calls out of scope.
 *
 * ## The two callers read a failure differently, on purpose
 *
 * The vertical engine reads leniently and always has: a failed read leaves the
 * globs it did get, and an empty result reports "No installed modules —
 * nothing to cascade", which delivers nothing. That behaviour is unchanged
 * here — `globs` is exactly what the inline code produced.
 *
 * The lateral lane cannot read it that way. An incomplete glob list is not an
 * empty scope there: every path it omits is REPORTED as outside the
 * destination's modules, which is a statement about the deployment made from
 * a read that failed. So `failed` says so, and that lane refuses the direction
 * rather than describing a scope it never saw.
 *
 * Library pins: when a clone pins a specific library version for a module
 * slug, that module's live globs are swapped for the pinned entry's
 * `file_paths` — which is how a fork stays on v3 of "checkout" while the prime
 * is on v5.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type InstalledGlobs = {
  globs: string[];
  /** `pins: checkout@v3, …` where a pin was honoured, else null. */
  pinSummary: string | null;
  /** Set when a read this answer depends on failed; `globs` is then partial. */
  failed: string | null;
};

export async function readInstalledGlobs(
  supabase: SupabaseClient<Database>,
  cloneId: string,
): Promise<InstalledGlobs> {
  const failures: string[] = [];

  const { data: cmods, error: modulesErr } = await supabase
    .from("clone_modules")
    .select("modules(slug, file_globs)")
    .eq("clone_id", cloneId);
  if (modulesErr) failures.push(`clone_modules: ${modulesErr.message}`);

  const { data: pins, error: pinsErr } = await supabase
    .from("clone_library_pins")
    .select("slug, version, library_entry_id")
    .eq("clone_id", cloneId);
  if (pinsErr) failures.push(`clone_library_pins: ${pinsErr.message}`);

  const pinRows = (pins ?? []) as Array<{
    slug: string;
    version: number;
    library_entry_id: string;
  }>;

  const pinMap = new Map<string, { version: number; files: string[] }>();
  if (pinRows.length > 0) {
    const entryIds = pinRows.map((p) => p.library_entry_id);
    const { data: entries, error: entriesErr } = await supabase
      .from("module_library")
      .select("id, file_paths")
      .in("id", entryIds);
    if (entriesErr) failures.push(`module_library: ${entriesErr.message}`);
    const fileMap = new Map<string, string[]>();
    for (const e of (entries ?? []) as Array<{ id: string; file_paths: string[] | null }>) {
      fileMap.set(e.id, e.file_paths ?? []);
    }
    for (const p of pinRows) {
      const files = fileMap.get(p.library_entry_id) ?? [];
      if (files.length > 0) pinMap.set(p.slug, { version: p.version, files });
    }
  }

  const honored: string[] = [];
  const globs = (
    (cmods ?? []) as Array<{
      modules: { slug: string | null; file_globs: string[] | null } | null;
    }>
  ).flatMap((cm) => {
    const slug = cm.modules?.slug ?? null;
    if (slug && pinMap.has(slug)) {
      const pin = pinMap.get(slug)!;
      honored.push(`${slug}@v${pin.version}`);
      return pin.files;
    }
    return cm.modules?.file_globs ?? [];
  });

  return {
    globs,
    pinSummary: honored.length > 0 ? `pins: ${honored.join(", ")}` : null,
    failed: failures.length > 0 ? failures.join("; ") : null,
  };
}
