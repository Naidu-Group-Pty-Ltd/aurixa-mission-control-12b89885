// Plan tab: what the planning agent proposed, what the checks found, and the
// first of the two approvals.
//
// Everything a person changes here is saved as a NEW plan version and
// re-validated by the server with the same checks the planner ran - an
// operator's words go through the same lint as a model's, because the agent
// reads them out either way. An errored plan cannot be approved.
import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ClipboardList, Pencil, Quote } from "lucide-react";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { MonoStatus } from "@/components/voice/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { approveStudioPlan, saveStudioPlanEdit } from "@/lib/voice-studio.functions";
import { ARCHETYPES } from "@/lib/voice-recipe/archetypes.pure";
import { VOICE_PALETTE } from "@/lib/voice-recipe/defaults.pure";
import {
  BACKEND_MENU,
  TOOL_CATALOG,
  isDeployable,
  type BackendKey,
} from "@/lib/voice-recipe/tools.pure";
import type { AgentContent, Citation, CloningPlan } from "@/lib/voice-studio/schemas.pure";
import type { StudioProjectData } from "./types";

type Editable = Pick<CloningPlan, "profile" | "topology" | "agents" | "voiceContext" | "kb">;

const BAND_TONE = { high: "success", medium: "warning", low: "destructive" } as const;

