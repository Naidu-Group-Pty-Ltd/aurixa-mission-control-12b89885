// How an entity's health reads in a list: the spine it wears and the word
// beside it. Shared by the health panel and the entity table.
import type { SpineTone } from "@/components/record-row";
import type { EntityHealth } from "@/lib/marketing/marketingEngine";

export const HEALTH: Record<EntityHealth["status"], { spine: SpineTone; word: string }> = {
  healthy: { spine: "ok", word: "healthy" },
  watch: { spine: "warn", word: "watch" },
  action_needed: { spine: "bad", word: "action needed" },
  not_scored: { spine: "idle", word: "not scored" },
};
