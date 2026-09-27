/**
 * Record one secrets write in `clone_backend_secrets` — the rows
 * `secretLedger.pure.ts` decides, one upsert per batch.
 *
 * Returns the first refusal's message, or `null` when every batch was
 * recorded. Never throws: the write it records has already happened or already
 * failed, and losing the record must not change what is reported about it —
 * every caller logs the message instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { secretLedgerBatches, type SecretLedgerInput } from "./secretLedger.pure";

type Db = SupabaseClient<Database>;

export async function recordSecretLedger(
  supabase: Db,
  input: SecretLedgerInput,
): Promise<string | null> {
  for (const batch of secretLedgerBatches(input)) {
    try {
      const { error } = await supabase
        .from("clone_backend_secrets")
        .upsert(batch, { onConflict: "clone_id,name" });
      if (error) return error.message;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}
