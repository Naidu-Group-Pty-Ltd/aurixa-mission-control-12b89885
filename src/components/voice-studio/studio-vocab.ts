// Words and tones the Studio's screens share, so a status reads the same on the
// project list and on the project page.
import type { OutcomeTone } from "@/lib/voice-vocab";
import type { SpineTone } from "@/components/record-row";

export const PROJECT_STATUS: Record<
  string,
  { label: string; tone: OutcomeTone; spine: SpineTone }
> = {
  draft: { label: "draft", tone: "neutral", spine: "idle" },
  planning: { label: "planning", tone: "info", spine: "live" },
  plan_ready: { label: "plan ready", tone: "warning", spine: "warn" },
  plan_approved: { label: "plan approved", tone: "info", spine: "live" },
  package_ready: { label: "package ready", tone: "warning", spine: "warn" },
  package_approved: { label: "ready to deploy", tone: "info", spine: "live" },
  deploying: { label: "deploying", tone: "info", spine: "live" },
  deployed: { label: "deployed", tone: "success", spine: "ok" },
  failed: { label: "needs attention", tone: "destructive", spine: "bad" },
};

export const TARGET_LABEL: Record<string, string> = {
  clone: "Existing workspace",
  lead: "Lead",
  agreement: "Signed agreement",
  prospect: "Prospect",
};

export const STAGE_LABEL: Record<string, string> = {
  extract_docs: "Reading documents",
  profile: "Building the business profile",
  topology: "Designing the fleet",
  agent_content: "Writing each agent",
  voice_context: "Writing the shared voice",
  kb_draft: "Drafting the knowledge base",
  validate: "Checking and repairing",
  assemble: "Assembling the plan",
};

export function statusOf(status: string) {
  return (
    PROJECT_STATUS[status] ?? {
      label: status,
      tone: "neutral" as OutcomeTone,
      spine: "idle" as SpineTone,
    }
  );
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
