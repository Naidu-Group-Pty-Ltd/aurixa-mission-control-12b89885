/**
 * The public application for Builder / Developer Portal access.
 *
 * A lead fills this in and, with no operator in between, their organisation
 * is created on the network and their invitation is sent. That automation is
 * the product decision; what it costs is that this is the ONE page in Mission
 * Control a stranger can reach that causes a write, so three things are
 * deliberate here.
 *
 *  * **No `ProtectedRoute`, and no sign-in of any kind.** A builder lead has
 *    no account — that is what they are asking for. `join.$token` is the same
 *    shape: a public page whose whole job is to admit somebody who is not yet
 *    inside.
 *
 *  * **Only four boxes are required.** Registered name, type of business, and
 *    a person to write to. Everything else is description an operator can
 *    chase later. Demanding an ACN and a postcode before somebody is allowed
 *    to express interest is how an application form stops being answered —
 *    and the two mandatory ones are mandatory because the network's own
 *    columns are NOT NULL, not because we would like to know.
 *
 *  * **A refusal is read in the applicant's vocabulary, never the console's.**
 *    `readApplicationRefusal` exists because the operator readings in
 *    `buildersNetworkFailure` end in acts only an operator can perform, and
 *    the field it names is focused rather than merely mentioned.
 *
 * The confirmation never shows an invitation link. The link is the credential
 * and it goes to the mailbox on the application; this page is told only
 * whether the message went.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { submitBuilderAccessRequest } from "@/server/builders-network.functions";
import {
  APPLICATION_STATES,
  ORG_TYPE_LABEL,
  readApplicationRefusal,
  type ApplicationRefusal,
} from "@/lib/builderApplication.pure";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Building2, CheckCircle2, Loader2, MailCheck, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/apply/builder")({
  component: ApplyBuilderPage,
  head: () => ({
    meta: [{ title: "Apply for Builder Portal access — Aurixa Systems" }],
  }),
});

type FormValues = {
  legal_name: string;
  trading_name: string;
  org_type: string;
  abn: string;
  acn: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  website: string;
  suburb: string;
  state: string;
  postcode: string;
  message: string;
};

const EMPTY: FormValues = {
  legal_name: "",
  trading_name: "",
  org_type: "",
  abn: "",
  acn: "",
  contact_name: "",
  contact_email: "",
  contact_phone: "",
  website: "",
  suburb: "",
  state: "",
  postcode: "",
  message: "",
};

type Accepted = {
  outcome: "provisioned" | "attached";
  organisation_legal_name: string;
  email_sent: boolean;
};

function ApplyBuilderPage() {
  const submit = useServerFn(submitBuilderAccessRequest);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ApplicationRefusal | null>(null);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const set = (key: keyof FormValues) => (value: string) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  /**
   * A refusal that names a field focuses it. Saying "an ABN is eleven digits"
   * above a form of thirteen boxes leaves the reader to find which one — and
   * `refusal.field` is exactly the answer, so not using it would be a hint
   * this page already holds and chose not to give.
   */
  const refuse = (code: string) => {
    const reading = readApplicationRefusal(code);
    setRefusal(reading);
    if (reading.field) {
      const el = formRef.current?.querySelector<HTMLElement>(`[name="${reading.field}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      const result = await submit({ data: values });
      if (!result.ok) {
        refuse(result.error);
        return;
      }
      setAccepted({
        outcome: result.outcome,
        organisation_legal_name: result.organisation_legal_name,
        email_sent: result.email_sent,
      });
    } catch (error) {
      // The input validator throws its refusal code as an Error message, and
      // a transport fault arrives the same way. Both are read by the same
      // table, which falls through to one honest sentence for a code it does
      // not author rather than showing the applicant a raw identifier.
      refuse(error instanceof Error ? error.message : "");
    } finally {
      setBusy(false);
    }
  };

  if (accepted) {
    return (
      <div className="grid-bg flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
              <CheckCircle2 className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="font-mono tracking-wide">APPLICATION RECEIVED</CardTitle>
            <CardDescription>
              {accepted.organisation_legal_name || "Your business"} has been set up on the Builder /
              Developer Portal.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {accepted.email_sent ? (
              <Alert>
                <MailCheck className="h-4 w-4" />
                <AlertTitle className="text-sm">Check your email</AlertTitle>
                <AlertDescription className="text-xs">
                  {accepted.outcome === "attached"
                    ? `We have written to ${values.contact_email}. You already have a Builder Portal account, so sign in as usual — ${accepted.organisation_legal_name} is now in your organisation switcher.`
                    : `We have sent ${values.contact_email} a link to choose a password. It can be used once and expires, so open it soon. If it does not arrive within a few minutes, check your spam folder.`}
                </AlertDescription>
              </Alert>
            ) : (
              /*
               * The organisation exists and the message did not go. Saying
               * "check your email" here would send somebody to an empty inbox
               * and then to a second application, which the day-long window
               * would refuse — so it says what actually happened instead.
               */
              <Alert className="border-warning/40 bg-warning/5">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <AlertTitle className="text-sm">We could not send your email</AlertTitle>
                <AlertDescription className="text-xs">
                  Your application went through and {accepted.organisation_legal_name} is set up,
                  but we were unable to write to {values.contact_email}. Please get in touch and
                  quote your business name — there is no need to apply again.
                </AlertDescription>
              </Alert>
            )}
            <p className="text-xs">
              Your listing is reviewed before it appears in the marketplace. We will be in touch.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid-bg flex min-h-dvh items-start justify-center p-6">
      <div className="w-full max-w-2xl py-8">
        <Card>
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="font-mono tracking-wide">
              APPLY FOR BUILDER PORTAL ACCESS
            </CardTitle>
            <CardDescription>
              Builders, developers and sales representatives list their stock through the Aurixa
              Builder / Developer Portal. Tell us about your business and we will set you up.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {refusal && (
              <Alert className="mb-6 border-destructive/40 bg-destructive/5">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <AlertTitle className="text-sm">
                  {refusal.kind === "ours"
                    ? "We could not submit your application"
                    : "Please check this before we can continue"}
                </AlertTitle>
                <AlertDescription className="text-xs text-muted-foreground">
                  {refusal.sentence}
                </AlertDescription>
              </Alert>
            )}
            <form ref={formRef} onSubmit={onSubmit} className="space-y-6" noValidate>
              <section className="space-y-4">
                <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Your business
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="apply-legal_name">Registered name (required)</Label>
                    <Input
                      id="apply-legal_name"
                      name="legal_name"
                      autoFocus
                      value={values.legal_name}
                      onChange={(e) => set("legal_name")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-trading_name">Trading name</Label>
                    <Input
                      id="apply-trading_name"
                      name="trading_name"
                      value={values.trading_name}
                      onChange={(e) => set("trading_name")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-org_type">What you do (required)</Label>
                    <Select value={values.org_type || undefined} onValueChange={set("org_type")}>
                      <SelectTrigger id="apply-org_type" name="org_type">
                        <SelectValue placeholder="Choose one" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(ORG_TYPE_LABEL).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-website">Website</Label>
                    <Input
                      id="apply-website"
                      name="website"
                      inputMode="url"
                      placeholder="https://"
                      value={values.website}
                      onChange={(e) => set("website")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-abn">ABN</Label>
                    <Input
                      id="apply-abn"
                      name="abn"
                      inputMode="numeric"
                      value={values.abn}
                      onChange={(e) => set("abn")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-acn">ACN</Label>
                    <Input
                      id="apply-acn"
                      name="acn"
                      inputMode="numeric"
                      value={values.acn}
                      onChange={(e) => set("acn")(e.target.value)}
                    />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Who we write to
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="apply-contact_name">Your name (required)</Label>
                    <Input
                      id="apply-contact_name"
                      name="contact_name"
                      autoComplete="name"
                      value={values.contact_name}
                      onChange={(e) => set("contact_name")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-contact_email">Email (required)</Label>
                    <Input
                      id="apply-contact_email"
                      name="contact_email"
                      type="email"
                      autoComplete="email"
                      value={values.contact_email}
                      onChange={(e) => set("contact_email")(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Your access link is sent here, and it becomes the sign-in for the account that
                      owns your organisation.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-contact_phone">Phone</Label>
                    <Input
                      id="apply-contact_phone"
                      name="contact_phone"
                      type="tel"
                      autoComplete="tel"
                      value={values.contact_phone}
                      onChange={(e) => set("contact_phone")(e.target.value)}
                    />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  Where you are
                </h2>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="apply-suburb">Suburb</Label>
                    <Input
                      id="apply-suburb"
                      name="suburb"
                      value={values.suburb}
                      onChange={(e) => set("suburb")(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-state">State</Label>
                    <Select value={values.state || undefined} onValueChange={set("state")}>
                      <SelectTrigger id="apply-state" name="state">
                        <SelectValue placeholder="Choose" />
                      </SelectTrigger>
                      <SelectContent>
                        {APPLICATION_STATES.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="apply-postcode">Postcode</Label>
                    <Input
                      id="apply-postcode"
                      name="postcode"
                      inputMode="numeric"
                      value={values.postcode}
                      onChange={(e) => set("postcode")(e.target.value)}
                    />
                  </div>
                </div>
              </section>

              <div className="space-y-2">
                <Label htmlFor="apply-message">Anything else we should know</Label>
                <Textarea
                  id="apply-message"
                  name="message"
                  rows={4}
                  value={values.message}
                  onChange={(e) => set("message")(e.target.value)}
                />
              </div>

              <Button type="submit" className="w-full" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {busy ? "Submitting…" : "Apply for access"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                We will create your organisation and email you a link to set your password. Your
                listing is reviewed before it appears in the marketplace.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
