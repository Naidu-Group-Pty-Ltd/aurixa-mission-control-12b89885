/**
 * A function the clone declares travels with its source.
 *
 * `reconcileConfigToml` brings prime's `[functions.X]` declarations across on
 * every pass — that is what keeps `verify_jwt` honest — while a function's own
 * directory crosses only where an installed module glob names it. So a
 * module-scoped clone can end a pass declaring a function it has no code for:
 * the CRM-independent line declared `agent-speech` (cascade #82) and later
 * `agent-realtime-session` and `urban-centre-register-ingest` (#104), each
 * CALLED by code that did cross (`realtimeVoiceEngine.ts`, the urban-centre
 * cron migrations), and each needed a hand reconcile to carry the directory.
 * A declaration with no source is a 404 at the gateway on the clone and a red
 * deploy lane; it is never a state anybody chose.
 *
 * The rule: a function the final `config.toml` declares, whose directory the
 * clone does not hold and this delivery does not write, owes prime's files
 * for that directory. They are fed to the subject carry as owed paths, so they
 * meet the exclusions, the CRM line's withheld functions, the ceiling and
 * `prepareOne` on the same terms as any import the carry brings — a withheld
 * function stays withheld, it is only ever a missing one that is carried.
 *
 * Pure: the engine supplies the listings.
 */
import { functionBlocksIn } from "./configTomlReconcile.pure";

const FUNCTIONS_ROOT = "supabase/functions/";

export function declaredFunctionSourcesOwed(args: {
  /** The `config.toml` this pass leaves the clone with. */
  toml: string;
  /** Prime's tree: blob SHA by path. */
  prime: ReadonlyMap<string, string>;
  /** The clone's tree before this pass. */
  clone: ReadonlyMap<string, string>;
  /** Paths this pass already writes. */
  delivering: ReadonlySet<string>;
}): string[] {
  const dirOf = (path: string): string | null => {
    if (!path.startsWith(FUNCTIONS_ROOT)) return null;
    const rest = path.slice(FUNCTIONS_ROOT.length);
    const slash = rest.indexOf("/");
    return slash > 0 ? rest.slice(0, slash) : null;
  };
  const present = new Set<string>();
  for (const path of args.clone.keys()) {
    const dir = dirOf(path);
    if (dir) present.add(dir);
  }
  for (const path of args.delivering) {
    const dir = dirOf(path);
    if (dir) present.add(dir);
  }
  const owedDirs = new Set<string>();
  for (const block of functionBlocksIn(args.toml)) {
    if (block.name.startsWith("_") || present.has(block.name)) continue;
    owedDirs.add(block.name);
  }
  if (owedDirs.size === 0) return [];
  const owed: string[] = [];
  for (const path of args.prime.keys()) {
    const dir = dirOf(path);
    if (dir && owedDirs.has(dir)) owed.push(path);
  }
  return owed.sort();
}
