/**
 * Which table privileges a clone gives its browser roles that the prime does
 * not: compared on every pass of the privilege sweep, reported, and not yet
 * taken back.
 *
 * ## What this is for
 *
 * On 28 Oct 2026 all four clones gave `anon` SELECT, INSERT, UPDATE and DELETE
 * on 24 tables whose policies are `TO public USING (true)`, so a request
 * carrying nothing but a clone's publishable key could read
 * `client_address_history`, `client_income_sources`, `finance_agent_contacts`
 * (bank details) and the 3.5M-row `api_usage_log`, and write every reference
 * cache a report reads (DELIVERY_SYSTEM_PLAN.md §14).
 *
 * The cause is in the build, not in any one clone. A clone is built from the
 * prime's catalogue with Supabase's default privileges, which give `anon` and
 * `authenticated` every privilege on a new `public` table. The grants stage
 * adds a prime grant a clone lacks and never revokes one it holds (a clone's
 * `public` legitimately carries a surplus, see `schema-introspection.server.ts`),
 * and nothing compared table grants after that. The hand revokes and the
 * prime's 20270204090000 closed the 24 tables on the four clones that exist;
 * 20270205090000 restates 124 more relations. A clone built later starts open
 * again, and this is what sees it.
 *
 * ## Report first
 *
 * The owner's decision of 28 Oct 2026: "Sweep tables, report first". The sweep
 * reports for a week, and the owner reviews the reports before anything is
 * enforced. So nothing here plans a statement: every output is a count, a
 * ranked list or a fingerprint. `ENFORCE_TABLE_GRANTS` is the switch an
 * enforcement would sit behind. It is off, and nothing is behind it yet.
 *
 * ## The rules of the comparison
 *
 * 1. **The prime's live ACL is the authority**, as it is for function EXECUTE
 *    (`routinePrivileges.pure.ts`): it is the set the prime's own traffic runs
 *    on.
 * 2. **A surplus is a table privilege the clone gives a browser role and the
 *    prime does not.** A privilege held through PUBLIC is held, on both sides.
 *    `service_role` is the backend's own key and is not compared.
 * 3. **Only relations both sides hold are compared** (tables, partitioned and
 *    foreign tables, views, materialised views in `public`). One only the
 *    clone holds is a variant's own, and one only the prime holds has not
 *    reached the clone: each is counted and ignored.
 * 4. **Column grants are their own thing.** `relacl` carries table-level
 *    privileges only; a column grant lives in `attacl` and is compared apart,
 *    never counted as a table surplus. `template_comments` gives
 *    `authenticated` UPDATE on three columns and none at table level, on all
 *    five projects, and that is not a difference. Where a table-level surplus
 *    has the prime granting the same role the same privilege on columns, the
 *    entry says so (`columnGrantsToKeep`): a table-level REVOKE takes the
 *    role's column grants of that privilege with it.
 * 5. **MAINTAIN is compared only where both servers have it.** Postgres 17
 *    added it, and on an older server nobody can hold it, so comparing it there
 *    would report a difference neither side chose. It is dropped from both
 *    sides and the report says `maintainCompared: false`. All five run 17
 *    today (17.4 on the prime, 17.6 on the clones), so it is compared.
 * 6. **Absent is never zero.** A side that could not be read, or answered no
 *    relation at all, is unreadable. It is never "0 surplus", and it never
 *    clears a finding announced before.
 *
 * ## Worst first
 *
 * Writes (INSERT, UPDATE, DELETE, TRUNCATE) first, then a SELECT nothing but
 * privileges guard: a table with RLS off, or one a permissive SELECT policy
 * opens to that role with `USING (true)` and no restrictive policy narrows; a
 * materialised or foreign table, which RLS cannot cover; a view without
 * `security_invoker`, which reads its tables as its owner. Then the other
 * SELECTs, then REFERENCES, TRIGGER and MAINTAIN. Within a class, a relation
 * whose reads nothing but privileges guard comes first, `anon`'s before
 * `authenticated`'s, then one where `anon` holds the class before one where
 * only `authenticated` does, because `anon` is what the publishable key runs
 * as.
 */
import { createHash } from "node:crypto";
import { parseViewOptions } from "./routinePrivileges.pure";

/** The roles a browser request runs as, and the only ones compared. */
export const BROWSER_ROLES = ["anon", "authenticated"] as const;
export type BrowserRole = (typeof BROWSER_ROLES)[number];

