#!/usr/bin/env node
/**
 * Does every migration run AFTER the objects it needs are created?
 *
 * ## The defect this exists for
 *
 * A migration file's name is its version, and a version is the order it runs
 * in. `20260917110000_builder_marketplace_ranking.sql` altered
 * `builder_network_stock_items`, which is created by
 * `20261123000000_builder_network_stock_mirror.sql` — so on any rebuild from
 * this repository it ran two months before the table existed and failed.
 *
 * It reached a merged pull request. Nothing could see it: every gate this
 * repository owns reads migrations one at a time, and the fault is not in any
 * one file. It is in the ORDER of two, which only a pass over the whole set in
 * version order can judge.
 *
 * It is an easy fault to introduce here because **this tree's versions are
 * sequence numbers wearing a date's clothes**. They run to 20261203 while the
 * wall clock says September, so "today's timestamp" — the obvious thing to
 * name a new migration — lands in the middle of applied history rather than at
 * the end.
 *
 * ## What it judges, and what it refuses to
 *
 * Only references Postgres resolves AT THE STATEMENT, and only where the
 * object's creation is somewhere in this repository's own migrations. Both
 * halves matter.
 *
 * The first half is why a PL/pgSQL body is stripped before anything is read.
 * A function body is not parsed for object existence at `CREATE FUNCTION`
 * time — it is stored as text and resolved when it runs — so a body naming a
 * table created later is correct and common, and flagging it would drown
 * every real finding. Comments and string literals go the same way, and for
 * the same reason: what is in them is not a reference.
 *
 * The second half is why an unknown object is never a finding. This
 * repository's migrations are not the only thing that has ever created an
 * object in these databases — six functions and three triggers ran in
 * production with no file at all until they were captured — so "no migration
 * creates this" means the gate cannot judge, not that the object is absent.
 * Erring the other way would make the gate unusable on the first schema it
 * did not fully explain.
 *
 * ## Liveness, not first creation
 *
 * An object dropped and recreated is absent in between, so the timeline is
 * walked as CREATE and DROP events in (version, offset) order and a
 * requirement is satisfied only while the object is live at that point. The
 * idempotent `drop ... if exists` immediately followed by `create` — which is
 * most of this corpus — resolves correctly because offsets are compared
 * within a file as well as between files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Schemas an extension or the platform owns. Nothing in this repository
 * creates `cron.job` or `auth.users`, so a reference to one is not evidence
 * of anything and would otherwise be an unjudgeable finding on every file
 * that schedules a job.
 */
export const FOREIGN_SCHEMAS = new Set([
  "auth", "storage", "extensions", "vault", "graphql", "graphql_public",
  "realtime", "supabase_functions", "supabase_migrations", "pgsodium",
  "pgbouncer", "cron", "net", "pg_catalog", "information_schema", "pgtle",
]);

/** A relation reference resolves against any of these. */
const RELATION = new Set(["table", "view", "materialized_view"]);

/**
 * Blank a span in place, keeping every other character at its own offset so a
 * line number computed after stripping is the line number in the real file.
 * Newlines survive; everything else becomes a space.
 *
 * A character array rather than string slicing: rebuilding the whole source
 * per span is quadratic, and this corpus is ~1,000 files with several over a
 * megabyte — it took the pass from minutes to milliseconds.
 */
const SPACES = " ".repeat(4096);
const blankRun = (text) => (/\n/.test(text) ? text.replace(/[^\n]/g, " ")
  : text.length <= SPACES.length ? SPACES.slice(0, text.length) : " ".repeat(text.length));

/**
 * Replace every span that is not SQL the planner resolves — line comments,
 * block comments (which nest in Postgres), single-quoted literals and
 * dollar-quoted bodies — with spaces of the same length, so a line number
 * computed afterwards is the line number in the real file.
 *
 * One left-to-right scan rather than a regex per form, because these forms
 * contain each other: a `--` inside a string is not a comment and a `'` inside
 * a dollar-quoted body is not a string, and a regex per form gets that wrong
 * in both directions.
 *
 * It collects spans and rebuilds the string once. The first version spread the
 * source into a character array; on this corpus — 395 MB across ~1,000 files,
 * with three seed migrations of 40 MB each — that alone took half a minute.
 */
