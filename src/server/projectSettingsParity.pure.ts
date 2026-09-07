/**
 * The settings that live on the PROJECT rather than in the database — and why
 * parity was blind to all of them.
 *
 * ## What this closes
 *
 * Every stage of the parity report reads the database: tables, policies,
 * functions, grants, enums, triggers, constraints, indexes, matviews,
 * sequences, cron, realtime. Catalog introspection can see all of it. So a
 * clone can be reported **reconciled on twenty sections at once** while a
 * module on it is completely unreachable, because what makes it unreachable
 * is not in the database at all.
 *
 * That is exactly what happened. `aml` existed on all three clones with every
 * table, every policy and every function correct — and every `.schema('aml')`
 * call answered `Invalid schema: aml`, because the project's PostgREST
 * **exposed-schema list** did not name it. Parity said reconciled. The module
 * was dead. Both readings were accurate about what they measured, and nothing
 * measured the thing that mattered.
 *
 * The engine now replicates these settings (`replicateApiConfig`,
 * `replicateStorageConfig`), which stops a NEW clone drifting. This is the
 * other half: the report has to be able to SEE the drift, or "we fixed the
 * provisioning path" is a claim nothing can check on the clones that already
 * exist.
 *
 * ## The rules
 *
 * **A missing exposed schema is BLOCKING, and it is the only project setting
 * that is.** Blocking is reserved in this report for a shortfall that stops
 * the clone doing its job, and an unexposed schema does precisely that: every
 * request against it fails, from every caller, for ever. Grouping it with the
 * advisory readings is what let it pass unnoticed for the life of three
 * clones.
 *
 * **Extra is not a defect.** A clone exposing a schema the prime does not, or
 * allowing a larger upload than the prime, is surplus rather than shortfall —
 * the same asymmetry `replicateApiConfig` and `replicateStorageConfig` apply
 * when they refuse to narrow. It is reported and never blocks.
 *
 * **A read that FAILED is not a setting that MATCHES.** This is the rule that
 * decides whether the section is worth having. A Management API call that
 * 500s, times out or is refused for want of a token must read `unavailable`
 * — not "no difference found", which is what an unguarded diff of two nulls
 * produces, and which would recreate the exact blindness this section exists
 * to remove. `unavailable` is carried into the summary so the operator knows
 * the question was asked and not answered.
 */

export type SettingReading<T> =
  | { state: "read"; value: T | null }
  | { state: "unavailable"; error: string };

export type ProjectSettingsSnapshot = {
  /** PostgREST's `db_schema`, verbatim — a comma-separated list. */
  exposedSchemas: SettingReading<string>;
  /** The project-wide storage upload ceiling, in bytes. */
  uploadLimitBytes: SettingReading<number>;
};

export type ProjectSettingsDiff = {
  exposed_schemas: {
    prime: string[] | null;
    target: string[] | null;
    /** In the prime and not the clone. Every one is a dead module. */
    missing_in_target: string[];
    /** In the clone and not the prime. Surplus; never blocking. */
    extra_in_target: string[];
    unavailable: string | null;
  };
  upload_limit: {
    prime: number | null;
    target: number | null;
    /** True only where the clone allows LESS than the prime. */
    target_is_lower: boolean;
    unavailable: string | null;
  };
  /** Reasons this section could not be judged. Empty when it was. */
  unavailable: string[];
};

