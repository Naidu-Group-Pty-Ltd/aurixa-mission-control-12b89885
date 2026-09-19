// What this provisioning run will and will not be able to do, said BEFORE the
// button rather than after it.
//
// ## Why this exists
//
// `readiness.pure.ts` has held the whole catalogue since it was written —
// Vercel, Cloudflare (DNS *and* the clone's Turnstile widget), Resend, the
// GitHub App, the Supabase management token. It was rendered in exactly one
// place: `/health`. The New Clone wizard, which is the one page where the
// answer changes what an operator does, showed none of it.
//
// What the wizard said instead was unfalsifiable. The deployment section reads
// "Dormant if no hosting token is configured … Nothing here blocks the wizard",
// and the subdomain section reads "Dormant if Cloudflare isn't configured yet".
// Both warn that something MIGHT be true without ever saying whether it IS, so
// an operator ticks Vercel, ticks a subdomain, provisions, and finds out days
// later from a `deployment` row parked at `pending_platform` and a login page
// whose CAPTCHA never appeared.
//
// ## What it does not do
//
// It does not block. `provisionClone` is the authority on what may be created,
// and a readiness reading is presence-only — a token that is set may still be
// revoked. Blocking on it would refuse a run that would have worked, which is
// the failure mode `ACTIVATION_GATE.md` records on the other side of this
// codebase: "the failure this screen could cause is locking out somebody who
// has paid". So this discloses and the server refuses. Two gates is how one of
// them becomes wrong.
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CircleCheck,
  CircleX,
  HelpCircle,
  Loader2,
  Minus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { type ReadinessReport } from "@/lib/readiness.functions";
import type { ProvisioningReadiness } from "@/lib/useProvisioningReadiness";

type Capability = ReadinessReport["capabilities"][number];

/**
 * The same four words the health card uses, deliberately.
 *
 * `ready` says "no gaps" rather than "healthy" because presence is all this
 * establishes, and `unknown` is drawn as neither pass nor fail — a precondition
 * this side could not read is not a finding about the configuration.
 */
function VerdictPill({ verdict }: { verdict: Capability["verdict"] }) {
  switch (verdict) {
    case "blocked":
      return (
        <Badge variant="destructive" className="gap-1">
          <CircleX className="h-3 w-3" /> blocked
        </Badge>
      );
    case "degraded":
      return (
        <Badge variant="outline" className="gap-1">
          <Minus className="h-3 w-3" /> degraded
        </Badge>
      );
    case "unknown":
      return (
        <Badge variant="outline" className="gap-1 text-muted-foreground">
          <HelpCircle className="h-3 w-3" /> could not check
        </Badge>
      );
    case "ready":
      return (
        <Badge variant="secondary" className="gap-1">
          <CircleCheck className="h-3 w-3 text-emerald-500" /> no gaps
        </Badge>
      );
  }
}

/**
 * One line an operator can act on, for a capability a section depends on.
 *
 * Rendered inline in the section that needs it, so the answer is beside the
 * control rather than in a panel somewhere above it.
 */
export function CapabilityNote({
  readiness,
  capabilityKey,
  whenBlocked,
  whenReady,
}: {
  readiness: ProvisioningReadiness;
  capabilityKey: string;
  whenBlocked: string;
  whenReady: string;
}) {
  const verdict = readiness.verdictFor(capabilityKey);
  if (readiness.loading) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking what this deployment can
        do…
      </p>
    );
  }
  if (verdict === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Could not check whether this is configured. That is not the same as it being unconfigured —
        the provisioning run is unaffected either way.
      </p>
    );
  }
  if (verdict === "blocked") {
    return (
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        <span>{whenBlocked}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <CircleCheck className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" aria-hidden />
      <span>{whenReady}</span>
    </p>
  );
}

/**
 * The panel itself: every capability provisioning a clone depends on.
 *
 * Scoped by `onClonePath`, which the report carries per capability — Stripe
 * being unconfigured is a real problem and is not a reason to put a warning on
 * this page.
 */
