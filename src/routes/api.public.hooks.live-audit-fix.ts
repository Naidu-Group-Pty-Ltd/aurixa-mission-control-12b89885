// Live audit fix callback: lifecycle events from `codex-remediation.yml` on
// Prime when it is fixing a live-audit defect — Claude Code, on a
// `live-audit/fix-…` branch, with a key derived for that fix alone.
//
// The handler, and how a fix's pull request moves its finding, live in
// src/server/live-audit-fix.server.ts.
import { createFileRoute } from "@tanstack/react-router";
import { handleLiveAuditFixCallback } from "@/server/live-audit-fix.server";

export const Route = createFileRoute("/api/public/hooks/live-audit-fix")({
  server: {
    handlers: {
      POST: async ({ request }) => handleLiveAuditFixCallback(request),
    },
  },
});
