// Module file-glob validator.
//
// `modules.file_globs` drives what the cascade engine reads out of the prime
// repo (via GitHub tree walking) and pushes into clones. A malformed glob is a
// footgun in multiple ways:
//
//   1. Path traversal — `..` segments could match files outside the module
//      scope. GitHub tree API returns repo-relative paths so it can't leave
//      the repo, but a stray `..` still lets one module reach into another's
//      files silently.
//   2. Absolute paths — a leading `/` never matches a GitHub tree entry,
//      producing a silent zero-file cascade with no error surface.
//   3. Backslashes — Windows-style separators never match POSIX paths.
//   4. Catastrophic regex — `**/**/**/**/*` translates to `.*.*.*.*.*` which
//      is exponential on some inputs.
//   5. Control characters or null bytes — corrupt regex, break logging.
//   6. Empty strings — regex matches everything, exfiltrating the whole tree.
//
// This module is client-safe (used by both server writers and UI display).

const MAX_GLOB_LEN = 200;
const MAX_DOUBLESTAR = 2;
const ALLOWED_CHARS = /^[A-Za-z0-9._\-/*?{}[\],!+@()|]+$/;

export type GlobIssue = { glob: string; reason: string };

export type GlobValidationResult = {
  valid: string[];
  invalid: GlobIssue[];
};

/**
 * Validate & sanitise a list of file globs.
 * Returns the accepted patterns plus a per-pattern rejection reason for the
 * caller to surface (log, toast, UI badge). Never throws — callers decide
 * whether to hard-fail or fall back to the accepted subset.
 */
export function validateModuleGlobs(input: unknown): GlobValidationResult {
  const valid: string[] = [];
  const invalid: GlobIssue[] = [];
  const seen = new Set<string>();

  const list = Array.isArray(input) ? input : [];
  for (const raw of list) {
    const issue = classifyGlob(raw);
    if (issue) {
      invalid.push({ glob: String(raw), reason: issue });
      continue;
    }
    const g = (raw as string).trim();
    if (seen.has(g)) continue;
    seen.add(g);
    valid.push(g);
  }

  return { valid, invalid };
}

/** Returns `null` if the glob is safe, otherwise a human-readable reason. */
function classifyGlob(raw: unknown): string | null {
  if (typeof raw !== "string") return "not a string";
  const g = raw.trim();
  if (g.length === 0) return "empty";
  if (g.length > MAX_GLOB_LEN) return `exceeds ${MAX_GLOB_LEN} chars`;
  if (g.startsWith("/")) return "leading '/' (absolute path)";
  if (g.includes("\\")) return "backslash (use forward slashes)";
  if (g.includes("\0")) return "null byte";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(g)) return "control characters";
  if (!ALLOWED_CHARS.test(g)) return "disallowed characters";
  // Path traversal: any `..` segment.
  if (g.split("/").some((seg) => seg === "..")) return "'..' path traversal";
  // Cap catastrophic regex expansion.
  const doubleStars = g.match(/\*\*/g)?.length ?? 0;
  if (doubleStars > MAX_DOUBLESTAR) return `too many '**' (${doubleStars})`;
  // Reject triple-star and higher.
  if (/\*{3,}/.test(g)) return "'***' (invalid glob)";
  return null;
}

/**
 * Second line of defence for file paths *returned* by a matcher: even if a
 * glob slipped through validation, refuse paths that escape the module's
 * intended scope.
 */
export function isSafeRepoPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  return true;
}

/**
 * Compile a repo glob to a regex.
 *
 * This lived privately inside `github-app.server.ts`, where it decides which
 * files the cascade READS out of prime. It is exported here because the same
 * question is now asked a second time — which files the cascade must NOT WRITE
 * into a clone (`server/cascade/syncExclusions.pure.ts`) — and two glob
 * implementations answering the same question differently is how an exclusion
 * silently stops excluding. One implementation, imported by both.
 *
 * `**` crosses directory separators, `*` and `?` do not.
 */
export function globToRegex(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Whether a path matches ANY of `globs`, as `globs.some((g) =>
 * globToRegex(g).test(path))` answers it — in one regular expression rather
 * than one per glob.
 *
 * Every pattern `globToRegex` writes is anchored at both ends, carries no
 * flags and no capture group (each metacharacter is escaped), so the
 * alternation of them matches a path exactly when one of them does.
 *
 * Measured 20 Oct 2026 on `npc-crm-independent-6505dc`: 135 installed modules
 * are 1,160 distinct globs, and the cascade asks them of prime's 11,712 paths
 * and the clone's 10,837. One `RegExp.test` per glob per path was two seconds
 * of the pass's CPU; the alternation is one native match per path.
 */
export function globsMatcher(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  const combined = new RegExp(globs.map((g) => `(?:${globToRegex(g).source})`).join("|"));
  return (path) => combined.test(path);
}
