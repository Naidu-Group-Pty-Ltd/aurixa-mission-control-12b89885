import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listCloneScanJobs } from "@/lib/codex-security.functions";
import { SCAN_POLICY_SUMMARY } from "@/lib/codex-scan-policy";

/**
 * A clone's security, read-only. Clones are no longer scanned or fixed on
 * their own (src/lib/codex-scan-policy.ts): Prime is scanned every night, its
 * findings are fixed and merged there, and the cascade brings each fix here.
 * What remains is the clone's scan history from before.
 */
export function CloneCodexScansCard({ cloneId }: { cloneId: string }) {
  const jobsQ = useQuery({
    queryKey: ["clone-codex-jobs", cloneId],
    queryFn: () => listCloneScanJobs({ data: { cloneId } }),
  });
  const jobs: any[] = jobsQ.data?.jobs ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" /> Codex Security
          </CardTitle>
          <CardDescription>
            {SCAN_POLICY_SUMMARY} Fixes merged on Prime arrive here with the next cascade.
          </CardDescription>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to="/security/scans">Prime&apos;s scans and fixes</Link>
        </Button>
      </CardHeader>
      {jobs.length > 0 && (
        <CardContent>
          <h4 className="text-sm font-medium mb-2">Earlier scans of this clone</h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.slice(0, 10).map((j: any) => (
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
                    {j.completed_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}
