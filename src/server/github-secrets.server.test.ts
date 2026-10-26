import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SealedBoxError } from "@/server/github-sealed-box.server";
import {
  CLONE_CODEX_REPO_SECRETS,
  RETIRED_CODEX_REPO_SECRETS,
  buildCodexRepoSecrets,
  describeSecretError,
  previewCodexRepoSecrets,
  putEnvironmentSecret,
  syncRepoSecrets,
  validateSecretName,
} from "@/server/github-secrets.server";

/** Every GitHub call in this module goes through the App-authenticated client. */
const request = vi.fn();
vi.mock("@/server/github-app.server", () => ({
  getAppOctokit: () => ({ request: (...args: unknown[]) => request(...args) }),
}));

const TOUCHED = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_SECURITY_API_KEY",
  "CODEX_REMEDIATION_WEBHOOK_SECRET",
  "CODEX_SECURITY_WEBHOOK_SECRET",
  "APP_PUBLIC_URL",
  "PUBLIC_APP_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  request.mockReset();
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("validateSecretName", () => {
  it("accepts GitHub's allowed shape", () => {
    for (const name of ["OPENAI_API_KEY", "_PRIVATE", "A1_B2"]) {
      expect(validateSecretName(name)).toBeNull();
    }
  });

  it("rejects names GitHub would 422 on, with a reason", () => {
    // GitHub answers these with a bare 422 and no useful body, so catching
    // them locally is the difference between a fix and a mystery.
    expect(validateSecretName("lowercase")).toMatch(/uppercase/);
    expect(validateSecretName("HAS-DASH")).toMatch(/uppercase/);
    expect(validateSecretName("1STARTS_WITH_DIGIT")).toMatch(/uppercase/);
    expect(validateSecretName("HAS SPACE")).toMatch(/uppercase/);
  });

  it("rejects the reserved GITHUB_ prefix", () => {
    expect(validateSecretName("GITHUB_TOKEN")).toMatch(/reserved/);
  });
});

describe("describeSecretError", () => {
  it("explains that a 404 may be a permission problem, not a missing repo", () => {
    // GitHub returns 404 for a missing repo, an uninstalled app, AND a
    // missing Secrets permission — an operator cannot guess which.
    const { status, message } = describeSecretError({ status: 404 }, "acme", "widgets");
    expect(status).toBe(404);
    expect(message).toContain("acme/widgets");
    expect(message).toContain("not installed");
    expect(message).toContain("Secrets: Read & write");
  });

  it("names the exact permission for a 403", () => {
    const { message } = describeSecretError(
      { status: 403, response: { data: { message: "Resource not accessible" } } },
      "acme",
      "widgets",
    );
    expect(message).toContain("Secrets: Read & write");
    expect(message).toContain("Resource not accessible");
  });

  it("points a 401 at the App credentials", () => {
    const { message } = describeSecretError({ status: 401 }, "acme", "widgets");
    expect(message).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(message).toContain("GITHUB_APP_ID");
  });

  it("falls back to the raw message for unclassified errors", () => {
    const { status, message } = describeSecretError(new Error("socket hang up"), "a", "b");
    expect(status).toBeNull();
    expect(message).toBe("socket hang up");
  });

  it("separates a local encryption failure from a GitHub permission problem", () => {
    // The whole point: an operator seeing this must not go hunting through
    // GitHub App permissions for a fault that lives in our own runtime.
    const { status, message, fatal } = describeSecretError(
      new SealedBoxError("no cryptographic random source"),
      "acme",
      "widgets",
    );
    expect(status).toBeNull();
    expect(fatal).toBe(true);
    expect(message).toContain("before GitHub was contacted");
    expect(message).toContain("not a repository or App-permission problem");
    expect(message).toContain("no cryptographic random source");
  });

  it("recognises a reintroduced Wasm crypto dependency by its abort message", () => {
    // The exact production failure: libsodium-wrappers on Cloudflare Workers.
    const { fatal, message } = describeSecretError(
      new Error(
        "Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed " +
          "by embedder). Build with -sASSERTIONS for more info.",
      ),
      "acme",
      "widgets",
    );
    expect(fatal).toBe(true);
    expect(message).toContain("could not encrypt");
    expect(message).toContain("Workers runtime");
  });

  it("marks repo-wide faults fatal and per-secret faults not", () => {
    const target = ["acme", "widgets"] as const;
    for (const status of [401, 403, 404]) {
      expect(describeSecretError({ status }, ...target).fatal).toBe(true);
    }
    // A 422 is about this name or value, so the remaining secrets deserve a try.
    expect(describeSecretError({ status: 422 }, ...target).fatal).toBe(false);
    expect(describeSecretError(new Error("socket hang up"), ...target).fatal).toBe(false);
  });
});

