/**
 * `.gitleaks.toml` carries two kinds of fact, like `supabase/config.toml`, and
 * excluding it whole lost one of them.
 *
 * ## What it cost
 *
 * The file is `protected` in `DEFAULT_MIRROR_EXCLUSIONS`: it allows this
 * deployment's own Supabase anon key as one literal, and prime's copy would
 * allow prime's key in its place and re-flag the clone's. That is the one
 * per-deployment fact in it. The rest is the record of what the secret scan may
 * let through, which is a fact about the REPOSITORY, and the exclusion froze it
 * at whatever each clone forked with.
 *
 * Prime ca5009825 (30 Oct 2026) replaced the real Google key a gate script
 * planted with a synthetic one and allowed the synthetic key in its place, in
 * one commit. The script travelled and the allowance could not, so `security`
 * went red on all five clones' cascade proposals, and each proposal counted the
 * file among the paths "withheld without comment". Each clone's copy was then
 * fixed by hand (176e535, 842b6efd, 1dd653a, 87a8511, db06be9). The frozen
 * copies had drifted the other way too. Three still allowed a lock-file shape
 * prime stopped needing on 9 Oct (77f4f5fc5). Tutorial Demo inherited the CRM
 * line's copy, so it allowed the CRM line's key as "this deployment's own".
 *
 * ## The rule (the owner's decision, 30 Oct 2026)
 *
 * The exclusion row stays, and the write path never carries the file. What
 * travels is the source's file with this deployment's own key put back,
 * written through the reconcile path exactly as `configTomlReconcile.pure.ts`
 * writes `config.toml`:
 *
 *   · the source's text, whole: every allowance, comment and header it has;
 *   · less any allowance for this deployment's own project, which is put back
 *     below, and, where the source is another deployment (a lineage parent),
 *     any allowance for the parent's own project. That key is the parent's
 *     identity, and no file a child inherits carries it: measured 30 Oct 2026,
 *     each child's scan passes without allowing its parent's key. The prime's
 *     key stays wherever the source has it, because files every clone inherits
 *     carry it;
 *   · plus one block allowing this deployment's own key as one literal
 *     (`ownKeyBlock`), the block provisioning writes.
 *
 * The own key is read from the clone's current file. It is the one allowance
 * whose JWT `ref` claim is the project this clone's `config.toml` names. If
 * there is none, more than one, or one that is not an `anon` key, the file is
 * held for a person. The reconcile never writes a config that would reject the
 * clone's own key, never guesses which key is current, and never writes an
 * allowance for a key that bypasses RLS.
 *
 * ## Refusing is the default
 *
 * The result is read back. It must allow the own key, allow no other key for
 * the own project, and name no project the rule took out anywhere outside a
 * comment. An allowance is never edited where it shares a block with a path,
 * commit or stopword allowance, or shares a line with another value. Removing
 * it there would widen what the block allows, or need a TOML writer this
 * module does not have, so the file is held instead.
 *
 * ## What it drops is said
 *
 * The derived file can allow less than the clone's did: a key prime never
 * allowed, or an allowance the clone added that the source does not carry. Each
 * is reported (`keysDropped`, `allowancesDropped`), so a dropped allowance that
 * was still needed turns the proposal's secret scan red on a proposal that says
 * which one it dropped.
 */

/** The one path this module has an opinion about. */
export const GITLEAKS_CONFIG_PATH = ".gitleaks.toml";

/** A Supabase key a gitleaks config allows, read from a `regexes` or `stopwords` value. */
export type AllowedKey = {
  /** The token, with a regex's escaped dots read as dots. */
  key: string;
  /** The project its `ref` claim names. */
  ref: string;
  /** Its `role` claim, or null where it has none. */
  role: string | null;
  /** Zero-based line of the value. */
  line: number;
  /** Whether the value shares its line with another value, or with the array's brackets. */
  sharedLine: boolean;
};

/** A key the derived file no longer allows, named without the key itself. */
export type DroppedKey = { ref: string; role: string | null };

