/**
 * What happens AFTER the button, and what is allowed to look unfinished.
 *
 * Measured on the real run that prompted this (`npc-crm-independent-6505dc`,
 * 19 Sep 2026). Provisioning wrote the clone row at 05:20:23 and returned
 * almost immediately; its Supabase project was still deploying edge functions
 * seven at a time sixteen minutes later. In that window the clone page
 * legitimately showed a Vercel deployment parked on
 * "Waiting for the clone's Supabase backend to report its URL and key.", a
 * subdomain reading `awaiting_deployment`, and no Turnstile widget.
 *
 * Every one of those is a dependency waiting on the one thing that is
 * genuinely slow — and all three were read as failures, because nothing
 * anywhere said the sequence out loud. The wizard ended at a button.
 *
 * So this states the order, names the queue that performs each step, and says
 * plainly which states are expected rather than broken. It is deliberately
 * about the PIPELINE and never about this particular form's inputs, which is
 * what lets it be written in advance and still be true — the same rule
 * `planningControlGuide` answers to in the sibling product.
 *
 * It claims nothing it cannot support. The cadences are the pg_cron schedules
 * (`backend-provisioning-drain-1min`, `deployment-drain-1min`,
 * `turnstile-reconcile-10min`, and `email-identity-drain` on its five-minute
 * schedule), and the duration is given as a measured range with its cause
 * rather than as a promise.
 *
 * (Cron expressions are spelled out in words here on purpose: a literal
 * five-minute cron contains the two characters that end a block comment, and
 * writing one inside this header truncated the file mid-sentence.)
 */
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

type Step = {
  /** What happens. */
  what: string;
  /** Who performs it — a named queue, so the claim is checkable. */
  by: string;
  /** What it waits for, when it waits. */
  waits?: string;
};

export function ProvisioningSequenceNote({
  dedicatedBackend,
  subdomainEnabled,
  armTurnstile,
  armEmail,
  deploys,
}: {
  dedicatedBackend: boolean;
  subdomainEnabled: boolean;
  armTurnstile: boolean;
  armEmail: boolean;
  deploys: boolean;
}) {
  const steps: Step[] = [
    {
      what: "The clone record, its GitHub repository and its hosting project are created.",
      by: "this request, while you wait",
    },
  ];

  if (dedicatedBackend) {
    steps.push({
      what:
        "Its own Supabase project is created, then the prime's schema, RLS policies, grants and " +
        "edge functions are replicated into it. This is the slow step: it resumes every minute " +
        "and pauses at an invocation budget each pass, so a full backend takes roughly 15–30 " +
        "minutes.",
      by: "backend-provisioning-drain, every minute",
    });
  }

  if (deploys) {
    steps.push({
      what: "The hosting environment is synced and the first build is deployed.",
      by: "deployment-drain, every minute",
      waits: dedicatedBackend
        ? "the backend above, for its URL and anon key — a build wired to nothing renders an empty shell"
        : undefined,
    });
  }

  if (subdomainEnabled) {
    steps.push({
      what: "The subdomain's DNS record is written and verified.",
      by: "the deployment drain",
      waits: deploys ? "a deployment to point at" : undefined,
    });
  }

  if (armTurnstile) {
    steps.push({
      what: "This clone's own Turnstile widget is minted and its secret written to its backend.",
      by: "turnstile-reconcile, every ten minutes",
      waits: dedicatedBackend ? "the backend, which is where the secret is stored" : undefined,
    });
  }

  if (armEmail) {
    steps.push({
      what: "Its sending domain is registered and verifies once DNS propagates.",
      by: "email-identity-drain, every five minutes",
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">After you click Provision</CardTitle>
        <CardDescription>
          Most of this happens without you. The steps below run on their own schedules and pick up
          where they left off, so you can close this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={s.by + i} className="border border-border/70 p-3">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="text-sm">{s.what}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Run by <span className="font-mono">{s.by}</span>
                {s.waits ? <> · waits for {s.waits}</> : null}
              </p>
            </li>
          ))}
        </ol>

        {/*
          The line this whole card exists for. Three separate rows read as
          failures on the measured run, and every one of them was a
          dependency doing exactly what it should.
        */}
        <p className="text-xs text-muted-foreground">
          While that runs, the clone page shows later steps as waiting — a deployment parked on the
          backend, a subdomain with nothing to point at yet, no widget. That is this sequence in
          progress, not a fault. Waiting does not consume any step's retry budget, and nothing here
          needs you to come back and click it.
        </p>
      </CardContent>
    </Card>
  );
}
