// The live audit's settings: when it runs, on which models, how far it goes,
// what the guard lets through, and whether Claude fixes on its own. An admin
// edits; an operator reads.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_AUDIT_MODEL, EFFORTS, LIVE_AUDIT_MODELS } from "@/lib/live-audit-policy";
import { setLiveAuditNightlySchedule, updateLiveAuditSettings } from "@/lib/live-audit.functions";

type Settings = Record<string, any>;

const DEFAULT_CHOICE = "__default__";

function ModelSelect({
  id,
  value,
  onChange,
  disabled,
  defaultLabel,
}: {
  id: string;
  value: string | null;
  onChange: (v: string | null) => void;
  disabled: boolean;
  defaultLabel: string;
}) {
  return (
    <Select
      value={value ?? DEFAULT_CHOICE}
      onValueChange={(v) => onChange(v === DEFAULT_CHOICE ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_CHOICE}>{defaultLabel}</SelectItem>
        {LIVE_AUDIT_MODELS.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label} — {m.note}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EffortSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EFFORTS.map((e) => (
          <SelectItem key={e} value={e}>
            {e}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const list = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

export function LiveAuditSettingsPanel({
  settings,
  canAct,
}: {
  settings: Settings | null;
  canAct: boolean;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Settings | null>(settings);
  const [allowText, setAllowText] = useState("");
  const [blockText, setBlockText] = useState("");
  const [cron, setCron] = useState("");

  useEffect(() => {
    setDraft(settings);
    setAllowText((settings?.guard_allow_functions ?? []).join("\n"));
    setBlockText((settings?.guard_block_functions ?? []).join("\n"));
    setCron(settings?.nightly_cron ?? "");
  }, [settings]);

  const updateFn = useServerFn(updateLiveAuditSettings);
  const save = useMutation({
    mutationFn: (patch: Settings) => updateFn({ data: patch as never }),
    onSuccess: (r: { changed: string[] }) => {
      toast.success(r.changed.length ? `Saved: ${r.changed.join(", ")}` : "Nothing changed");
      qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
      qc.invalidateQueries({ queryKey: ["live-audit-health"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const scheduleFn = useServerFn(setLiveAuditNightlySchedule);
  const schedule = useMutation({
    mutationFn: () => scheduleFn({ data: { cron: cron.trim() } }),
    onSuccess: (r: { applied?: boolean; reason?: string }) => {
      if (r?.applied === false) toast.warning(r.reason ?? "The schedule was not applied");
      else toast.success("Nightly schedule moved");
      qc.invalidateQueries({ queryKey: ["live-audit-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!draft) {
    return (
      <p className="text-sm text-muted-foreground">
        No settings row for Prime yet: apply the live audit's migration.
      </p>
    );
  }
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...(d ?? {}), [k]: v }));
  const disabled = !canAct || save.isPending;
  const num = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    set(k, e.target.value === "" ? "" : Number(e.target.value));

  const submit = () =>
    save.mutate({
      claude_enabled: draft.claude_enabled === true,
      nightly_enabled: draft.nightly_enabled,
      mode: draft.mode,
      target_url: draft.target_url,
      audit_model: draft.audit_model ?? null,
      fix_model: draft.fix_model ?? null,
      effort_scope: draft.effort_scope,
      effort_explore: draft.effort_explore,
      effort_triage: draft.effort_triage,
      fix_effort: draft.fix_effort,
      budget_usd: Number(draft.budget_usd),
      max_pages: Number(draft.max_pages),
      max_journeys: Number(draft.max_journeys),
      max_steps: Number(draft.max_steps),
      time_budget_minutes: Number(draft.time_budget_minutes),
      viewports: draft.viewports,
      screenshots: draft.screenshots,
      guard_allow_functions: list(allowText),
      guard_block_functions: list(blockText),
      autofix_enabled: draft.autofix_enabled,
      autofix_max_per_run: Number(draft.autofix_max_per_run),
      autofix_min_confidence: Number(draft.autofix_min_confidence),
    });

  return (
    <div className="space-y-4">
      {!canAct && (
        <p className="text-sm text-muted-foreground">
          Read-only: an admin changes the live audit's settings.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Claude</CardTitle>
          <CardDescription>
            Claude reads Prime's code, chooses the journeys, explores and judges what it saw; Claude
            Code writes every fix. While Use Claude is off, runs make no Anthropic call (they crawl
            and judge from the browser alone) and no fix is drafted, whatever key Mission Control
            holds. Until you choose a model, runs use {DEFAULT_AUDIT_MODEL} and record that it was
            the default.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="flex items-center gap-2 md:col-span-2">
            <Switch
              id="la-claude"
              checked={draft.claude_enabled === true}
              onCheckedChange={(v) => set("claude_enabled", v)}
              disabled={disabled}
            />
            <Label htmlFor="la-claude">
              Use Claude: turn on once the live audit&apos;s Anthropic key is provisioned
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="la-audit-model">Audit model</Label>
            <ModelSelect
              id="la-audit-model"
              value={draft.audit_model ?? null}
              onChange={(v) => set("audit_model", v)}
              disabled={disabled}
              defaultLabel={`Not chosen — runs use ${DEFAULT_AUDIT_MODEL}`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="la-fix-model">Fix model</Label>
            <ModelSelect
              id="la-fix-model"
              value={draft.fix_model ?? null}
              onChange={(v) => set("fix_model", v)}
              disabled={disabled}
              defaultLabel="Not chosen — the fix workflow's default"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 md:col-span-2 md:grid-cols-4">
            {(
              [
                ["effort_scope", "Reading the code"],
                ["effort_explore", "Exploring"],
                ["effort_triage", "Judging"],
                ["fix_effort", "Fixing"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`la-${k}`}>{label}</Label>
                <EffortSelect
                  id={`la-${k}`}
                  value={draft[k]}
                  onChange={(v) => set(k, v)}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">When and how far</CardTitle>
          <CardDescription>
            A run stops at whichever limit it reaches first, and says so: a run that stopped early
            resolves nothing by its absence.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="la-nightly"
                checked={!!draft.nightly_enabled}
                onCheckedChange={(v) => set("nightly_enabled", v)}
                disabled={disabled}
              />
              <Label htmlFor="la-nightly">Run every night</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="la-cron">At (cron, UTC)</Label>
              <div className="flex gap-2">
                <Input
                  id="la-cron"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  className="w-40 font-mono"
                  disabled={!canAct}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    !canAct ||
                    schedule.isPending ||
                    !cron.trim() ||
                    cron.trim() === settings?.nightly_cron
                  }
                  onClick={() => schedule.mutate()}
                >
                  Move
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="la-mode">Target</Label>
              <Select value={draft.mode} onValueChange={(v) => set("mode", v)} disabled={disabled}>
                <SelectTrigger id="la-mode" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="live">Production, as a staff account</SelectItem>
                  <SelectItem value="preview">A build of main, on staging</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-64 flex-1 space-y-1.5">
              <Label htmlFor="la-url">Production URL</Label>
              <Input
                id="la-url"
                value={draft.target_url ?? ""}
                onChange={(e) => set("target_url", e.target.value)}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {(
              [
                ["budget_usd", "Spend cap (USD)", 0.5],
                ["time_budget_minutes", "Minutes", 1],
                ["max_pages", "Pages", 1],
                ["max_journeys", "Journeys", 1],
                ["max_steps", "Steps per journey", 1],
              ] as const
            ).map(([k, label, step]) => (
              <div key={k} className="space-y-1.5">
                <Label htmlFor={`la-${k}`}>{label}</Label>
                <Input
                  id={`la-${k}`}
                  type="number"
                  step={step}
                  value={draft[k] ?? ""}
                  onChange={num(k)}
                  disabled={disabled}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2">
              <Switch
                id="la-mobile"
                checked={(draft.viewports ?? []).includes("mobile")}
                onCheckedChange={(v) => set("viewports", v ? ["desktop", "mobile"] : ["desktop"])}
                disabled={disabled}
              />
              <Label htmlFor="la-mobile">Also at phone width</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="la-shots"
                checked={draft.screenshots === "issues"}
                onCheckedChange={(v) => set("screenshots", v ? "issues" : "off")}
                disabled={disabled}
              />
              <Label htmlFor="la-shots">
                Screenshot each defect (kept in Mission Control's private bucket)
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">The guard</CardTitle>
          <CardDescription>
            Every request the browser makes passes the guard, which lets a backend function through
            only when its code reads or the call names an action that reads. Over-blocking is the
            safe failure: allow here, one at a time, what you know only reads; block what the
            profiler let through. One per line: a function's name (every call), name:action (calls
            naming that action) or name:- (calls naming none), as a run's held-back list prints
            them. A block wins, and nothing allows a call that asks to write on the way (mark_read:
            true).
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="la-allow">Always allow</Label>
            <Textarea
              id="la-allow"
              rows={4}
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              className="font-mono text-xs"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="la-block">Always block</Label>
            <Textarea
              id="la-block"
              rows={4}
              value={blockText}
              onChange={(e) => setBlockText(e.target.value)}
              className="font-mono text-xs"
              disabled={disabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Automatic fixes</CardTitle>
          <CardDescription>
            After each completed run, Claude drafts fixes for the worst defects it is surest of, as
            draft pull requests a person reviews and merges. A person can ask for a fix on any open
            defect, whatever its severity. Nothing is dispatched until the Anthropic key is set.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="la-autofix"
              checked={!!draft.autofix_enabled}
              onCheckedChange={(v) => set("autofix_enabled", v)}
              disabled={disabled}
            />
            <Label htmlFor="la-autofix">Fix automatically</Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="la-autofix-max">Per run, at most</Label>
            <Input
              id="la-autofix-max"
              type="number"
              className="w-28"
              value={draft.autofix_max_per_run ?? ""}
              onChange={num("autofix_max_per_run")}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="la-autofix-conf">Confidence at least</Label>
            <Input
              id="la-autofix-conf"
              type="number"
              step={0.05}
              min={0}
              max={1}
              className="w-28"
              value={draft.autofix_min_confidence ?? ""}
              onChange={num("autofix_min_confidence")}
              disabled={disabled}
            />
          </div>
        </CardContent>
      </Card>

      {canAct && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(settings)} disabled={save.isPending}>
            Discard
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      )}
    </div>
  );
}
