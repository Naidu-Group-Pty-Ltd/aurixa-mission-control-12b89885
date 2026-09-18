/**
 * What the unattended application pipeline did, for the operator who was not
 * there when it did it.
 *
 * `/apply/builder` creates an organisation and invites its owner with nobody
 * in the loop. That is the product decision, and its cost is that every
 * outcome — including every failure — happens out of sight. This panel is the
 * whole answer to "how would anybody know": each application is listed with
 * what the network decided about it, and nothing else on this page reports it.
 *
 * Three rules shape it.
 *
 *  * **This panel acts on nothing.** Everything an application could do it
 *    already did when it was submitted, and the organisation it created is in
 *    the list above with the full set of controls. Offering an Approve here
 *    would be a second door onto the same decision, which is how two surfaces
 *    come to disagree about what a case is.
 *
 *  * **An unsent invitation leads.** A refused application is visible from its
 *    badge and its consequence is that nothing happened. An application that
 *    was PROVISIONED with `invite_sent: false` is the dangerous one — the
 *    organisation exists, the owner is expecting an email and there is none —
 *    so it is called out rather than left to be spotted in a row.
 *
 *  * **Database vocabulary never reaches the operator.** `outcome_detail`
 *    carries the network's own refusal codes, and `readNetworkFailure` is the
 *    module that already authors them in an operator's words. A second list
 *    here is how one screen comes to say something another does not.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { readNetworkFailure } from "@/lib/buildersNetworkFailure.pure";
import { ORG_TYPE_LABEL } from "@/lib/builderApplication.pure";
import type { NetworkAccessRequest } from "@/server/builders-network.functions";
import { AlertTriangle, ClipboardList, Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

/** Where a lead applies. One literal, because the console links it and copies it. */
export const APPLICATION_PATH = "/apply/builder";

const STATUS_LABEL: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "quiet" }> = {
  received: { label: "In flight", tone: "quiet" },
  provisioned: { label: "Set up", tone: "ok" },
  attached: { label: "Joined an existing account", tone: "ok" },
  refused: { label: "Refused", tone: "bad" },
};

function StatusPill({ value }: { value: string }) {
  const read = STATUS_LABEL[value] ?? { label: value.replaceAll("_", " "), tone: "quiet" as const };
  const className =
    read.tone === "ok"
      ? "border-primary/40 bg-primary/10 text-primary"
      : read.tone === "bad"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : read.tone === "warn"
          ? "border-warning/40 bg-warning/10 text-warning"
          : undefined;
  return (
    <Badge variant="outline" className={className}>
      {read.label}
    </Badge>
  );
}

export interface AccessRequestsPanelProps {
  loading: boolean;
  requests: NetworkAccessRequest[] | null;
  /** The network's own refusal, when the list itself could not be read. */
  error: string | null;
}

export function AccessRequestsPanel({ loading, requests, error }: AccessRequestsPanelProps) {
  /*
   * "Set up and not written to" — the only state here that needs a person.
   * `attached` is excluded deliberately: that applicant already had an
   * account and their sign-in still works, so a lost notification is a
   * courtesy rather than a locked door.
   */
  const undelivered = (requests ?? []).filter(
    (request) => request.status === "provisioned" && !request.invite_sent,
  );

  const copyLink = async () => {
    const url = `${window.location.origin}${APPLICATION_PATH}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Application link copied");
    } catch {
      // A clipboard the browser refuses is not a failure worth hiding — the
      // operator can still read the address off the link beside this button.
      toast.error("Could not copy — the link is beside this button");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Access applications</CardTitle>
          <p className="text-xs text-muted-foreground">
            Submitted at{" "}
            <a
              href={APPLICATION_PATH}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {APPLICATION_PATH}
            </a>
            . Each one creates its organisation and invites its owner with no operator step —
            approval is still yours, above.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void copyLink()}>
            <Copy className="mr-1 h-4 w-4" aria-hidden /> Copy link
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={APPLICATION_PATH} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden /> Open form
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {undelivered.length > 0 && (
          <Alert className="border-warning/40 bg-warning/5">
            <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />
            <AlertTitle className="text-sm">
              {undelivered.length === 1
                ? "One applicant was set up and never written to"
                : `${undelivered.length} applicants were set up and never written to`}
            </AlertTitle>
            <AlertDescription className="text-xs text-muted-foreground">
              Their organisation exists and their invitation did not send, so they are waiting for
              an email that will not arrive. Use <strong>Invite owner</strong> on the organisation
              above to mint and send a fresh link.
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : error ? (
          <p className="text-sm text-muted-foreground">{readNetworkFailure(error).sentence}</p>
        ) : !requests || requests.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-8 w-8" aria-hidden />}
            title="No applications yet"
            description="Anyone who applies through the form appears here with what the network decided."
          />
        ) : (
          <div className="divide-y divide-border">
            {requests.map((request) => {
              // `outcome_detail` repeats the status on the happy paths; only a
              // refusal carries a reason worth a sentence.
              const reason =
                request.status === "refused" && request.outcome_detail
                  ? readNetworkFailure(request.outcome_detail).sentence
                  : null;
              return (
                <div key={request.id} className="flex flex-wrap items-start gap-3 py-3">
                  <div className="min-w-0 flex-1 basis-72">
                    <p className="truncate font-medium">{request.legal_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {request.contact_name} &lt;{request.contact_email}&gt;
                      {request.org_type
                        ? ` · ${ORG_TYPE_LABEL[request.org_type] ?? request.org_type.replaceAll("_", " ")}`
                        : ""}
                      {request.state ? ` · ${request.state}` : ""}
                    </p>
                    {reason && <p className="mt-1 text-xs text-destructive">{reason}</p>}
                    {request.message && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        “{request.message}”
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <StatusPill value={request.status} />
                    {request.status !== "refused" && (
                      <Badge
                        variant="outline"
                        className={
                          request.invite_sent
                            ? undefined
                            : "border-warning/40 bg-warning/10 text-warning"
                        }
                      >
                        {request.invite_sent ? "Emailed" : "Not emailed"}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {new Date(request.created_at).toLocaleString("en-AU")}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