/** A grantee a table ACL can name for a browser: either role, or PUBLIC (grantee oid 0). */
export type BrowserGrantee = BrowserRole | "PUBLIC";

/**
 * The one schema compared. `aml` gives `anon` no USAGE, so nothing in it can
 * be reached with the publishable key whatever its tables grant.
 */
export const TABLE_GRANT_SCHEMA = "public";

/** Writes, then reads, then the rest: the order every list here is in. */
export const TABLE_PRIVILEGES = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "SELECT",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;
export type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

/** TRUNCATE is a write RLS never sees. */
export const WRITE_PRIVILEGES: readonly TablePrivilege[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
];

/**
 * The switch a table-grant enforcement would sit behind. OFF.
 *
 * "Sweep tables, report first" (the owner, 28 Oct 2026): a week of reports,
 * then the owner reviews them before anything is enforced. Nothing reads this
 * to write, because nothing that writes a grant is built: turning it on before
 * then changes what the report calls itself (`tableGrantMode`) and nothing
 * else. Enforcing is a change of its own, made after the review, that builds
 * the revoke and turns this on together.
 */
export const ENFORCE_TABLE_GRANTS = false as const;

export type TableGrantMode = "report_only" | "enforcement_not_built";

/** What the sweep's table comparison is, said in every report. */
export function tableGrantMode(enforce: boolean = ENFORCE_TABLE_GRANTS): TableGrantMode {
  return enforce ? "enforcement_not_built" : "report_only";
}

/** One relation as read from a project's catalogue. */
export type RelationAcl = {
  /** `schema.name`, rendered by the catalogue (quote_ident). */
  relation: string;
  /** `pg_class.relkind`: r table, p partitioned table, v view, m materialised view, f foreign table. */
  kind: string;
  /** Table-level privileges held directly by each grantee, from `relacl`. */
  grants: Record<BrowserGrantee, TablePrivilege[]>;
  /** Column-level grants to the browser roles and PUBLIC, from `attacl`. */
  columnGrants: Array<{ grantee: BrowserGrantee; privilege: TablePrivilege; column: string }>;
  /** `relrowsecurity`. */
  rls: boolean;
  /** A view's `security_invoker`; false for anything else. */
  securityInvoker: boolean;
  /** Grantees a permissive SELECT (or ALL) policy reaches with `USING (true)`. */
  openReadFor: BrowserGrantee[];
  /** Grantees a restrictive SELECT (or ALL) policy narrows. */
  restrictedReadFor: BrowserGrantee[];
};

/** One side's catalogue: its relations, and whether its server has MAINTAIN. */
export type RelationAclReading = { relations: RelationAcl[]; maintain: boolean };

const PRIVILEGE_SET = new Set<string>(TABLE_PRIVILEGES);

/** A privilege list as the catalogue answers it (`'SELECT,TRIGGER'`, an array, or nothing), in TABLE_PRIVILEGES order. */
export function parseTablePrivileges(value: unknown): TablePrivilege[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? value.split(",")
      : [];
  const seen = new Set<string>();
  for (const v of raw) {
    const t = v.trim().toUpperCase();
    // A name this does not know is dropped, never carried: nothing here is
    // ever interpolated, and the report only speaks of the eight it knows.
    if (PRIVILEGE_SET.has(t)) seen.add(t);
  }
  return TABLE_PRIVILEGES.filter((p) => seen.has(p));
}

function parseGrantee(value: unknown): BrowserGrantee | null {
  const t = String(value ?? "")
    .trim()
    .replace(/^"|"$/g, "");
  if (t.toLowerCase() === "public") return "PUBLIC";
  return t === "anon" || t === "authenticated" ? t : null;
}

function parseGrantees(value: unknown): BrowserGrantee[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = new Set<BrowserGrantee>();
  for (const v of raw) {
    const g = parseGrantee(v);
    if (g) out.add(g);
  }
  return [...out].sort();
}

function parseColumnGrants(value: unknown): RelationAcl["columnGrants"] {
  let items: unknown = value;
  if (typeof value === "string") {
    try {
      items = JSON.parse(value);
    } catch {
      items = [];
    }
  }
  if (!Array.isArray(items)) return [];
  const out = new Map<string, RelationAcl["columnGrants"][number]>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const grantee = parseGrantee(row.grantee);
    const [privilege] = parseTablePrivileges([row.privilege]);
    const column = typeof row.column === "string" ? row.column : "";
    if (!grantee || !privilege || !column) continue;
    out.set(`${grantee}|${privilege}|${column}`, { grantee, privilege, column });
  }
  return [...out.values()].sort(
    (a, b) =>
      a.column.localeCompare(b.column) ||
      a.grantee.localeCompare(b.grantee) ||
      a.privilege.localeCompare(b.privilege),
  );
}