describe("syncRepoSecrets", () => {
  const secrets = { ALPHA: "a", BRAVO: "b", CHARLIE: "c" };

  it("encrypts and writes every configured secret", async () => {
    // 32 zero bytes is a structurally valid X25519 public key for sealing.
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(32)));
    request.mockImplementation((route: string) =>
      route.startsWith("GET") ? { data: { key: publicKey, key_id: "kid" } } : { data: {} },
    );

    const result = await syncRepoSecrets({ owner: "acme", repo: "widgets", secrets });

    expect(result.ok).toBe(true);
    expect(result.written).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
    const put = request.mock.calls.find(([route]) => String(route).startsWith("PUT"))?.[1] as {
      encrypted_value: string;
    };
    // Never the plaintext, and always ephemeral key + value + MAC.
    expect(put.encrypted_value).not.toBe("a");
    expect(atob(put.encrypted_value)).toHaveLength(32 + 1 + 16);
  });

  it("stops after a repo-wide fault instead of repeating it for every name", async () => {
    // This is the shape of the reported bug: one broken thing rendered as one
    // identical error line per secret, which read as six separate problems.
    request.mockRejectedValue(
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    );

    const result = await syncRepoSecrets({ owner: "acme", repo: "widgets", secrets });

    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(3);
    expect(result.failed[0].error).toContain("Secrets: Read & write");
    expect(result.failed.slice(1).map((f) => f.error)).toEqual([
      "not attempted — see the failure above, it affects every secret",
      "not attempted — see the failure above, it affects every secret",
    ]);
    // One GET, and no further round trips once the cause was known.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps going when only one secret is rejected", async () => {
    const publicKey = btoa(String.fromCharCode(...new Uint8Array(32)));
    request.mockImplementation((route: string, params: { secret_name?: string }) => {
      if (String(route).startsWith("GET")) return { data: { key: publicKey, key_id: "kid" } };
      if (params.secret_name === "BRAVO") {
        throw Object.assign(new Error("secret value too large"), { status: 422 });
      }
      return { data: {} };
    });

    const result = await syncRepoSecrets({ owner: "acme", repo: "widgets", secrets });

    expect(result.written).toEqual(["ALPHA", "CHARLIE"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ name: "BRAVO" });
  });

  it("skips unconfigured secrets without calling GitHub", async () => {
    const result = await syncRepoSecrets({
      owner: "acme",
      repo: "widgets",
      secrets: { ALPHA: undefined, BRAVO: null, CHARLIE: "" },
    });

    expect(result.nothingConfigured).toBe(true);
    expect(result.skipped).toHaveLength(3);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("removing secrets", () => {
  it("deletes the names it is given, an absent one included", async () => {
    request.mockImplementation(async (route: string, params: { secret_name: string }) => {
      if (route.startsWith("DELETE") && params.secret_name === "CODEX_SECURITY_WEBHOOK_SECRET") {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return { data: {} };
    });
    const result = await syncRepoSecrets({
      owner: "o",
      repo: "r",
      secrets: {},
      remove: RETIRED_CODEX_REPO_SECRETS,
    });
    expect(result.removed).toEqual([...RETIRED_CODEX_REPO_SECRETS]);
    expect(result.ok).toBe(true);
    expect(result.nothingConfigured).toBe(true);
    const deletes = request.mock.calls.filter(([route]) => String(route).startsWith("DELETE"));
    expect(deletes.map(([, p]) => p.secret_name)).toEqual([...RETIRED_CODEX_REPO_SECRETS]);
  });

  it("takes every Codex name out of a clone, the masters included", () => {
    expect(CLONE_CODEX_REPO_SECRETS).toEqual(
      expect.arrayContaining([
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        ...RETIRED_CODEX_REPO_SECRETS,
      ]),
    );
  });
});

describe("buildCodexRepoSecrets", () => {
  it("uses CODEX_SECURITY_API_KEY as the legacy alias for OPENAI_API_KEY", async () => {
    process.env.CODEX_SECURITY_API_KEY = "legacy-key";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.OPENAI_API_KEY).toBe("legacy-key");
  });

  it("prefers OPENAI_API_KEY when both are set", async () => {
    process.env.OPENAI_API_KEY = "new-key";
    process.env.CODEX_SECURITY_API_KEY = "legacy-key";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.OPENAI_API_KEY).toBe("new-key");
  });

  it("carries the Claude key, and never the callback-signing masters", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-test";
    process.env.CODEX_SECURITY_WEBHOOK_SECRET = "scan-master";
    process.env.CODEX_REMEDIATION_WEBHOOK_SECRET = "rem-master";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.ANTHROPIC_API_KEY).toBe("anthropic-test");
    for (const name of RETIRED_CODEX_REPO_SECRETS) expect(secrets).not.toHaveProperty(name);
    expect(JSON.stringify(secrets)).not.toContain("master");
  });

  it("derives callback URLs from the configured origin", async () => {
    process.env.PUBLIC_APP_URL = "https://mc.example/";
    const secrets = await buildCodexRepoSecrets();
    expect(secrets.CODEX_CALLBACK_URL).toBe(
      "https://mc.example/api/public/hooks/codex-remediation",
    );
    expect(secrets.CODEX_SCAN_CALLBACK_URL).toBe(
      "https://mc.example/api/public/hooks/codex-security",
    );
  });
});