export function stripUnresolved(src) {
  const n = src.length;
  const spans = [];
  let i = 0;

  while (i < n) {
    const c = src.charCodeAt(i);

    // `-` `-`
    if (c === 45 && src.charCodeAt(i + 1) === 45) {
      let end = src.indexOf("\n", i);
      if (end === -1) end = n;
      spans.push([i, end]);
      i = end;
      continue;
    }

    // `/` `*`
    if (c === 47 && src.charCodeAt(i + 1) === 42) {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        const open = src.indexOf("/*", j);
        const close = src.indexOf("*/", j);
        if (close === -1) { j = n; break; }
        if (open !== -1 && open < close) { depth += 1; j = open + 2; continue; }
        depth -= 1;
        j = close + 2;
      }
      spans.push([i, j]);
      i = j;
      continue;
    }

    // `'`
    if (c === 39) {
      let j = i + 1;
      for (;;) {
        const q = src.indexOf("'", j);
        if (q === -1) { j = n; break; }
        if (src.charCodeAt(q + 1) === 39) { j = q + 2; continue; }
        j = q + 1;
        break;
      }
      spans.push([i, j]);
      i = j;
      continue;
    }

    // `$tag$` … `$tag$`
    if (c === 36) {
      let j = i + 1;
      while (j < n) {
        const k = src.charCodeAt(j);
        const word = (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95;
        if (!word) break;
        j += 1;
      }
      if (src.charCodeAt(j) === 36) {
        const tag = src.slice(i, j + 1);
        const close = src.indexOf(tag, j + 1);
        const end = close === -1 ? n : close + tag.length;
        spans.push([i, end]);
        i = end;
        continue;
      }
    }

    i += 1;
  }

  if (spans.length === 0) return src;

  const parts = [];
  let prev = 0;
  for (const [from, to] of spans) {
    if (from > prev) parts.push(src.slice(prev, from));
    parts.push(blankRun(src.slice(from, to)));
    prev = to;
  }
  if (prev < n) parts.push(src.slice(prev));
  return parts.join("");
}

