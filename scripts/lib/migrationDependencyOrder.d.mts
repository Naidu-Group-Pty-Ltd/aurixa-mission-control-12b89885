/**
 * Types for the dependency-order analysis, so a spec importing it is checked
 * rather than silently `any`.
 *
 * It is a `.mjs` because it is a build script the CI gate runs directly under
 * Node, with no compile step — and a `.d.mts` beside it is how that stays true
 * while the spec still gets real types. Without it `tsc` raises TS7016 on any
 * deployment that has `noImplicitAny` on, which is not all of them: the gate
 * passed in one repository and failed in the next for exactly that reason.
 */

export declare const FOREIGN_SCHEMAS: Set<string>;

/** Blank comments, string literals and dollar-quoted bodies, preserving offsets. */
export declare function stripUnresolved(src: string): string;

/** `public.foo`, `"Foo"` and `foo` are one name; a real schema is kept. */
export declare function canon(raw: string): string;

export declare function schemaOf(raw: string): string | null;

export type ObjectClass =
  | "table" | "view" | "materialized_view" | "function"
  | "sequence" | "type" | "schema" | "index" | "trigger";

export interface MigrationEvent {
  kind: "create" | "drop";
  cls: ObjectClass;
  name: string;
  /** Character offset in the stripped source. */
  at: number;
}

export interface Requirement {
  name: string;
  /** The words that produced it, e.g. `alter table`, `view body reads`. */
  form: string;
  at: number;
  cls: Set<ObjectClass> | null;
}

export interface Finding {
  file: string;
  version: string | null;
  line: number;
  object: string;
  form: string;
  created_by: string | null;
  reason: string;
}

export declare function extractEvents(sql: string): MigrationEvent[];
export declare function extractRequirements(sql: string): Requirement[];
export declare function versionOf(file: string): string | null;
export declare function analyse(dir: string): { files: number; findings: Finding[] };
