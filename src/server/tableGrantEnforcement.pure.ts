import { demoCloneRefusal } from "./demoClone.pure";
import { dollarTag } from "./migrationEffectProbe.pure";
import {
  BROWSER_ROLES,
  TABLE_GRANT_SCHEMA,
  TABLE_PRIVILEGES,
  type BrowserGrantee,
  type RelationAcl,
  type SurplusEntry,
  type TablePrivilege,
} from "./tablePrivileges.pure";

/**
 * Taking back the table privileges a clone gives its browser roles and the
 * prime does not.
 *
 * ## The decision
 *
 * The sweep compared and reported for three days under the owner's
 * "Sweep tables, report first" (28 Oct 2026). On 31 Oct 2026 the owner chose
 * "Build enforcement, all clones": "Build it and revoke the excess on all five
 * clones to match the prime. This changes live customer databases."
 * Measured that morning by the sweep: 991 surplus privileges on 65 relations
 * on each of three clones, 1,198 on 78 on NPC CRM Independent, and 2,143 on
 * 139 on the tutorial demo, where `anon` held every privilege on `mh_audit`,
 * `mh_messages` and `client_fact_finds` and the prime grants it none.
 *
 * It reached the clones in two steps, `TABLE_GRANT_ENFORCEMENT`: the demo
 * first, which holds no client's data (#472), and every clone once the demo
 * read back clean. The demo's first pass, at 13:37 UTC on 31 Oct 2026, took
 * back 2,143 privileges on 139 relations in one transaction, none failed.
 * Read at 14:27, its browser roles' table and column grants were identical
 * to the prime's, fingerprint for fingerprint. Each other clone's report had
 * listed what its pass would take back (`wouldRevoke`): the same 65 relations
 * on NPC Client Dashboard, NPC Test and Preflight, those and 13 more on NPC
 * CRM Independent, with no PUBLIC revoke and no refusal on any of them. A
 * scope short of `all` still lists, so a future narrowing is reviewed the
 * same way.
 *
 * ## What is taken back, and what is kept
 *
 * Exactly the comparison's surplus (`compareTableGrants`), and nothing else:
 *
 *   - a privilege a browser role holds directly and the prime's does not, by
 *     `REVOKE … FROM anon` or `authenticated`;
 *   - one the clone grants PUBLIC and the prime does not, by
 *     `REVOKE … FROM PUBLIC`: the prime grants PUBLIC none of them at table
 *     level. Where the prime gives a browser role that privilege directly and
 *     the clone gave it only through PUBLIC, it is granted directly, as the
 *     prime grants it. A role outside the browser roles that held it only
 *     through PUBLIC loses it; the demo grants PUBLIC nothing on any relation
 *     (read 31 Oct 2026), and a clone's list (`revokeLines`) names each
 *     PUBLIC revoke before the scope widens to it;
 *   - columns, which a role can lose three ways: a table-level REVOKE takes
 *     the grantee's column grants of that privilege with it; a role held the
 *     privilege through PUBLIC's; or the prime gives a role a column through
 *     PUBLIC where the clone gave it the whole table on its own. So the
 *     grantee's column grants the prime gives it are granted back, PUBLIC's
 *     included, and then each browser role is granted, on its own, any column
 *     it held here, the prime gives it, and it would otherwise lose
 *     (`template_comments` gives `authenticated` UPDATE on three columns on
 *     every project). Every column granted is one its grantee held before, so
 *     nobody gains one. A column grant a revoke takes that neither rule grants
 *     again is gone, and recorded as removed.
 *
 * MAINTAIN only where both servers have it, `service_role` never (it is the
 * backend's own key), and only relations both sides hold: one only the clone
 * holds is a variant's own.
 *
 * ## One statement a relation
 *
 * Each relation's revokes and grants are one `do` block, which the batch
 * applier runs in a subtransaction of its own. A grant back can therefore
 * never be missing while its revoke stands. The plan is re-derived from both
 * catalogues on every pass, so a pass the budget stops loses nothing.
 *
 * ## Reversible
 *
 * Every relation's plan carries the statements that undo it exactly
 * (`inverse`), column grants included, and the sweep files them in the audit
 * log before it may be called done.
 *
 * Pure: no network, no database.
 */

/** Which clones the sweep takes the surplus back on. */
export type TableGrantEnforcementScope = "off" | "demo" | "all";

/**
 * Every clone (31 Oct 2026), after the demo, first under `demo` (#472), read
 * back identical to the prime and each other clone's `wouldRevoke` list was
 * reviewed (the header above).
 */
