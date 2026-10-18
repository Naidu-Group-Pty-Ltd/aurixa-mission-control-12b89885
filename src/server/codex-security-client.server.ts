// Codex Security scan engine. Server-only.
//
// History: this module used to POST at `https://api.openai.com/v1/security`,
// an endpoint that has never existed. Every enqueue therefore 404'd, every
// job flipped straight to `failed`, and the whole feature read as dead. The
// engine below replaces that with a real, working execution path.
//
// Engines
//   `github_actions` (default) — dispatches `codex-security-scan.yml` in the
//     target repository through the Aurixa GitHub App. The workflow runs
//     gitleaks / semgrep / osv-scanner plus an optional Codex CLI reasoning
//     pass and reports findings back to the HMAC-verified webhook. This is
//     the path that actually runs today.
//   `http` — the original vendor-API passthrough, kept behind
//     `CODEX_SECURITY_ENGINE=http` so a real hosted scan API can be adopted
//     later without touching any caller.
//
// Callers only ever see `dispatchCodexScan`, so swapping engines is config.

import { getAppOctokit } from "@/server/github-app.server";
import { declaredWorkflowVersion } from "@/lib/codex-workflow-contract";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

export type ScanEngine = "github_actions" | "http";

export type CodexScanRequest = {
  jobId: string;
  repoFullName: string;
  ref?: string | null;
  pathGlobs?: string[] | null;
  kind: string;
  callbackUrl: string;
  callbackSecret: string;
  /** Owner/repo/installation for the GitHub Actions engine. */
  owner?: string | null;
  repo?: string | null;
  installationId?: string | null;
  /** Branch or tag that carries the workflow file. Must NOT be a raw SHA. */
  dispatchRef?: string | null;
  /** When set, the scan only covers files changed against this ref. */
  diffBase?: string | null;
  /** Opt out of the (slower, paid) Codex CLI reasoning pass. */
  deepScan?: boolean;
  metadata?: Record<string, unknown>;
};

export type CodexScanResponse = {
  externalScanId: string;
  status: string;
  engine: ScanEngine;
  workflowRunId?: number | null;
  workflowRunUrl?: string | null;
};

export const DEFAULT_SCAN_WORKFLOW_FILE = "codex-security-scan.yml";

export function scanWorkflowFile(): string {
  return process.env.CODEX_SCAN_WORKFLOW_FILE || DEFAULT_SCAN_WORKFLOW_FILE;
}

/**
 * Which engine executes scans. Defaults to `github_actions` because that is
 * the only one with a real backend today; `http` is opt-in.
 */
export function resolveScanEngine(): ScanEngine {
  const raw = (process.env.CODEX_SECURITY_ENGINE || "").trim().toLowerCase();
  if (raw === "http" || raw === "api") return "http";
  return "github_actions";
}

/**
 * Public origin of this Mission Control deployment, used to build callback
 * URLs. Accepts both spellings: the code historically read `APP_PUBLIC_URL`
 * while `.env.example` documented `PUBLIC_APP_URL`, so callbacks silently
 * fell back to the hardcoded default whenever only the documented name was
 * set. Both now work.
 */
export function appPublicOrigin(): string {
  const raw =
    process.env.APP_PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    "https://mission-control.aurixasystems.com.au";
  return raw.replace(/\/+$/, "");
}

export function scanCallbackUrl(): string {
  return `${appPublicOrigin()}/api/public/hooks/codex-security`;
}

export function remediationCallbackUrl(): string {
  return `${appPublicOrigin()}/api/public/hooks/codex-remediation`;
}

function splitRepo(req: CodexScanRequest): { owner: string; repo: string } {
  const owner = req.owner || req.repoFullName.split("/")[0] || "";
  const repo = req.repo || req.repoFullName.split("/")[1] || "";
  if (!owner || !repo) {
    throw new Error(`Cannot resolve owner/repo from "${req.repoFullName}"`);
  }
  return { owner, repo };
}

/** A ref is dispatchable only if it is a branch/tag name, not a commit SHA. */
function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

// ─── Engine: GitHub Actions ──────────────────────────────────────────────

