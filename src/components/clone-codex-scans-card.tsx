import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { PlayCircle, ShieldAlert, RefreshCw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listCloneScanJobs,
  listCloneOpenFindings,
  runCloneScanNow,
  setCloneNightly,
} from "@/lib/codex-security.functions";
import { supabase } from "@/integrations/supabase/client";

const sevColor: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-slate-500 text-white",
};

export function CloneCodexScansCard({ cloneId }: { cloneId: string }) {
  const qc = useQueryClient();

  const cloneCfgQ = useQuery({
    queryKey: ["clone-codex-cfg", cloneId],
    queryFn: async () => {
      const { data } = await supabase
        .from("clones")
        .select("codex_nightly_enabled")
        .eq("id", cloneId)
        .maybeSingle();
      return data;
    },
  });

  const jobsQ = useQuery({
    queryKey: ["clone-codex-jobs", cloneId],
    queryFn: () => listCloneScanJobs({ data: { cloneId } }),
    refetchInterval: 15000,
  });
  const findingsQ = useQuery({
    queryKey: ["clone-codex-open", cloneId],
    queryFn: () => listCloneOpenFindings({ data: { cloneId } }),
  });

  const runFn = useServerFn(runCloneScanNow);
  const setNightlyFn = useServerFn(setCloneNightly);

  const runNow = useMutation({
    mutationFn: () => runFn({ data: { cloneId } }),
    onSuccess: (r: any) => {
      if (r?.skipped) toast.info(`Skipped: ${r.reason}`);
      else toast.success("Scan queued");
      qc.invalidateQueries({ queryKey: ["clone-codex-jobs", cloneId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleNightly = useMutation({
    mutationFn: (v: boolean) => setNightlyFn({ data: { cloneId, enabled: v } }),
    onSuccess: () => {
      toast.success("Nightly preference saved");
      qc.invalidateQueries({ queryKey: ["clone-codex-cfg", cloneId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const open = findingsQ.data?.findings ?? [];
  const counts = open.reduce<Record<string, number>>((acc, f: any) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" /> Codex Security
          </CardTitle>
          <CardDescription>
            Autonomous scans, findings, and nightly schedule for this clone.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => jobsQ.refetch()}>
            <RefreshCw className="h-4 w-4 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <PlayCircle className="h-4 w-4 mr-1" />
            {runNow.isPending ? "Queuing…" : "Scan now"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between border p-3">
          <div>
            <Label className="font-medium">Include in nightly fleet scans</Label>
            <p className="text-xs text-muted-foreground">
              Governed by Prime's nightly cron. Disable to skip this clone.
            </p>
          </div>
          <Switch
            checked={cloneCfgQ.data?.codex_nightly_enabled !== false}
            onCheckedChange={(v) => toggleNightly.mutate(v)}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {["critical", "high", "medium", "low", "info"].map((s) => (
            <Badge key={s} className={sevColor[s]}>
              {s}: {counts[s] ?? 0}
            </Badge>
          ))}
        </div>

        <div>
          <h4 className="text-sm font-medium mb-2">Recent scans</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobsQ.data?.jobs ?? []).map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell>{j.kind}</TableCell>
                  <TableCell>
                    <Badge variant={j.status === "failed" ? "destructive" : "outline"}>
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {j.ref ? j.ref.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.started_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.completed_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
              {!jobsQ.isLoading && (jobsQ.data?.jobs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No scans yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {open.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Open findings</h4>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Severity</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>File</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {open.slice(0, 15).map((f: any) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <Badge className={sevColor[f.severity]}>{f.severity}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{f.title}</TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-xs">
                      {f.affected_file
                        ? `${f.affected_file}${f.affected_line ? `:${f.affected_line}` : ""}`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
