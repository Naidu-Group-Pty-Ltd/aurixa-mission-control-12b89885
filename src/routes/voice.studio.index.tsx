// Voice Cloning Studio - every cloning project, and the door to a new one.
//
// A project takes a client business (an existing workspace, a lead, a signed
// agreement or a prospect) and its documents, and produces a voice agent fleet
// for it from the recipe book - the proven NPC / Mission Control stack.
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Plus, Wand2 } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import { EmptyState } from "@/components/empty-state";
import { MonoStatus } from "@/components/voice/tone";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  createStudioProject,
  listStudioProjects,
  listStudioTargets,
} from "@/lib/voice-studio.functions";
import { statusOf, TARGET_LABEL } from "@/components/voice-studio/studio-vocab";

export const Route = createFileRoute("/voice/studio/")({
  component: () => (
    <ProtectedRoute>
      <StudioListPage />
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Cloning Studio — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Plan and deploy a voice agent fleet for a client from the proven NPC voice stack.",
      },
    ],
  }),
});

function StudioListPage() {
  const q = useQuery({
    queryKey: ["voice-studio", "projects"],
    queryFn: () => listStudioProjects(),
    refetchInterval: 15000,
  });
  const projects = q.data ?? [];
  const count = (s: string[]) => projects.filter((p) => s.includes(p.status)).length;

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow="voice operations"
        title="Cloning Studio"
        description="Give the planning agent a client's documents and it designs their voice fleet from the recipe book - the NPC stack that is live on real phone lines - with a cited plan, a reviewable build package and a verified deploy into the client's own VAPI org."
        actions={<NewProjectDialog />}
      />

      <div className="glass grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        <MetricCell label="projects" value={projects.length} />
        <MetricCell
          label="awaiting review"
          value={count(["plan_ready", "package_ready"])}
          tone="warning"
          alarm={count(["plan_ready", "package_ready"]) > 0}
        />
        <MetricCell label="deployed" value={count(["deployed"])} />
        <MetricCell
          label="needs attention"
          value={count(["failed"])}
          tone="destructive"
          alarm={count(["failed"]) > 0}
        />
      </div>

      {!q.isLoading && projects.length === 0 && (
        <EmptyState
          icon={<Wand2 />}
          title="No cloning projects yet"
          description="Start one for an existing workspace, a lead, a signed agreement or a prospect, then upload the client's documents."
          action={<NewProjectDialog />}
        />
      )}

      <div className="space-y-2">
        {projects.map((p) => {
          const s = statusOf(p.status);
          return (
            <Link
              key={p.id}
              to="/voice/studio/$projectId"
              params={{ projectId: p.id }}
              className="block"
            >
              <RecordRow
                spine={s.spine}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/30"
              >
                <Wand2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {TARGET_LABEL[p.target_kind] ?? p.target_kind} · {p.document_count} document
                    {p.document_count === 1 ? "" : "s"} · updated{" "}
                    {formatDistanceToNow(new Date(p.updated_at), { addSuffix: true })}
                  </p>
                </div>
                <MonoStatus
                  label={s.label}
                  tone={s.tone}
                  pulse={p.status === "planning" || p.status === "deploying"}
                />
              </RecordRow>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function NewProjectDialog() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"clone" | "lead" | "agreement" | "prospect">("prospect");
  const [targetId, setTargetId] = useState("");
  const [notes, setNotes] = useState("");
  const targets = useQuery({
    queryKey: ["voice-studio", "targets"],
    queryFn: () => listStudioTargets(),
    enabled: open,
  });

  const options =
    kind === "clone"
      ? targets.data?.clones
      : kind === "lead"
        ? targets.data?.leads
        : kind === "agreement"
          ? targets.data?.agreements
          : [];

  const create = useMutation({
    mutationFn: () =>
      createStudioProject({
        data: {
          name,
          targetKind: kind,
          cloneId: kind === "clone" ? targetId : null,
          leadId: kind === "lead" ? targetId : null,
          agreementId: kind === "agreement" ? targetId : null,
          notes,
        },
      }),
    onSuccess: ({ id }) => {
      setOpen(false);
      navigate({ to: "/voice/studio/$projectId", params: { projectId: id } });
    },
    onError: (e: Error) => toast.error("Could not create the project", { description: e.message }),
  });

  const pick = (id: string) => {
    setTargetId(id);
    const label = options?.find((o) => o.id === id)?.label;
    if (label && !name.trim()) setName(label);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" /> New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New cloning project</DialogTitle>
          <DialogDescription>
            Who is the fleet for? What Mission Control already knows about them is given to the
            planner alongside their documents, with contact details removed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Client</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as typeof kind);
                setTargetId("");
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["prospect", "lead", "agreement", "clone"] as const).map((k) => (
                  <SelectItem key={k} value={k}>
                    {TARGET_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {kind !== "prospect" && (
            <div className="space-y-1.5">
              <Label>{TARGET_LABEL[kind]}</Label>
              <Select value={targetId} onValueChange={pick}>
                <SelectTrigger>
                  <SelectValue placeholder={targets.isLoading ? "Loading..." : "Choose one"} />
                </SelectTrigger>
                <SelectContent>
                  {(options ?? []).map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                      {"detail" in o && o.detail ? ` · ${o.detail}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="studio-name">Project name</Label>
            <Input
              id="studio-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Harbourside Dental"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="studio-notes">Notes for the planner (optional)</Label>
            <Textarea
              id="studio-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What the client asked for, what must not change, anything the documents will not say."
            />
          </div>
          <Button
            className="w-full"
            disabled={
              name.trim().length < 2 || (kind !== "prospect" && !targetId) || create.isPending
            }
            onClick={() => create.mutate()}
          >
            Create project
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
