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
 * It reaches the clones in two steps, `TABLE_GRANT_ENFORCEMENT`: the demo
 * first, which holds no client's data, and every clone once the demo reads
 * back clean. Until a clone is in scope its report lists what would be taken
 * back, so the widening is reviewed against the list rather than a count.
 *
 * ## What is taken back, and what is kept
 *
 * Exactly the comparison's surplus (`compareTableGrants`), and nothing else:
 *
 *   - a privilege a browser role holds directly and the prime's does not, by
 *     `REVOKE … FROM anon` or `authenticated`;
 *   - one the clone grants PUBLIC and the prime does not, by
 *     `REVOKE … FROM PUBLIC`: the prime grants PUBLIC none of them, so no role
 *     loses there what it holds on the prime. Where the prime gives a browser
 *     role that privilege directly and the clone gave it only through PUBLIC,
 *     it is granted directly, as the prime grants it;
 *   - a table-level REVOKE takes the grantee's column grants of that privilege
 *     with it, so the prime's are granted back on their columns
 *     (`template_comments` gives `authenticated` UPDATE on three columns on
 *     every project). A column grant the clone held and the prime does not is
 *     gone with it, and recorded as removed.
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
 * Every relation's plan carries the grants that undo it (`inverse`), and the
 * sweep files them in the audit log before it may be called done.
 *
 * Pure: no network, no database.
 */

/** Which clones the sweep takes the surplus back on. */
export type TableGrantEnforcementScope = "off" | "demo" | "all";

/**
 * The demo first (31 Oct 2026). `all` once the demo's report reads no
 * surplus after a pass, which is what widening is checked against.
 */
export const TABLE_GRANT_ENFORCEMENT: TableGrantEnforcementScope = "demo";

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
  /** The prime's column grants a table-level revoke removes, granted back. */
  regrantColumns: Array<{ grantee: BrowserGrantee; privilege: TablePrivilege; columns: string[] }>;
  /** Column grants the clone held, the revoke removes, and the prime does not give. */
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

    const regrantColumns: RelationRevoke["regrantColumns"] = [];
    const removedColumnGrants: RelationRevoke["removedColumnGrants"] = [];
    for (const grantee of [...BROWSER_ROLES, "PUBLIC"] as const) {
      for (const x of revoke[grantee]) {
        const primeCols = [
          ...new Set(
            p.columnGrants
              .filter((g) => g.grantee === grantee && g.privilege === x)
              .map((g) => g.column),
          ),
        ].sort();
        if (primeCols.length) regrantColumns.push({ grantee, privilege: x, columns: primeCols });
        for (const g of c.columnGrants) {
          if (g.grantee === grantee && g.privilege === x && !primeCols.includes(g.column)) {
            removedColumnGrants.push({ grantee, privilege: x, column: g.column });
          }
        }
      }
    }

    const lines: string[] = [];
    for (const grantee of [...BROWSER_ROLES, "PUBLIC"] as const) {
      if (revoke[grantee].length) {
        lines.push(
          `revoke ${revoke[grantee].join(", ")} on ${e.relation} from ${granteeSql(grantee)};`,
        );
      }
    }
    for (const g of grantDirect) {
      lines.push(`grant ${g.privileges.join(", ")} on ${e.relation} to ${granteeSql(g.grantee)};`);
    }
    for (const g of regrantColumns) {
      lines.push(
        `grant ${g.privilege} (${g.columns.map(quoteColumn).join(", ")}) on ${e.relation} to ${granteeSql(g.grantee)};`,
      );
    }
    if (lines.length === 0) continue;

    const body = lines.map((l) => `  ${l}`).join("\n");
    const tag = dollarTag("table_grants", [body]);
    const statement = `do ${tag}\nbegin\n${body}\nend\n${tag}`;

    // Undoing it: the revoked privileges back, then the clone's own column
    // grants the revoke took. A direct grant made for a PUBLIC one is taken
    // back last, so the relation ends as it began.
    const inverse: string[] = [];
    for (const grantee of [...BROWSER_ROLES, "PUBLIC"] as const) {
      if (revoke[grantee].length) {
        inverse.push(
          `grant ${revoke[grantee].join(", ")} on ${e.relation} to ${granteeSql(grantee)};`,
        );
      }
    }
    for (const g of removedColumnGrants) {
      inverse.push(
        `grant ${g.privilege} (${quoteColumn(g.column)}) on ${e.relation} to ${granteeSql(g.grantee)};`,
      );
    }
    for (const g of grantDirect) {
      inverse.push(
        `revoke ${g.privileges.join(", ")} on ${e.relation} from ${granteeSql(g.grantee)};`,
      );
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
 * A clone's surplus as lines a person reviews before the scope widens to it:
 * `public.t: anon INSERT, UPDATE; authenticated DELETE`.
 */
export function surplusLines(entries: readonly SurplusEntry[]): string[] {
  return entries.map((e) => {
    const held = BROWSER_ROLES.filter((r) => e.surplus[r].length)
      .map((r) => `${r} ${e.surplus[r].join(", ")}`)
      .join("; ");
    return `${e.relation}: ${held}`;
  });
}
