import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// AI Fleet Manager — analyzes each clone vs prime and writes drift suggestions.
// Manually invokable from the Fleet Manager UI; also triggered by cron via
// /hooks/fleet-drift route.

type DriftSuggestion = {
  severity: "low" | "medium" | "high";
  title: string;
  rationale: string;
  recommended_action: "cascade_pr" | "cascade_auto_merge" | "notify" | "review";
};

async function analyzeClone(
  cloneSummary: {
    name: string;
    commits_behind: number;
    sync_status: string;
    last_cascade_at: string | null;
    installed_modules: string[];
  },
  apiKey: string,
): Promise<DriftSuggestion[]> {
  const body = {
    model: "google/gemini-3-flash-preview",
    messages: [
      {
        role: "system",
        content:
          "You are an SRE assistant managing a fleet of cloned codebases. Analyze a clone vs prime and recommend 1-3 concrete next actions. Return ONLY via the suggest_actions tool.",
      },
      {
        role: "user",
        content: `Clone: ${cloneSummary.name}
Commits behind prime: ${cloneSummary.commits_behind}
Sync status: ${cloneSummary.sync_status}
Last cascaded: ${cloneSummary.last_cascade_at ?? "never"}
Installed modules: ${cloneSummary.installed_modules.join(", ") || "(none)"}`,
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "suggest_actions",
          description: "Return drift mitigation suggestions",
          parameters: {
            type: "object",
            properties: {
              suggestions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    severity: {
                      type: "string",
                      enum: ["low", "medium", "high"],
                    },
                    title: { type: "string" },
                    rationale: { type: "string" },
                    recommended_action: {
                      type: "string",
                      enum: ["cascade_pr", "cascade_auto_merge", "notify", "review"],
                    },
                  },
                  required: ["severity", "title", "rationale", "recommended_action"],
                  additionalProperties: false,
                },
              },
            },
            required: ["suggestions"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: {
      type: "function",
      function: { name: "suggest_actions" },
    },
  };

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error("Fleet AI error", res.status, await res.text());
    return [];
  }
  const json = await res.json();
  const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return [];
  try {
    const parsed = JSON.parse(args);
    return parsed.suggestions ?? [];
  } catch {
    return [];
  }
}

