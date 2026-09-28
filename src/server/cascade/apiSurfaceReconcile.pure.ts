/**
 * `mobile/api-surface.json` is the third file generated from the function set,
 * and it is judged the same way the other two are: CI regenerates it and fails
 * on any byte of difference.
 *
 * ## What generates it
 *
 * `scripts/mobile/export-api-surface.mjs` reads the security registry and
 * `supabase/config.toml` and writes one entry per REGISTRY function — its
 * exposure class, the mobile scope that class maps to, and the `verify_jwt`
 * the config declares for it (true where it declares nothing). The clone's
 * `mobile:api:check` runs it with `--check`.
 *
 * So a clone whose registry is not prime's cannot hold prime's surface. The
 * registry pump takes out what the prime keeps for itself
 * (`primeOnlyFeatures.pure.ts`) and keeps what the clone owns, and prime's
 * surface then lists twenty-eight functions the clone's registry does not —
 * red on a file the cascade itself wrote, the defect the baselines were
 * reconciled to close.
 *
 * ## Nothing here is transcribed that the prime's own file cannot check
 *
 * Three things decide the output, and each is taken from somewhere that can
 * be wrong only visibly:
 *
 * - **The class-to-scope map** is read out of prime's committed surface,
 *   which carries both for every function. It is not copied from the
 *   generator's `SCOPE_BY_CLASS`: a second statement of one rule is how two
 *   statements come to disagree. A class prime's surface never shows — one
 *   only a clone uses — is refused rather than guessed, which is exactly what
 *   the generator itself does with a class it has not mapped.
 * - **The `verify_jwt` rule** is the generator's regular expression, and it is
 *   the one thing transcribed. It is checked on every pass: the surface is
 *   first composed from PRIME'S registry and config and must reproduce prime's
 *   committed file byte for byte, or nothing is written.
 * - **The order** is the generator's `localeCompare`, which depends on the
 *   locale of whatever runs it. Over names made of `a-z`, `0-9` and `-` every
 *   collation this could meet agrees with code-point order — the root order
 *   ranks punctuation below digits below letters, and the POSIX one IS code
 *   point — so that is what is used, and a name outside that alphabet is
 *   refused rather than placed by a guess about somebody's locale. Measured
 *   on prime@387feb03: 414 names, none outside it.
 *
 * A refusal is held and named like the registry's, and costs the pass the red
 * check it would otherwise have had.
 */

/** The one path this module has an opinion about. */
export const API_SURFACE_PATH = "mobile/api-surface.json";

export type ApiSurfaceReconcile =
  | {
      ok: true;
      /** The surface this clone's registry and config generate. */
      merged: string;
      /** How many functions it lists. */
      count: number;
      /** Functions prime's surface lists and this one does not. Sorted. */
      leftOut: string[];
      /** Functions this one lists and prime's does not. Sorted. */
      added: string[];
    }
  | { ok: false; reason: string };

type SurfaceEntry = {
  name: string;
  exposure_class: string;
  mobileScope: string;
  verify_jwt: boolean;
};

type Surface = {
  $comment: string;
  sources: string[];
  counts: Record<string, number>;
  functions: SurfaceEntry[];
};

/** The generator's serialisation, to the trailing newline. */
function serialise(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** The alphabet over which code-point order and every collation agree. */
const PLAIN_NAME = /^[a-z0-9-]+$/;

/**
 * The `verify_jwt` each `[functions.X]` block declares, by the GENERATOR's
 * rule: an unanchored header, a body running to the next line that opens a
 * section, `true` where the body says nothing, and the last block of a name
 * winning. Deliberately not the line-anchored reading the inventory uses — the
 * two generators disagree about a header inside prose, and this file is judged
 * by this one.
 */
export function surfaceVerifyJwt(toml: string): Map<string, boolean> {
  const declared = new Map<string, boolean>();
  const re = /\[functions\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(toml))) {
    const v = /verify_jwt\s*=\s*(true|false)/.exec(m[2]);
    declared.set(m[1], v ? v[1] === "true" : true);
  }
  return declared;
}

function parseObject(
  raw: string,
  which: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `${which} is not valid JSON: ${e}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `${which} is not a JSON object` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/**
 * The class-to-scope map prime's surface states, or a refusal where it states
 * two scopes for one class — which the generator cannot produce, so a file
 * doing it is not the generator's.
 */
function scopesFrom(
  surface: Surface,
): { ok: true; map: Map<string, string> } | { ok: false; reason: string } {
  const map = new Map<string, string>();
  for (const f of surface.functions) {
    if (!f || typeof f.exposure_class !== "string" || typeof f.mobileScope !== "string") {
      return { ok: false, reason: "the prime's mobile surface has an entry without a class" };
    }
    const seen = map.get(f.exposure_class);
    if (seen !== undefined && seen !== f.mobileScope) {
      return {
        ok: false,
        reason:
          `the prime's mobile surface maps the class ${f.exposure_class} to both ${seen} ` +
          `and ${f.mobileScope}`,
      };
    }
    map.set(f.exposure_class, f.mobileScope);
  }
  return { ok: true, map };
}