export type GitleaksReconcile =
  | {
      ok: true;
      /** The source's file, less the allowances taken out, plus this clone's own key. */
      merged: string;
      /** The project whose key the result allows as this deployment's own. */
      ownRef: string;
      /** False when the clone's copy already equals the reconciled result. */
      changed: boolean;
      /** Keys the clone's file allowed and the result does not, by project. Sorted. */
      keysDropped: DroppedKey[];
      /**
       * What the clone's file let through that the result does not, by the
       * description of the block it was in: how many of its values, or null
       * where the block could not be read. A value the result writes another
       * way counts, because its old form is gone.
       */
      allowancesDropped: { description: string; values: number | null }[];
    }
  | { ok: false; reason: string };

// ─── Reading the file ─────────────────────────────────────────────────────────

const HEADER = /^\s*\[\[?\s*[A-Za-z0-9_.\-"' ]+\s*\]\]?\s*(#.*)?$/;
const ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const isBlank = (line: string) => line.trim() === "";
const isComment = (line: string) => line.trim().startsWith("#");

/** What one line of an array holds: its strings, and whether the array closed on it. */
type Scanned = { values: string[]; closed: boolean; junk: boolean };

/**
 * The string values on one line of a TOML array, read with their quoting.
 * `'''…'''` and `'…'` are literal strings, which is how gitleaks configs write a
 * regex; `"…"` is read with its escapes left as written. Anything that is not a
 * string, a comma, whitespace, a comment or the closing bracket is `junk`, and
 * an array with junk in it is one this module does not edit.
 */
function scanArrayLine(text: string): Scanned {
  const values: string[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "," || c === "\r") {
      i += 1;
    } else if (c === "#") {
      break;
    } else if (text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3);
      if (end === -1) return { values, closed: false, junk: true };
      values.push(text.slice(i + 3, end));
      i = end + 3;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return { values, closed: false, junk: true };
      values.push(text.slice(i + 1, end));
      i = end + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return { values, closed: false, junk: true };
      values.push(text.slice(i + 1, j));
      i = j + 1;
    } else if (c === "]") {
      const rest = text.slice(i + 1).trim();
      return { values, closed: true, junk: rest !== "" && !rest.startsWith("#") };
    } else {
      return { values, closed: false, junk: true };
    }
  }
  return { values, closed: false, junk: false };
}

type ArrayField = {
  key: string;
  /** Lines of the assignment, first to last. */
  open: number;
  close: number;
  /** Null where a line could not be read. */
  values: { text: string; line: number; sharedLine: boolean }[] | null;
};

type ReadArray = ArrayField & { values: NonNullable<ArrayField["values"]> };
const isRead = (f: ArrayField): f is ReadArray => f.values !== null;

type Section = {
  /** The header line. */
  header: number;
  /** One past its last line: the next header, or the end of the file. */
  end: number;
  isAllowlist: boolean;
  /** Every key assigned in it. */
  keys: string[];
  /** Its scalar assignments, by key, as written after the `=`. */
  scalars: Map<string, string>;
  arrays: ArrayField[];
};

function sectionsOf(lines: readonly string[]): Section[] {
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i += 1) if (HEADER.test(lines[i])) headers.push(i);
  return headers.map((header, n) => {
    const end = n + 1 < headers.length ? headers[n + 1] : lines.length;
    const section: Section = {
      header,
      end,
      isAllowlist: /^\s*\[\[\s*allowlists\s*\]\]/.test(lines[header]),
      keys: [],
      scalars: new Map(),
      arrays: [],
    };
    for (let i = header + 1; i < end; i += 1) {
      if (isBlank(lines[i]) || isComment(lines[i])) continue;
      const m = ASSIGNMENT.exec(lines[i]);
      if (!m) continue;
      section.keys.push(m[1]);
      if (!m[2].trimStart().startsWith("[")) {
        section.scalars.set(m[1], m[2].trim());
        continue;
      }
      const field: ArrayField = { key: m[1], open: i, close: i, values: [] };
      const first = scanArrayLine(m[2].trimStart().slice(1));
      const take = (s: Scanned, line: number, edge: boolean) => {
        if (s.junk) field.values = null;
        if (field.values === null) return;
        const sharedLine = edge || s.values.length > 1;
        for (const text of s.values) field.values.push({ text, line, sharedLine });
      };
      take(first, i, true);
      let closed = first.closed;
      while (!closed && i + 1 < end) {
        i += 1;
        const s = scanArrayLine(lines[i]);
        // The closing line is shared with the bracket; an item line is not.
        take(s, i, s.closed);
        closed = s.closed;
      }
      field.close = i;
      if (!closed) field.values = null;
      section.arrays.push(field);
    }
    return section;
  });
}