export async function runFleetDriftScan(
  supabase: any,
): Promise<{ scanned: number; updated: number }> {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  if (!LOVABLE_API_KEY) {
    throw new Error("LOVABLE_API_KEY not configured");
  }

  const { data: clones } = await supabase.from("clones").select("*");
  if (!clones || clones.length === 0) return { scanned: 0, updated: 0 };

  // A clone that is still being PROVISIONED is not drifting — drift compares
  // two live things, and one of them does not exist yet. The 30 Aug dry run
  // measured what scanning one anyway does: a clone created at 15:34 drew a
  // "High drift" warning every 15 minutes for hours (each one a PAID model
  // call in analyzeClone), because a null last_cascade_at scored as 99,999
  // minutes behind. Backend or deployment still in flight → record the check
  // ran and nothing else.
  const inFlightBackends = new Set<string>();
  const { data: backendRows } = await supabase.from("clone_backends").select("clone_id, status");
  for (const b of backendRows ?? []) {
    if (["pending", "provisioning", "migrating", "seeding_admin"].includes(b.status)) {
      inFlightBackends.add(b.clone_id);
    }
  }
  const { data: deploymentRows } = await supabase
    .from("clone_deployments")
    .select("clone_id, status");
  for (const d of deploymentRows ?? []) {
    if (d.status !== "live" && d.status !== "failed") inFlightBackends.add(d.clone_id);
  }

  let updated = 0;
  for (const c of clones) {
    if (inFlightBackends.has(c.id)) {
      const { error: checkStampErr } = await supabase
        .from("clones")
        .update({ last_drift_check_at: new Date().toISOString() })
        .eq("id", c.id);
      if (checkStampErr) {
        console.error(
          `[fleet-drift] could not stamp drift check for provisioning clone ${c.id}: ${checkStampErr.message}`,
        );
      }
      updated++;
      continue;
    }

    // This scan ADVISES. It does not measure, and it must never write the
    // measurement.
    //
    // What stood here was a self-described "pseudo git diff" — a placeholder
    // that derived `commits_behind` from a CLOCK (minutes since the last
    // cascade, over 30, capped at 40) and then wrote it, and `sync_status`
    // with it, straight over the reading `runDriftRefresh` had taken from
    // GitHub ten minutes earlier. Two cron jobs, one column: `drift-refresh`
    // every 5 minutes measuring, `fleet-drift-scan` every 15 fabricating.
    //
    // The fabrication won whenever it ran last, and its arithmetic produced
    // the worst possible answer. A cascade that merely UPDATES a pull request
    // stamps `last_cascade_at`, so the clock reads near zero, so drift reads
    // 0, so the status is set to `in_sync` — measured 7 Sep 02:30 on
    // NPC Client Dashboard, which was and is 131 commits behind the prime with
    // its cascade still an open proposal. A false green on a fleet page says a
    // tenant is running current code when it is a hundred commits stale, which
    // is worse than any red.
    //
    // The number now comes from the one place that asks GitHub for it. The
    // suggestions below read what was measured rather than what was invented,
    // so a model can no longer be briefed on a fabricated figure either.
    const newCommitsBehind = c.commits_behind ?? 0;
    const newStatus = c.sync_status;

    const { data: cmods } = await supabase
      .from("clone_modules")
      .select("modules(name)")
      .eq("clone_id", c.id);
    const installedNames = (cmods ?? []).map((m: any) => m.modules?.name).filter(Boolean);

    const previousSuggestions = (c.drift_suggestions as DriftSuggestion[] | null) ?? [];
    const previousHighTitles = new Set(
      previousSuggestions.filter((s) => s.severity === "high").map((s) => s.title),
    );

    let suggestions: DriftSuggestion[] = [];
    if (newCommitsBehind > 0) {
      suggestions = await analyzeClone(
        {
          name: c.name,
          commits_behind: newCommitsBehind,
          sync_status: newStatus,
          last_cascade_at: c.last_cascade_at,
          installed_modules: installedNames,
        },
        LOVABLE_API_KEY,
      );
    }

    // Suggestions and the stamp — never `commits_behind`, never
    // `sync_status`. Those two are `runDriftRefresh`'s to write, from a
    // comparison GitHub actually performed.
    const { error: suggestionsErr } = await supabase
      .from("clones")
      .update({
        drift_suggestions: suggestions,
        last_drift_check_at: new Date().toISOString(),
      })
      .eq("id", c.id);
    if (suggestionsErr) {
      console.error(
        `[fleet-drift] could not write suggestions for clone ${c.id}: ${suggestionsErr.message}`,
      );
    }
    updated++;

    // Emit notifications when the clone ENTERS a behind state, not on every
    // scan while it stays there. The old title-set dedupe never held: the
    // titles are model-authored and vary per run, so "genuinely new" was true
    // every 15 minutes — the dry-run clone drew ten identical warnings in one
    // afternoon, two of them in the same insert at the same microsecond. A
    // transition is a fact the model cannot rephrase.
    const wasAlreadyBehind = c.sync_status === "behind" || c.sync_status === "failed";
    const newHigh = wasAlreadyBehind
      ? []
      : suggestions.filter((s) => s.severity === "high" && !previousHighTitles.has(s.title));
    if (newHigh.length > 0) {
      await supabase.from("notifications").insert(
        newHigh.map((s) => ({
          kind: "drift_high",
          severity: "warning",
          title: `High drift on ${c.name}`,
          body: s.title,
          clone_id: c.id,
          url: "/fleet-manager",
          metadata: {
            rationale: s.rationale,
            recommended_action: s.recommended_action,
          },
        })),
      );
    }
  }

  await supabase.from("audit_log").insert({
    action: "fleet.drift_scan",
    metadata: { scanned: clones.length, updated },
  });

  return { scanned: clones.length, updated };
}

export const triggerFleetDriftScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const result = await runFleetDriftScan(context.supabase);
      return { ok: true as const, ...result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Scan failed";
      return { ok: false as const, error: msg };
    }
  });