export const TABLE_GRANT_ENFORCEMENT: TableGrantEnforcementScope = "all";

/** What the sweep needs to know of a clone to decide. */
export type EnforcementCandidate = {
  billing_stripe_customer_id: string | null;
  entitled_plan_slug: string | null;
  tags: readonly string[] | null;
};

/**
 * Whether a clone's surplus is taken back this pass.
 *
 * At `demo`, a clone is in scope only when the shared rule says it is a demo
 * (`demoCloneRefusal`): tagged `demo`, with no Stripe customer and no plan.
 * A clone whose record could not be read is out of scope: deciding to write
 * on a guess is the one direction this must never fail in.
 */
export function enforcesTableGrants(
  scope: TableGrantEnforcementScope,
  clone: EnforcementCandidate | null,
): boolean {
  if (scope === "all") return true;
  if (scope === "off" || !clone) return false;
  return demoCloneRefusal(clone) === null;
}

/** Every grantee a statement here names, in the order its lines are written. */
const GRANTEES: readonly BrowserGrantee[] = [...BROWSER_ROLES, "PUBLIC"];

/** A grantee as SQL: `PUBLIC` is a keyword, the roles are bare identifiers. */
const granteeSql = (g: BrowserGrantee) => (g === "PUBLIC" ? "public" : g);

/** A column name as SQL, always quoted. */
const quoteColumn = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * A relation as the catalogue rendered it (`quote_ident` on both parts), in the
 * one schema compared. Anything else is refused rather than interpolated.
 */
const RELATION_SHAPE = new RegExp(`^${TABLE_GRANT_SCHEMA}\\.(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")$`);

export type RelationRevoke = {
  relation: string;
  /** Taken back at table level, per grantee, in TABLE_PRIVILEGES order. */
  revoke: Record<BrowserGrantee, TablePrivilege[]>;
  /** Granted directly because the prime grants it so and PUBLIC carried it here. */
  grantDirect: Array<{ grantee: BrowserGrantee; privileges: TablePrivilege[] }>;
  /**
   * Column grants made after the revokes, so no role loses a column it held
   * here and the prime gives it: per grantee and privilege, in GRANTEES and
   * TABLE_PRIVILEGES order.
   */
  regrantColumns: Array<{ grantee: BrowserGrantee; privilege: TablePrivilege; columns: string[] }>;
  /** Column grants the clone held that the revokes take and nothing grants again. */
  removedColumnGrants: Array<{
    grantee: BrowserGrantee;
    privilege: TablePrivilege;
    column: string;
  }>;
  /** The one statement that does all of it. */
  statement: string;
  /** The grants that put back what this takes, in the order to run them. */
  inverse: string[];
};

export type TableGrantRevokePlan = {
  relations: RelationRevoke[];
  /** Table-level privileges taken back, each counted once per relation and grantee. */
  privileges: number;
  /** Relations the plan would not write for, and why. */
  refused: Array<{ relation: string; why: string }>;
};

const ordered = (ps: Iterable<TablePrivilege>) => {
  const s = new Set(ps);
  return TABLE_PRIVILEGES.filter((p) => s.has(p));
};

/**
 * The statements that take a clone's surplus back, worst first, from the
 * comparison and both readings it was made from.
 */
