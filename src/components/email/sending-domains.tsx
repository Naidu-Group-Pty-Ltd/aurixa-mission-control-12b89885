/**
 * How a sending domain authenticates — SPF, DKIM, DMARC, MX — as a receiving
 * server reads it from DNS, with what to change. The warmup page lists every
 * domain in use; a campaign's Rules tab shows its own.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AuthFinding, DomainAuthReport, Severity } from "@/lib/email/domainAuth.pure";
import { getSendingDomains } from "@/lib/email-domains.functions";

const CHECK_LABELS: Record<AuthFinding["check"], string> = {
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  mx: "MX",
};

const VERDICT_TEXT: Record<Severity, string> = {
  ok: "authenticated",
  warn: "needs attention",
  bad: "failing",
  unknown: "could not check",
};

/** Severity as status: an icon and words, never colour alone. */
function SeverityIcon({ severity, className }: { severity: Severity; className?: string }) {
  const Icon =
    severity === "ok"
      ? CheckCircle2
      : severity === "bad"
        ? XCircle
        : severity === "warn"
          ? AlertTriangle
          : HelpCircle;
  return (
    <Icon
      aria-label={VERDICT_TEXT[severity]}
      className={cn(
        "h-4 w-4 shrink-0",
        severity === "ok" && "text-success",
        severity === "warn" && "text-warning",
        severity === "bad" && "text-destructive",
        severity === "unknown" && "text-muted-foreground",
        className,
      )}
    />
  );
}

export function VerdictBadge({ verdict }: { verdict: Severity }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-mono text-[10px]",
        verdict === "ok" && "text-success",
        verdict === "warn" && "text-warning",
        verdict === "bad" && "text-destructive",
        verdict === "unknown" && "text-muted-foreground",
      )}
    >
      <SeverityIcon severity={verdict} className="h-3 w-3" />
      {VERDICT_TEXT[verdict]}
    </Badge>
  );
}

/** One domain's four checks, each with what is true and what to change. */
export function DomainReport({ report }: { report: DomainAuthReport }) {
  return (
    <ul className="space-y-2">
      {report.findings.map((finding) => (
        <li key={finding.check} className="flex items-start gap-3">
          <SeverityIcon severity={finding.severity} className="mt-0.5" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm">
              <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">
                {CHECK_LABELS[finding.check]}
              </span>{" "}
              <span className="text-muted-foreground">{finding.summary}</span>
            </p>
            {finding.fix ? (
              <p className="text-xs text-foreground">
                <span className="text-muted-foreground">Fix: </span>
                {finding.fix}
              </p>
            ) : null}
            {finding.record ? (
              <p className="break-all font-mono text-[10px] text-muted-foreground">
                {finding.record}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Every domain the pool, the campaigns and the tenants send from. */
export function SendingDomainsPanel() {
  const [fresh, setFresh] = useState(0);
  const domains = useQuery({
    queryKey: ["email", "sending-domains", fresh],
    queryFn: () => getSendingDomains({ data: { fresh: fresh > 0 } }),
    staleTime: 10 * 60_000,
  });
  const rows = domains.data?.domains ?? [];
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="label-mono">sending domains</p>
          <p className="text-sm text-muted-foreground">
            Warmup earns a mailbox its reputation; these records are what let a receiver attach it
            to the domain. Mail that fails them is junked whatever its history.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setFresh((n) => n + 1)}
          disabled={domains.isFetching}
        >
          {domains.isFetching ? (
            <Loader2 className="mr-2 h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-3 w-3" />
          )}
          Check DNS again
        </Button>
      </div>
      {domains.error ? (
        <p className="font-mono text-xs text-destructive">{(domains.error as Error).message}</p>
      ) : domains.isLoading ? (
        <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Asking DNS…
        </p>
      ) : rows.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">
          No mailbox is warming or sending yet.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <div key={row.domain} className="glass space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-sm text-foreground">{row.domain}</p>
                <VerdictBadge verdict={row.report.verdict} />
              </div>
              <DomainReport report={row.report} />
              <p className="font-mono text-[10px] text-muted-foreground">
                Sent from by{" "}
                {row.usedBy
                  .slice(0, 4)
                  .map((entry) => `${entry.address} (${entry.as})`)
                  .join(", ")}
                {row.usedBy.length > 4 ? `, and ${row.usedBy.length - 4} more` : ""} · checked{" "}
                {formatDistanceToNow(new Date(row.report.checkedAt), { addSuffix: true })}
              </p>
            </div>
          ))}
        </div>
      )}
      {domains.data && domains.data.more > 0 ? (
        <p className="font-mono text-[10px] text-muted-foreground">
          {domains.data.more} more domain{domains.data.more === 1 ? "" : "s"} not shown.
        </p>
      ) : null}
    </section>
  );
}
