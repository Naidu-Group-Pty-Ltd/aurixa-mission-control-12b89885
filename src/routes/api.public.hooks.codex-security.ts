// Codex Security webhook receiver.
//
// Every rule about which callbacks are believed — per-job keys, timestamps,
// replay refusal, closed jobs, run-to-repository binding — and how a batch is
// applied lives in src/server/codex-scan-callback.server.ts, where it can be
// tested without a router.
import { createFileRoute } from "@tanstack/react-router";
import { handleScanCallback } from "@/server/codex-scan-callback.server";

export const Route = createFileRoute("/api/public/hooks/codex-security")({
  server: {
    handlers: {
      POST: async ({ request }) => handleScanCallback(request),
    },
  },
});