export function ProvisioningReadinessPanel({
  readiness,
}: {
  readiness: ProvisioningReadiness & { reload: () => void };
}) {
  const { report, loading, reload } = readiness;
  const path = (report?.capabilities ?? []).filter((c) => c.onClonePath);
  const blocked = path.filter((c) => c.verdict === "blocked");
  const degraded = path.filter((c) => c.verdict === "degraded");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 basis-[22rem]">
            <CardTitle className="text-base">0 · What this run can do</CardTitle>
            <CardDescription>
              Every credential the clone pipeline spends, read before anything is created. This does
              not block provisioning — it tells you which parts will silently park.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={loading}
            className="shrink-0"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            <span className="ml-1.5">Re-check</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !report ? (
          <p className="text-sm text-muted-foreground">Reading this deployment's configuration…</p>
        ) : !report ? (
          <Alert>
            <AlertDescription className="text-sm">
              Readiness could not be read. That is not a finding about the configuration — the
              wizard is unaffected and provisioning is unchanged.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {blocked.length > 0 && (
              <Alert variant="destructive">
                <AlertDescription className="space-y-1 text-sm">
                  <p className="font-medium">
                    {blocked.length === 1
                      ? "One part of the pipeline cannot run."
                      : `${blocked.length} parts of the pipeline cannot run.`}{" "}
                    The clone will still be created — those steps park instead.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            <ul className="space-y-2">
              {path.map((capability) => (
                <li key={capability.key} className="border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{capability.title}</span>
                    <VerdictPill verdict={capability.verdict} />
                  </div>
                  {/*
                    `consequence` says what breaks while a capability is
                    BLOCKED — its own type declares exactly that. Rendering it
                    for every non-ready verdict told an operator "A clone
                    cannot get its own Supabase project. Provisioning stops
                    before anything is created." about a capability whose
                    required credentials are all present and whose only absence
                    is an optional soft-limit override that defaults when
                    unset. `readiness-card.tsx` had this right from the start,
                    for the reason it gives: "shown only when something is
                    actually wrong, so a working platform is not a wall of
                    warnings."
                  */}
                  {capability.verdict === "blocked" && (
                    <p className="mt-1 text-xs text-destructive">{capability.consequence}</p>
                  )}

                  {capability.blockers.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {capability.blockers.map((blocker) => (
                        <li key={blocker} className="text-xs text-destructive">
                          {blocker}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/*
                    A pill reading `degraded` with nothing beside it is its own
                    small failure — it names a state and not the thing an
                    operator would act on. These are the optional credentials
                    that are absent, said plainly, with the reassurance that
                    the step still runs.
                  */}
                  {capability.verdict === "degraded" && (
                    <ul className="mt-1 space-y-1">
                      {capability.credentials
                        .filter((c) => !c.required && c.state === "missing")
                        .map((c) => (
                          <li key={c.name} className="text-xs text-muted-foreground">
                            <span className="font-mono">{c.name}</span> is not set — {c.purpose}
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            {degraded.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Degraded means an optional credential is absent. The step still runs — on a default,
                or without the one refinement that credential buys. It is not a failure and it does
                not stop a clone being created.
              </p>
            )}

            {blocked.length > 0 && (
              /*
                Worth saying once, because it is the question every blocker
                above raises and no page answered: these are read with
                `process.env` in Mission Control's own server, so they are set
                on THIS app's hosting project. There is no screen in here that
                writes them — Settings → Domains reports whether they are set
                and binds the Cloudflare zone, which is a different thing and
                is why looking for a token field there finds nothing.
              */
              <p className="text-xs text-muted-foreground">
                Every name above is an environment variable on Mission Control's own hosting
                project, not a setting inside this app — nothing in here writes them.{" "}
                <a href="/settings/domains" className="underline">
                  Settings → Domains
                </a>{" "}
                reports whether they arrived and is where the Cloudflare zone is bound.
              </p>
            )}

            {/*
              The caveat travels ON the report rather than being written here,
              so a redesign that drops it has to drop a field off the payload
              instead of deleting a line of JSX.
            */}
            <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
              {report.caveat}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