export function planTableGrantRevokes(input: {
  entries: readonly SurplusEntry[];
  prime: readonly RelationAcl[];
  clone: readonly RelationAcl[];
  maintainOnBoth: boolean;
}): TableGrantRevokePlan {
  const primeBy = new Map(input.prime.map((r) => [r.relation, r]));
  const cloneBy = new Map(input.clone.map((r) => [r.relation, r]));
  const keep = (ps: readonly TablePrivilege[]) =>
    input.maintainOnBoth ? [...ps] : ps.filter((p) => p !== "MAINTAIN");

  const plan: TableGrantRevokePlan = { relations: [], privileges: 0, refused: [] };
  for (const e of input.entries) {
    const p = primeBy.get(e.relation);
    const c = cloneBy.get(e.relation);
    if (!p || !c) {
      plan.refused.push({ relation: e.relation, why: "not held on both sides" });
      continue;
    }
    if (!RELATION_SHAPE.test(e.relation)) {
      plan.refused.push({ relation: e.relation, why: "not a relation name the catalogue renders" });
      continue;
    }

    const surplusAny = new Set(BROWSER_ROLES.flatMap((r) => e.surplus[r]));
    const revoke = { anon: [], authenticated: [], PUBLIC: [] } as Record<
      BrowserGrantee,
      TablePrivilege[]
    >;
    for (const role of BROWSER_ROLES) {
      const direct = new Set(keep(c.grants[role]));
      revoke[role] = e.surplus[role].filter((x) => direct.has(x));
    }
    // A privilege the clone grants PUBLIC is surplus for a browser role only
    // where the prime grants it neither PUBLIC nor that role (rule 2 of the
    // comparison), so the prime grants PUBLIC none of these.
    const publicHeld = new Set(keep(c.grants.PUBLIC));
    revoke.PUBLIC = ordered([...surplusAny].filter((x) => publicHeld.has(x)));

    // What a browser role keeps on the prime and held here only through PUBLIC.
    const grantDirect: RelationRevoke["grantDirect"] = [];
    for (const role of BROWSER_ROLES) {
      const primeDirect = new Set(keep(p.grants[role]));
      const cloneDirect = new Set(keep(c.grants[role]));
      const lose = revoke.PUBLIC.filter((x) => primeDirect.has(x) && !cloneDirect.has(x));
      if (lose.length) grantDirect.push({ grantee: role, privileges: lose });
    }

    // Column grants, which `attacl` holds apart from the table's ACL. A role
    // can lose a column the prime gives it three ways here: its own
    // table-level grant is revoked, which takes its column grants of that
    // privilege too; PUBLIC's is, which it held the privilege through; or the
    // prime gives it the column through PUBLIC and the clone gave it the
    // whole table on its own. So, per privilege a revoke touches:
    //   1. a grantee whose table-level privilege is revoked is granted back
    //      the column grants the prime gives that grantee, PUBLIC included,
    //      so a role outside the browser roles keeps what PUBLIC gives it;
    //   2. then each browser role is granted, on its own, every column it
    //      held here, the prime gives it (itself or through PUBLIC), and it
    //      would otherwise no longer hold.
    // Each column granted is one its grantee held before, through the
    // table-level grant revoked, so nobody gains a column (Codex on #472).
    const touched = ordered([...BROWSER_ROLES.flatMap((r) => revoke[r]), ...revoke.PUBLIC]);
    const columnsOf = (acl: RelationAcl, grantee: BrowserGrantee, x: TablePrivilege) =>
      [
        ...new Set(
          acl.columnGrants
            .filter((g) => g.grantee === grantee && g.privilege === x)
            .map((g) => g.column),
        ),
      ].sort();
    const columnKey = (g: BrowserGrantee, x: TablePrivilege) => `${g}|${x}`;
    // Each grantee's own column grants of each touched privilege, before and after.
    const heldBefore = new Map<string, string[]>();
    const heldAfter = new Map<string, Set<string>>();
    for (const x of touched) {
      for (const g of GRANTEES) {
        const had = columnsOf(c, g, x);
        heldBefore.set(columnKey(g, x), had);
        heldAfter.set(columnKey(g, x), new Set(revoke[g].includes(x) ? columnsOf(p, g, x) : had));
      }
      for (const role of BROWSER_ROLES) {
        const tableBefore = c.grants[role].includes(x) || c.grants.PUBLIC.includes(x);
        const tableAfter =
          (c.grants[role].includes(x) && !revoke[role].includes(x)) ||
          (c.grants.PUBLIC.includes(x) && !revoke.PUBLIC.includes(x)) ||
          grantDirect.some((d) => d.grantee === role && d.privileges.includes(x));
        if (tableAfter) continue;
        const own = heldAfter.get(columnKey(role, x))!;
        const viaPublic = heldAfter.get(columnKey("PUBLIC", x))!;
        const ownBefore = heldBefore.get(columnKey(role, x))!;
        const publicBefore = heldBefore.get(columnKey("PUBLIC", x))!;
        const primeGives = new Set([...columnsOf(p, role, x), ...columnsOf(p, "PUBLIC", x)]);
        for (const col of [...primeGives].sort()) {
          const had = tableBefore || ownBefore.includes(col) || publicBefore.includes(col);
          if (had && !own.has(col) && !viaPublic.has(col)) own.add(col);
        }
      }
    }
    // What the statement grants on columns, what it takes for good, and what
    // it adds that the clone did not hold, which undoing takes away again.
    const regrantColumns: RelationRevoke["regrantColumns"] = [];
    const removedColumnGrants: RelationRevoke["removedColumnGrants"] = [];
    const addedColumnGrants: RelationRevoke["regrantColumns"] = [];
    for (const g of GRANTEES) {
      for (const x of touched) {
        const before = heldBefore.get(columnKey(g, x))!;
        const after = [...heldAfter.get(columnKey(g, x))!].sort();
        const granted = revoke[g].includes(x)
          ? after
          : after.filter((col) => !before.includes(col));
        if (granted.length) regrantColumns.push({ grantee: g, privilege: x, columns: granted });
        const added = after.filter((col) => !before.includes(col));
        if (added.length) addedColumnGrants.push({ grantee: g, privilege: x, columns: added });
        for (const column of before) {
          if (!after.includes(column))
            removedColumnGrants.push({ grantee: g, privilege: x, column });
        }
      }
    }

    const columnSql = (
      verb: "grant" | "revoke",
      g: BrowserGrantee,
      x: TablePrivilege,
      cols: readonly string[],
    ) =>
      `${verb} ${x} (${cols.map(quoteColumn).join(", ")}) on ${e.relation} ${verb === "grant" ? "to" : "from"} ${granteeSql(g)};`;

    const lines: string[] = [];
    for (const grantee of GRANTEES) {
      if (revoke[grantee].length) {
        lines.push(
          `revoke ${revoke[grantee].join(", ")} on ${e.relation} from ${granteeSql(grantee)};`,
        );
      }
    }
    for (const g of grantDirect) {
      lines.push(`grant ${g.privileges.join(", ")} on ${e.relation} to ${granteeSql(g.grantee)};`);
    }
    for (const g of regrantColumns)
      lines.push(columnSql("grant", g.grantee, g.privilege, g.columns));
    if (lines.length === 0) continue;

    const body = lines.map((l) => `  ${l}`).join("\n");
    const tag = dollarTag("table_grants", [body]);
    const statement = `do ${tag}\nbegin\n${body}\nend\n${tag}`;

    // Undoing it, in order: the column grants this made that the clone did
    // not hold are taken away; the table-level privileges are granted back,
    // then the column grants the revokes took. A direct grant made for a
    // PUBLIC one is taken back last, and as that revoke takes the role's
    // column grants of the privilege with it, the ones it held before are
    // granted again (Codex on #472). The relation ends as it began.
    const inverse: string[] = [];
    for (const g of addedColumnGrants) {
      inverse.push(columnSql("revoke", g.grantee, g.privilege, g.columns));
    }
    for (const grantee of GRANTEES) {
      if (revoke[grantee].length) {
        inverse.push(
          `grant ${revoke[grantee].join(", ")} on ${e.relation} to ${granteeSql(grantee)};`,
        );
      }
    }
    for (const g of GRANTEES) {
      for (const x of touched) {
        const cols = removedColumnGrants
          .filter((r) => r.grantee === g && r.privilege === x)
          .map((r) => r.column);
        if (cols.length) inverse.push(columnSql("grant", g, x, cols));
      }
    }
    for (const d of grantDirect) {
      inverse.push(
        `revoke ${d.privileges.join(", ")} on ${e.relation} from ${granteeSql(d.grantee)};`,
      );
      for (const x of d.privileges) {
        const cols = heldBefore.get(columnKey(d.grantee, x)) ?? [];
        if (cols.length) inverse.push(columnSql("grant", d.grantee, x, cols));
      }
    }

    plan.privileges += revoke.anon.length + revoke.authenticated.length + revoke.PUBLIC.length;
    plan.relations.push({
      relation: e.relation,
      revoke,
      grantDirect,
      regrantColumns,
      removedColumnGrants,
      statement,
      inverse,
    });
  }
  return plan;
}

/**
 * What a pass would take back on a clone, as lines a person reviews before the
 * scope widens to it: `public.t: anon INSERT, UPDATE; authenticated DELETE`,
 * with `PUBLIC SELECT` where the revoke is PUBLIC's, which every role held it
 * through. Read from the plan, so it is what the statements would do, and a
 * relation the plan refused says so.
 */
export function revokeLines(plan: TableGrantRevokePlan): string[] {
  return [
    ...plan.relations.map(
      (r) =>
        `${r.relation}: ${GRANTEES.filter((g) => r.revoke[g].length)
          .map((g) => `${g} ${r.revoke[g].join(", ")}`)
          .join("; ")}`,
    ),
    ...plan.refused.map((r) => `${r.relation}: refused, ${r.why}`),
  ];
}