export function canon(raw) {
  const parts = raw
    .split(".")
    .map((p) => p.replace(/"/g, "").trim().toLowerCase())
    .filter(Boolean);
  if (parts.length > 1 && parts[0] === "public") parts.shift();
  return parts.join(".");
}

export const schemaOf = (raw) => {
  const parts = raw.split(".").map((p) => p.replace(/"/g, "").trim().toLowerCase());
  return parts.length > 1 ? parts[0] : null;
};

const NAME = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*`;

const CLASS_OF = {
  table: "table",
  view: "view",
  "materialized view": "materialized_view",
  function: "function",
  procedure: "function",
  sequence: "sequence",
  type: "type",
  schema: "schema",
  index: "index",
  trigger: "trigger",
};

/** CREATE and DROP events, in file order, with the offset each occurred at. */
export function extractEvents(sql) {
  const events = [];

  const createRe = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:global\s+|local\s+|temp\s+|temporary\s+|unrecoverable\s+)?(?:unique\s+)?` +
      String.raw`(materialized\s+view|table|view|function|procedure|sequence|type|schema|index|trigger)\s+` +
      String.raw`(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(${NAME})`,
    "gi",
  );
  for (const m of sql.matchAll(createRe)) {
    const cls = CLASS_OF[m[1].toLowerCase().replace(/\s+/g, " ")];
    if (cls) events.push({ kind: "create", cls, name: canon(m[2]), at: m.index });
  }

  const dropRe = new RegExp(
    String.raw`\bdrop\s+(materialized\s+view|table|view|function|procedure|sequence|type|schema|index|trigger)\s+` +
      String.raw`(?:concurrently\s+)?(?:if\s+exists\s+)?(${NAME})`,
    "gi",
  );
  for (const m of sql.matchAll(dropRe)) {
    const cls = CLASS_OF[m[1].toLowerCase().replace(/\s+/g, " ")];
    if (cls) events.push({ kind: "drop", cls, name: canon(m[2]), at: m.index });
  }

  return events.sort((a, b) => a.at - b.at);
}

/**
 * The forms Postgres resolves at the statement. Each carries the words that
 * produced it, because a finding an author cannot locate in their own file is
 * a finding they will baseline rather than read.
 *
 * `if exists` / `if not exists` variants are deliberately absent: a statement
 * that tolerates the object's absence does not require its presence.
 */
const REQUIREMENT_FORMS = [
  { form: "alter table", cls: RELATION, re: new RegExp(String.raw`\balter\s+table\s+(?!if\s+exists\b)(?:only\s+)?(${NAME})`, "gi") },
  { form: "alter view", cls: RELATION, re: new RegExp(String.raw`\balter\s+(?:materialized\s+)?view\s+(?!if\s+exists\b)(${NAME})`, "gi") },
  { form: "alter sequence", cls: new Set(["sequence"]), re: new RegExp(String.raw`\balter\s+sequence\s+(?!if\s+exists\b)(${NAME})`, "gi") },
  { form: "alter type", cls: new Set(["type"]), re: new RegExp(String.raw`\balter\s+type\s+(?!if\s+exists\b)(${NAME})`, "gi") },
  { form: "create index on", cls: RELATION, re: new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${NAME}\s+)?on\s+(?:only\s+)?(${NAME})`, "gi") },
  { form: "create trigger on", cls: RELATION, re: new RegExp(String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${NAME}\s+(?:before|after|instead\s+of)\b[\s\S]{0,200}?\bon\s+(${NAME})`, "gi") },
  { form: "create policy on", cls: RELATION, re: new RegExp(String.raw`\bcreate\s+policy\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+on\s+(${NAME})`, "gi") },
  // Without `if exists` only. Measured against PostgreSQL 16 rather than
  // assumed: `drop policy if exists p on t` SUCCEEDS when `t` does not exist —
  // the guard covers the relation, not just the policy — and `drop trigger if
  // exists` behaves the same way. Reading it the other way produced 88
  // findings on this corpus, every one of them wrong.
  { form: "drop policy on", cls: RELATION, re: new RegExp(String.raw`\bdrop\s+policy\s+(?!if\s+exists\b)(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s+on\s+(${NAME})`, "gi") },
  { form: "references", cls: RELATION, re: new RegExp(String.raw`\breferences\s+(${NAME})`, "gi") },
  { form: "insert into", cls: RELATION, re: new RegExp(String.raw`\binsert\s+into\s+(${NAME})`, "gi") },
  { form: "update", cls: RELATION, re: new RegExp(String.raw`\bupdate\s+(?:only\s+)?(${NAME})\s+set\b`, "gi") },
  { form: "delete from", cls: RELATION, re: new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?(${NAME})`, "gi") },
  { form: "comment on", cls: null, re: new RegExp(String.raw`\bcomment\s+on\s+(?:table|view|column|function|index|type|sequence|constraint\s+${NAME}\s+on)\s+(${NAME})`, "gi") },
  { form: "grant on", cls: null, re: new RegExp(String.raw`\bgrant\s+[\s\S]{1,120}?\bon\s+(?:table\s+|sequence\s+|function\s+|all\s+tables\s+in\s+schema\s+)?(${NAME})\s+to\b`, "gi") },
];

/**
 * A view body IS resolved when the view is created, so its sources are
 * requirements — but only the ones that are relations. A common table
 * expression is a name that exists for the length of one statement, and
 * counting it would report every `with ... select` as a missing table.
 */
const CTE_RE = new RegExp(String.raw`\bwith\s+(?:recursive\s+)?((?:${NAME})\s+as\s*\()`, "gi");
const FROM_RE = new RegExp(String.raw`\b(?:from|join)\s+(?:only\s+)?(${NAME})`, "gi");

function cteNames(sql) {
  const names = new Set();
  // Every `name AS (` in the statement, including the comma-separated tail of a
  // WITH list, which the leading `with` alone does not reach.
  const listRe = new RegExp(String.raw`(?:\bwith\s+(?:recursive\s+)?|,\s*)((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))\s+as\s*\(`, "gi");
  for (const m of sql.matchAll(listRe)) names.add(canon(m[1]));
  return names;
}

export function extractRequirements(sql) {
  const found = [];
  const seen = new Set();

  const push = (name, form, at, cls) => {
    const c = canon(name);
    if (!c) return;
    const schema = schemaOf(name);
    if (schema && FOREIGN_SCHEMAS.has(schema)) return;
    // A bare `select`/`values`/etc. swept up by a loose form is not a name.
    if (/^(select|values|only|table|public|current_user|session_user)$/.test(c)) return;
    const key = `${c}|${form}|${at}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ name: c, form, at, cls });
  };

  for (const { form, re, cls } of REQUIREMENT_FORMS) {
    re.lastIndex = 0;
    for (const m of sql.matchAll(re)) push(m[1], form, m.index, cls);
  }

  // View bodies, minus their own CTEs.
  const viewRe = new RegExp(
    String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}` +
      String.raw`(?:\s+with\s*\([^)]*\))?\s+as\b([\s\S]*?);`,
    "gi",
  );
  for (const m of sql.matchAll(viewRe)) {
    const body = m[1];
    const locals = cteNames(body);
    FROM_RE.lastIndex = 0;
    for (const f of body.matchAll(FROM_RE)) {
      const c = canon(f[1]);
      if (locals.has(c)) continue;
      push(f[1], "view body reads", m.index + m[0].indexOf(body) + f.index, RELATION);
    }
  }

  return found;
}

const lineAt = (src, offset) => src.slice(0, offset).split("\n").length;

export const versionOf = (file) => (/^(\d{14})/.exec(file) || [])[1] ?? null;

/**
 * Walk every migration in version order and report each requirement that is
 * not live where it stands.
 */
export function analyse(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const parsed = files.map((file) => {
    const raw = readFileSync(join(dir, file), "utf8");
    const sql = stripUnresolved(raw);
    return { file, raw, sql, events: extractEvents(sql), requires: extractRequirements(sql) };
  });

  /** object name -> ordered [{ order, at, kind, cls }] */
  const timeline = new Map();
  parsed.forEach(({ events }, order) => {
    for (const e of events) {
      if (!timeline.has(e.name)) timeline.set(e.name, []);
      timeline.get(e.name).push({ order, at: e.at, kind: e.kind, cls: e.cls });
    }
  });
  for (const list of timeline.values()) {
    list.sort((a, b) => (a.order - b.order) || (a.at - b.at));
  }

  const findings = [];

  parsed.forEach(({ file, raw, sql, requires }, order) => {
    for (const req of requires) {
      const history = timeline.get(req.name);
      // Never created by anything here — unjudgeable, so not a finding.
      if (!history) continue;
      if (req.cls && !history.some((e) => e.kind === "create" && req.cls.has(e.cls))) continue;

      const before = history.filter((e) => e.order < order || (e.order === order && e.at < req.at));
      const live = before.length > 0 && before[before.length - 1].kind === "create";
      if (live) continue;

      const creator = history.find((e) => e.kind === "create" && (e.order > order || (e.order === order && e.at > req.at)));
      findings.push({
        file,
        version: versionOf(file),
        line: lineAt(sql, req.at),
        object: req.name,
        form: req.form,
        created_by: creator ? parsed[creator.order].file : null,
        reason: creator
          ? (creator.order === order ? "created later in this same file" : "created by a later migration")
          : "dropped by an earlier migration and not recreated",
      });
    }
  });

  return { files: files.length, findings };
}
