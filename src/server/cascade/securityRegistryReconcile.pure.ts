/**
 * `supabase/functions-registry/SECURITY_REGISTRY.json` is the same shape of
 * problem as `supabase/config.toml`, one file along.
 *
 * ## Why it cannot simply travel
 *
 * The registry names every edge function and its exposure class, and the
 * clone's own CI asserts both directions of that:
 *
 *     Function "X" exists on disk but is not in SECURITY_REGISTRY.json.
 *     Function "X" is declared in config.toml but is not in SECURITY_REGISTRY.json.
 *
 * So a clone that owns functions prime does not have cannot take prime's
 * registry: the file would be missing its own entries and the check would
 * refuse. Measured against prime `98c068a` on 20 Sep 2026, prime holds 413
 * entries and `npc-crm-independent` holds 416 — `crm-calendar`,
 * `crm-inbound-message` and `crm-send-message`, with no entry prime holds that
 * the clone does not.
 *
 * ## Why it cannot simply be excluded either
 *
 * The mirror of the same failure. Prime adds a function, the cascade delivers
 * its directory, the registry does not travel, and the first check above fires
 * on a function the cascade itself put there. Excluding the file makes every
 * cascade that adds a function owe a human an edit.
 *
 * So it is reconciled, exactly as `config.toml` is: prime's file wins every
 * name the two share, the clone keeps the entries prime has no opinion about,
 * and the result is read back for anything the clone declared and lost.
 *
 * ## The file is only written in a shape this module can reproduce
 *
 * `JSON.parse` keeps the LAST of two identically-named keys and discards the
 * first without complaint — a hazard the clone's own checker documents in its
 * header, because a duplicated entry is then invisible to every check that
 * reads the parsed object. Re-serialising a parsed registry would silently
 * DELETE that duplicate, laundering away a defect the clone's gate exists to
 * catch.
 *
 * The guard is a fidelity check rather than a duplicate detector: re-serialise
 * each input and require it to equal the input byte for byte. A duplicate key
 * fails it, and so does any other shape this module would not reproduce
 * faithfully — different indentation, a comment, a key order it does not
 * preserve. Both live files pass it (verified 20 Sep 2026), and anything that
 * stops passing is held for a person rather than rewritten by a guess.
 *
 * Non-ASCII is escaped as `\uXXXX` because that is how both files are written;
 * `JSON.stringify` emits the literal character, which would reformat 96 KB of
 * file on the first cascade and bury the change nobody could then review.
 */

/** The one path this module has an opinion about. */
export const SECURITY_REGISTRY_PATH = "supabase/functions-registry/SECURITY_REGISTRY.json";

export type SecurityRegistryReconcile =
  | {
      ok: true;
      /** Prime's registry with the clone's own entries kept. */
      merged: string;
      /** False when the clone's copy already equals the reconciled result. */
      changed: boolean;
      /** Entries the clone holds that prime has none for. */
      carriedForward: string[];
    }
  | { ok: false; reason: string };

type Registry = { functions?: Record<string, unknown> } & Record<string, unknown>;

/**
 * The exact serialisation both live files are written in.
 *
 * Two spaces, a trailing newline, and every non-ASCII character escaped.
 */
export function serialiseSecurityRegistry(value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return (
    json.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) +
    "\n"
  );
}

function parseFaithfully(
  raw: string,
  which: string,
): { ok: true; value: Registry } | { ok: false; reason: string } {
  let value: Registry;
  try {
    value = JSON.parse(raw) as Registry;
  } catch (e) {
    return { ok: false, reason: `${which}'s SECURITY_REGISTRY.json is not valid JSON: ${e}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `${which}'s SECURITY_REGISTRY.json is not a JSON object` };
  }
  const functions = value.functions;
  if (!functions || typeof functions !== "object" || Array.isArray(functions)) {
    return {
      ok: false,
      reason: `${which}'s SECURITY_REGISTRY.json has no \`functions\` object to reconcile`,
    };
  }
  if (serialiseSecurityRegistry(value) !== raw) {
    return {
      ok: false,
      reason:
        `${which}'s SECURITY_REGISTRY.json is not in the shape this reconcile can reproduce ` +
        `byte for byte. Rewriting it would change more than the entries — and a duplicated ` +
        `function key, which \`JSON.parse\` silently discards, fails exactly this way`,
    };
  }
  return { ok: true, value };
}

/** Entries the clone declared that a candidate result does not carry. */
export function entriesLostBy(cloneJson: string, candidate: string): string[] {
  const readNames = (raw: string): string[] => {
    try {
      const f = (JSON.parse(raw) as Registry).functions;
      return f && typeof f === "object" ? Object.keys(f) : [];
    } catch {
      return [];
    }
  };
  const kept = new Set(readNames(candidate));
  return readNames(cloneJson).filter((n) => !kept.has(n));
}

/**
 * Compose the registry this clone should hold.
 *
 * Prime's entry wins every name the two share — that is what carries a changed
 * exposure class or a flipped `verify_jwt` across. The clone keeps only the
 * names prime has no entry for at all.
 */
export function reconcileSecurityRegistry(args: {
  primeJson: string;
  cloneJson: string;
}): SecurityRegistryReconcile {
  const prime = parseFaithfully(args.primeJson, "the prime");
  if (!prime.ok) return prime;
  const clone = parseFaithfully(args.cloneJson, "this clone");
  if (!clone.ok) return clone;

  const primeFns = prime.value.functions as Record<string, unknown>;
  const cloneFns = clone.value.functions as Record<string, unknown>;
  const carriedForward = Object.keys(cloneFns).filter((n) => !(n in primeFns));

  // Prime's document, with the clone's own entries appended to `functions`.
  // Every other top-level key is prime's, the way config.toml's preamble is.
  const mergedFunctions: Record<string, unknown> = { ...primeFns };
  for (const name of carriedForward) mergedFunctions[name] = cloneFns[name];
  const merged = serialiseSecurityRegistry({ ...prime.value, functions: mergedFunctions });

  // Read the result back, for the thing this file decides. An entry the clone
  // declared and the result does not is a function the clone's own checker
  // will refuse — and it refuses the cascade's own delivery, not a mistake
  // anybody made here.
  const lost = entriesLostBy(args.cloneJson, merged);
  if (lost.length > 0) {
    return {
      ok: false,
      reason:
        `the reconciled registry drops this clone's own entr${lost.length === 1 ? "y" : "ies"} ` +
        `for ${lost.join(", ")}, which its own security check requires for every function on disk`,
    };
  }

  return { ok: true, merged, changed: merged !== args.cloneJson, carriedForward };
}
