// Codex remediation callback: lifecycle events from the GitHub Actions
// workflow that produces draft fix PRs.
//
// Authentication (a per-remediation derived key, timestamps, replay
// refusal), the forward-only status machine, and the finding mirror live in
// src/server/codex-remediation-callback.server.ts.
import { createFileRoute } from "@tanstack/react-router";
import { handleRemediationCallback } from "@/server/codex-remediation-callback.server";

export const Route = createFileRoute("/api/public/hooks/codex-remediation")({
  server: {
    handlers: {
      POST: async ({ request }) => handleRemediationCallback(request),
    },
  },
});