/** A JWT's claims, or null where the text is not one. */
function claimsOf(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    const claims: unknown = JSON.parse(json);
    return claims !== null && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The Supabase key a regex value allows as one literal, or null. A gitleaks
 * regex writes a token's dots escaped or bare, and may anchor it; both read
 * as the token. A value that is a pattern rather than a token is not a key.
 */
function supabaseKeyOf(value: string): { key: string; ref: string; role: string | null } | null {
  const token = value.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\./g, ".");
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
  const claims = claimsOf(token);
  if (!claims || typeof claims.ref !== "string") return null;
  return {
    key: token,
    ref: claims.ref,
    role: typeof claims.role === "string" ? claims.role : null,
  };
}

const ALLOWING_ARRAYS = new Set(["regexes", "stopwords"]);

/** Every Supabase key the config allows, where this module can read it. */
export function supabaseKeysAllowed(toml: string): AllowedKey[] {
  const out: AllowedKey[] = [];
  for (const section of sectionsOf(toml.split("\n"))) {
    for (const field of section.arrays) {
      if (!ALLOWING_ARRAYS.has(field.key) || field.values === null) continue;
      for (const v of field.values) {
        const k = supabaseKeyOf(v.text);
        if (k) out.push({ ...k, line: v.line, sharedLine: v.sharedLine });
      }
    }
  }
  return out;
}

const ANY_TOKEN = /[A-Za-z0-9_-]{8,}\\?\.[A-Za-z0-9_-]{8,}\\?\.[A-Za-z0-9_-]+/g;

/**
 * Every Supabase key named anywhere outside a comment, however it is written.
 * The read-back's reader: it does not trust the parser above to have found
 * every value, so a key in a layout the parser skipped is still seen.
 */
function keysNamedOutsideComments(toml: string): { key: string; ref: string }[] {
  const out: { key: string; ref: string }[] = [];
  for (const line of toml.split("\n")) {
    if (isComment(line)) continue;
    for (const m of line.matchAll(ANY_TOKEN)) {
      const k = supabaseKeyOf(m[0]);
      if (k) out.push({ key: k.key, ref: k.ref });
    }
  }
  return out;
}

// ─── Writing it ───────────────────────────────────────────────────────────────

/**
 * The block that allows this deployment's own key, as provisioning writes it
 * and every cascade puts it back.
 */
function ownKeyBlock(ref: string, key: string): string {
  const description =
    `This deployment's own Supabase anon (publishable) key, for project ${ref}. Mission Control ` +
    "writes it on provisioning and puts it back on every cascade. The rest of this file is the " +
    "prime's, so where it says this project it means the prime's, whose key stays allowed " +
    "because files this repository inherits carry it. An anon key is publishable and every row " +
    "it reaches is decided by RLS; it is allowed as ONE literal, so a rotated key, another " +
    "project's key or a service_role key all still fail.";
  const q = "'''";
  return [
    "",
    "[[allowlists]]",
    `description = ${JSON.stringify(description)}`,
    "regexes = [",
    `  ${q}${key}${q},`,
    "]",
    "",
  ].join("\n");
}

function withOwnKeyBlock(toml: string, ref: string, key: string): string {
  return `${toml.replace(/\s*$/, "")}\n${ownKeyBlock(ref, key)}`;
}

