/**
 * The gateway's front door: `https://mobile.aurixasystems.com.au/` (and
 * `/access` on any host). A person enters their email and their workspace's
 * address and is sent a 15-minute link by Aurixa Systems. The answer on the
 * page is the same sentence whatever happened, so the form cannot be used to
 * learn who has access to what.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/access")({
  component: AccessPage,
  head: () => ({
    meta: [
      { title: "Mobile access — Aurixa Systems" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

function AccessPage() {
  const [email, setEmail] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/public/mobile/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          workspace: workspace.replace(/^https?:\/\//, "").replace(/[/?#].*$/, ""),
        }),
      });
      const body = (await r.json().catch(() => ({}))) as { message?: string };
      if (r.ok) setAnswer(body.message ?? "If that email has access, a link is on its way.");
      else setError(body.message ?? "That did not work. Try again shortly.");
    } catch {
      setError("That did not work. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <Card className="glass w-full max-w-md">
        <CardHeader>
          <CardTitle>Open your workspace's app</CardTitle>
          <CardDescription>
            We will email you a link that installs and signs in to your app. It lasts 15 minutes and
            works once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {answer ? (
            <p role="status" className="text-sm">
              {answer}
            </p>
          ) : (
            <form className="space-y-4" onSubmit={submit} noValidate>
              <div className="space-y-2">
                <Label htmlFor="access-email">Email</Label>
                <Input
                  id="access-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="access-workspace">Workspace address</Label>
                <Input
                  id="access-workspace"
                  inputMode="url"
                  autoCapitalize="none"
                  placeholder="yourfirm.aurixasystems.com.au"
                  value={workspace}
                  onChange={(e) => setWorkspace(e.target.value.trim().toLowerCase())}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Mail className="mr-2 h-4 w-4" aria-hidden />
                )}
                Email me a link
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