async function dispatchViaGitHubActions(req: CodexScanRequest): Promise<CodexScanResponse> {
  const { owner, repo } = splitRepo(req);
  const octokit = getAppOctokit(req.installationId ?? undefined);
  const workflowFile = scanWorkflowFile();

  // `workflow_dispatch` only accepts a branch or tag as its ref. PR scans
  // target a head SHA, so we dispatch on a branch that carries the workflow
  // and pass the SHA through as the `scan_ref` input for checkout.
  const requested = (req.dispatchRef || req.ref || "").trim();
  const dispatchRef = requested && !isCommitSha(requested) ? requested : req.dispatchRef || "main";

  const inputs: Record<string, string> = {
    job_id: req.jobId,
    scan_kind: req.kind,
    scan_ref: req.ref ?? "",
    diff_base: req.diffBase ?? "",
    path_globs: (req.pathGlobs ?? []).join(","),
    callback_url: req.callbackUrl,
    callback_secret: req.callbackSecret,
    deep_scan: req.deepScan === false ? "false" : "true",
  };

  try {
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner,
          repo,
          workflow_id: workflowFile,
          ref: dispatchRef,
          inputs,
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
  } catch (err) {
    throw new Error(describeDispatchError(err, owner, repo, workflowFile, dispatchRef));
  }

  // The workflow reports its own run id and url in the `scan.started`
  // callback, so there is deliberately no polling here — it would add
  // seconds of latency per scan for information that arrives anyway.
  return {
    externalScanId: `gha:${owner}/${repo}:${req.jobId}`,
    status: "running",
    engine: "github_actions",
    workflowRunId: null,
    workflowRunUrl: null,
  };
}

/**
 * GitHub's dispatch errors are famously terse ("Not Found" for a missing
 * workflow file, a missing branch, AND a missing permission). Operators
 * chasing a dead scan pipeline need to know which one it was.
 */
function describeDispatchError(
  err: unknown,
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404) {
    return (
      `GitHub returned 404 dispatching ${workflowFile} on ${target}@${ref}. ` +
      `Check that .github/workflows/${workflowFile} exists on branch "${ref}", ` +
      `that the branch exists, and that the Aurixa GitHub App is installed on ${target} ` +
      `with Actions: read & write.`
    );
  }
  if (status === 403) {
    return (
      `GitHub returned 403 dispatching ${workflowFile} on ${target}. ` +
      `The GitHub App installation is missing the Actions: read & write permission ` +
      `(re-accept the App's permissions on the installation). Detail: ${message}`
    );
  }
  if (status === 422) {
    return (
      `GitHub rejected the dispatch inputs for ${workflowFile} on ${target}@${ref}: ${message}. ` +
      `This usually means the workflow file in the target repo is an older revision ` +
      `whose workflow_dispatch inputs no longer match — re-sync the workflow template.`
    );
  }
  return `Codex scan dispatch failed for ${target}@${ref}${status ? ` [${status}]` : ""}: ${message}`;
}

/**
 * Best-effort check that the target repo actually carries a Codex workflow —
 * the scan workflow unless another file is named — and which
 * `WORKFLOW_VERSION` its copy declares. Used by the engine health panel so
 * "nothing is running" and "running an outdated workflow" are diagnosable
 * without reading Actions logs.
 */
export async function checkScanWorkflowPresent(input: {
  owner: string;
  repo: string;
  ref?: string | null;
  installationId?: string | null;
  workflowFile?: string;
}): Promise<{
  present: boolean;
  detail: string;
  version: number | null;
  /** Whether the file declares `workflow_dispatch` (null when it was not read). */
  dispatchable: boolean | null;
}> {
  const workflowFile = input.workflowFile ?? scanWorkflowFile();
  try {
    const octokit = getAppOctokit(input.installationId ?? undefined);
    const res = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: input.owner,
      repo: input.repo,
      path: `.github/workflows/${workflowFile}`,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    const content = (res.data as { content?: string; encoding?: string }).content;
    const text =
      typeof content === "string"
        ? Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8")
        : "";
    const version = text ? declaredWorkflowVersion(text) : null;
    return {
      present: true,
      detail: `.github/workflows/${workflowFile} found`,
      version,
      dispatchable: text ? /\bworkflow_dispatch\b/.test(text) : null,
    };
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 404) {
      return {
        present: false,
        detail: `.github/workflows/${workflowFile} is missing from ${input.owner}/${input.repo}`,
        version: null,
        dispatchable: null,
      };
    }
    return {
      present: false,
      detail:
        err instanceof Error
          ? `Could not verify workflow file: ${err.message}`
          : "Could not verify workflow file",
      version: null,
      dispatchable: null,
    };
  }
}

