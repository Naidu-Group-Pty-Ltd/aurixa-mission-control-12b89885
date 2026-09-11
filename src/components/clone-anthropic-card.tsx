import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/copy-button";
import { AlertTriangle, CheckCircle2, Circle, CircleDot, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  getCloneAnthropicIdentity,
  provisionCloneAnthropicWorkspace,
  runCloneAnthropicSelftestFn,
} from "@/lib/anthropic-attribution.functions";

type StepState = "done" | "open" | "blocked";

/**
 * Where the operator is sent when a reading is not green.
 *
 * Written per END rather than per message, because both ends answer with
 * similar text and send somebody to opposite places — the lesson the
 * verification broker already paid for.
 */
const REMEDY: Record<string, string> = {
  unconfigured:
    "The clone holds no Anthropic credential and no federation identity. Run the secrets reconcile, or give it a workspace below.",
  mission_control:
    "Mission Control refused to issue an identity. Check ANTHROPIC_FEDERATION_PRIVATE_KEY and the bootstrap values here, not on the clone.",
  anthropic: "Anthropic refused the call. The credential or the federation rule is the problem, not this deployment.",
  workspace:
    "Anthropic will not let this credential act in that workspace. The workspace was removed, or the id names somebody else's.",
};

function StepIcon({ state }: { state: StepState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (state === "open") return <CircleDot className="h-4 w-4 text-info" aria-hidden />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" aria-hidden />;
}

function when(value: string | null | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString("en-AU");
}

/**
 * Whose line this clone's Claude usage lands on.
 *
 * Anthropic publishes no endpoint that creates an API key, so the per-clone
 * credential the other four model vendors get cannot exist here. The unit of
 * attribution is the WORKSPACE — creatable, and named by a header on every
 * request — and federation then removes the key from the clone entirely.
 *
 * The card leads with what is PROVED rather than what is configured: every
 * reading on this page can be green while a clone cannot obtain a credential
 * at all, which is exactly the fault this platform has already had once on
 * three tenants that had never completed a verification.
 */
export function CloneAnthropicCard({ cloneId }: { cloneId: string }) {
  const loadFn = useServerFn(getCloneAnthropicIdentity);
  const provisionFn = useServerFn(provisionCloneAnthropicWorkspace);
  const selftestFn = useServerFn(runCloneAnthropicSelftestFn);

  const [busy, setBusy] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["clone-anthropic-identity", cloneId],
    queryFn: async () => loadFn({ data: { cloneId } }),
  });

  const unreadable = data && !data.ok ? data.error : null;
  const row = data?.ok ? data.row : null;

  /*
   * RECORDED and DELIVERED are different facts, and the second one fails on
   * its own: the Management API write can be refused after Anthropic has
   * created the workspace. A row exists either way, so reading `workspace_id`
   * as "this clone has its workspace" tells an operator the step is done while
   * the project may never have received the id.
   *
   * What a null stamp is NOT is proof the id was never written.
   * `20260911090000` clears legitimate and presumed stamps alike, precisely
   * because they are indistinguishable, so after it runs the honest reading is
   * UNCONFIRMED — and an undelivered clone that is federated is attributed
   * anyway, by the rule's binding rather than by the header. This card cannot
   * see the key ledger, so it says what it knows and claims nothing about
   * which line the spend lands on.
   */
  const recorded = Boolean(row?.workspace_id);
  const hasWorkspace = recorded && Boolean(row?.delivered_at);
  const federated = Boolean(row?.federation_rule_id);
  const proved = Boolean(row?.verified_at);

  const steps: { id: string; label: string; state: StepState; detail: string }[] = [
    {
      id: "workspace",
      label: "Own Anthropic workspace",
      state: hasWorkspace ? "done" : "open",
      detail: hasWorkspace
        ? `${row?.workspace_name ?? "(unnamed)"} carries this clone's model spend`
        : recorded
          ? `${row?.workspace_name ?? "(unnamed)"} exists at Anthropic; delivery of its id to this project is unconfirmed. A reconcile confirms it, or federation attributes the spend without it.`
          : "Without one, this clone's Claude usage lands on the organisation's default line with every other tenant's",
    },
    {
      id: "federation",
      label: "Holds no Anthropic key",
      // RECORDED, not delivered. `federateClone` reads `workspace_id` and never
      // `delivered_at`: it adds the service account to that workspace and binds
      // the rule to it, so an undelivered clone federates normally. Keying this
      // on delivery said `blocked` and sent an operator looking for a broken
      // step that was one reconcile from done.
      state: federated ? "done" : recorded ? "open" : "blocked",
      detail: federated
        ? "The clone obtains a short-lived token naming itself; no organisation key is on its project"
        : "The clone still runs on the organisation key, which can act in any workspace the organisation has",
    },
    {
      id: "proved",
      label: "Proved reachable",
      state: proved ? "done" : "open",
      // Configuration is not reachability, and this is the line that says so.
      detail: proved
        ? `Last proved ${when(row?.verified_at)}`
        : "Nothing has confirmed this clone can actually obtain a credential",
    },
  ];

  async function act(
    run: () => Promise<unknown>,
    describe: (result: unknown) => { ok: boolean; message: string },
  ) {
    setBusy(true);
    try {
      const result = await run();
      const { ok, message } = describe(result);
      if (ok) toast.success(message);
      else toast.error(message);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-[16rem] flex-1">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" aria-hidden />
              Anthropic attribution
            </CardTitle>
            <CardDescription>
              Whose line this clone&rsquo;s Claude usage lands on, and whether it can reach the
              vendor at all.
            </CardDescription>
          </div>
          <Badge variant={proved ? "default" : hasWorkspace ? "secondary" : "outline"}>
            {proved ? "Proved" : hasWorkspace ? "Configured" : "Not attributed"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the identity ledger&hellip;</p>
        ) : unreadable ? (
          // A failed read is not an absent identity. Saying so stops an
          // operator provisioning a workspace this clone may already have.
          <p className="text-sm text-muted-foreground">
            The identity ledger could not be read, so nothing here is known:{" "}
            <span className="font-mono">{unreadable}</span>
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {steps.map((s) => (
                <li key={s.id} className="flex items-start gap-2">
                  <span className="mt-0.5">
                    <StepIcon state={s.state} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{s.label}</span>
                    <span className="block text-sm text-muted-foreground">{s.detail}</span>
                  </span>
                </li>
              ))}
            </ul>

            {row?.workspace_id ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">Workspace</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {row.workspace_id}
                </code>
                <CopyButton value={row.workspace_id} />
              </div>
            ) : null}

            {row?.last_error ? (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-medium">The last attempt reported a fault</p>
                  <p className="text-muted-foreground">{row.last_error}</p>
                  {/*
                    * `verified_at` is kept through a failure, because it is the
                    * last time this was PROVED and that stays true whatever is
                    * broken now. Saying both is what lets somebody tell a
                    * regression from a thing that never worked.
                    */}
                  <p className="text-muted-foreground">
                    Last proved working: {when(row.verified_at)}
                  </p>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => provisionFn({ data: { cloneId } }),
                    (r) => {
                      const res = r as { provisioned: boolean; detail?: string; reason?: string };
                      return {
                        ok: res.provisioned,
                        message: res.detail ?? res.reason ?? "Nothing changed",
                      };
                    },
                  )
                }
              >
                {hasWorkspace ? "Re-check workspace" : "Give it a workspace"}
              </Button>

              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  act(
                    () => selftestFn({ data: { cloneId } }),
                    (r) => {
                      const res = r as
                        | { ok: true; reach: { ok: boolean; end: string | null; why: string | null; modelCount: number | null } }
                        | { ok: false; reason: string; error: string };
                      if (!res.ok) return { ok: false, message: res.error };
                      if (res.reach.ok) {
                        return {
                          ok: true,
                          message: `Reached Anthropic and listed ${res.reach.modelCount ?? 0} models.`,
                        };
                      }
                      // Name the end, then the remedy for that end. A generic
                      // "it failed" sends an operator to wait out an outage
                      // that is not happening.
                      const remedy = res.reach.end ? REMEDY[res.reach.end] : null;
                      return {
                        ok: false,
                        message: [res.reach.why, remedy].filter(Boolean).join(" — "),
                      };
                    },
                  )
                }
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                Run self-test
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">
              The self-test costs nothing at either end: a federated exchange is not a billable
              call and the model list is metadata, so no tokens are consumed. It asks the clone
              rather than answering from here, because this side cannot see the clone&rsquo;s own
              Mission Control key or its scopes.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