describe("previewCodexRepoSecrets", () => {
  it("reports nothing configured when no secret env vars are set", async () => {
    const preview = await previewCodexRepoSecrets();
    // Callback URLs are always derivable, so they count as configured; the
    // point is that the required model key is flagged as missing.
    expect(preview.missingRequired).toContain("OPENAI_API_KEY");
    expect(preview.entries.find((e) => e.name === "OPENAI_API_KEY")?.configured).toBe(false);
  });

  it("needs both model keys: Codex for P2 and below, Claude for P0/P1", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect((await previewCodexRepoSecrets()).missingRequired).toEqual(["ANTHROPIC_API_KEY"]);
    process.env.ANTHROPIC_API_KEY = "anthropic-test";
    const preview = await previewCodexRepoSecrets();
    expect(preview.missingRequired).toEqual([]);
    expect(preview.configuredCount).toBeGreaterThan(0);
  });

  it("never returns a secret value", async () => {
    process.env.OPENAI_API_KEY = "sk-super-secret";
    const preview = await previewCodexRepoSecrets();
    expect(JSON.stringify(preview)).not.toContain("sk-super-secret");
  });
});

describe("putEnvironmentSecret", () => {
  // 32 zero bytes is a structurally valid X25519 public key for sealing.
  const publicKey = btoa(String.fromCharCode(...new Uint8Array(32)));
  const notFound = () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
  const input = {
    owner: "acme",
    repo: "widgets",
    environment: "supabase-production",
    name: "SUPABASE_SERVICE_ROLE_KEY",
    value: "the-value",
  };

  it("writes into the environment, never the repository", async () => {
    request.mockImplementation((route: string) => {
      if (route.endsWith("/secrets/public-key")) return { data: { key: publicKey, key_id: "kid" } };
      if (route.startsWith("GET")) return notFound();
      return { data: {} };
    });

    const r = await putEnvironmentSecret(input);

    expect(r.created).toBe(true);
    const routes = request.mock.calls.map(([route]) => String(route));
    expect(routes.every((route) => route.includes("/environments/{environment_name}"))).toBe(true);
    expect(routes.some((route) => route.includes("/actions/secrets"))).toBe(false);
    const put = request.mock.calls.find(([route]) =>
      String(route).startsWith(
        "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/",
      ),
    )?.[1] as { environment_name: string; encrypted_value: string; key_id: string };
    expect(put.environment_name).toBe("supabase-production");
    expect(put.key_id).toBe("kid");
    expect(put.encrypted_value).not.toContain("the-value");
  });

  it("says a secret that was already there was kept, not created", async () => {
    request.mockImplementation((route: string) =>
      route.startsWith("GET") ? { data: { key: publicKey, key_id: "kid" } } : { data: {} },
    );
    expect((await putEnvironmentSecret(input)).created).toBe(false);
  });

  it("creates an environment that does not exist yet, with no rules, and writes into it", async () => {
    let created = false;
    request.mockImplementation((route: string, params: Record<string, unknown>) => {
      if (route === "PUT /repos/{owner}/{repo}/environments/{environment_name}") {
        // Created bare, exactly as GitHub creates one on first use: no
        // branch policy, no reviewers, nothing of the owner's decided here.
        expect(Object.keys(params).sort()).toEqual(["environment_name", "owner", "repo"]);
        created = true;
        return { data: {} };
      }
      if (route.endsWith("/secrets/public-key")) {
        return created ? { data: { key: publicKey, key_id: "kid" } } : notFound();
      }
      if (route.startsWith("GET")) return notFound();
      return { data: {} };
    });

    expect((await putEnvironmentSecret(input)).created).toBe(true);
    expect(created).toBe(true);
  });

  it("never changes an environment that exists", async () => {
    request.mockImplementation((route: string) =>
      route.startsWith("GET") ? { data: { key: publicKey, key_id: "kid" } } : { data: {} },
    );
    await putEnvironmentSecret(input);
    const routes = request.mock.calls.map(([route]) => String(route));
    expect(routes).not.toContain("PUT /repos/{owner}/{repo}/environments/{environment_name}");
  });

  it("carries a refusal that is not a missing environment", async () => {
    request.mockRejectedValue(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(putEnvironmentSecret(input)).rejects.toMatchObject({ status: 403 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