// ─── Engine: hosted HTTP API (opt-in) ────────────────────────────────────

function httpBaseUrl(): string {
  return (process.env.CODEX_SECURITY_BASE_URL || "https://api.openai.com/v1/security").replace(
    /\/+$/,
    "",
  );
}

function apiKey(): string {
  const k = process.env.CODEX_SECURITY_API_KEY;
  if (!k) throw new Error("CODEX_SECURITY_API_KEY not configured");
  return k;
}

async function dispatchViaHttp(req: CodexScanRequest): Promise<CodexScanResponse> {
  const res = await withRetry(
    async () => {
      const r = await fetch(`${httpBaseUrl()}/scans`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_job_id: req.jobId,
          repository: req.repoFullName,
          ref: req.ref ?? undefined,
          path_globs: req.pathGlobs ?? undefined,
          kind: req.kind,
          callback_url: req.callbackUrl,
          callback_secret: req.callbackSecret,
          metadata: req.metadata ?? {},
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        const error = new Error(
          `Codex enqueue failed [${r.status}]: ${text.slice(0, 500)}`,
        ) as Error & { status?: number };
        error.status = r.status;
        throw error;
      }
      return r;
    },
    { attempts: 3, shouldRetry: isTransientHttpError },
  );

  const body = (await res.json()) as { id: string; status?: string };
  return {
    externalScanId: body.id,
    status: body.status || "running",
    engine: "http",
  };
}

export async function getCodexScan(externalScanId: string) {
  const res = await fetch(`${httpBaseUrl()}/scans/${externalScanId}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Codex status failed [${res.status}]: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// ─── Public entry point ──────────────────────────────────────────────────

export async function dispatchCodexScan(req: CodexScanRequest): Promise<CodexScanResponse> {
  if (!req.callbackSecret) {
    throw new Error(
      "CODEX_SECURITY_WEBHOOK_SECRET is not configured — the scanner would have " +
        "no way to report results back, so the scan was not dispatched.",
    );
  }
  return resolveScanEngine() === "http" ? dispatchViaHttp(req) : dispatchViaGitHubActions(req);
}

/** Back-compat alias for the pre-engine call site name. */
export const enqueueCodexScan = dispatchCodexScan;

// ─── Webhook signature verification ──────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-independent, branch-free comparison of two hex digests. */
function constantTimeEquals(a: string, b: string): boolean {
  // Fold the length difference into the result rather than returning early
  // for unequal lengths, so timing leaks nothing about the expected digest.
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function hmacHex(secret: string, rawBody: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(rawBody)));
}

/**
 * Verify an inbound webhook signature (`sha256=<hex>` or bare hex) against a
 * candidate secret list. Multiple candidates let a rotation accept both the
 * old and new value during the cutover window; empty/nullish entries are
 * dropped, and an empty list always fails closed.
 *
 * Callers pass the secrets for *their* endpoint only — the scan and
 * remediation webhooks deliberately do not accept each other's key.
 */
export async function verifyHmacSignature(
  rawBody: string,
  signatureHeader: string | null,
  candidateSecrets: (string | null | undefined)[],
): Promise<boolean> {
  if (!signatureHeader) return false;

  const secrets = candidateSecrets.filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (secrets.length === 0) return false;

  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  let ok = false;
  for (const secret of secrets) {
    // No early exit: every candidate is checked so verification time does
    // not depend on which secret matched.
    if (constantTimeEquals(await hmacHex(secret, rawBody), provided)) ok = true;
  }
  return ok;
}

/**
 * Verify a scan webhook signature. `extraSecrets` carries the per-source
 * intake secret (security_intake_sources) so the pipeline authenticates even
 * when no env var is configured.
 */
export async function verifyCodexSignature(
  rawBody: string,
  signatureHeader: string | null,
  extraSecrets: (string | null | undefined)[] = [],
): Promise<boolean> {
  return verifyHmacSignature(rawBody, signatureHeader, [
    process.env.CODEX_SECURITY_WEBHOOK_SECRET,
    ...extraSecrets,
  ]);
}

/** Sign a payload the same way inbound callbacks are expected to be signed. */
export async function signCodexPayload(secret: string, rawBody: string): Promise<string> {
  return `sha256=${await hmacHex(secret, rawBody)}`;
}
