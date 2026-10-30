// Live audit callback: what a run of `live-audit.yml` on Prime reports —
// started, its context request, progress, findings in batches, completed or
// failed.
//
// Authentication (a per-run derived key, timestamps, replay refusal), the
// findings' ingest and the run's finalisation live in
// src/server/live-audit-callback.server.ts.
import { createFileRoute } from "@tanstack/react-router";
import { handleLiveAuditCallback } from "@/server/live-audit-callback.server";

export const Route = createFileRoute("/api/public/hooks/live-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => handleLiveAuditCallback(request),
    },
  },
});
