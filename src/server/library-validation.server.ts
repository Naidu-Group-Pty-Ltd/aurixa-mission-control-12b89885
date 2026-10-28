// Pin validation, for the cascade engine's pre-flight and the pages alike.
//
// The `validateClonePins` server function used to restate this check, and the
// two copies had already drifted in what they read. It now calls this one,
// with the same SupabaseClient-taking signature the engine's background flows
// (webhooks, cron) need. The judgement itself is `judgeClonePins` in
// `libraryApproval.pure.ts`.
//
// What a pin is checked for: its entry still exists, is approved, records the
// commit it was approved at (D19), and has files. And what each pin rests on:
// the commit its entry records, reported per pin.
//
// A failed read of the entries is reported as the failure it is. It used to
// leave the entry map empty, so every pin read "Library entry was deleted".
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  describeDbError,
  judgeClonePins,
  type ClonePin,
  type PinCommit,
  type PinIssue,
  type PinnedEntry,
} from "./libraryApproval.pure";

export type { PinCommit, PinIssue } from "./libraryApproval.pure";

export async function validateClonePinsServer(
  supabase: SupabaseClient<Database>,
  cloneIds: string[],
): Promise<{
  ok: boolean;
  issues: PinIssue[];
  /** Every pin checked, with the commit its entry records (null: none recorded, or unread). */
  pins: PinCommit[];
  checked: number;
  error?: string;
}> {
  if (cloneIds.length === 0) return { ok: true, issues: [], pins: [], checked: 0 };

  const { data: pins, error } = await supabase
    .from("clone_library_pins")
    .select("clone_id, slug, version, library_entry_id")
    .in("clone_id", cloneIds);
  if (error) return { ok: false, issues: [], pins: [], checked: 0, error: error.message };

  const pinRows: ClonePin[] = pins ?? [];
  if (pinRows.length === 0) return { ok: true, issues: [], pins: [], checked: 0 };

  const entryIds = Array.from(new Set(pinRows.map((p) => p.library_entry_id)));
  const { data: entries, error: entriesError } = await supabase
    .from("module_library")
    .select("id, approval_status, file_paths, source_commit_sha")
    .in("id", entryIds);

  const judged = judgeClonePins(
    pinRows,
    entriesError
      ? { unread: describeDbError(entriesError) }
      : new Map<string, PinnedEntry>((entries ?? []).map((e) => [e.id, e])),
  );
  return { ok: true, ...judged, checked: pinRows.length };
}