export function PlanTab({
  data,
  refresh,
  onApproved,
}: {
  data: StudioProjectData;
  refresh: () => void;
  onApproved: () => void;
}) {
  const plan = data.currentPlan as unknown as CloningPlan | null;
  const row = data.plans.find((p) => p.id === data.project.current_plan_id) ?? null;
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const save = useMutation({
    mutationFn: (args: { edit: Editable; note: string }) =>
      saveStudioPlanEdit({
        data: { projectId: data.project.id, basePlanId: row!.id, edit: args.edit, note: args.note },
      }),
    onSuccess: (r) => {
      toast.success(`Saved as version ${r.version}`, {
        description: r.hasErrors ? "The checks still find errors - see the list below." : undefined,
      });
      setEditingAgent(null);
      setAdvanced(false);
      refresh();
    },
    onError: (e: Error) => toast.error("Could not save the edit", { description: e.message }),
  });
  const approve = useMutation({
    mutationFn: () => approveStudioPlan({ data: { planId: row!.id } }),
    onSuccess: (r) => {
      toast.success(`Plan approved - package v${r.version} compiled`);
      refresh();
      onApproved();
    },
    onError: (e: Error) => toast.error("Could not approve", { description: e.message }),
  });

  if (!plan || !row) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title="No plan yet"
        description="Add the client's documents on the Documents tab and make the plan. It takes a few minutes; this page updates as it goes."
      />
    );
  }

  const editable: Editable = {
    profile: plan.profile,
    topology: plan.topology,
    agents: plan.agents,
    voiceContext: plan.voiceContext,
    kb: plan.kb,
  };
  const errors = plan.issues.filter((i) => i.severity === "error");
  const warnings = plan.issues.filter((i) => i.severity === "warning");
  const agentBeingEdited = plan.agents.find((a) => a.agentKey === editingAgent) ?? null;

  return (
    <div className="space-y-6">
      <div className="glass flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            Plan v{row.version} · {plan.profile.businessName}
            {row.edit_note ? (
              <span className="text-muted-foreground"> · {row.edit_note}</span>
            ) : null}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            Recipe book v{plan.recipeVersion} · confidence {plan.confidence.score}/100 ·{" "}
            {plan.confidence.reasons.join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MonoStatus
            label={`${plan.confidence.band} confidence`}
            tone={BAND_TONE[plan.confidence.band]}
          />
          <Button variant="outline" size="sm" onClick={() => setAdvanced(true)}>
            <Pencil className="mr-1 h-3 w-3" /> Edit everything
          </Button>
          <Button
            onClick={() => approve.mutate()}
            disabled={row.has_errors || approve.isPending || row.status === "superseded"}
            title={row.has_errors ? "Fix the errors below first" : undefined}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            {row.status === "approved" ? "Re-compile package" : "Approve plan"}
          </Button>
        </div>
      </div>

      {(errors.length > 0 || warnings.length > 0) && (
        <section className="space-y-2">
          <p className="label-mono">Checks</p>
          {[...errors, ...warnings].map((i, n) => (
            <RecordRow
              key={n}
              spine={i.severity === "error" ? "bad" : "warn"}
              className="flex items-start gap-3 px-4 py-2.5"
            >
              <AlertTriangle
                className={`mt-0.5 h-4 w-4 shrink-0 ${i.severity === "error" ? "text-destructive" : "text-warning"}`}
              />
              <div className="min-w-0 text-sm">
                <p>{i.message}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {i.code} · {i.path}
                </p>
              </div>
            </RecordRow>
          ))}
        </section>
      )}

      {plan.openItems.length > 0 && (
        <section className="space-y-2">
          <p className="label-mono">Open items before go-live</p>
          {plan.openItems.map((o, n) => (
            <RecordRow key={n} spine="warn" className="px-4 py-2.5">
              <p className="text-sm font-medium">
                {o.title}{" "}
                <Badge variant="outline" className="ml-1">
                  {o.owner}
                </Badge>
              </p>
              <p className="text-xs text-muted-foreground">{o.detail}</p>
            </RecordRow>
          ))}
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="glass space-y-3 p-5">
          <p className="label-mono">The business</p>
          <p className="text-sm">{plan.profile.oneLiner}</p>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Industry</dt>
            <dd>{plan.profile.industry}</dd>
            <dt className="text-muted-foreground">Hours</dt>
            <dd>{plan.profile.hoursSummary || "-"}</dd>
            <dt className="text-muted-foreground">Timezone</dt>
            <dd>{plan.profile.timezone}</dd>
            <dt className="text-muted-foreground">Booking window</dt>
            <dd>
              {plan.profile.bookingWindow
                ? `${plan.profile.bookingWindow.startTime}-${plan.profile.bookingWindow.endTime}, ${plan.profile.bookingWindow.slotMinutes} min slots, ${plan.profile.bookingWindow.minNoticeHours}h notice`
                : "not established by the documents"}
            </dd>
            <dt className="text-muted-foreground">Booking types</dt>
            <dd>{plan.profile.bookingTypes.map((b) => b.label).join(", ") || "-"}</dd>
            <dt className="text-muted-foreground">Systems</dt>
            <dd>
              {plan.profile.systems.map((s) => `${s.name} (${s.category})`).join(", ") || "-"}
            </dd>
          </dl>
          {plan.profile.services.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="label-mono">Services</p>
              {plan.profile.services.map((s) => (
                <div key={s.name} className="text-xs">
                  <span className="font-medium">{s.name}</span> - {s.description}
                  <Citations items={s.citations} />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="glass space-y-3 p-5">
          <p className="label-mono">What the documents did not answer</p>
          {plan.profile.gaps.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing outstanding.</p>
          ) : (
            <ul className="space-y-2 text-xs">
              {plan.profile.gaps.map((g) => (
                <li key={g.question}>
                  <p className="font-medium">{g.question}</p>
                  <p className="text-muted-foreground">{g.whyItMatters}</p>
                </li>
              ))}
            </ul>
          )}
          {plan.topology.risks.length > 0 && (
            <>
              <p className="label-mono pt-2">Risks on a call</p>
              <ul className="space-y-2 text-xs">
                {plan.topology.risks.map((r) => (
                  <li key={r.title}>
                    <p className="font-medium">{r.title}</p>
                    <p className="text-muted-foreground">{r.detail}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <p className="label-mono">
          The fleet · {plan.topology.agents.length} agent
          {plan.topology.agents.length === 1 ? "" : "s"}
          {plan.topology.squad
            ? ` · squad "${plan.topology.squad.name}", entry ${plan.topology.squad.entryAgentKey}`
            : ""}
        </p>
        {plan.topology.agents.map((a) => {
          const content = plan.agents.find((c) => c.agentKey === a.key);
          return (
            <RecordRow key={a.key} spine="idle" className="space-y-2 px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {a.personaName} · {content?.roleTitle ?? ARCHETYPES[a.archetype].label}
                    <Badge variant="secondary" className="ml-2">
                      {ARCHETYPES[a.archetype].label}
                    </Badge>
                    {a.outboundTrigger && (
                      <Badge variant="outline" className="ml-1">
                        dials on {a.outboundTrigger.replace(/_/g, " ")}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{a.rationale}</p>
                  {content && <p className="mt-1 text-xs italic">"{content.firstMessage}"</p>}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingAgent(a.key)}
                  aria-label={`Edit ${a.personaName}`}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {a.tools.map((t) => {
                  const ok = isDeployable(t.tool, t.backend);
                  return (
                    <span
                      key={t.tool}
                      title={`${BACKEND_MENU[t.backend].label}${ok ? "" : " - not deployable yet; an open item"}`}
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${ok ? "border-border text-muted-foreground" : "border-warning/60 text-warning"}`}
                    >
                      {TOOL_CATALOG[t.tool].label} · {t.backend.replace(/_/g, " ")}
                    </span>
                  );
                })}
              </div>
            </RecordRow>
          );
        })}
      </section>

      <section className="space-y-2">
        <p className="label-mono">Knowledge base draft</p>
        <div className="glass max-h-[28rem] space-y-1 overflow-auto p-5 text-sm">
          {plan.kb.flatMap((part) =>
            part.blocks.map((b, i) => {
              const key = `${part.part}-${i}`;
              if (b.kind === "h1")
                return (
                  <h3 key={key} className="pt-3 font-display text-base">
                    {b.text}
                  </h3>
                );
              if (b.kind === "h2")
                return (
                  <h4 key={key} className="pt-2 font-medium">
                    {b.text}
                  </h4>
                );
              return (
                <p
                  key={key}
                  className={
                    b.kind === "b"
                      ? "pl-4 text-muted-foreground before:content-['-_']"
                      : "text-muted-foreground"
                  }
                >
                  {b.text}
                  <Citations items={b.citations} />
                </p>
              );
            }),
          )}
        </div>
      </section>

      {agentBeingEdited && (
        <AgentEditor
          agent={agentBeingEdited}
          topologyAgent={plan.topology.agents.find((a) => a.key === agentBeingEdited.agentKey)!}
          saving={save.isPending}
          onClose={() => setEditingAgent(null)}
          onSave={(content, topo, note) =>
            save.mutate({
              edit: {
                ...editable,
                agents: plan.agents.map((a) => (a.agentKey === content.agentKey ? content : a)),
                topology: {
                  ...plan.topology,
                  agents: plan.topology.agents.map((a) => (a.key === topo.key ? topo : a)),
                },
              },
              note,
            })
          }
        />
      )}
      {advanced && (
        <AdvancedEditor
          value={editable}
          saving={save.isPending}
          onClose={() => setAdvanced(false)}
          onSave={(edit, note) => save.mutate({ edit, note })}
        />
      )}
    </div>
  );
}

function Citations({ items }: { items: Citation[] }) {
  if (!items.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {items.map((c, i) => (
        <span
          key={i}
          title={`"${c.quote}"${c.locator ? ` - ${c.locator}` : ""}`}
          className="inline-flex items-center gap-0.5 rounded border border-border px-1 font-mono text-[9px] text-muted-foreground"
        >
          <Quote className="h-2 w-2" />
          {c.docId}
        </span>
      ))}
    </span>
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function AgentEditor({
  agent,
  topologyAgent,
  saving,
  onClose,
  onSave,
}: {
  agent: AgentContent;
  topologyAgent: CloningPlan["topology"]["agents"][number];
  saving: boolean;
  onClose: () => void;
  onSave: (
    content: AgentContent,
    topo: CloningPlan["topology"]["agents"][number],
    note: string,
  ) => void;
}) {
  const [firstMessage, setFirstMessage] = useState(agent.firstMessage);
  const [canDo, setCanDo] = useState(agent.canDo.join("\n"));
  const [cannotDo, setCannotDo] = useState(agent.cannotDo.join("\n"));
  const [extraNever, setExtraNever] = useState(agent.extraNever.join("\n"));
  const [extraAlways, setExtraAlways] = useState(agent.extraAlways.join("\n"));
  const [persona, setPersona] = useState(topologyAgent.personaName);
  const [voice, setVoice] = useState<string>(topologyAgent.voice);
  const [backends, setBackends] = useState<Record<string, BackendKey>>(
    Object.fromEntries(topologyAgent.tools.map((t) => [t.tool, t.backend])),
  );
  const [note, setNote] = useState("");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {topologyAgent.personaName}</DialogTitle>
          <DialogDescription>
            One item per line. Saving makes a new plan version and re-runs every check.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Persona name</Label>
              <Input value={persona} onChange={(e) => setPersona(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Voice</Label>
              <Select value={voice} onValueChange={setVoice}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICE_PALETTE.map((v) => (
                    <SelectItem key={v.key} value={v.key}>
                      {v.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Field label="First message" value={firstMessage} onChange={setFirstMessage} rows={2} />
          <Field label="Can do" value={canDo} onChange={setCanDo} />
          <Field label="Cannot do" value={cannotDo} onChange={setCannotDo} />
          <Field label="Never (extra absolute rules)" value={extraNever} onChange={setExtraNever} />
          <Field
            label="Always (extra absolute rules)"
            value={extraAlways}
            onChange={setExtraAlways}
          />
          <div className="space-y-1.5">
            <Label>Where each tool runs</Label>
            {topologyAgent.tools.map((t) => (
              <div key={t.tool} className="flex items-center gap-2 text-xs">
                <span className="w-40 shrink-0">{TOOL_CATALOG[t.tool].label}</span>
                <Select
                  value={backends[t.tool]}
                  onValueChange={(v) => setBackends((b) => ({ ...b, [t.tool]: v as BackendKey }))}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOOL_CATALOG[t.tool].allowedBackends.map((b) => (
                      <SelectItem key={b} value={b}>
                        {BACKEND_MENU[b].label}
                        {isDeployable(t.tool, b) ? "" : " (open item)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>What changed and why</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Client asked for a shorter greeting"
            />
          </div>
          <Button
            className="w-full"
            disabled={saving}
            onClick={() =>
              onSave(
                {
                  ...agent,
                  firstMessage: firstMessage.trim(),
                  canDo: lines(canDo),
                  cannotDo: lines(cannotDo),
                  extraNever: lines(extraNever),
                  extraAlways: lines(extraAlways),
                },
                {
                  ...topologyAgent,
                  personaName: persona.trim() || topologyAgent.personaName,
                  voice: voice as typeof topologyAgent.voice,
                  tools: topologyAgent.tools.map((t) => ({
                    ...t,
                    backend: backends[t.tool] ?? t.backend,
                  })),
                },
                note || `Edited ${topologyAgent.personaName}`,
              )
            }
          >
            Save as a new version
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function AdvancedEditor({
  value,
  saving,
  onClose,
  onSave,
}: {
  value: Editable;
  saving: boolean;
  onClose: () => void;
  onSave: (edit: Editable, note: string) => void;
}) {
  const initial = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(initial);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit the whole plan</DialogTitle>
          <DialogDescription>
            The profile, fleet, agents, shared voice and knowledge base, as the planner wrote them.
            The server checks the shape and re-runs every check; anything off the recipe book's
            menus is refused.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="min-h-[55vh] font-mono text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What changed and why"
        />
        <Button
          disabled={saving || text === initial}
          onClick={() => {
            try {
              onSave(JSON.parse(text) as Editable, note || "Edited the plan");
              setError(null);
            } catch {
              setError("That is not valid JSON.");
            }
          }}
        >
          Save as a new version
        </Button>
      </DialogContent>
    </Dialog>
  );
}
