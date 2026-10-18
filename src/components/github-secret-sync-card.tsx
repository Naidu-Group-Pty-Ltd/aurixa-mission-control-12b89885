import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/confirm-dialog";
import {
  syncPrimeActionsSecrets,
  syncCloneActionsSecrets,
  syncAllCloneActionsSecrets,
  listGithubSecretSyncs,
  previewActionsSecrets,
} from "@/lib/github-secrets.functions";

type Props = { target: "prime" } | { target: "clone"; cloneId: string } | { target: "fleet" };

export function GitHubSecretSyncCard(props: Props) {
  const confirm = useConfirm();
  const syncPrime = useServerFn(syncPrimeActionsSecrets);
  const syncClone = useServerFn(syncCloneActionsSecrets);
  const syncAll = useServerFn(syncAllCloneActionsSecrets);
  const list = useServerFn(listGithubSecretSyncs);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<any>(null);

  const listInput =
    props.target === "clone"
      ? { cloneId: props.cloneId, limit: 5 }
      : props.target === "prime"
        ? { targetKind: "prime" as const, limit: 5 }
        : { limit: 10 };

  const { data, refetch } = useQuery({
    queryKey: ["github-secret-syncs", props.target, (props as any).cloneId],
    queryFn: async () => list({ data: listInput }),
  });

  // What a sync would actually push. Shown up front so "0 written" is
  // explained before the operator clicks, not after.
  const previewQ = useQuery({
    queryKey: ["github-secret-preview"],
    queryFn: () => previewActionsSecrets(),
    staleTime: 60_000,
  });
  const preview = previewQ.data;

  const rows: any[] = data?.rows ?? [];
  const last = rows[0];

  const isPrime = props.target === "prime";

  async function run() {
    if (!isPrime) {
      const ok = await confirm({
        title:
          props.target === "clone"
            ? "Remove the Codex secrets from this clone's repo?"
            : "Remove the Codex secrets from every clone repo?",
        description:
          "Deletes OPENAI_API_KEY, CODEX_SECURITY_API_KEY, ANTHROPIC_API_KEY, the callback URLs and the old signing secrets from the repository's Actions secrets. Clones no longer run the Codex workflows, and only those workflows read these names.",
        confirmText: "Remove",
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setLastRun(null);
    try {
      const res: any =
        props.target === "prime"
          ? await syncPrime()
          : props.target === "clone"
            ? await syncClone({ data: { cloneId: props.cloneId } })
            : await syncAll();

      setLastRun(res);

      // Every handler now returns an explicit boolean `ok` plus a `message`,
      // so success and failure are no longer inferred from a count.
      if (res?.ok) {
        toast.success(res.message ?? "Sync complete");
      } else if (res?.nothingConfigured) {
        toast.warning(res.message ?? "No secrets configured to push");
      } else {
        toast.error(res?.error ?? res?.message ?? "Sync failed — see details below");
      }

      if (res?.historyError) {
        toast.warning("Sync ran, but the history row could not be written.");
      }

      await refetch();
    } catch (e: any) {
      const message = e?.message ?? "Sync failed";
      setLastRun({ ok: false, error: message });
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const label =
    props.target === "prime"
      ? "Sync to Prime repo"
      : props.target === "clone"
        ? "Remove Codex secrets from this clone"
        : "Remove Codex secrets from all clones";

  const missingRequired = preview?.missingRequired ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> GitHub Actions secrets
          {props.target === "fleet" && (
            <Badge variant="outline" className="text-[10px] uppercase">
              fleet
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {isPrime ? (
            <>
              Pushes the Codex Security workflow secrets — the Codex and Claude model keys — into
              Prime&apos;s repository using the Aurixa GitHub App and sealed-box encryption; values
              never appear in the browser. Also removes the callback-signing masters earlier syncs
              wrote there. Requires the App installation to hold{" "}
              <strong>Secrets: read &amp; write</strong>.
            </>
          ) : (
            <>
              Clones are neither scanned nor fixed on their own — Prime&apos;s fixes reach them
              through the cascade — so their repositories need no Codex secrets. This removes the
              ones earlier syncs wrote.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* What will be pushed */}
        {isPrime && preview && (
          <div className="space-y-1 border p-2 text-xs">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              will push {preview.configuredCount}/{preview.entries.length} secrets
            </div>
            {preview.entries.map((e: any) => (
              <div key={e.name} className="flex items-start gap-2">
                {e.configured ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                ) : (
                  <XCircle
                    className={`mt-0.5 h-3 w-3 shrink-0 ${
                      e.required ? "text-red-500" : "text-muted-foreground"
                    }`}
                  />
                )}
                <div className="min-w-0">
                  <span className="font-mono">{e.name}</span>
                  {e.required && !e.configured && (
                    <Badge variant="destructive" className="ml-2 text-[9px]">
                      required
                    </Badge>
                  )}
                  {e.purpose && (
                    <div className="text-muted-foreground break-words">{e.purpose}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {isPrime && missingRequired.length > 0 && (
          <div className="flex items-start gap-2 border border-warning/40 bg-warning/5 p-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <div>
              <span className="font-mono">{missingRequired.join(", ")}</span> is not configured in
              Mission Control. Scans still run gitleaks, semgrep and osv-scanner, but findings the
              missing key&apos;s engine fixes (Claude: P0/P1, Codex: P2 and below) cannot be fixed.
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={run} disabled={busy}>
            {busy ? (isPrime ? "Syncing…" : "Removing…") : label}
          </Button>
          {last && (
            <div className="text-xs text-muted-foreground">
              Last: {new Date(last.created_at).toLocaleString()}{" "}
              <Badge variant={last.ok ? "default" : "destructive"} className="ml-1">
                {last.ok ? "ok" : "failed"}
              </Badge>
            </div>
          )}
        </div>

        {/* Per-repo outcome of the fleet run just performed */}
        {lastRun?.results?.length > 0 && (
          <div className="space-y-1 border p-2 text-xs">
            {lastRun.results.map((r: any) => (
              <div key={r.cloneId} className="flex items-start justify-between gap-2">
                <span className="truncate font-mono">{r.target}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {!r.ok && <span className="text-destructive">{r.error}</span>}
                  <Badge variant={r.ok ? "secondary" : "destructive"}>
                    {r.ok ? `+${r.written}` : "err"}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Failure detail for a single-repo run */}
        {lastRun && !lastRun.ok && !lastRun.results && (
          <div className="border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive">
            {lastRun.failed?.length
              ? lastRun.failed.map((f: any) => (
                  <div key={f.name} className="break-words">
                    {f.name}: {f.error}
                  </div>
                ))
              : lastRun.error}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-1 border p-2 text-xs">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              history
            </div>
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2">
                <div className="truncate font-mono">
                  {r.owner}/{r.repo}
                  <span className="ml-2 text-muted-foreground">· {r.trigger_source}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    +{r.written?.length ?? 0} wrote
                    {r.failed?.length ? ` · ${r.failed.length} failed` : ""}
                  </span>
                  <Badge variant={r.ok ? "secondary" : "destructive"}>{r.ok ? "ok" : "err"}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {last?.failed?.length > 0 && (
          <div className="border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive">
            {last.failed.map((f: any) => (
              <div key={f.name} className="break-words">
                {f.name}: {f.error}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
