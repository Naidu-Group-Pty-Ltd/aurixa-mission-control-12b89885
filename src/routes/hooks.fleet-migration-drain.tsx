import { createFileRoute } from "@tanstack/react-router";
import { handleFleetMigrationCron } from "@/server/fleet-migration.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 5 min, except at
// :00 and :30, which are the sweep's (see below).
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// THE SAME PASS, SERVING ONLY WHAT IS MID-SEED.
//
// The sweep next door runs every thirty minutes on the stated grounds that
// nothing in this lane is queue-draining. That was true until oversized seeds
// became chunk-resumable. Measured 20 Sep 2026 by running this repository's own
// `readSeedShape` and `chunkSeedStatements` over the prime's
// `20261203000000_seed_template_library_v14_tier_separation.sql` (41,678,125
// bytes, 543 rows): the seed is 45 statements at the 1 MB ceiling, each takes
// seconds to send, and a 45-second invocation carries about two dozen. The rest
// waited half an hour.
//
// A tick here serves only clones carrying a chunk cursor, and asks that of the
// database before it reads the GitHub allowance — so a fleet with no seed in
// flight pays one indexed select and nothing else. The mode narrows an
// already-eligible set, so this door reaches no clone the sweep cannot.
//
// AND IT NEVER RUNS BESIDE THE SWEEP. At :00 and :30 both used to fire and
// each claimed a clone mid-seed. On three of the ten paired ticks measured on
// 26 Sep 2026 while a lone pass fitted its isolate, the two seed streams killed
// it — both passes gone in the same instant, both claims left standing — and
// no lone pass died at all. Since the sweep serves everything this door serves,
// the drain gives up those two minutes: `20260926160000_fleet_drain_leaves_the_
// sweep_its_minutes.sql`, pinned by `fleetDrainCadence.test.ts`.
export const Route = createFileRoute("/hooks/fleet-migration-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => handleFleetMigrationCron(request, "drain"),
    },
  },
});
