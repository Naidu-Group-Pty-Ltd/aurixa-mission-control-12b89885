import { createFileRoute } from "@tanstack/react-router";
import { handleFleetMigrationCron } from "@/server/fleet-migration.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 30 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Applies the prime's migrations to a bounded slice of the fleet. The cascade
// already copies migration FILES into every clone's repository; this is what
// gets them into the clone's DATABASE, which until now happened only when an
// operator pressed a button on an admin page.
//
// Thirty minutes, not one: a clone's schema does not change between ticks, and
// each run is bounded to a few clones so the fleet is worked through across
// ticks rather than in one invocation that would outlive the isolate.
//
// The one case that sentence stopped covering is a clone part-way through an
// oversized seed, which IS a queue being drained — that is what
// `/hooks/fleet-migration-drain` is for, on the same handler at a shorter
// cadence. See `handleFleetMigrationCron`.
//
// It can only ever reach a clone: the candidate list is `clone_backends`, whose
// `clone_id` is NOT NULL, so the prime — whose ref lives in `prime_config` —
// has no row there to return.
export const Route = createFileRoute("/hooks/fleet-migration-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => handleFleetMigrationCron(request, "sweep"),
    },
  },
});
