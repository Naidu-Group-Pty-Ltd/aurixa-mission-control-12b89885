// The normalizer embedded in .github/workflows/codex-security-scan.yml, run
// for real: extracted from the workflow file, executed with node against
// scanner reports, its output read back.
//
// Credential-shaped fixtures are built at run time, never written into this
// file: a literal key here would be one more finding in every scan of this
// repository, and the point of the severity rules below is to stop filing
// exactly that kind of thing as critical.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

function extractNormalizer(): string {
  const text = readFileSync(
    path.join(process.cwd(), ".github/workflows/codex-security-scan.yml"),
    "utf8",
  );
  const open = `cat > "$HELPER_DIR/normalize.mjs" <<'NORMALIZE'\n`;
  const start = text.indexOf(open);
  if (start < 0) throw new Error("normalizer heredoc not found in the scan workflow");
  const body = text.slice(start + open.length, text.indexOf("\n          NORMALIZE\n", start));
  return body
    .split("\n")
    .map((l) => (l.startsWith("          ") ? l.slice(10) : l))
    .join("\n");
}

const ROOT = mkdtempSync(path.join(tmpdir(), "codex-normalizer-"));
const SCRIPT = path.join(ROOT, "normalize.mjs");
writeFileSync(SCRIPT, extractNormalizer());
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let n = 0;
type Files = Record<string, string>;
type Reports = Record<string, unknown>;

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const runGit = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...GIT_ENV },
    encoding: "utf8",
  }).trim();

function writeFiles(ws: string, files: Files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    writeFileSync(path.join(ws, rel), content);
  }
}