/** Whether the scan config already names this key, its dots bare or escaped. */
export function gitleaksAllowsKey(toml: string, key: string): boolean {
  return toml.includes(key) || toml.includes(key.split(".").join("\\."));
}

/**
 * Teach the secret scan this deployment's own anon key. Provisioning's step.
 *
 * Appended rather than substituted: appending cannot corrupt the blocks
 * already there, where an in-place rewrite of a TOML array can, and the
 * prime's literal has to stay for the inherited migrations.
 *
 * Idempotent — a config that already names the key is returned unchanged, so
 * re-running provisioning does not stack duplicate blocks.
 */
export function appendOwnKeyAllowlist(
  toml: string,
  cloneRef: string,
  cloneAnonKey: string,
): string {
  if (gitleaksAllowsKey(toml, cloneAnonKey)) return toml;
  return withOwnKeyBlock(toml, cloneRef, cloneAnonKey);
}

/**
 * The source's text with the given values taken out, or the reason it cannot
 * be done safely.
 *
 * A value on a line of its own goes with its line. Where that empties its
 * array, the whole `[[allowlists]]` block goes, with any comment directly
 * above its header and one blank line beside it, the way
 * `dropFunctionBlocks` removes a `[functions.X]` block. That is only done
 * where the block allows nothing else. A block that also allows paths, commits
 * or stopwords would widen to allow them alone.
 */
