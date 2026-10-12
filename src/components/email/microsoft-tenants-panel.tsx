/**
 * The Microsoft tenants campaigns can send through, and — for an admin — the
 * form that adds, rotates, re-verifies and removes them.
 *
 * The deployment's own tenant is the one in its Lovable secrets
 * (MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
 * MICROSOFT_MAILBOX_EMAIL) and is changed there. Every other tenant is entered
 * here: the same four values, stored encrypted in Supabase Vault and, like a
 * secret, write-only — the page shows a hint of each, never the value.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Building2,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RecordRow, type SpineTone } from "@/components/record-row";
import { useConfirm } from "@/components/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  LABEL_MAX,
  tenantChangeProblems,
  tenantInputProblems,
} from "@/lib/email/microsoftTenants.pure";
import {
  addMicrosoftTenant,
  removeMicrosoftTenant,
  updateMicrosoftTenant,
  verifyMicrosoftTenant,
} from "@/lib/microsoft-tenants.functions";
import {
  hintLine,
  useMicrosoftTenants,
  type TenantSummary,
} from "@/components/email/use-microsoft-tenants";

const GRAPH_ROLES: { role: string; why: string; required?: boolean }[] = [
  { role: "Mail.Send", why: "send campaign messages", required: true },
  { role: "Mail.Read", why: "read bounces, check mailboxes" },
  { role: "Mail.ReadWrite", why: "attachments over about 2.9 MB" },
  { role: "User.ReadBasic.All", why: "list the tenant's mailboxes" },
];

function spineFor(tenant: TenantSummary): SpineTone {
  if (!tenant.configured || tenant.expiry === "expired") return "bad";
  if (tenant.verifyError || tenant.expiry === "soon") return "warn";
  return tenant.isDefault || tenant.verifiedAt ? "ok" : "idle";
}

function usageLine(tenant: TenantSummary): string {
  const { running, other } = tenant.campaigns;
  const total = running + other;
  if (total === 0) return "no open campaigns";
  return `${total} open campaign${total === 1 ? "" : "s"}${running ? ` (${running} running)` : ""}`;
}

export function MicrosoftTenantsPanel() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const tenantsQuery = useMicrosoftTenants();
  const [editing, setEditing] = useState<TenantSummary | "new" | null>(null);

  const refreshAll = () => qc.invalidateQueries({ queryKey: ["email"] });

  const verify = useMutation({
    mutationFn: (tenantId: string | null) => verifyMicrosoftTenant({ data: { tenantId } }),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Microsoft issued a token with these credentials", {
          description: result.roles?.length
            ? `Granted: ${result.roles.join(", ")}`
            : "The token carries no application roles — mailbox access may come from Exchange RBAC for Applications instead.",
        });
      } else {
        toast.error("Microsoft did not accept these credentials", {
          description: result.error ?? undefined,
        });
      }
      void refreshAll();
    },
    onError: (error: Error) => toast.error("Could not verify", { description: error.message }),
  });

  const remove = useMutation({
    mutationFn: (tenantId: string) => removeMicrosoftTenant({ data: { tenantId } }),
    onSuccess: () => {
      toast.success("Tenant removed and its credentials deleted");
      void refreshAll();
    },
    onError: (error: Error) => toast.error("Could not remove", { description: error.message }),
  });

  const listing = tenantsQuery.data;
  const tenants = listing?.tenants ?? [];
  const canManage = listing?.canManage ?? false;

  return (
    <div className="space-y-4">
      <div className="glass-inset spine spine-idle flex flex-wrap items-start gap-3 px-4 py-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1 text-sm text-muted-foreground">
          <p>
            Each campaign sends through one Microsoft tenant, chosen on its Message tab. The
            deployment&apos;s own tenant comes from its Lovable secrets; add others here with the
            same four values from their Azure app registration.
          </p>
          <p className="font-mono text-[11px]">
            Credentials entered here are tried with Microsoft before they are saved, stored
            encrypted in Supabase Vault, and never shown again — like a secret, they can be replaced
            but not read back.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" />
            Add tenant
          </Button>
        ) : listing ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Only an admin can add or change tenants.
          </p>
        ) : null}
      </div>

      {tenantsQuery.isLoading ? (
        <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Reading tenants…
        </p>
      ) : null}
      {tenantsQuery.error ? (
        <p className="font-mono text-xs text-destructive">
          {(tenantsQuery.error as Error).message}
        </p>
      ) : null}

      <div className="space-y-2">
        {tenants.map((tenant) => (
          <RecordRow
            key={tenant.id ?? "default"}
            spine={spineFor(tenant)}
            className="flex flex-wrap items-start gap-3 px-4 py-3"
          >
            <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{tenant.label}</span>
                {tenant.isDefault ? (
                  <Badge variant="secondary" className="font-mono text-[10px]">
                    default · Lovable secrets
                  </Badge>
                ) : null}
                <StatusBadges tenant={tenant} />
              </div>
              <p className="font-mono text-xs text-muted-foreground">
                {[
                  hintLine(tenant) ??
                    (tenant.isDefault
                      ? "MICROSOFT_TENANT_ID, _CLIENT_ID and _CLIENT_SECRET are not all set"
                      : null),
                  tenant.defaultMailbox
                    ? `default mailbox ${tenant.defaultMailbox}`
                    : "no default mailbox",
                  usageLine(tenant),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {tenant.verifyError ? (
                <p className="font-mono text-[11px] leading-snug text-destructive">
                  Last check: {tenant.verifyError}
                </p>
              ) : null}
              {tenant.grantedRoles ? <RoleLine roles={tenant.grantedRoles} /> : null}
              {tenant.isDefault ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  Changed in Lovable → Project settings → Secrets, then republished.
                </p>
              ) : null}
            </div>
            {canManage ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  title="Ask Microsoft for a token with the stored credentials now"
                  disabled={!tenant.configured || verify.isPending}
                  onClick={() => verify.mutate(tenant.id)}
                >
                  {verify.isPending && verify.variables === tenant.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  <span className="ml-1 hidden sm:inline">Verify</span>
                </Button>
                {tenant.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Rename, change the default mailbox, or replace the credentials"
                      onClick={() => setEditing(tenant)}
                    >
                      <Pencil className="h-3 w-3" />
                      <span className="ml-1 hidden sm:inline">Edit</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Remove this tenant and delete its credentials"
                      disabled={remove.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove ${tenant.label}?`,
                          description:
                            "Its credentials are deleted from the Vault. A campaign that sends through it must be moved to another tenant before it can start again; the record of what it already sent is kept. A running campaign on this tenant has to be paused first.",
                          confirmText: "Remove",
                          destructive: true,
                        });
                        if (ok && tenant.id) remove.mutate(tenant.id);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
          </RecordRow>
        ))}
      </div>

      {editing ? (
        <TenantFormDialog
          tenant={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refreshAll();
          }}
        />
      ) : null}
    </div>
  );
}

function StatusBadges({ tenant }: { tenant: TenantSummary }) {
  const badges: { text: string; tone: "ok" | "warn" | "bad" }[] = [];
  if (!tenant.configured) badges.push({ text: "not configured", tone: "bad" });
  else if (tenant.verifyError) badges.push({ text: "credentials refused", tone: "bad" });
  else if (tenant.verifiedAt) {
    badges.push({
      text: `verified ${formatDistanceToNow(new Date(tenant.verifiedAt), { addSuffix: true })}`,
      tone: "ok",
    });
  }
  if (tenant.expiry === "expired") badges.push({ text: "secret expired", tone: "bad" });
  else if (tenant.expiry === "soon" && tenant.secretExpiresOn) {
    badges.push({ text: `secret expires ${tenant.secretExpiresOn}`, tone: "warn" });
  }
  return (
    <>
      {badges.map((badge) => (
        <Badge
          key={badge.text}
          variant="outline"
          className={cn(
            "font-mono text-[10px]",
            badge.tone === "ok" && "text-success",
            badge.tone === "warn" && "text-warning",
            badge.tone === "bad" && "text-destructive",
          )}
        >
          {badge.text}
        </Badge>
      ))}
    </>
  );
}

function RoleLine({ roles }: { roles: string[] }) {
  const held = new Set(roles);
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
      {GRAPH_ROLES.map(({ role, why }) => {
        // Mail.ReadWrite covers reading too, and User.Read.All covers the basic listing.
        const has =
          held.has(role) ||
          (role === "Mail.Read" && held.has("Mail.ReadWrite")) ||
          (role === "User.ReadBasic.All" &&
            (held.has("User.Read.All") || held.has("Directory.Read.All")));
        return (
          <span key={role} title={why} className={has ? "text-success" : undefined}>
            {has ? "✓" : "–"} {role}
          </span>
        );
      })}
    </p>
  );
}

type FormState = {
  label: string;
  directoryTenantId: string;
  clientId: string;
  clientSecret: string;
  defaultMailbox: string;
  secretExpiresOn: string;
};

function TenantFormDialog({
  tenant,
  onClose,
  onSaved,
}: {
  /** null to add one. */
  tenant: TenantSummary | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const adding = tenant === null;
  const [form, setForm] = useState<FormState>({
    label: tenant?.label ?? "",
    directoryTenantId: "",
    clientId: "",
    clientSecret: "",
    defaultMailbox: tenant?.defaultMailbox ?? "",
    secretExpiresOn: tenant?.secretExpiresOn ?? "",
  });
  const [showSecret, setShowSecret] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const problems = adding
    ? tenantInputProblems(form, { requireCredentials: true })
    : tenantChangeProblems(form);

  const save = useMutation({
    mutationFn: async () => {
      const shared = {
        label: form.label.trim(),
        defaultMailbox: form.defaultMailbox.trim() || null,
        secretExpiresOn: form.secretExpiresOn || null,
      };
      if (adding) {
        const added = await addMicrosoftTenant({
          data: {
            ...shared,
            directoryTenantId: form.directoryTenantId.trim(),
            clientId: form.clientId.trim(),
            clientSecret: form.clientSecret.trim(),
          },
        });
        return { roles: added.roles, replaced: true };
      }
      const changed = await updateMicrosoftTenant({
        data: {
          tenantId: tenant.id as string,
          ...shared,
          ...(form.directoryTenantId.trim()
            ? { directoryTenantId: form.directoryTenantId.trim() }
            : {}),
          ...(form.clientId.trim() ? { clientId: form.clientId.trim() } : {}),
          ...(form.clientSecret.trim() ? { clientSecret: form.clientSecret.trim() } : {}),
        },
      });
      return { roles: changed.roles, replaced: changed.credentialsReplaced };
    },
    onSuccess: ({ roles, replaced }) => {
      toast.success(
        adding
          ? "Tenant added"
          : replaced
            ? "Tenant updated — the new credentials were accepted by Microsoft"
            : "Tenant updated",
        replaced
          ? {
              description: roles?.length
                ? `Granted: ${roles.join(", ")}`
                : "Microsoft issued a token. It carries no application roles, so mailbox access must come from Exchange RBAC for Applications.",
            }
          : undefined,
      );
      onSaved();
    },
    onError: (error: Error) =>
      toast.error(adding ? "The tenant was not added" : "The tenant was not updated", {
        description: error.message,
      }),
  });

  const submit = () => {
    setAttempted(true);
    if (problems.length === 0) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !save.isPending ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{adding ? "Add a Microsoft tenant" : `Edit ${tenant.label}`}</DialogTitle>
          <DialogDescription>
            {adding
              ? "The same values the deployment's own tenant has as Lovable secrets, from the Azure app registration that will send for this tenant."
              : "Leave a credential blank to keep the stored one. Anything you enter replaces it once Microsoft accepts it."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field id="tenant-label" label="Name" hint="How campaigns and this page refer to it.">
            <Input
              id="tenant-label"
              value={form.label}
              onChange={set("label")}
              maxLength={LABEL_MAX}
              placeholder="e.g. NPC Services"
              autoComplete="off"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="tenant-directory"
              label="Directory (tenant) ID"
              secret="MICROSOFT_TENANT_ID"
              hint={tenant?.hints ? `Stored: ${tenant.hints.directory}` : undefined}
            >
              <Input
                id="tenant-directory"
                value={form.directoryTenantId}
                onChange={set("directoryTenantId")}
                placeholder={adding ? "00000000-0000-0000-0000-000000000000" : "unchanged"}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            <Field
              id="tenant-client"
              label="Application (client) ID"
              secret="MICROSOFT_CLIENT_ID"
              hint={tenant?.hints ? `Stored: ${tenant.hints.client}` : undefined}
            >
              <Input
                id="tenant-client"
                value={form.clientId}
                onChange={set("clientId")}
                placeholder={adding ? "00000000-0000-0000-0000-000000000000" : "unchanged"}
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
          </div>

          <Field
            id="tenant-secret"
            label="Client secret — its Value"
            secret="MICROSOFT_CLIENT_SECRET"
            hint={
              tenant?.hints
                ? `Stored: ${tenant.hints.secret} — leave blank to keep it.`
                : "The Value column, shown once when the secret is created — not the Secret ID."
            }
          >
            <div className="flex gap-2">
              <Input
                id="tenant-secret"
                type={showSecret ? "text" : "password"}
                value={form.clientSecret}
                onChange={set("clientSecret")}
                placeholder={adding ? "" : "unchanged"}
                autoComplete="new-password"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title={showSecret ? "Hide" : "Show what you typed"}
                onClick={() => setShowSecret((shown) => !shown)}
              >
                {showSecret ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              </Button>
            </div>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="tenant-mailbox"
              label="Default mailbox"
              secret="MICROSOFT_MAILBOX_EMAIL"
              hint="Optional. Used when a campaign does not choose one."
            >
              <Input
                id="tenant-mailbox"
                type="email"
                value={form.defaultMailbox}
                onChange={set("defaultMailbox")}
                placeholder="hello@example.com"
                autoComplete="off"
              />
            </Field>
            <Field id="tenant-expiry" label="Secret expires" hint="Optional. Warned 30 days ahead.">
              <Input
                id="tenant-expiry"
                type="date"
                value={form.secretExpiresOn}
                onChange={set("secretExpiresOn")}
              />
            </Field>
          </div>

          <details className="rounded border border-border/50 px-3 py-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer text-foreground">Where to find these</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>
                Microsoft Entra admin center → App registrations → the application (or New
                registration, single tenant).
              </li>
              <li>
                Its Overview page shows the <b>Application (client) ID</b> and{" "}
                <b>Directory (tenant) ID</b>.
              </li>
              <li>
                Certificates &amp; secrets → New client secret → copy the <b>Value</b> straight
                away; Azure never shows it again. Note its expiry date.
              </li>
              <li>
                API permissions → Add a permission → Microsoft Graph → <b>Application</b>{" "}
                permissions:{" "}
                {GRAPH_ROLES.map(({ role, why, required }, index) => (
                  <span key={role}>
                    {index > 0 ? ", " : ""}
                    <code>{role}</code> ({why}
                    {required ? ", required" : ""})
                  </span>
                ))}
                — then <b>Grant admin consent</b>.
              </li>
              <li>
                To limit which mailboxes it can use, scope it with an Exchange application access
                policy or RBAC for Applications.
              </li>
            </ol>
          </details>

          {attempted && problems.length > 0 ? (
            <ul className="space-y-1 font-mono text-[11px] text-destructive">
              {problems.map((problem) => (
                <li key={problem}>— {problem}</li>
              ))}
            </ul>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : adding ? (
                <ShieldCheck className="mr-2 h-4 w-4" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              {save.isPending ? "Checking with Microsoft…" : adding ? "Verify and add" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  secret,
  hint,
  children,
}: {
  id: string;
  label: string;
  /** The deployment secret this field is the equivalent of. */
  secret?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2">
        {label}
        {secret ? (
          <span className="font-mono text-[10px] font-normal text-muted-foreground">
            like {secret}
          </span>
        ) : null}
      </Label>
      {children}
      {hint ? <p className="font-mono text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
