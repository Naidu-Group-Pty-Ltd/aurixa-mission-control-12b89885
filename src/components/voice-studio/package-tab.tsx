// Package tab: exactly what will be written into the client's VAPI org - every
// system prompt, every tool, the knowledge-base file, the squad - and the
// second approval. A package is immutable and hashed; the diff shows what moved
// since the previous version, so a re-approval is a review of the change.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Package } from "lucide-react";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { MonoStatus } from "@/components/voice/tone";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { approveStudioPackage, getStudioPackageDiff } from "@/lib/voice-studio.functions";
import { hunks, type DiffLine } from "@/lib/voice-studio/diff.pure";
import type { BuildPackage } from "@/lib/voice-studio/package.pure";
import { TOOL_CATALOG, BACKEND_MENU } from "@/lib/voice-recipe/tools.pure";
import type { StudioProjectData } from "./types";

export function PackageTab({ data, refresh }: { data: StudioProjectData; refresh: () => void }) {
  const pkg = data.currentPackage as unknown as BuildPackage | null;
  const row = data.packages.find((p) => p.id === data.project.current_package_id) ?? null;
  const previous = row
    ? (data.packages.find((p) => p.version < row.version && p.status !== "draft") ??
      data.packages.find((p) => p.version < row.version) ??
      null)
    : null;
  const [view, setView] = useState<string>("summary");

  const diff = useQuery({
    queryKey: ["voice-studio", "diff", previous?.id ?? null, row?.id],
    queryFn: () => getStudioPackageDiff({ data: { fromId: previous!.id, toId: row!.id } }),
    enabled: Boolean(row && previous),
  });

  const approve = useMutation({
    mutationFn: () => approveStudioPackage({ data: { packageId: row!.id } }),
    onSuccess: () => {
      toast.success("Package approved - it can be deployed");
      refresh();
    },
    onError: (e: Error) => toast.error("Could not approve", { description: e.message }),
  });

  if (!pkg || !row) {
    return (
      <EmptyState
        icon={<Package />}
        title="No package yet"
        description="Approving a plan compiles it into a package: the exact prompts, tools, knowledge base and squad that deploy will write."
      />
    );
  }

  const agent = pkg.agents.find((a) => a.key === view);

  return (
    <div className="space-y-6">
      <div className="glass flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            Package v{row.version} · {pkg.agents.length} assistant
            {pkg.agents.length === 1 ? "" : "s"} · {pkg.tools.length} tool
            {pkg.tools.length === 1 ? "" : "s"}
            {pkg.kb ? ` · knowledge base ${Math.round(pkg.kb.bytes / 1024)} KB` : ""}
            {pkg.squad ? " · squad" : ""}
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            sha256 {pkg.contentSha256.slice(0, 16)}... · recipe book v{pkg.recipeVersion}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MonoStatus
            label={row.status}
            tone={
              row.status === "approved" ? "success" : row.status === "draft" ? "warning" : "neutral"
            }
          />
          {row.status === "draft" && (
            <Button onClick={() => approve.mutate()} disabled={approve.isPending}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Approve package
            </Button>
          )}
        </div>
      </div>

      {pkg.prerequisites.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Deploy will need: {pkg.prerequisites.map((p) => p.replace(/_/g, " ")).join(", ")} - set
          them on the Deploy tab.
        </p>
      )}

      {diff.data && (
        <section className="space-y-2">
          <p className="label-mono">Since v{previous?.version}</p>
          <div className="flex flex-wrap gap-1.5">
            {diff.data.agents.map((a) => (
              <Badge key={a.key} variant={a.status === "same" ? "outline" : "secondary"}>
                {a.key}: {a.status}
                {a.status === "changed" ? ` +${a.added} -${a.removed}` : ""}
              </Badge>
            ))}
            <Badge variant={diff.data.kb.status === "same" ? "outline" : "secondary"}>
              knowledge base: {diff.data.kb.status}
              {diff.data.kb.status === "changed"
                ? ` +${diff.data.kb.added} -${diff.data.kb.removed}`
                : ""}
            </Badge>
            {diff.data.tools
              .filter((t) => t.status !== "same")
              .map((t) => (
                <Badge key={t.key} variant="secondary">
                  tool {t.key}: {t.status}
                </Badge>
              ))}
            {diff.data.squadChanged && <Badge variant="secondary">squad changed</Badge>}
          </div>
          {diff.data.agents
            .filter((a) => a.status === "changed" && a.lines?.length)
            .map((a) => (
              <details key={a.key} className="glass p-3">
                <summary className="cursor-pointer text-xs font-medium">
                  {a.key} prompt changes
                </summary>
                <DiffView lines={a.lines!} />
              </details>
            ))}
        </section>
      )}

      <div className="flex flex-wrap gap-1.5">
        {["summary", ...pkg.agents.map((a) => a.key), ...(pkg.kb ? ["kb"] : [])].map((k) => (
          <Button
            key={k}
            size="sm"
            variant={view === k ? "default" : "outline"}
            onClick={() => setView(k)}
          >
            {k === "summary"
              ? "Summary"
              : k === "kb"
                ? "Knowledge base"
                : (pkg.agents.find((a) => a.key === k)?.persona ?? k)}
          </Button>
        ))}
      </div>

      {view === "summary" && (
        <div className="space-y-4">
          <section className="space-y-2">
            <p className="label-mono">Assistants</p>
            {pkg.agents.map((a) => (
              <RecordRow key={a.key} spine="idle" className="px-4 py-2.5">
                <p className="text-sm font-medium">{a.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {a.direction}
                  {a.outboundTrigger ? ` · ${a.outboundTrigger.replace(/_/g, " ")}` : ""} ·{" "}
                  {a.toolKeys.join(", ")} · {a.systemPrompt.length.toLocaleString("en-AU")} chars
                </p>
              </RecordRow>
            ))}
          </section>
          <section className="space-y-2">
            <p className="label-mono">Org tools</p>
            {pkg.tools.map((t) => (
              <RecordRow
                key={t.key}
                spine="idle"
                className="flex items-center justify-between px-4 py-2"
              >
                <span className="text-sm">{TOOL_CATALOG[t.key].label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {BACKEND_MENU[t.backend].label}
                </span>
              </RecordRow>
            ))}
          </section>
          {pkg.squad && (
            <section className="space-y-1">
              <p className="label-mono">Squad</p>
              <p className="text-sm">{pkg.squad.name}</p>
            </section>
          )}
          {pkg.openItems.length > 0 && (
            <section className="space-y-2">
              <p className="label-mono">Carried open items</p>
              {pkg.openItems.map((o, i) => (
                <RecordRow key={i} spine="warn" className="px-4 py-2">
                  <p className="text-sm">{o.title}</p>
                  <p className="text-xs text-muted-foreground">{o.detail}</p>
                </RecordRow>
              ))}
            </section>
          )}
        </div>
      )}

      {agent && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="label-mono">
              {agent.name} · system prompt · sha256 {agent.systemPromptSha256.slice(0, 12)}...
            </p>
            <CopyButton value={agent.systemPrompt} />
          </div>
          <pre className="glass max-h-[36rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed">
            {agent.systemPrompt}
          </pre>
        </section>
      )}

      {view === "kb" && pkg.kb && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="label-mono">
              {pkg.kb.fileName} · {pkg.kb.mimetype} · {pkg.kb.bytes.toLocaleString("en-AU")} bytes
            </p>
            <CopyButton value={pkg.kb.text} />
          </div>
          <pre className="glass max-h-[36rem] overflow-auto whitespace-pre-wrap p-5 font-mono text-xs leading-relaxed">
            {pkg.kb.text}
          </pre>
        </section>
      )}
    </div>
  );
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="mt-2 max-h-96 overflow-auto font-mono text-[11px] leading-relaxed">
      {hunks(lines).map((l, i) =>
        l.op === "skip" ? (
          <div key={i} className="text-muted-foreground">
            ... {l.count} unchanged line{l.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div
            key={i}
            className={
              l.op === "add"
                ? "text-success"
                : l.op === "del"
                  ? "text-destructive"
                  : "text-muted-foreground"
            }
          >
            {l.op === "add" ? "+ " : l.op === "del" ? "- " : "  "}
            {l.text}
          </div>
        ),
      )}
    </pre>
  );
}