/**
 * Compose a surface the way the generator does, from one registry and one
 * config, in prime's own framing (`$comment`, `sources`).
 */
function compose(args: {
  registryJson: string;
  toml: string;
  scopes: ReadonlyMap<string, string>;
  frame: Pick<Surface, "$comment" | "sources">;
  which: string;
}): { ok: true; text: string; names: string[] } | { ok: false; reason: string } {
  const parsed = parseObject(args.registryJson, `${args.which}'s security registry`);
  if (!parsed.ok) return parsed;
  const registry = parsed.value.functions;
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { ok: false, reason: `${args.which}'s security registry has no \`functions\` object` };
  }
  const declared = surfaceVerifyJwt(args.toml);
  const entries = Object.entries(registry as Record<string, { exposure_class?: unknown }>);

  const oddNames = entries.map(([name]) => name).filter((name) => !PLAIN_NAME.test(name));
  if (oddNames.length > 0) {
    return {
      ok: false,
      reason:
        `${args.which}'s registry names ${oddNames.join(", ")}, outside the letters, digits and ` +
        `hyphens whose order this reconcile can reproduce without the generator's locale`,
    };
  }
  const unmapped = entries
    .filter(([, entry]) => !args.scopes.has(String(entry?.exposure_class)))
    .map(([name, entry]) => `${name} (${String(entry?.exposure_class)})`);
  if (unmapped.length > 0) {
    return {
      ok: false,
      reason:
        `${args.which}'s registry gives ${unmapped.join(", ")} an exposure class the prime's ` +
        `mobile surface never maps, so which scope it belongs to is the generator's decision`,
    };
  }

  const functions: SurfaceEntry[] = entries
    .map(([name, entry]) => {
      const exposureClass = String(entry.exposure_class);
      return {
        name,
        exposure_class: exposureClass,
        mobileScope: args.scopes.get(exposureClass) as string,
        verify_jwt: declared.has(name) ? (declared.get(name) as boolean) : true,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // First-appearance order over the sorted list, as the generator builds it.
  const counts: Record<string, number> = {};
  for (const f of functions) counts[f.mobileScope] = (counts[f.mobileScope] ?? 0) + 1;

  return {
    ok: true,
    text: serialise({
      $comment: args.frame.$comment,
      sources: args.frame.sources,
      counts,
      functions,
    }),
    names: functions.map((f) => f.name),
  };
}

/**
 * The surface this clone's reconciled registry and config generate, or a named
 * refusal.
 *
 * `mergedRegistryJson` and `mergedToml` are what the registry and config pumps
 * decided this pass lands — never either side's file, for the reason the
 * baselines give: a surface generated from a document that does not land
 * describes a repository that will not exist.
 */
export function reconcileApiSurface(args: {
  primeSurfaceJson: string;
  primeRegistryJson: string;
  primeToml: string;
  mergedRegistryJson: string;
  mergedToml: string;
}): ApiSurfaceReconcile {
  const parsed = parseObject(args.primeSurfaceJson, "the prime's mobile surface");
  if (!parsed.ok) return parsed;
  const surface = parsed.value as Partial<Surface>;
  if (
    typeof surface.$comment !== "string" ||
    !Array.isArray(surface.sources) ||
    !surface.counts ||
    typeof surface.counts !== "object" ||
    !Array.isArray(surface.functions)
  ) {
    return { ok: false, reason: "the prime's mobile surface is not the shape its generator emits" };
  }
  const scopes = scopesFrom(surface as Surface);
  if (!scopes.ok) return scopes;
  const frame = { $comment: surface.$comment, sources: surface.sources as string[] };

  // The transcription answers for itself before it is trusted: composed from
  // the prime's own inputs it must BE the prime's file. A generator that
  // changed shape, a locale that ordered differently, or a prime whose own
  // surface is stale all fail here, and all of them would otherwise be
  // written into a clone as a plausible file.
  const own = compose({
    registryJson: args.primeRegistryJson,
    toml: args.primeToml,
    scopes: scopes.map,
    frame,
    which: "the prime",
  });
  if (!own.ok) return own;
  if (own.text !== args.primeSurfaceJson) {
    return {
      ok: false,
      reason:
        "composed from the prime's own registry and config, this reconcile does not reproduce " +
        "the prime's committed mobile surface — so either the prime's file is stale or its " +
        "generator has changed shape, and a surface composed the same way for this clone could " +
        "not be trusted",
    };
  }

  const merged = compose({
    registryJson: args.mergedRegistryJson,
    toml: args.mergedToml,
    scopes: scopes.map,
    frame,
    which: "the reconciled",
  });
  if (!merged.ok) return merged;

  const primeNames = new Set(own.names);
  const mergedNames = new Set(merged.names);
  return {
    ok: true,
    merged: merged.text,
    count: merged.names.length,
    leftOut: own.names.filter((n) => !mergedNames.has(n)).sort(),
    added: merged.names.filter((n) => !primeNames.has(n)).sort(),
  };
}