/** Lay out a workspace and a report directory, run the normalizer, return its output. */
function normalize(opts: {
  files?: Files;
  reports?: Reports;
  statuses?: Record<string, { status: string; reason?: string; mode?: string }>;
  env?: Record<string, string>;
  scope?: string[];
  /** Commit `files` to a git repository, as a checkout would have them. */
  committed?: boolean;
  /** A pull request: `base` committed, then `files` (and `deleted`) committed on top. */
  pr?: { base: Files; deleted?: string[] };
}) {
  const dir = path.join(ROOT, `run-${++n}`);
  const ws = path.join(dir, "ws");
  const reports = path.join(dir, "reports");
  mkdirSync(path.join(reports, "status"), { recursive: true });
  mkdirSync(ws, { recursive: true });
  let prEnv: Record<string, string> = {};
  if (opts.pr) {
    runGit(ws, ["init", "-q", "-b", "main", "."]);
    writeFiles(ws, opts.pr.base);
    runGit(ws, ["add", "-A"]);
    runGit(ws, ["commit", "-q", "-m", "base"]);
    const base = runGit(ws, ["rev-parse", "HEAD"]);
    writeFiles(ws, opts.files ?? {});
    for (const rel of opts.pr.deleted ?? []) rmSync(path.join(ws, rel));
    runGit(ws, ["add", "-A"]);
    runGit(ws, ["commit", "-q", "-m", "change"]);
    prEnv = { SCOPE_MODE: "diff", BASE_SHA: base };
  } else {
    writeFiles(ws, opts.files ?? {});
    if (opts.committed) {
      runGit(ws, ["init", "-q", "-b", "main", "."]);
      runGit(ws, ["add", "-A"]);
      runGit(ws, ["commit", "-q", "-m", "tree"]);
    }
  }
  for (const [name, content] of Object.entries(opts.reports ?? {})) {
    writeFileSync(
      path.join(reports, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  const statuses = opts.statuses ?? {
    gitleaks: { status: "ok", mode: "dir" },
    semgrep: { status: "ok" },
    "osv-scanner": { status: "ok" },
    codex: { status: "ok" },
  };
  for (const [name, s] of Object.entries(statuses)) {
    writeFileSync(path.join(reports, "status", `${name}.json`), JSON.stringify(s));
  }
  if (opts.scope) writeFileSync(path.join(reports, "scope.txt"), opts.scope.join("\n"));
  execFileSync(process.execPath, [SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "",
      REPORT_DIR: reports,
      GITHUB_WORKSPACE: ws,
      ...GIT_ENV,
      ...prEnv,
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { ws, ...JSON.parse(readFileSync(path.join(reports, "normalized.json"), "utf8")) } as {
    ws: string;
    findings: any[];
    summary: any;
  };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");
// The scanners' inline suppression markers, built like the credentials: a
// literal one here would count as a suppression in every scan of this repo.
const SEMGREP_IGNORE = ["// no", "semgrep"].join("");
const GITLEAKS_ALLOW = ["// gitleaks", "allow"].join(":");
const jwt = (role: string) =>
  [
    b64url('{"alg":"HS256","typ":"JWT"}'),
    b64url(JSON.stringify({ iss: "supabase", role })),
    b64url(crypto.randomBytes(32)),
  ].join(".");
const token = () =>
  crypto
    .randomBytes(24)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, 32) + "9aZ";
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const legacy = (parts: string[]) => sha(parts.filter(Boolean).join(" ")).slice(0, 32);

/** A gitleaks report entry for `needle` on `line` of `text`. */
function leak(file: string, text: string, rule: string, needle: string, endLine?: number) {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  const line = lines[idx];
  return {
    RuleID: rule,
    Description: `${rule} detected`,
    File: file,
    StartLine: idx + 1,
    EndLine: endLine ?? idx + 1,
    StartColumn: line.indexOf(needle) + 1,
    EndColumn: endLine ? lines[endLine - 1].length : line.length,
    Match: "REDACTED",
    Secret: "REDACTED",
    Commit: "",
    Fingerprint: `${file}:${rule}:${idx + 1}`,
  };
}

describe("gitleaks severity", () => {
  const anon = jwt("anon");
  const service = jwt("service_role");
  const random = token();
  const testValue = token();
  const material = Array.from({ length: 3 }, () => crypto.randomBytes(48).toString("base64")).join(
    "\n",
  );
  const config = [
    `export const anonKey = "${anon}";`,
    `export const serviceKey = "${service}";`,
    `export const assistantId = "${crypto.randomUUID()}";`,
    `export const names = { apiKey: "STRIPE_SECRET_KEY" };`,
    `export const token = "${random}";`,
    `export const authHeader = "${token()}";`,
    `export const stripeKey = "${["pk", "live", token()].join("_")}";`,
  ].join("\n");
  const migration = `DO $$\nDECLARE\n  v_secret text := '${crypto.randomBytes(32).toString("hex")}';\nBEGIN\nEND $$;\n`;
  const fixture = `const apiKey = "${testValue}";\n`;
  const pem = `const HEADER = "-----BEGIN PRIVATE KEY-----";\n`;
  const keyFile = `-----BEGIN PRIVATE KEY-----\n${material}\n-----END PRIVATE KEY-----\n`;

  const out = normalize({
    files: {
      "src/config.ts": config,
      "src/client.test.ts": fixture,
      "src/pem.ts": pem,
      "keys/server.pem": keyFile,
      "supabase/migrations/20260101000000_cron.sql": migration,
    },
    reports: {
      "gitleaks.json": [
        leak("src/config.ts", config, "jwt", anon),
        leak("src/config.ts", config, "jwt", service),
        leak("src/config.ts", config, "generic-api-key", "assistantId"),
        leak("src/config.ts", config, "generic-api-key", "apiKey"),
        leak("src/config.ts", config, "generic-api-key", "token ="),
        leak("src/config.ts", config, "generic-api-key", "authHeader"),
        leak("src/config.ts", config, "generic-api-key", "stripeKey"),
        leak(
          "supabase/migrations/20260101000000_cron.sql",
          migration,
          "generic-api-key",
          "v_secret",
        ),
        leak("src/client.test.ts", fixture, "generic-api-key", "apiKey"),
        leak("src/pem.ts", pem, "private-key", "-----BEGIN"),
        leak("keys/server.pem", keyFile, "private-key", "-----BEGIN", 5),
      ],
    },
  });
  const sev = (file: string, line: number) =>
    out.findings.find((f) => f.file === file && f.line === line)?.severity;

  it("files a public Supabase anon key as info and a service_role key as critical", () => {
    expect(sev("src/config.ts", 1)).toBe("info");
    expect(out.findings.find((f) => f.line === 1 && f.file === "src/config.ts").title).toBe(
      "Supabase anon (publishable) key committed",
    );
    expect(sev("src/config.ts", 2)).toBe("critical");
  });

  it("does not call an identifier or a secret's name a credential", () => {
    expect(sev("src/config.ts", 3)).toBe("info");
    expect(sev("src/config.ts", 4)).toBe("info");
  });

  it("files a random value named like a credential as high, in code and in SQL", () => {
    expect(sev("src/config.ts", 5)).toBe("high");
    expect(sev("supabase/migrations/20260101000000_cron.sql", 3)).toBe("high");
  });

  it("files the rest of the generic rule as medium, low in a test file, info for publishable keys", () => {
    expect(sev("src/config.ts", 6)).toBe("medium");
    expect(sev("src/client.test.ts", 1)).toBe("low");
    expect(sev("src/config.ts", 7)).toBe("info");
  });

  it("tells PEM-handling code from key material", () => {
    expect(sev("src/pem.ts", 1)).toBe("low");
    expect(sev("keys/server.pem", 1)).toBe("critical");
  });

  it("never sends the credential itself", () => {
    const sent = JSON.stringify(out.findings);
    for (const secret of [anon, service, random, testValue, material.split("\n")[0]]) {
      expect(sent).not.toContain(secret);
    }
    expect(out.findings.every((f) => f.snippet === null)).toBe(true);
  });

  it("keeps the old line-based id alongside, for re-keying", () => {
    const f = out.findings.find((x) => x.file === "src/config.ts" && x.line === 5);
    expect(f.legacy_fingerprint).toBe(
      legacy(["gitleaks", "generic-api-key", "src/config.ts", "5"]),
    );
    expect(f.id).not.toBe(f.legacy_fingerprint);
  });
});

describe("semgrep", () => {
  const anon = jwt("anon");
  const app = (prefix = "") =>
    `${prefix}export function a(x: string) {\n  return eval(x);\n}\nexport function b(x: string) {\n  return eval(x);\n}\nconst key = "${anon}";\n`;
  const result = (
    text: string,
    needle: string,
    nth: number,
    checkId: string,
    extra: Record<string, unknown>,
  ) => {
    let at = -1;
    for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
    const line = text.slice(0, at).split("\n").length;
    return {
      check_id: checkId,
      path: "src/app.ts",
      start: { line, col: 1, offset: at },
      end: { line, col: 1, offset: at + needle.length },
      extra: { message: "found it", metadata: {}, lines: "requires login", ...extra },
    };
  };
  const report = (text: string) => ({
    results: [
      result(text, "eval(x)", 0, "javascript.lang.security.detect-eval", { severity: "WARNING" }),
      result(text, "eval(x)", 1, "javascript.lang.security.detect-eval", { severity: "WARNING" }),
      result(text, anon, 0, "generic.secrets.security.detected-jwt-token", { severity: "ERROR" }),
      result(text, `const key = "${anon}"`, 0, "javascript.lang.audit.hardcoded-string", {
        severity: "CRITICAL",
      }),
    ],
    errors: [],
  });
  const first = normalize({
    files: { "src/app.ts": app() },
    reports: { "semgrep.json": report(app()) },
  });
  const shifted = normalize({
    files: { "src/app.ts": app("// a header\n\n") },
    reports: { "semgrep.json": report(app("// a header\n\n")) },
  });
  const evals = (o: typeof first) => o.findings.filter((f) => f.rule_id.endsWith("detect-eval"));

  it("keeps a finding's identity when lines are added above it", () => {
    expect(
      evals(shifted)
        .map((f) => f.id)
        .sort(),
    ).toEqual(
      evals(first)
        .map((f) => f.id)
        .sort(),
    );
    expect(evals(shifted).map((f) => f.line)).not.toEqual(evals(first).map((f) => f.line));
  });

  it("tells identical matches in one file apart", () => {
    const ids = evals(first).map((f) => f.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("reads the matched code from the checkout and redacts it", () => {
    const hardcoded = first.findings.find((f) => f.rule_id.endsWith("hardcoded-string"));
    expect(hardcoded.severity).toBe("critical");
    expect(hardcoded.snippet).toContain("[redacted jwt]");
    expect(hardcoded.snippet).not.toContain(anon);
    expect(evals(first)[0].snippet).toContain("eval(x)");
  });

  it("sends no snippet for a secret rule, and recognises the anon key there too", () => {
    const secret = first.findings.find((f) => f.rule_id.includes("detected-jwt-token"));
    expect(secret.snippet).toBeNull();
    expect(secret.severity).toBe("info");
  });

  it("keeps the old line-based id alongside", () => {
    const f = evals(first).find((x) => x.line === 2);
    expect(f.legacy_fingerprint).toBe(
      legacy(["semgrep", "javascript.lang.security.detect-eval", "src/app.ts", "2"]),
    );
  });
});

describe("osv-scanner", () => {
  const vuln = (id: string, cve: string, vector: string, fixed: string) => ({
    id,
    aliases: [cve],
    summary: `${id} summary`,
    severity: [{ type: "CVSS_V3", score: vector }],
    affected: [
      {
        package: { name: "lodash", ecosystem: "npm" },
        ranges: [{ events: [{ introduced: "0" }, { fixed }] }],
      },
    ],
  });
  const lockReport = (lockPath: string, vulns: ReturnType<typeof vuln>[]) => ({
    results: [
      {
        source: { path: lockPath, type: "lockfile" },
        packages: [
          {
            package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
            vulnerabilities: vulns,
            groups: vulns.map((v) => ({ ids: [v.id], max_severity: "" })),
          },
        ],
      },
    ],
  });
  const critical = vuln(
    "GHSA-aaaa-bbbb-cccc",
    "CVE-2021-0001",
    "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    "4.17.21",
  );
  const medium = vuln(
    "GHSA-dddd-eeee-ffff",
    "CVE-2021-0002",
    "CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N",
    "4.17.22",
  );

  it("scores CVSS vectors instead of filing every vulnerability as medium", () => {
    const out = normalize({
      reports: { "osv.json": lockReport("/x/package-lock.json", [critical, medium]) },
    });
    const byId = Object.fromEntries(out.findings.map((f) => [f.rule_id, f]));
    expect(byId["GHSA-aaaa-bbbb-cccc"]).toMatchObject({ severity: "critical", cvss: 9.8 });
    expect(byId["GHSA-dddd-eeee-ffff"].severity).toBe("medium");
    expect(byId["GHSA-aaaa-bbbb-cccc"].description).toContain("Fixed in: 4.17.21");
    expect(byId["GHSA-aaaa-bbbb-cccc"].description).toContain("CVE-2021-0001");
  });

  it("reports only what a pull request introduces", () => {
    const out = normalize({
      env: { SCOPE_MODE: "diff" },
      scope: ["package-lock.json"],
      files: { "package-lock.json": "{}" },
      reports: {
        "osv.json": lockReport("package-lock.json", [critical, medium]),
        "osv-base.json": lockReport("/tmp/base/1/package-lock.json", [medium]),
        "osv-base-paths.json": { "/tmp/base/1/package-lock.json": "package-lock.json" },
      },
    });
    expect(out.findings.map((f) => f.rule_id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });
});

describe("the Codex review", () => {
  const code = "export async function handler(req) {\n  return db.query(req.body.sql);\n}\n";
  const run = (title: string) =>
    normalize({
      files: { "src/handler.ts": code },
      reports: {
        "codex.json": {
          findings: [
            {
              title,
              severity: "HIGH",
              description: null,
              file: "src/handler.ts",
              line: 2,
              cwe: "CWE-89: SQLi",
              confidence: 2,
            },
            { title: 42 },
            null,
          ],
        },
      },
    });

  it("keeps identity when the model words the same issue differently", () => {
    const a = run("SQL injection in handler");
    const b = run("Raw SQL from the request body is executed");
    expect(a.findings).toHaveLength(1);
    expect(a.findings[0].id).toBe(b.findings[0].id);
    expect(a.findings[0]).toMatchObject({
      severity: "high",
      cwe: "CWE-89",
      auto_fix_confidence: 1,
      description: null,
    });
  });
});

describe("scanner outcomes", () => {
  it("treats a scanner whose step never reported as failed, not clean", () => {
    const out = normalize({
      reports: { "semgrep.json": { results: [], errors: [] } },
      statuses: { gitleaks: { status: "ok", mode: "dir" } },
    });
    expect(out.summary.scanners.semgrep.status).toBe("failed");
    expect(out.summary.scanners.gitleaks.status).toBe("failed"); // ok, but no readable report
    expect(out.summary.scanners.codex.status).toBe("failed");
  });

  it("skips the history scan when the tree scan did not work", () => {
    const out = normalize({
      env: { GITLEAKS_HISTORY: "true" },
      statuses: {
        gitleaks: { status: "failed", reason: "gitleaks exited 2" },
        "gitleaks-history": { status: "ok", mode: "history" },
      },
      reports: { "gitleaks-history.json": [] },
    });
    expect(out.summary.scanners["gitleaks-history"].status).toBe("skipped");
  });

  it("drops findings outside a path-scoped scan", () => {
    const text = 'const apiKey = "' + token() + '";\n';
    const out = normalize({
      env: { SCOPE_MODE: "paths" },
      scope: ["src/kept.ts"],
      files: { "src/kept.ts": text, "src/other.ts": text },
      reports: {
        "gitleaks.json": [
          leak("src/kept.ts", text, "generic-api-key", "apiKey"),
          leak("src/other.ts", text, "generic-api-key", "apiKey"),
        ],
      },
    });
    expect(out.findings.map((f) => f.file)).toEqual(["src/kept.ts"]);
    expect(out.summary.scope).toEqual({ mode: "paths", files: 1 });
  });

  it("summarises what it sends", () => {
    const out = normalize({ reports: { "gitleaks.json": [] } });
    expect(out.summary).toMatchObject({ total: 0, fingerprint_version: 2, critical: 0 });
  });
});

describe("what the scan ran and what it was told to ignore", () => {
  it("counts findings per scanner", () => {
    const text = 'const apiKey = "' + token() + '";\n';
    const out = normalize({
      files: { "src/a.ts": text },
      reports: {
        "gitleaks.json": [leak("src/a.ts", text, "generic-api-key", "apiKey")],
        "semgrep.json": {
          results: [
            {
              check_id: "javascript.lang.security.audit.eval",
              path: "src/a.ts",
              start: { line: 1, col: 1 },
              end: { line: 1, col: 10 },
              extra: { severity: "ERROR", message: "eval", metadata: {} },
            },
          ],
          errors: [],
        },
      },
    });
    expect(Object.keys(out.summary.by_scanner).sort()).toEqual(["gitleaks", "semgrep"]);
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    expect(total(out.summary.by_scanner.gitleaks)).toBe(1);
    expect(total(out.summary.by_scanner.semgrep)).toBe(1);
  });

  it("passes through which semgrep rules ran", () => {
    const rules = {
      source: "registry",
      digest: "0123456789abcdef",
      files: [{ name: "p.yml", sha256: "aa" }],
    };
    expect(normalize({ reports: { "semgrep-rules.json": rules } }).summary.rulesets).toEqual({
      semgrep: rules,
    });
    expect(normalize({}).summary.rulesets).toBeNull();
  });

  it("lists the ignore files in force on a full scan, and no changes", () => {
    const out = normalize({
      committed: true,
      files: { ".gitleaksignore": "x\n", "src/a.ts": `${SEMGREP_IGNORE}\n${GITLEAKS_ALLOW}\n` },
    });
    expect(out.summary.suppressions.files).toEqual([
      { path: ".gitleaksignore", sha256: sha("x\n").slice(0, 16) },
    ]);
    expect(out.summary.suppressions).toMatchObject({ nosemgrep: 1, gitleaks_allow: 1 });
    expect(out.summary.suppressions).not.toHaveProperty("changed");
  });

  it("reports a pull request's edits to what the scanners ignore, and judges it by the base's", () => {
    const out = normalize({
      pr: {
        base: {
          ".gitleaksignore": "base-entry\n",
          "config/.semgrepignore": "fixtures/\n",
          "src/a.ts": `const a = 1; ${SEMGREP_IGNORE}\n`,
          ".github/workflows/codex-security-scan.yml": "name: scan\n",
        },
        deleted: ["config/.semgrepignore"],
      },
      files: {
        ".gitleaksignore": "base-entry\nsrc/a.ts:generic-api-key:2\n",
        ".semgrepignore": "src/\n",
        "src/a.ts": [
          `const a = 1; ${SEMGREP_IGNORE}`,
          `const b = 2; ${SEMGREP_IGNORE.toUpperCase()}`,
          `const c = 3; ${GITLEAKS_ALLOW}`,
          "",
        ].join("\n"),
        ".github/workflows/codex-security-scan.yml": "name: scan\non: push\n",
      },
    });
    const s = out.summary.suppressions;
    expect(s.changed).toEqual(
      expect.arrayContaining([
        { path: ".gitleaksignore", change: "modified" },
        { path: ".semgrepignore", change: "added" },
        { path: "config/.semgrepignore", change: "removed" },
        { path: ".github/workflows/codex-security-scan.yml", change: "modified" },
      ]),
    );
    expect(s.changed).toHaveLength(4);
    expect(s.nosemgrep_added).toBe(1);
    expect(s.gitleaks_allow_added).toBe(1);
    // In force for this scan: the base's ignore files, hashed as the base has them.
    expect(s.files.map((f: { path: string }) => f.path).sort()).toEqual([
      ".gitleaksignore",
      "config/.semgrepignore",
    ]);
    const gl = s.files.find((f: { path: string }) => f.path === ".gitleaksignore");
    expect(gl.sha256).toBe(sha("base-entry\n").slice(0, 16));
  });

  it("reports nothing changed for a pull request that leaves the controls alone", () => {
    const out = normalize({
      pr: { base: { ".gitleaksignore": "x\n", "src/a.ts": "a\n" } },
      files: { "src/a.ts": "b\n" },
    });
    expect(out.summary.suppressions).toMatchObject({
      changed: [],
      nosemgrep_added: 0,
      gitleaks_allow_added: 0,
    });
  });
});
