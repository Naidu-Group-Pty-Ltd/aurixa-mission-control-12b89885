import { createFileRoute } from "@tanstack/react-router";
import { handleFleetMigrationCron } from "@/server/fleet-migration.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 5 min.
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
export const Route = createFileRoute("/hooks/fleet-migration-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => handleFleetMigrationCron(request, "drain"),
    },
  },
});
