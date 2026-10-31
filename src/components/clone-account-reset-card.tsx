import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CopyButton } from "@/components/copy-button";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import {
  getCloneAccountResetEligibility,
  resetCloneDemoAccountFn,
} from "@/lib/clone-account-reset.functions";

// No quote, backslash or look-alike: the password travels inside a SQL literal
// on the clone, and is read off this screen by a person.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.!@#%+=";

/** 24 characters drawn at random, holding every class the product counts. */
function generatePassword(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const chars = [...bytes]
      .filter((b) => b < 256 - (256 % ALPHABET.length))
      .map((b) => ALPHABET[b % ALPHABET.length]);
    const candidate = chars.slice(0, 24).join("");
    if (
      candidate.length === 24 &&
      /[a-z]/.test(candidate) &&
      /[A-Z]/.test(candidate) &&
      /[0-9]/.test(candidate) &&
      /[^A-Za-z0-9]/.test(candidate)
    ) {
      return candidate;
    }
  }
}

/**
 * Set a demo clone's staff account back to a password the operator holds.
 *
 * Offered only where the server says the clone is a demo (`accountResetRefusal`):
 * anywhere else the panel says why and shows no form. The password is the
 * operator's, typed or generated here; Mission Control passes it to the clone
 * and keeps no copy, so this panel is the only place it is ever shown.
 */
export function CloneAccountResetCard({ cloneId }: { cloneId: string }) {
  const eligibilityFn = useServerFn(getCloneAccountResetEligibility);
  const resetFn = useServerFn(resetCloneDemoAccountFn);
  const { data: eligibility, isLoading } = useQuery({
    queryKey: ["clone-account-reset", cloneId],
    queryFn: () => eligibilityFn({ data: { cloneId } }),
  });
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [clearAuthenticator, setClearAuthenticator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);

  const reset = async () => {
    const asked = clearAuthenticator ? ", its authenticator removed" : "";
    if (
      !window.confirm(
        `Reset ${account.trim()} on this clone? Its password is replaced${asked}, and every session it has open is ended.`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await resetFn({ data: { cloneId, account, password, clearAuthenticator } });
      if (res.ok) {
        const authenticator =
          res.authenticatorClear === true
            ? "no authenticator"
            : res.authenticatorClear === false
              ? "authenticator still enrolled"
              : "authenticator not read";
        const sessions = `${res.sessionsEnded} session${res.sessionsEnded === 1 ? "" : "s"} ended`;
        setLast(`${res.account}: password set and verified · ${sessions} · ${authenticator}`);
        toast.success(`Reset ${res.account}`);
        setPassword("");
        setReveal(false);
      } else {
        toast.error(res.error);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" aria-hidden /> Demo accounts
        </CardTitle>
        <CardDescription>
          Set a staff account on this demo back to a password you hold. Never offered for a
          workspace somebody signs in to.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !eligibility?.eligible ? (
          <p className="text-sm text-muted-foreground">
            {eligibility?.reason ?? "Could not read whether this clone is a demo."}
          </p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="reset-account">Account</Label>
              <Input
                id="reset-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="username or email"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-password">New password</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="reset-password"
                  type={reveal ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setPassword(generatePassword());
                    setReveal(true);
                  }}
                >
                  Generate
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setReveal((v) => !v)}
                  aria-pressed={reveal}
                >
                  {reveal ? "Hide" : "Show"}
                </Button>
                {password && <CopyButton value={password} label="Copy password" />}
              </div>
              <p className="text-xs text-muted-foreground">
                At least 12 characters, mixing two of lowercase, uppercase, digits and symbols.
              </p>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="reset-clear-authenticator"
                checked={clearAuthenticator}
                onCheckedChange={(v) => setClearAuthenticator(v === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="reset-clear-authenticator">
                  Also remove its authenticator and recovery codes
                </Label>
                <p className="text-xs text-muted-foreground">
                  It then signs in with the password alone, and enrols again in the workspace.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              disabled={busy || !account.trim() || !password}
              onClick={() => void reset()}
            >
              Reset account
            </Button>
            {last && <p className="text-xs text-muted-foreground">{last}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
