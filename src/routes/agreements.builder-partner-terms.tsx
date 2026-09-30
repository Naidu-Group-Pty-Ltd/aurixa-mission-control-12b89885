/**
 * The Builder Partner Agreement terms: the file builders sign, registered
 * here and put in force by an admin.
 *
 * The terms are supplied as a document — a PDF or a Word file — and nothing
 * here reads a clause. What is recorded is the file's digest, its name and
 * version, whether Aurixa countersigns, and the statement the execution
 * schedule prints above the signatures. While terms are in force, approving a
 * builder on the Builders Network waits for their signed agreement.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Download, RefreshCw, Upload } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  activateBuilderPartnerTerms,
  deleteBuilderPartnerTerms,
  downloadBuilderPartnerTerms,
  installBuilderPartnerTerms,
  listBuilderPartnerTerms,
  retireBuilderPartnerTerms,
} from "@/lib/builderPartnerAgreements.functions";
import {
  DEFAULT_EXECUTION_STATEMENT,
  TEMPLATE_MAX_BYTES,
  WAIVER_REASON_MIN,
} from "@/lib/agreements/builderPartner.pure";
import { saveBase64File } from "@/lib/agreements/saveFile";
import { useUserRoles } from "@/lib/use-user-roles";

export const Route = createFileRoute("/agreements/builder-partner-terms")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <TermsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Builder Partner terms — Aurixa Mission Control" }] }),
});

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function TermsPage() {
  const qc = useQueryClient();
  const roles = useUserRoles();
  const confirm = useConfirm();
  const termsQ = useQuery({
    queryKey: ["agreements", "builder-partner-terms"],
    queryFn: () => listBuilderPartnerTerms(),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["agreements"] });

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("Builder Partner Agreement");
  const [versionLabel, setVersionLabel] = useState("");
  const [countersignatureRequired, setCountersignatureRequired] = useState(false);
  const [executionStatement, setExecutionStatement] = useState(DEFAULT_EXECUTION_STATEMENT);
  const [notes, setNotes] = useState("");

  const install = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose the terms file first.");
      if (file.size > TEMPLATE_MAX_BYTES) throw new Error("The file is larger than 15 MB.");
      return installBuilderPartnerTerms({
        data: {
          fileName: file.name,
          base64: await fileToBase64(file),
          details: { name, versionLabel, countersignatureRequired, executionStatement, notes },
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`Registered "${r.terms.name}" — put it in force when it has been checked.`);
      for (const w of r.warnings) toast.warning(w);
      setFile(null);
      refresh();
    },
    onError: (err) => toast.error(message(err)),
  });
  const act = useMutation({
    mutationFn: async (input: {
      id: string;
      kind: "activate" | "retire" | "delete";
      reason?: string;
    }) => {
      if (input.kind === "activate") await activateBuilderPartnerTerms({ data: { id: input.id } });
      else if (input.kind === "retire")
        await retireBuilderPartnerTerms({ data: { id: input.id, reason: input.reason ?? "" } });
      else await deleteBuilderPartnerTerms({ data: { id: input.id } });
      return input.kind;
    },
    onSuccess: (kind) => {
      toast.success(
        kind === "activate"
          ? "Terms in force"
          : kind === "retire"
            ? "Terms retired"
            : "Registration deleted",
      );
      refresh();
    },
    onError: (err) => toast.error(message(err)),
  });
  const download = useMutation({
    mutationFn: async (id: string) => {
      const r = await downloadBuilderPartnerTerms({ data: { id } });
      saveBase64File(r.base64, r.filename, r.mediaType);
    },
    onError: (err) => toast.error(message(err)),
  });

  if (termsQ.isPending || roles.loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading terms…</div>;
  }
  if (termsQ.error || !termsQ.data) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="The Builder Partner terms could not be loaded"
          description={message(termsQ.error)}
          action={
            <Button variant="outline" onClick={() => void termsQ.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Try again
            </Button>
          }
        />
      </div>
    );
  }
  const data = termsQ.data;
  const admin = roles.isAdmin;

  const activate = async (id: string, label: string) => {
    const ok = await confirm({
      title: `Put "${label}" in force?`,
      description:
        "New Builder Partner Agreements are sent under these terms, and approving a builder on the Builders Network waits for their signed agreement (an admin may waive it with a recorded reason). Any terms in force now are retired.",
      confirmText: "Put in force",
    });
    if (ok) act.mutate({ id, kind: "activate" });
  };
  const retire = (id: string) => {
    const reason = window.prompt(
      `Why are these terms being retired? With none in force, approval stops waiting for a signed agreement. (At least ${WAIVER_REASON_MIN} characters.)`,
    );
    if (reason !== null) act.mutate({ id, kind: "retire", reason });
  };
  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Delete this registration?",
      description: "It was never put in force; nothing was sent under it.",
      confirmText: "Delete",
      destructive: true,
    });
    if (ok) act.mutate({ id, kind: "delete" });
  };

  return (
    <div className="space-y-6 p-6">
      <BackLink />
      <header>
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Agreements</p>
        <h1 className="text-2xl font-semibold">Builder Partner Agreement terms</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          The document a builder signs before the Builder Portal admits them. Each agreement sends
          these terms with an execution schedule naming the builder and the terms' digest.
        </p>
      </header>

      {!data.installed ? (
        <EmptyState
          icon={<AlertTriangle />}
          title="Not installed on this database yet"
          description="The migration that adds Builder Partner Agreements has not been applied."
        />
      ) : null}
      {data.installed && !data.inForceId ? (
        <div className="rounded-md border border-warning/40 px-3 py-2 text-sm text-warning">
          No terms are in force: Builder Partner Agreements cannot be sent, and approval on the
          Builders Network does not wait for one.
        </div>
      ) : null}
      {!data.docusign.ready ? (
        <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
          DocuSign is not configured (missing: {data.docusign.missing.join(", ")}). Terms cannot be
          put in force until it is.
        </div>
      ) : null}

      {data.installed && admin ? (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">Register a terms file</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="terms-file">File (PDF or Word, up to 15 MB)</Label>
              <Input
                id="terms-file"
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="terms-name">Name</Label>
              <Input id="terms-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="terms-version">Version</Label>
              <Input
                id="terms-version"
                placeholder="e.g. v1.0 — October 2026"
                value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <Switch
                id="terms-countersign"
                checked={countersignatureRequired}
                onCheckedChange={setCountersignatureRequired}
              />
              <Label htmlFor="terms-countersign">Aurixa countersigns</Label>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="terms-statement">
              Execution statement (printed above the signatures)
            </Label>
            <Textarea
              id="terms-statement"
              rows={4}
              value={executionStatement}
              onChange={(e) => setExecutionStatement(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="terms-notes">Notes (internal)</Label>
            <Textarea
              id="terms-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <Button onClick={() => install.mutate()} disabled={!file || install.isPending}>
            <Upload className="mr-1.5 h-4 w-4" /> Register terms
          </Button>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="font-medium">Registered terms</h2>
        {data.terms.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing registered yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.terms.map((t) => (
              <li key={t.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">
                      {t.name} <span className="text-muted-foreground">· {t.versionLabel}</span>{" "}
                      <Badge variant={t.status === "active" ? "default" : "outline"}>
                        {t.status === "active" ? "in force" : t.status}
                      </Badge>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.fileName} · {(t.byteSize / 1024).toFixed(0)} KB
                      {t.pageCount ? ` · ${t.pageCount} pages` : ""} · SHA-256{" "}
                      <code>{t.sha256.slice(0, 16)}…</code> · registered{" "}
                      {format(new Date(t.uploadedAt), "d MMM yyyy")}
                      {t.countersignatureRequired ? " · countersigned by Aurixa" : ""}
                      {t.issuedCount !== null ? ` · ${t.issuedCount} agreement(s) sent` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => download.mutate(t.id)}>
                      <Download className="mr-1.5 h-4 w-4" /> File
                    </Button>
                    {admin && t.status === "staged" ? (
                      <>
                        <Button
                          size="sm"
                          onClick={() => void activate(t.id, t.name)}
                          disabled={act.isPending}
                        >
                          Put in force
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void remove(t.id)}>
                          Delete
                        </Button>
                      </>
                    ) : null}
                    {admin && t.status === "active" ? (
                      <Button variant="ghost" size="sm" onClick={() => retire(t.id)}>
                        Retire
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/agreements"
      className="inline-flex items-center text-sm text-muted-foreground hover:underline"
    >
      <ArrowLeft className="mr-1 h-4 w-4" /> Agreements
    </Link>
  );
}