const truthy = (v: unknown) => v === true || v === "true" || v === "t";

/**
 * The relation-ACL statement's rows, as `runSqlOnProject` hands them back:
 * comma lists, `jsonb` already parsed (or as text), booleans (or their text).
 *
 * MAINTAIN is said to exist only when every row says so. An unrecognised
 * answer therefore drops it from the comparison rather than reporting it.
 */
export function toRelationAcls(rows: ReadonlyArray<Record<string, unknown>>): RelationAclReading {
  const relations: RelationAcl[] = [];
  let maintain = rows.length > 0;
  for (const r of rows) {
    const relation = typeof r.relation === "string" ? r.relation : "";
    if (!relation) continue;
    if (!truthy(r.maintain)) maintain = false;
    relations.push({
      relation,
      kind: String(r.kind ?? ""),
      grants: {
        anon: parseTablePrivileges(r.anon),
        authenticated: parseTablePrivileges(r.authenticated),
        PUBLIC: parseTablePrivileges(r.public),
      },
      columnGrants: parseColumnGrants(r.column_grants),
      rls: truthy(r.rls),
      securityInvoker: parseViewOptions(r.options).get("security_invoker") === "true",
      openReadFor: parseGrantees(r.open_read),
      restrictedReadFor: parseGrantees(r.restricted_read),
    });
  }
  return { relations, maintain: maintain && relations.length > 0 };
}

// ─── The comparison ──────────────────────────────────────────────────

export type SurplusSeverity = "write" | "open_read" | "read" | "other";

/** Worst first. */
export const SEVERITY_ORDER: readonly SurplusSeverity[] = ["write", "open_read", "read", "other"];

export type SurplusEntry = {
  relation: string;
  kind: string;
  severity: SurplusSeverity;
  /** What each browser role holds here and the prime's does not, in TABLE_PRIVILEGES order. */
  surplus: Record<BrowserRole, TablePrivilege[]>;
  /** Roles whose surplus SELECT nothing but privileges guard. */
  openRead: BrowserRole[];
  /** Of the surplus, what the clone grants only through PUBLIC. */
  viaPublic: TablePrivilege[];
  /**
   * Column grants the PRIME gives a role a privilege on, where that role holds
   * the same privilege as a table-level surplus here. A table-level REVOKE
   * would take them with it, so an enforcement must keep them.
   */
  columnGrantsToKeep: string[];
};

export type TableGrantComparison = {
  /** Relations both sides hold. */
  compared: number;
  /** Relations only the clone holds: a variant's own, ignored. */
  cloneOnly: number;
  /** Relations only the prime holds: not on the clone yet, ignored. */
  primeOnly: number;
  maintainCompared: boolean;
  /** Every relation with a table-level surplus, worst first. */
  entries: SurplusEntry[];
  /**
   * Column-level grants the clone gives a browser role and the prime does not
   * (`public.t(col) anon UPDATE`), their own list and never in `entries`.
   */
  columnSurplus: string[];
};

const isWrite = (p: TablePrivilege) => WRITE_PRIVILEGES.includes(p);

/** Whether a role's SELECT here is guarded by nothing but its privileges. */
function readIsOpen(rel: RelationAcl, role: BrowserRole): boolean {
  switch (rel.kind) {
    case "m":
    case "f":
      // RLS cannot be enabled on a materialised view or a foreign table.
      return true;
    case "v":
      // Without security_invoker a view reads its tables as its owner, past
      // every policy on them (`routinePrivileges.pure.ts`).
      return !rel.securityInvoker;
    default: {
      if (!rel.rls) return true;
      const reaches = (gs: readonly BrowserGrantee[]) => gs.includes(role) || gs.includes("PUBLIC");
      return reaches(rel.openReadFor) && !reaches(rel.restrictedReadFor);
    }
  }
}

function severityOf(surplus: Record<BrowserRole, TablePrivilege[]>, openRead: BrowserRole[]) {
  const all = BROWSER_ROLES.flatMap((r) => surplus[r]);
  if (all.some(isWrite)) return "write" as const;
  if (openRead.length) return "open_read" as const;
  if (all.includes("SELECT")) return "read" as const;
  return "other" as const;
}

