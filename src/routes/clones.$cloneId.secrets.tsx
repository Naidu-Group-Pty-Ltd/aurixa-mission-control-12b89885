import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  backfillCloneAllowedOrigins,
  listCloneBackendSecrets,
  setCloneBackendSecret,
} from "@/lib/backend-provisioning.functions";
import { AppShell } from "@/components/app-shell";
import { CloneEmailIdentityCard } from "@/components/clone-email-identity-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/clones/$cloneId/secrets")({
  head: () => ({
    meta: [{ title: "Clone secrets · Aurixa Mission Control" }],
  }),
  component: CloneSecretsPage,
});

type SecretRow = {
  name: string;
  status: "missing" | "set" | "failed" | "inherited";
  last_set_at: string | null;
  last_error: string | null;
  updated_at: string;
};

const STATUS_META: Record<
  SecretRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  set: { label: "Set", variant: "default" },
  inherited: { label: "Inherited from prime", variant: "secondary" },
  missing: { label: "Missing — action required", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
};

function CloneSecretsPage() {
  const { cloneId } = Route.useParams();
  const router = useRouter();
  const listFn = useServerFn(listCloneBackendSecrets);
  const setFn = useServerFn(setCloneBackendSecret);
  const backfillFn = useServerFn(backfillCloneAllowedOrigins);
  const [deriving, setDeriving] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-backend-secrets", cloneId],
    queryFn: async () => listFn({ data: { cloneId } }),
  });

  const secrets: SecretRow[] = data?.ok ? (data.secrets as SecretRow[]) : [];
  const missing = secrets.filter((s) => s.status === "missing" || s.status === "failed").length;

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">
              <Link to="/clones/$cloneId" params={{ cloneId }}>
                ← Back to clone
              </Link>
            </div>
            <h1 className="font-display text-[1.75rem] leading-[1.1]">Clone backend secrets</h1>
            <p className="text-sm text-muted-foreground">
              Values are written directly to the clone's Supabase project. Values are never stored
              in this dashboard.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {missing > 0 && (
              <Badge variant="destructive" className="text-sm">
                {missing} awaiting input
              </Badge>
            )}
            {/*
              ALLOWED_ORIGINS is the one deployment-config secret Mission
              Control can work out on its own, from this clone's own domains.
              Everything else in that class needs a person, which is why this
              is one button and not a "derive everything" sweep.
            */}
            <Button
              variant="outline"
              disabled={deriving}
              onClick={async () => {
                setDeriving(true);
                try {
                  const res = await backfillFn({ data: { cloneId } });
                  if (!res?.ok) {
                    toast.error(res?.error ?? "Could not derive ALLOWED_ORIGINS");
                  } else if (res.applied > 0) {
                    toast.success("ALLOWED_ORIGINS set from this clone's own domains");
                  } else {
                    const first = res.results.find((r) => !r.ok);
                    toast.error(
                      first && "error" in first ? first.error : "Nothing to derive for this clone",
                    );
                  }
                  await refetch();
                  await router.invalidate();
                } finally {
                  setDeriving(false);
                }
              }}
            >
              {deriving ? "Deriving…" : "Derive ALLOWED_ORIGINS"}
            </Button>
          </div>
        </div>

        {/*
          The dedicated email identity sits above the raw secret list because
          it is the intended way RESEND_API_KEY gets a value here — a
          domain-scoped key of the clone's own, not a pasted copy of the
          prime's. The list below still accepts a manual value for it, which
          stays correct as the escape hatch.
        */}
        <CloneEmailIdentityCard cloneId={cloneId} />

        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

        {!isLoading && data && !data.ok && (
          <div className="border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {data.error}
          </div>
        )}

        {!isLoading && secrets.length === 0 && (
          <div className="border p-6 text-sm text-muted-foreground">
            No secrets tracked for this clone yet. Once provisioning finishes, every secret
            referenced by the prime's edge functions will appear here.
          </div>
        )}

        <div className="space-y-3">
          {secrets.map((row) => (
            <SecretRowCard
              key={row.name}
              row={row}
              onSave={async (value) => {
                const res = await setFn({ data: { cloneId, name: row.name, value } });
                if (res?.ok) {
                  toast.success(`${row.name} updated on clone project`);
                  await refetch();
                  router.invalidate();
                } else {
                  toast.error(res?.error ?? "Failed to update secret");
                }
              }}
            />
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function SecretRowCard({ row, onSave }: { row: SecretRow; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const meta = STATUS_META[row.status];

  return (
    <div className="border p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-mono text-sm font-medium">{row.name}</div>
        <Badge variant={meta.variant}>{meta.label}</Badge>
      </div>
      {row.last_error && (
        <div className="mb-2 text-xs text-destructive">Last error: {row.last_error}</div>
      )}
      {row.last_set_at && (
        <div className="mb-2 text-xs text-muted-foreground">
          Last updated {new Date(row.last_set_at).toLocaleString()}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value) return;
          setSaving(true);
          try {
            await onSave(value);
            setValue("");
          } finally {
            setSaving(false);
          }
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            row.status === "set" || row.status === "inherited" ? "Replace value…" : "Paste value…"
          }
        />
        <Button type="submit" disabled={!value || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}