/** `"public, graphql_public, aml"` → `["public","graphql_public","aml"]`. */
export function parseSchemaList(csv: string | null | undefined): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function diffProjectSettings(
  prime: ProjectSettingsSnapshot,
  target: ProjectSettingsSnapshot,
): ProjectSettingsDiff {
  const unavailable: string[] = [];

  // ── Exposed schemas ──────────────────────────────────────────────────────
  let schemaUnavailable: string | null = null;
  if (prime.exposedSchemas.state === "unavailable") {
    schemaUnavailable = `the prime's exposed schemas could not be read (${prime.exposedSchemas.error})`;
  } else if (target.exposedSchemas.state === "unavailable") {
    schemaUnavailable = `this project's exposed schemas could not be read (${target.exposedSchemas.error})`;
  }
  if (schemaUnavailable) unavailable.push(schemaUnavailable);

  const primeSchemas = prime.exposedSchemas.state === "read" ? parseSchemaList(prime.exposedSchemas.value) : null;
  const targetSchemas =
    target.exposedSchemas.state === "read" ? parseSchemaList(target.exposedSchemas.value) : null;

  // Only a pair of real readings produces a difference. Two nulls are not a
  // match — they are two questions nobody answered.
  const comparable = primeSchemas !== null && targetSchemas !== null;
  const missing = comparable ? primeSchemas!.filter((s) => !targetSchemas!.includes(s)) : [];
  const extra = comparable ? targetSchemas!.filter((s) => !primeSchemas!.includes(s)) : [];

  // ── Project upload limit ─────────────────────────────────────────────────
  let limitUnavailable: string | null = null;
  if (prime.uploadLimitBytes.state === "unavailable") {
    limitUnavailable = `the prime's upload limit could not be read (${prime.uploadLimitBytes.error})`;
  } else if (target.uploadLimitBytes.state === "unavailable") {
    limitUnavailable = `this project's upload limit could not be read (${target.uploadLimitBytes.error})`;
  }
  if (limitUnavailable) unavailable.push(limitUnavailable);

  const primeLimit = prime.uploadLimitBytes.state === "read" ? prime.uploadLimitBytes.value : null;
  const targetLimit = target.uploadLimitBytes.state === "read" ? target.uploadLimitBytes.value : null;
  // A clone that allows MORE is not a defect — the same asymmetry
  // `replicateStorageConfig` applies when it refuses to lower a limit.
  const targetIsLower = primeLimit !== null && targetLimit !== null && targetLimit < primeLimit;

  return {
    exposed_schemas: {
      prime: primeSchemas,
      target: targetSchemas,
      missing_in_target: missing,
      extra_in_target: extra,
      unavailable: schemaUnavailable,
    },
    upload_limit: {
      prime: primeLimit,
      target: targetLimit,
      target_is_lower: targetIsLower,
      unavailable: limitUnavailable,
    },
    unavailable,
  };
}

/**
 * What this section contributes to `blocking_issues`.
 *
 * A missing exposed schema and nothing else. The upload limit is a real
 * shortfall — a bucket asking for more room than the project allows is
 * refused — but it refuses one upload, where an unexposed schema refuses an
 * entire module for ever. Blocking has to keep meaning "this clone cannot do
 * its job" or it stops being read.
 */
export function projectSettingsBlockers(diff: ProjectSettingsDiff): string[] {
  const out: string[] = [];
  if (diff.exposed_schemas.missing_in_target.length > 0) {
    out.push(`unexposed_schemas:${diff.exposed_schemas.missing_in_target.length}`);
  }
  return out;
}

/**
 * One line for the summary, or the empty string when there is nothing to say.
 *
 * An unavailable reading is stated rather than omitted: a section that goes
 * quiet when it cannot see is the failure this whole section exists to fix.
 */
export function projectSettingsSummary(diff: ProjectSettingsDiff): string {
  const parts: string[] = [];

  const missing = diff.exposed_schemas.missing_in_target;
  if (missing.length > 0) {
    // Named, not counted. "1 unexposed schema" sends nobody anywhere; `aml`
    // tells an operator which module is dead.
    parts.push(
      `schema(s) in the prime's API and NOT this project's: ${missing.join(", ")} — ` +
        `every request against them answers "Invalid schema"`,
    );
  }
  if (diff.exposed_schemas.extra_in_target.length > 0) {
    parts.push(`exposed here and not on the prime: ${diff.exposed_schemas.extra_in_target.join(", ")}`);
  }
  if (diff.upload_limit.target_is_lower) {
    parts.push(
      `upload limit ${diff.upload_limit.target} < prime's ${diff.upload_limit.prime} — ` +
        `a bucket asking for more room than that is refused`,
    );
  }
  for (const reason of diff.unavailable) parts.push(`not judged: ${reason}`);

  return parts.length > 0 ? `project settings: ${parts.join(" · ")}` : "";
}
