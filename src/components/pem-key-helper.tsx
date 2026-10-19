import { useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CheckCircle2, XCircle, Copy, Key, Terminal, ShieldCheck, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { pkcs1ToPkcs8Pem, pkcs8PemToDer } from "@/lib/rsa-key-pem";

type KeyFormat = "idle" | "pkcs1" | "pkcs8" | "other-pem" | "invalid";

interface VerifyResult {
  ok: boolean;
  algorithm: string;
  bitLength: number;
  message: string;
}

function detectFormat(pem: string): KeyFormat {
  const t = pem.trim();
  if (!t) return "idle";
  if (t.includes("-----BEGIN RSA PRIVATE KEY-----")) return "pkcs1";
  if (t.includes("-----BEGIN PRIVATE KEY-----")) return "pkcs8";
  if (t.includes("-----BEGIN")) return "other-pem";
  return "invalid";
}

/** Convert PKCS#1 PEM → PKCS#8 PEM: the same key, its DER wrapped (`@/lib/rsa-key-pem`). */
function convertToPkcs8(pkcs1Pem: string): string {
  return pkcs1ToPkcs8Pem(pkcs1Pem);
}

const SELF_TEST = new TextEncoder().encode("github-app-key-test");
const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * Deep-verify, with the browser's own WebCrypto: the key imports as an RSA
 * PKCS#8 private key, is long enough for GitHub, and signs a payload its own
 * public half verifies. WebCrypto is what the JWT library imports it with
 * too, so a key that passes here is one the server can use.
 */
async function deepVerify(pem: string): Promise<VerifyResult> {
  const trimmed = pem.trim();

  // Must be PKCS#8
  if (!trimmed.includes("-----BEGIN PRIVATE KEY-----")) {
    return {
      ok: false,
      algorithm: "unknown",
      bitLength: 0,
      message: "Key is not in PKCS#8 format. Expected header: -----BEGIN PRIVATE KEY-----",
    };
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey("pkcs8", pkcs8PemToDer(trimmed), RSA_SHA256, true, [
      "sign",
    ]);
  } catch {
    return {
      ok: false,
      algorithm: "unknown",
      bitLength: 0,
      message:
        "Failed to parse key as a valid RSA private key. Ensure this is an unencrypted RSA key from your GitHub App.",
    };
  }

  const bitLength = (privateKey.algorithm as RsaHashedKeyAlgorithm).modulusLength ?? 0;

  // GitHub requires RSA 2048+
  if (bitLength < 2048) {
    return {
      ok: false,
      algorithm: "RSA",
      bitLength,
      message: `RSA key is only ${bitLength}-bit. GitHub Apps require at least 2048-bit RSA keys.`,
    };
  }

  // Quick sanity: sign + verify a test payload
  try {
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);
    if (!jwk.n || !jwk.e || !jwk.d) {
      return {
        ok: false,
        algorithm: "unknown",
        bitLength,
        message:
          "Key parsed but does not contain RSA components (n, e, d). GitHub Apps require an RSA key.",
      };
    }
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      RSA_SHA256,
      false,
      ["verify"],
    );
    const signature = await crypto.subtle.sign(RSA_SHA256, privateKey, SELF_TEST);
    const valid = await crypto.subtle.verify(RSA_SHA256, publicKey, signature, SELF_TEST);
    if (!valid) {
      return {
        ok: false,
        algorithm: "RSA",
        bitLength,
        message: "Key sign/verify self-test failed. The key may be corrupted or truncated.",
      };
    }
  } catch {
    return {
      ok: false,
      algorithm: "RSA",
      bitLength,
      message: "Key sign/verify self-test threw an error. The key may be corrupted.",
    };
  }

  return {
    ok: true,
    algorithm: "RSA",
    bitLength,
    message: `Valid RSA-${bitLength} private key in PKCS#8 format. Sign/verify self-test passed. Ready for GitHub App use.`,
  };
}

