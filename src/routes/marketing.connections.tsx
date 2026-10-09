// Connections: the accounts the Marketing module reads, and the credentials it
// reads them with.
//
// Operators see what is connected; administrators connect, test and remove.
// A credential is encrypted before it is stored, it is never sent back to a
// browser — this page shows its fingerprint — and leaving a credential field
// blank on a later save keeps the stored one. Every save is checked against
// the vendor first: a token the vendor refuses is not saved.
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RecordRow } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import {
  getMarketingConnections,
  removeMarketingConnection,
  saveMarketingConnection,
  testMarketingConnection,
} from "@/lib/marketing.functions";
import { SOURCE_DEFINITIONS, type MarketingSource } from "@/lib/marketing/connectionFields.pure";
import { useUserRoles } from "@/lib/use-user-roles";

export const Route = createFileRoute("/marketing/connections")({
  component: ConnectionsPage,
  head: () => ({ meta: [{ title: "Connections — Marketing — Aurixa Systems Mission Control" }] }),
});

type Status = Awaited<ReturnType<typeof getMarketingConnections>>["connections"][number];

function when(value: string | null): string {
  if (!value) return "never";
  try {
    return format(parseISO(value), "d MMM yyyy, h:mm a");
  } catch {
    return value;
  }
}

function ConnectionsPage() {
  const listFn = useServerFn(getMarketingConnections);
  const q = useQuery({ queryKey: ["marketing", "connections"], queryFn: () => listFn() });
  const { isAdmin } = useUserRoles();

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {(q.error as Error).message}
      </p>
    );
  }
  return (
    <div className="space-y-5">
      {q.data && !q.data.encryption && (
        <RecordRow spine="bad" className="px-4 py-3 text-sm" role="alert">
          <p className="font-medium">Credentials cannot be stored yet</p>
          <p className="mt-1 text-muted-foreground">
            CREDENTIALS_ENC_KEY is not set on this deployment, so nothing can be encrypted, and a
            credential is never stored in plain text. Set it, then connect sources here.
          </p>
        </RecordRow>
      )}
      {!isAdmin && (
        <p className="font-mono text-[10px] text-muted-foreground">
          connecting, testing or removing a source needs an administrator
        </p>
      )}
      {(q.data?.connections ?? []).map((status) => (
        <ConnectionCard
          key={status.source}
          status={status}
          canEdit={isAdmin && !!q.data?.encryption}
        />
      ))}
      {q.isLoading && <p className="text-sm text-muted-foreground">Reading connections…</p>}
    </div>
  );
}

function ConnectionCard({ status, canEdit }: { status: Status; canEdit: boolean }) {
  const def = SOURCE_DEFINITIONS[status.source as MarketingSource];
  const qc = useQueryClient();
  const saveFn = useServerFn(saveMarketingConnection);
  const testFn = useServerFn(testMarketingConnection);
  const removeFn = useServerFn(removeMarketingConnection);
  const [settings, setSettings] = useState<Record<string, string>>(status.settings);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState("");
  const confirm = useConfirm();

  useEffect(() => setSettings(status.settings), [status.settings]);

  const invalid = def.fields.find(
    (f) =>
      !f.secret &&
      f.pattern &&
      (settings[f.key] ?? "").trim() &&
      !f.pattern.test((settings[f.key] ?? "").trim()),
  );

  const save = async () => {
    setBusy("save");
    setError("");
    try {
      const answer = await saveFn({
        data: { source: status.source as MarketingSource, settings, secrets },
      });
      if (answer.ok) {
        toast.success(
          `${def.label} connected${answer.status.accountName ? ` — ${answer.status.accountName}` : ""}`,
        );
        setSecrets({});
        qc.invalidateQueries({ queryKey: ["marketing"] });
      } else {
        setError(answer.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The connection could not be saved.");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setError("");
    try {
      const answer = await testFn({ data: { source: status.source as MarketingSource } });
      if (answer.ok)
        toast.success(
          `${def.label} answered${answer.accountName ? ` for ${answer.accountName}` : ""}`,
        );
      else setError(answer.error);
      qc.invalidateQueries({ queryKey: ["marketing", "connections"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The test could not run.");
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Remove ${def.label}?`,
      description:
        "The stored credentials are deleted. The figures already recorded stay; nothing new is read until it is connected again.",
      confirmText: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy("remove");
    try {
      await removeFn({ data: { source: status.source as MarketingSource } });
      toast.success(`${def.label} removed`);
      setSettings({});
      setSecrets({});
      qc.invalidateQueries({ queryKey: ["marketing"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The connection could not be removed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <CardTitle className="text-base">{def.label}</CardTitle>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            {status.configured
              ? `connected${status.accountName ? ` · ${status.accountName}` : ""}`
              : "not connected"}
          </span>
        </div>
        <CardDescription>{def.provides}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(status.configured || status.lastError) && (
          <RecordRow
            spine={status.lastError ? "warn" : "ok"}
            className="px-4 py-2 font-mono text-[11px] text-muted-foreground"
          >
            verified {when(status.verifiedAt)} · last checked {when(status.lastCheckedAt)}
            {status.lastError && (
              <span className="mt-1 block text-foreground">last check: {status.lastError}</span>
            )}
          </RecordRow>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          {def.fields.map((f) => {
            const id = `${status.source}-${f.key}`;
            const stored = status.fingerprints[f.key];
            return (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={id} className="label-mono">
                  {f.label}
                  {f.required ? "" : " · optional"}
                </Label>
                {f.secret ? (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="off"
                    disabled={!canEdit}
                    value={secrets[f.key] ?? ""}
                    placeholder={stored ? `stored ${stored} — leave blank to keep` : "not set"}
                    onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                ) : (
                  <Input
                    id={id}
                    disabled={!canEdit}
                    value={settings[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                )}
                {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
              </div>
            );
          })}
        </div>

        {invalid && (
          <p className="text-xs text-destructive">{`${invalid.label}: ${invalid.invalid ?? "not a valid value"}`}</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={busy !== null || !!invalid}>
              {busy === "save"
                ? "Checking with the vendor…"
                : status.configured
                  ? "Save changes"
                  : "Connect"}
            </Button>
            {status.configured && (
              <Button size="sm" variant="outline" onClick={test} disabled={busy !== null}>
                {busy === "test" ? "Testing…" : "Test"}
              </Button>
            )}
            {(status.configured || Object.keys(status.fingerprints).length > 0) && (
              <Button size="sm" variant="ghost" onClick={remove} disabled={busy !== null}>
                Remove
              </Button>
            )}
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            where these come from
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            {def.setup.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      </CardContent>
    </Card>
  );
}
