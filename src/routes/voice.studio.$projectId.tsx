// One cloning project: documents in, a cited plan, a reviewable package, and a
// verified deploy into the client's own VAPI org. Two approvals stand between
// the model and a live phone line - the plan's and the package's.
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { PageHeader } from "@/components/page-header";
import { MonoStatus } from "@/components/voice/tone";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getStudioProject } from "@/lib/voice-studio.functions";
import { DocumentsTab } from "@/components/voice-studio/documents-tab";
import { PlanTab } from "@/components/voice-studio/plan-tab";
import { PackageTab } from "@/components/voice-studio/package-tab";
import { DeployTab } from "@/components/voice-studio/deploy-tab";
import { statusOf, TARGET_LABEL } from "@/components/voice-studio/studio-vocab";

export const Route = createFileRoute("/voice/studio/$projectId")({
  component: () => (
    <ProtectedRoute>
      <StudioProjectPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Cloning project — Aurixa Mission Control" }] }),
});

function StudioProjectPage() {
  const { projectId } = Route.useParams();
  const qc = useQueryClient();
  const [tab, setTab] = useState("documents");
  const key = ["voice-studio", "project", projectId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => getStudioProject({ data: { id: projectId } }),
    // Planning and deploying happen on the worker; poll while either is live.
    refetchInterval: (query) => {
      const s = query.state.data?.project.status;
      return s === "planning" ||
        s === "deploying" ||
        query.state.data?.deployments.some((d) => d.status === "queued" || d.status === "running")
        ? 5000
        : 30000;
    },
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  if (q.isError) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not load this project: {(q.error as Error).message}
      </div>
    );
  }
  if (!q.data) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  const data = q.data;
  const s = statusOf(data.project.status);

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        eyebrow={
          <Link to="/voice/studio" className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> cloning studio
          </Link>
        }
        title={data.project.name}
        description={`${TARGET_LABEL[data.project.target_kind] ?? data.project.target_kind}${data.project.notes ? ` · ${data.project.notes}` : ""}`}
        actions={
          <MonoStatus
            label={s.label}
            tone={s.tone}
            pulse={data.project.status === "planning" || data.project.status === "deploying"}
          />
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="plan">
            Plan{data.plans.length ? ` v${data.plans[0].version}` : ""}
          </TabsTrigger>
          <TabsTrigger value="package">
            Package{data.packages.length ? ` v${data.packages[0].version}` : ""}
          </TabsTrigger>
          <TabsTrigger value="deploy">Deploy</TabsTrigger>
        </TabsList>
        <TabsContent value="documents" className="pt-4">
          <DocumentsTab data={data} refresh={refresh} />
        </TabsContent>
        <TabsContent value="plan" className="pt-4">
          <PlanTab data={data} refresh={refresh} onApproved={() => setTab("package")} />
        </TabsContent>
        <TabsContent value="package" className="pt-4">
          <PackageTab data={data} refresh={refresh} />
        </TabsContent>
        <TabsContent value="deploy" className="pt-4">
          <DeployTab data={data} refresh={refresh} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