/** Whether `anon` itself carries the entry's worst class, which ranks it ahead of `authenticated`. */
function anonCarriesWorst(e: SurplusEntry): boolean {
  const anon = e.surplus.anon;
  switch (e.severity) {
    case "write":
      return anon.some(isWrite);
    case "open_read":
      return e.openRead.includes("anon");
    case "read":
      return anon.includes("SELECT");
    default:
      return anon.length > 0;
  }
}

const surplusCount = (e: SurplusEntry) =>
  BROWSER_ROLES.reduce((n, r) => n + e.surplus[r].length, 0);

export function compareTableGrants(input: {
  prime: readonly RelationAcl[];
  clone: readonly RelationAcl[];
  /** Both servers have MAINTAIN (rule 5). */
  maintainOnBoth: boolean;
}): TableGrantComparison {
  const primeBy = new Map(input.prime.map((r) => [r.relation, r]));
  const cloneNames = new Set(input.clone.map((r) => r.relation));
  const keep = (ps: readonly TablePrivilege[]) =>
    input.maintainOnBoth ? [...ps] : ps.filter((p) => p !== "MAINTAIN");

  let compared = 0;
  let cloneOnly = 0;
  const entries: SurplusEntry[] = [];
  const columnSurplus: string[] = [];

  for (const c of [...input.clone].sort((a, b) => a.relation.localeCompare(b.relation))) {
    const p = primeBy.get(c.relation);
    if (!p) {
      cloneOnly += 1;
      continue;
    }
    compared += 1;

    const surplus = { anon: [], authenticated: [] } as Record<BrowserRole, TablePrivilege[]>;
    const viaPublic = new Set<TablePrivilege>();
    const columnGrantsToKeep: string[] = [];
    const primeHeld = {} as Record<BrowserRole, Set<TablePrivilege>>;

    for (const role of BROWSER_ROLES) {
      const primeHas = new Set(keep([...p.grants[role], ...p.grants.PUBLIC]));
      primeHeld[role] = primeHas;
      const direct = new Set(keep(c.grants[role]));
      const viaPub = new Set(keep(c.grants.PUBLIC));
      surplus[role] = TABLE_PRIVILEGES.filter(
        (x) => (direct.has(x) || viaPub.has(x)) && !primeHas.has(x),
      );
      for (const x of surplus[role]) {
        if (!direct.has(x)) viaPublic.add(x);
        const columns = p.columnGrants
          .filter((g) => g.privilege === x && (g.grantee === role || g.grantee === "PUBLIC"))
          .map((g) => g.column);
        if (columns.length) {
          columnGrantsToKeep.push(`${role} ${x} (${[...new Set(columns)].sort().join(", ")})`);
        }
      }
    }

    // Column grants, apart (rule 4). One the clone gives is a surplus only
    // where the prime gives that role the privilege neither on the column nor
    // on the whole table.
    for (const g of c.columnGrants) {
      const roles: readonly BrowserRole[] = g.grantee === "PUBLIC" ? BROWSER_ROLES : [g.grantee];
      for (const role of roles) {
        if (primeHeld[role].has(g.privilege)) continue;
        const primeGrantsColumn = p.columnGrants.some(
          (pg) =>
            pg.column === g.column &&
            pg.privilege === g.privilege &&
            (pg.grantee === role || pg.grantee === "PUBLIC"),
        );
        if (!primeGrantsColumn)
          columnSurplus.push(`${c.relation}(${g.column}) ${role} ${g.privilege}`);
      }
    }

    if (BROWSER_ROLES.every((r) => surplus[r].length === 0)) continue;
    const openRead = BROWSER_ROLES.filter((r) => surplus[r].includes("SELECT") && readIsOpen(c, r));
    entries.push({
      relation: c.relation,
      kind: c.kind,
      severity: severityOf(surplus, openRead),
      surplus,
      openRead,
      viaPublic: TABLE_PRIVILEGES.filter((x) => viaPublic.has(x)),
      columnGrantsToKeep,
    });
  }

  // Within a class, a relation whose rows nothing but privileges guard comes
  // first. Measured 28 Oct 2026, 110 of NPC Test's 190 relations with a
  // surplus hold all sixteen privileges, so without this the capped list was
  // ten of those in alphabetical order, and `finance_agent_contacts`, bank
  // details under a `TO public USING (true)` policy, was not on it.
  const openRank = (e: SurplusEntry) =>
    e.openRead.includes("anon") ? 0 : e.openRead.length > 0 ? 1 : 2;
  entries.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      openRank(a) - openRank(b) ||
      Number(anonCarriesWorst(b)) - Number(anonCarriesWorst(a)) ||
      surplusCount(b) - surplusCount(a) ||
      a.relation.localeCompare(b.relation),
  );

  return {
    compared,
    cloneOnly,
    primeOnly: input.prime.filter((r) => !cloneNames.has(r.relation)).length,
    maintainCompared: input.maintainOnBoth,
    entries,
    columnSurplus: [...new Set(columnSurplus)].sort(),
  };
}

