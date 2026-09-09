/**
 * Give a newly provisioned clone the sync exclusion policy its own module
 * header has always claimed it gets.
 *
 * ## What was not true
 *
 * `DEFAULT_MIRROR_EXCLUSIONS` in `syncExclusions.pure.ts` says, of itself:
 * *"Seeded when a mirror is registered, and editable afterwards."* Nothing in
 * this codebase ever wrote it. Measured 9 Sep 2026 by reading every writer of
 * `clone_sync_exclusions`: the cascade engine reads it, the drift sweep reads
 * it, and the only INSERT anywhere is the one-off seed migration
 * `20260826070000_seed_mirror_exclusions.sql`, which targets the mirrors that
 * existed the day it ran.
 *
 * Two things follow, and both are live.
 *
 * **A clone provisioned today has an empty policy.** `assertMirrorPolicy`
 * refuses a mirror in that state, so the moment anybody moves a clone to
 * `sync_scope: 'mirror'` — in the UI, in a migration, in a repair — every
 * cascade to it throws `MissingExclusionPolicyError` and the clone silently
 * stops syncing until somebody notices and seeds it by hand. That is the
 * fail-closed side of the design working exactly as intended, against a state
 * provisioning creates every time.
 *
 * **A module-scoped clone has no path protection at all.** Its exclusion set is
 * legitimately allowed to be empty — it receives only the globs of what it
 * installed — but "allowed to be empty" and "is empty because nothing ever
 * wrote it" are different facts that look identical from the table. A module
 * whose globs reach `src/integrations/**` would carry prime's
 * `src/integrations/supabase/env.ts` straight onto the clone, which is the
 * failure that whole list exists to prevent: the deployed dashboard served the
 * PRIME's production database and signing in authenticated against real staff
 * accounts. `backendIdentityHold` catches it by CONTENT, which is why this has
 * not bitten again — but that is the second line, added after the first one
 * missed two paths, and it is not a reason to leave the first line unbuilt.
 *
 * ## One list
 *
 * The rows come from `DEFAULT_MIRROR_EXCLUSIONS` itself, imported. The seed
 * migration transcribes that list and `syncExclusions.test.ts` fails if the two
 * disagree; a third copy here would have nothing pinning it, and an incomplete
 * copy is precisely how `public/lead-magnet-embed.html` came to be reverted by
 * a live cascade after it had been fixed.
 *
 * ## Never fails the provisioning it accompanies
 *
 * A clone with no exclusions is the state provisioning produces today, so
 * failing to improve on it must not destroy a clone that has already been
 * created, had a repository forked and had modules installed. The outcome is
 * returned and recorded instead. `ON CONFLICT DO NOTHING` semantics come from
 * the table's own `(clone_id, pattern)` unique constraint, so a re-run — an
 * operator's retry, an idempotent re-provision — adds what is missing and
 * touches nothing that is there.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_MIRROR_EXCLUSIONS } from "./syncExclusions.pure";

export type SeedExclusionsResult = {
  readonly ok: boolean;
  /** Rows this call wrote. Zero on a clone that already carried the policy. */
  readonly inserted: number;
  /** Patterns offered, whether or not they were already present. */
  readonly offered: number;
  readonly error: string | null;
};

export async function seedSyncExclusions(
  supabase: SupabaseClient<Database>,
  cloneId: string,
): Promise<SeedExclusionsResult> {
  const rows = DEFAULT_MIRROR_EXCLUSIONS.map((e) => ({
    clone_id: cloneId,
    pattern: e.pattern,
    reason: e.reason,
    note: e.note ?? null,
  }));

  const { data, error } = await supabase
    .from("clone_sync_exclusions")
    // `ignoreDuplicates` is what makes this idempotent: the unique constraint
    // is (clone_id, pattern), so a second run adds only what is missing. The
    // alternative — merging — would silently overwrite a note or a reason an
    // operator had edited, and this policy is explicitly "a starting policy,
    // not a constant".
    .upsert(rows, { onConflict: "clone_id,pattern", ignoreDuplicates: true })
    .select("pattern");

  if (error) {
    return { ok: false, inserted: 0, offered: rows.length, error: error.message };
  }
  return { ok: true, inserted: (data ?? []).length, offered: rows.length, error: null };
}