function withoutValues(
  toml: string,
  targets: readonly AllowedKey[],
): { text: string; blocksRemoved: number } | { refusal: string } {
  if (targets.length === 0) return { text: toml, blocksRemoved: 0 };
  const lines = toml.split("\n");
  const remove = new Set<number>();
  let blocksRemoved = 0;
  const refOn = new Map(targets.map((t) => [t.line, t.ref]));
  for (const t of targets) {
    if (t.sharedLine) {
      return {
        refusal:
          `the allowance for project \`${t.ref}\` shares its line with another value or with ` +
          `its array's brackets, so it cannot be taken out without rewriting the array`,
      };
    }
  }
  for (const section of sectionsOf(lines)) {
    const fields = section.arrays
      .filter(isRead)
      .filter((f) => f.values.some((v) => refOn.has(v.line)));
    if (fields.length === 0) continue;
    const emptied = fields.filter((f) => f.values.every((v) => refOn.has(v.line)));
    if (emptied.length === 0) {
      for (const f of fields) for (const v of f.values) if (refOn.has(v.line)) remove.add(v.line);
      continue;
    }
    const others = section.keys.filter(
      (k) => k !== "description" && k !== "regexTarget" && !emptied.some((f) => f.key === k),
    );
    const ref = refOn.get(emptied[0].values[0].line);
    if (!section.isAllowlist) {
      return {
        refusal:
          `the allowance for project \`${ref}\` is the only value in \`${lines[section.header].trim()}\`, ` +
          `a block this reconcile does not edit`,
      };
    }
    if (others.length > 0) {
      return {
        refusal:
          `the allowance for project \`${ref}\` is the only value in a block that also has ` +
          `${others.map((k) => `\`${k}\``).join(", ")}, and taking it out would leave that ` +
          `block allowing more than it did`,
      };
    }
    let start = section.header;
    while (start - 1 >= 0 && isComment(lines[start - 1])) start -= 1;
    let last = section.header;
    for (let i = section.header + 1; i < section.end; i += 1) {
      if (!isBlank(lines[i]) && !isComment(lines[i])) last = i;
    }
    for (let i = start; i <= last; i += 1) remove.add(i);
    if (last + 1 < lines.length && isBlank(lines[last + 1])) remove.add(last + 1);
    else if (start - 1 >= 0 && isBlank(lines[start - 1])) remove.add(start - 1);
    blocksRemoved += 1;
  }
  return { text: lines.filter((_, i) => !remove.has(i)).join("\n"), blocksRemoved };
}

/** One value an allowance block lets through, with what it is matched against. */
type AllowedValue = { field: string; target: string; value: string; description: string };

/**
 * Every value the config's `[[allowlists]]` blocks let through, other than a
 * Supabase key (`supabaseKeysAllowed` reads those). `target` is the block's
 * `regexTarget`, because the same regex allows different things against the
 * secret and against the whole line. Null where a block has an array this
 * module could not read, named by its description.
 */
function allowedValues(toml: string): { read: AllowedValue[]; unread: string[] } {
  const read: AllowedValue[] = [];
  const unread: string[] = [];
  for (const s of sectionsOf(toml.split("\n"))) {
    if (!s.isAllowlist) continue;
    const description = (s.scalars.get("description") ?? "").replace(/^"(.*)"$/, "$1");
    const target = (s.scalars.get("regexTarget") ?? "").replace(/^["']+|["']+$/g, "");
    for (const f of s.arrays) {
      if (!isRead(f)) {
        unread.push(description);
        continue;
      }
      for (const v of f.values) {
        if (supabaseKeyOf(v.text) === null)
          read.push({ field: f.key, target, value: v.text, description });
      }
    }
  }
  return { read, unread };
}

/**
 * Two spellings of one value: a quote character written as a hex escape
 * matches what the character matches (`[\x27"]` and `['"]` are one class).
 */
const sameValue = (a: AllowedValue) =>
  [a.field, a.target, a.value.replace(/\\x27/g, "'").replace(/\\x22/g, '"')].join("\u0000");

const MAX_DESCRIPTION = 90;

function excerpt(description: string, fallback: string): string {
  const text = description.trim() || fallback;
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}

/**
 * Compose the `.gitleaks.toml` this clone should hold.
 *
 * `ownRef` is the project this clone's own `config.toml` names, which is the
 * authority on which key is its own. `registeredRef` is the project Mission
 * Control has registered for it (`clone_backends_safe`), or null where none
 * has been provisioned, and is only a cross-check, as it is for `config.toml`.
 */
export function reconcileGitleaksToml(args: {
  sourceToml: string;
  cloneToml: string;
  ownRef: string | null;
  registeredRef: string | null;
  /**
   * Whose file `sourceToml` is. Every key the prime's file allows stays,
   * except this clone's own, which is put back. A lineage parent's own key is
   * the parent's identity and is taken out too.
   */
  source: { kind: "prime" } | { kind: "deployment"; ownRef: string | null };
}): GitleaksReconcile {
  const { sourceToml, cloneToml, ownRef, registeredRef, source } = args;
  const refuse = (reason: string): GitleaksReconcile => ({ ok: false, reason });

  if (ownRef === null || !/^[a-z]{20}$/.test(ownRef)) {
    return refuse(
      "this clone's own project could not be read from its `supabase/config.toml`, so which " +
        "allowance is its own cannot be told",
    );
  }
  if (registeredRef !== null && registeredRef !== ownRef) {
    return refuse(
      `this clone's config.toml names project \`${ownRef}\` while its registered backend is ` +
        `\`${registeredRef}\`. A reconcile must not decide which of them is right`,
    );
  }
  const takeOut = new Set([ownRef]);
  if (source.kind === "deployment") {
    if (source.ownRef === null) {
      return refuse(
        "the source deployment's own project could not be read from its `supabase/config.toml`, " +
          "so its own allowance cannot be told from the prime's",
      );
    }
    if (source.ownRef === ownRef) {
      return refuse(
        `the source deployment's config.toml names this clone's own project, \`${ownRef}\`. ` +
          "Two deployments cannot share an identity, and something needs a person",
      );
    }
    takeOut.add(source.ownRef);
  }

  const ownKeys = [
    ...new Map(
      supabaseKeysAllowed(cloneToml)
        .filter((k) => k.ref === ownRef)
        .map((k) => [k.key, k] as const),
    ).values(),
  ];
  if (ownKeys.length === 0) {
    return refuse(
      `this clone's .gitleaks.toml allows no key for its own project, \`${ownRef}\`, so the key ` +
        "the derived file must allow cannot be read from it",
    );
  }
  if (ownKeys.length > 1) {
    return refuse(
      `this clone's .gitleaks.toml allows ${ownKeys.length} different keys for its own project, ` +
        `\`${ownRef}\`, and which of them is current cannot be told from the file`,
    );
  }
  const own = ownKeys[0];
  if (own.role !== "anon") {
    return refuse(
      `the key this clone's .gitleaks.toml allows for its own project is not an anon key ` +
        `(role \`${own.role ?? "none"}\`). A reconcile never writes an allowance for a key that ` +
        "bypasses RLS",
    );
  }

  const removed = withoutValues(
    sourceToml,
    supabaseKeysAllowed(sourceToml).filter((k) => takeOut.has(k.ref)),
  );
  if ("refusal" in removed) return refuse(removed.refusal);
  const merged = withOwnKeyBlock(removed.text, ownRef, own.key);

  // Read the result back with the reader that trusts nothing above.
  const named = keysNamedOutsideComments(merged);
  if (!supabaseKeysAllowed(merged).some((k) => k.key === own.key)) {
    return refuse("the derived file does not allow this clone's own key. Nothing was written");
  }
  const stray = [
    ...new Set(
      named
        .filter((k) => takeOut.has(k.ref) && !(k.ref === ownRef && k.key === own.key))
        .map((k) => k.ref),
    ),
  ];
  if (stray.length > 0) {
    return refuse(
      `the derived file still names a key for ${stray.map((r) => `\`${r}\``).join(", ")} in a ` +
        "place this reconcile does not edit. It needs a person",
    );
  }
  const headers = (t: string) => sectionsOf(t.split("\n")).filter((s) => s.isAllowlist).length;
  if (headers(merged) !== headers(sourceToml) - removed.blocksRemoved + 1) {
    return refuse("the derived file's allowance blocks do not add up. Nothing was written");
  }

  const mergedKeys = new Set(supabaseKeysAllowed(merged).map((k) => k.key));
  const keysDropped = [
    ...new Map(
      supabaseKeysAllowed(cloneToml)
        .filter((k) => !mergedKeys.has(k.key))
        .map((k) => [k.key, { ref: k.ref, role: k.role }] as const),
    ).values(),
  ].sort((a, b) => a.ref.localeCompare(b.ref));
  const carried = new Set(allowedValues(merged).read.map(sameValue));
  const was = allowedValues(cloneToml);
  const lost = new Map<string, number | null>();
  for (const a of was.read) {
    if (carried.has(sameValue(a))) continue;
    const n = lost.get(a.description);
    lost.set(a.description, n === null ? null : (n ?? 0) + 1);
  }
  for (const description of was.unread) lost.set(description, null);
  const allowancesDropped = [...lost].map(([description, values]) => ({
    description: excerpt(description, "an allowance with no description"),
    values,
  }));

  return {
    ok: true,
    merged,
    ownRef,
    changed: merged !== cloneToml,
    keysDropped,
    allowancesDropped,
  };
}

/** One line for the proposal: what the derivation changed, and what it dropped. */
export function describeGitleaksReconcile(
  verdict: Extract<GitleaksReconcile, { ok: true }>,
  sourcePossessive: string,
): string {
  const parts = [
    `${GITLEAKS_CONFIG_PATH} · ${sourcePossessive} allowances, with this deployment's own key ` +
      `(project ${verdict.ownRef}) put back`,
  ];
  if (verdict.keysDropped.length > 0) {
    parts.push(
      `no longer allows the key for ${verdict.keysDropped
        .map((k) => `\`${k.ref}\` (${k.role ?? "no role"})`)
        .join(", ")}`,
    );
  }
  if (verdict.allowancesDropped.length > 0) {
    parts.push(
      `no longer allows what this clone's copy let through under ${verdict.allowancesDropped
        .map(
          (d) => `"${d.description}" (${d.values === null ? "not read" : `${d.values} value(s)`})`,
        )
        .join("; ")}`,
    );
  }
  return parts.join(" · ");
}