/**
 * The comparison, order-independent: the same surplus reads the same however
 * either catalogue happened to list it. The empty string when there is none,
 * so "nothing differs" is a value a reader can compare against rather than an
 * absence to special-case.
 */
export function tableGrantFingerprint(
  c: Pick<TableGrantComparison, "entries" | "columnSurplus">,
): string {
  const lines = [
    ...c.entries.flatMap((e) =>
      BROWSER_ROLES.flatMap((r) => e.surplus[r].map((x) => `${e.relation} ${r} ${x}`)),
    ),
    ...c.columnSurplus.map((s) => `column ${s}`),
  ].sort();
  if (lines.length === 0) return "";
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ─── What a report carries ───────────────────────────────────────────

/** How many relations a report names. The counts always cover all of them. */
export const WORST_RELATIONS_CAP = 10;

export type WorstRelation = {
  relation: string;
  kind: string;
  severity: SurplusSeverity;
  /** Surplus privileges, comma-separated, writes first. */
  anon?: string;
  authenticated?: string;
  openRead?: BrowserRole[];
  viaPublic?: string;
  columnGrantsToKeep?: string[];
};

export type TableGrantSummary = {
  compared: number;
  cloneOnly: number;
  primeOnly: number;
  maintainCompared: boolean;
  /** Surplus privileges, each counted once per relation and role. */
  surplus: number;
  /** Relations holding any. */
  relations: number;
  byRole: Record<BrowserRole, number>;
  byPrivilege: Partial<Record<TablePrivilege, number>>;
  /** Relations in each class, by the worst thing each holds. */
  bySeverity: Record<SurplusSeverity, number>;
  /** Column-level surplus, counted apart from `surplus` (rule 4). */
  columnSurplus: number;
  /** The worst relations, capped at WORST_RELATIONS_CAP. */
  worst: WorstRelation[];
  /** Relations with a surplus that `worst` does not name. */
  unlisted: number;
  /** Up to WORST_RELATIONS_CAP of the column-level surplus. */
  columnSample: string[];
  fingerprint: string;
};

export function summariseTableGrants(
  c: TableGrantComparison,
  cap: number = WORST_RELATIONS_CAP,
): TableGrantSummary {
  const byRole = { anon: 0, authenticated: 0 } as Record<BrowserRole, number>;
  const byPrivilege: Partial<Record<TablePrivilege, number>> = {};
  const bySeverity = { write: 0, open_read: 0, read: 0, other: 0 } as Record<
    SurplusSeverity,
    number
  >;
  for (const e of c.entries) {
    bySeverity[e.severity] += 1;
    for (const r of BROWSER_ROLES) {
      byRole[r] += e.surplus[r].length;
      for (const x of e.surplus[r]) byPrivilege[x] = (byPrivilege[x] ?? 0) + 1;
    }
  }
  const limit = Math.max(0, cap);
  const worst = c.entries.slice(0, limit).map((e) => {
    const w: WorstRelation = { relation: e.relation, kind: e.kind, severity: e.severity };
    if (e.surplus.anon.length) w.anon = e.surplus.anon.join(",");
    if (e.surplus.authenticated.length) w.authenticated = e.surplus.authenticated.join(",");
    if (e.openRead.length) w.openRead = e.openRead;
    if (e.viaPublic.length) w.viaPublic = e.viaPublic.join(",");
    if (e.columnGrantsToKeep.length) w.columnGrantsToKeep = e.columnGrantsToKeep;
    return w;
  });
  return {
    compared: c.compared,
    cloneOnly: c.cloneOnly,
    primeOnly: c.primeOnly,
    maintainCompared: c.maintainCompared,
    surplus: byRole.anon + byRole.authenticated,
    relations: c.entries.length,
    byRole,
    byPrivilege,
    bySeverity,
    columnSurplus: c.columnSurplus.length,
    worst,
    unlisted: Math.max(0, c.entries.length - worst.length),
    columnSample: c.columnSurplus.slice(0, limit),
    fingerprint: tableGrantFingerprint(c),
  };
}

// ─── Telling a person ────────────────────────────────────────────────

/**
 * `metadata.source` on the notice, and the audit action that records each one
 * delivered, which is how the sweep finds the last one it raised.
 */
export const TABLE_GRANT_NOTICE_SOURCE = "clone_table_privileges";

export type TableGrantNoticeDecision =
  | { notify: false; why: string }
  | { notify: true; kind: "surplus" | "cleared"; fingerprint: string };

/**
 * Whether this pass's reading is worth interrupting somebody for.
 *
 * `previous` is the fingerprint on the last notice raised for this clone, or
 * null when none ever was. A notice is raised when the surplus CHANGES, never
 * once a half hour for the same unfixed thing, and a clearance is raised too:
 * it tells whoever reads the first notice that it is closed, and it is the
 * record that makes the same surplus coming back a change again.
 *
 * A clone this pass did not read (`current` null) changes nothing. Reading a
 * failure as "no surplus" would announce a clearance the catalogue never
 * showed.
 */
export function decideTableGrantNotice(input: {
  previous: string | null;
  current: { fingerprint: string } | null;
}): TableGrantNoticeDecision {
  if (!input.current) {
    return { notify: false, why: "not read this pass, so nothing is known to have changed" };
  }
  const fingerprint = input.current.fingerprint;
  if (fingerprint === (input.previous ?? "")) {
    return { notify: false, why: "the same as the last notice raised for this clone" };
  }
  return fingerprint === ""
    ? { notify: true, kind: "cleared", fingerprint }
    : { notify: true, kind: "surplus", fingerprint };
}

const KIND_NOUN: Record<string, string> = {
  r: "table",
  p: "partitioned table",
  v: "view",
  m: "materialised view",
  f: "foreign table",
};

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-AU")} ${n === 1 ? one : many}`;

/** The notice's words. Named in full, because nothing else on the page says which relation. */
export function describeTableGrantNotice(
  cloneName: string,
  summary: TableGrantSummary,
  kind: "surplus" | "cleared",
): { title: string; body: string; severity: "warning" | "success" } {
  if (kind === "cleared") {
    return {
      severity: "success",
      title: `${cloneName}: browser roles hold no table privilege the prime does not`,
      body:
        `The sweep compared ${plural(summary.compared, "relation")} in public with the prime's ` +
        "live ACLs and found no difference. The surplus announced before is gone.",
    };
  }
  const lines = summary.worst.map((w) => {
    const held = BROWSER_ROLES.filter((r) => w[r])
      .map((r) => `${r} ${w[r]!.replace(/,/g, ", ")}`)
      .join("; ");
    const open = w.openRead?.length
      ? ` (read guarded by privileges alone for ${w.openRead.join(", ")})`
      : "";
    const keepCols = w.columnGrantsToKeep?.length
      ? ` (the prime's column grants ${w.columnGrantsToKeep.join("; ")} would go with a table-level revoke)`
      : "";
    return `- ${w.relation}, ${KIND_NOUN[w.kind] ?? w.kind}: ${held}${open}${keepCols}`;
  });
  if (summary.unlisted > 0) lines.push(`- and ${plural(summary.unlisted, "more relation")}`);
  const columns =
    summary.columnSurplus > 0
      ? ` It also gives ${plural(summary.columnSurplus, "column grant")} the prime does not.`
      : "";
  return {
    severity: "warning",
    title:
      `${cloneName}: browser roles hold ${plural(summary.surplus, "table privilege")} ` +
      `the prime does not, on ${plural(summary.relations, "relation")}`,
    body:
      `Compared with the prime's live ACLs on ${plural(summary.compared, "relation")} both hold: ` +
      `anon ${summary.byRole.anon.toLocaleString("en-AU")}, ` +
      `authenticated ${summary.byRole.authenticated.toLocaleString("en-AU")}.${columns} ` +
      "Report only: nothing was revoked, and nothing will be until the owner has reviewed " +
      "a week of these.\n\nWorst first:\n" +
      lines.join("\n"),
  };
}
