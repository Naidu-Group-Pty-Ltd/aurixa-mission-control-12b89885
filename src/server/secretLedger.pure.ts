/**
 * What the secrets ledger records for one write.
 *
 * `clone_backend_secrets` is what the clone's Secrets page reads ("Last
 * updated …") and what every sweep reads to decide whether a name is settled.
 * Before a write could be skipped, each caller stamped every name it had asked
 * for with `last_set_at: now` once the write succeeded — true then, because
 * everything asked for was sent. Since `secretWriteDiff.pure.ts`, a batch the
 * project already holds is not sent at all, and stamping it would tell an
 * operator a secret was set moments ago when nothing was sent.
 *
 * ## The rules
 *
 * **A failed write records every name it covered as failed**, with no set time
 * and the error — what every caller did before.
 *
 * **A name that was SENT moves `last_set_at`** (and `set_by`, where the caller
 * records one): somebody set it now.
 *
 * **A name left out because the project already held it keeps its
 * `last_set_at` and `set_by`**: nobody set it now. Its status and error ARE
 * brought up to date, because the digest has just proved the project holds the
 * value — a name that failed last pass and is held now reads as held.
 *
 * **Rows that differ in their columns never share a request.** A bulk upsert
 * writes every column any row names; a row that omits one gets it as NULL. So
 * the sent names and the held names are two batches, and the held batch names
 * no `last_set_at` at all — an existing row keeps its time, and a row seen for
 * the first time has none, which is what the ledger knows about it.
 *
 * Pure: no I/O. `secretLedger.server.ts` writes the batches.
 */

import type { SecretWriteResult } from "./secretWriteDiff.pure";

export type SecretLedgerRow = {
  clone_id: string;
  name: string;
  status: string;
  last_error: string | null;
  last_set_at?: string | null;
  set_by?: string | null;
};

export type SecretLedgerInput = {
  cloneId: string;
  /**
   * Every name the write covered. Read only when the write FAILED — a success
   * says by name what was sent and what was already held.
   */
  names: readonly string[];
  result: SecretWriteResult;
  /** What a name the project holds is recorded as: Mission Control's own value, or the prime's. */
  status: "set" | "inherited";
  /** Who set a SENT name. Omitted, the column is not written at all. */
  setBy?: string | null;
  now: string;
};

export function secretLedgerBatches(input: SecretLedgerInput): SecretLedgerRow[][] {
  const withSetBy = <T extends object>(row: T): T & { set_by?: string | null } =>
    input.setBy === undefined ? row : { ...row, set_by: input.setBy };

  if (!input.result.ok) {
    const error = input.result.error;
    const failed = input.names.map((name) =>
      withSetBy({
        clone_id: input.cloneId,
        name,
        status: "failed",
        last_set_at: null,
        last_error: error,
      }),
    );
    return failed.length > 0 ? [failed] : [];
  }

  const sent = input.result.written.map((name) =>
    withSetBy({
      clone_id: input.cloneId,
      name,
      status: input.status,
      last_set_at: input.now,
      last_error: null,
    }),
  );
  const held = input.result.unchanged.map((name) => ({
    clone_id: input.cloneId,
    name,
    status: input.status,
    last_error: null,
  }));
  return [sent, held].filter((batch) => batch.length > 0);
}