export function PemKeyHelper() {
  const [input, setInput] = useState("");
  const [converted, setConverted] = useState("");
  const [format, setFormat] = useState<KeyFormat>("idle");
  const [autoConvert, setAutoConvert] = useState(true);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const tryAutoConvert = useCallback(
    (pem: string): { fmt: KeyFormat; conv: string } => {
      const fmt = detectFormat(pem);
      if (fmt === "pkcs1" && autoConvert) {
        try {
          const pkcs8 = convertToPkcs8(pem);
          return { fmt: "pkcs8", conv: pkcs8 };
        } catch {
          return { fmt: "invalid", conv: "" };
        }
      }
      return { fmt, conv: "" };
    },
    [autoConvert],
  );

  const handleInput = (val: string) => {
    setInput(val);
    setVerifyResult(null);
    setError(null);
    setCopied(false);

    const { fmt, conv } = tryAutoConvert(val);
    setFormat(fmt);
    setConverted(conv);
  };

  const manualConvert = () => {
    setError(null);
    try {
      const pkcs8 = convertToPkcs8(input.trim());
      setConverted(pkcs8);
      setFormat("pkcs8");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversion failed");
      setFormat("invalid");
    }
  };

  const runVerify = async () => {
    setVerifying(true);
    setError(null);
    const result = await deepVerify(converted || input);
    setVerifyResult(result);
    if (!result.ok) setFormat("invalid");
    setVerifying(false);
  };

  const copyToClipboard = async () => {
    const text = converted || input;
    await navigator.clipboard.writeText(text.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const effectiveKey = converted || input;
  const canVerify = effectiveKey.trim().includes("-----BEGIN PRIVATE KEY-----");

  return (
    <Card className="/80">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-mono tracking-wide">
          <Key className="h-4 w-4 text-primary" />
          {"PRIVATE KEY CONVERTER & VALIDATOR"}
        </CardTitle>
        <CardDescription className="text-xs">
          GitHub App keys are often downloaded in <strong>PKCS#1</strong> format (
          <code className="bg-muted px-1">BEGIN RSA PRIVATE KEY</code>). Our system requires{" "}
          <strong>PKCS#8</strong> format (<code className="bg-muted px-1">BEGIN PRIVATE KEY</code>).
          Convert and verify here before saving.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* OpenSSL command reference */}
        <div className="border border-border bg-muted/40 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" />
            OpenSSL command (alternative)
          </div>
          <pre className="overflow-x-auto bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-foreground/90 select-all">
            {`openssl pkcs8 -topk8 -inform PEM \\
  -outform PEM -nocrypt \\
  -in your-github-app-key.pem \\
  -out converted-key.pem`}
          </pre>
          <p className="text-[11px] text-muted-foreground">
            Or use the in-browser converter below.
          </p>
        </div>

        {/* Auto-convert toggle */}
        <div className="flex items-center gap-3">
          <Switch id="auto-convert" checked={autoConvert} onCheckedChange={setAutoConvert} />
          <Label htmlFor="auto-convert" className="text-xs cursor-pointer">
            Auto-convert PKCS#1 to PKCS#8 on paste
          </Label>
        </div>

        {/* Input */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Paste your private key (PKCS#1 or PKCS#8)
          </label>
          <Textarea
            rows={6}
            className="font-mono text-[11px] leading-relaxed"
            placeholder={
              "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
            }
            value={input}
            onChange={(e) => handleInput(e.target.value)}
          />
          {format !== "idle" && (
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] uppercase",
                  format === "pkcs1" && "border-warning/40 text-warning",
                  format === "pkcs8" && "border-success/40 text-success",
                  format === "other-pem" && "border-warning/40 text-warning",
                  format === "invalid" && "border-destructive/40 text-destructive",
                )}
              >
                {format === "pkcs1" && "PKCS#1 detected — click Convert below"}
                {format === "pkcs8" &&
                  (converted ? "Auto-converted to PKCS#8 ✓" : "PKCS#8 format ✓")}
                {format === "other-pem" && "Unrecognised PEM type — expected RSA private key"}
                {format === "invalid" && "Invalid or unrecognised key"}
              </Badge>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2">
          {format === "pkcs1" && !autoConvert && (
            <Button size="sm" onClick={manualConvert}>
              Convert to PKCS#8
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={runVerify}
            disabled={!canVerify || verifying}
          >
            {verifying ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            )}
            Verify as GitHub App key
          </Button>
        </div>

        {/* Converted output */}
        {converted && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-success">
              Converted key (PKCS#8) — copy this into the secret
            </label>
            <Textarea
              rows={6}
              readOnly
              className="font-mono text-[11px] leading-relaxed border-success/30 bg-success/5"
              value={converted}
            />
            <Button size="sm" variant="outline" onClick={copyToClipboard}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              {copied ? "Copied!" : "Copy to clipboard"}
            </Button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}

        {/* Verify result */}
        {verifyResult && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border p-3 text-xs",
              verifyResult.ok
                ? "border-success/40 bg-success/5 text-success"
                : "border-destructive/40 bg-destructive/5 text-destructive",
            )}
          >
            {verifyResult.ok ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <div className="space-y-0.5">
              <div>{verifyResult.message}</div>
              {verifyResult.ok && (
                <div className="text-[10px] text-muted-foreground">
                  Algorithm: {verifyResult.algorithm} · Key size: {verifyResult.bitLength}-bit
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
