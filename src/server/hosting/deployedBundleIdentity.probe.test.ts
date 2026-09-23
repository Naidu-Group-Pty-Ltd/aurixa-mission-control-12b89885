/**
 * The probe itself, against a deployment it can actually fetch.
 *
 * The pure spec proves the rule over text. This proves the probe hands the rule
 * the RIGHT text — which is where the billing reading went blind: a build that
 * declares its backend in `/version.json` was returned from before any
 * JavaScript was fetched, so its billing identity read `not_scanned` on every
 * probe, `not_scanned` never earns a rebuild, and `npc-crm-independent` served
 * a bundle with no identity of its own from 19 to 23 Sep 2026 with nothing
 * reporting it. Measured on the probe of the rebuild that re-published it:
 * `bytes_scanned: 0`.
 *
 * `fetch` is stubbed with a whole deployment — manifest, page, entry, preload —
 * so the assertions include what was NOT fetched. The database is a recorder:
 * the second half of this file drives `verifyCloneBundleIdentity` and asserts
 * on what it wrote, because the re-sync reason and the report are effects, and
 * an effect nobody reads is how the last reason came to say the wrong thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: {} as Record<string, Record<string, unknown> | null>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  resyncs: [] as Array<{ cloneId: string; reason: string }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.maybeSingle = async () => ({ data: db.rows[table] ?? null, error: null });
    b.update = (patch: Record<string, unknown>) => {
      db.updates.push({ table, patch });
      return { eq: async () => ({ error: null }) };
    };
    b.insert = async (values: Record<string, unknown>) => {
      db.inserts.push({ table, values });
      return { error: null };
    };
    return b;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("./redeploy.server", () => ({
  requestEnvResync: async (input: { cloneId: string; reason: string }) => {
    db.resyncs.push(input);
    return { queued: true };
  },
}));

import { probeDeployedBundle, verifyCloneBundleIdentity } from "./deployedBundleIdentity.server";
import { billingFallbackSentence } from "./deployedBundleIdentity.pure";

const ORIGIN = "https://npc-crm-independent.aurixasystems.com.au";
const OWN_REF = "qvuwrvwzjyigptmnijyb";
const PRIME_REF = "dduzbchuswwbefdunfct";
const UID = "npc-crm-independent-6505dc";
const ENTRY = "/assets/index-ZGt6E6UT.js";
const PRELOAD = "/assets/vendor-utils-DMnzLHu3.js";

const HTML = `<!DOCTYPE html><html><head>
  <script type="module" crossorigin src="${ENTRY}"></script>
  <link rel="modulepreload" crossorigin href="${PRELOAD}">
</head><body><div id="root"></div></body></html>`;

/** The resolver as it compiles: the built-in is in every build. */
const RESOLVER = 'const Bt="npc-prime",Br="dduzbchuswwbefdunfct";';

type Site = Record<string, string | null>;
let site: Site = {};
let fetched: string[] = [];

function serve(s: Site) {
  site = s;
}

function manifest(ref: string, source: "env" | "fallback" = "env") {
  return JSON.stringify({ buildId: "b-1", supabase: { projectRef: ref, source } });
}

beforeEach(() => {
  fetched = [];
  site = {};
  db.rows = {};
  db.updates = [];
  db.inserts = [];
  db.resyncs = [];
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) || "/" : url;
    const body = site[path];
    if (body === undefined || body === null) {
      return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => body } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a build that declares its backend", () => {
  it("still has its entry read for the billing identity, and finds it", async () => {
    serve({
      "/version.json": manifest(OWN_REF),
      "/": HTML,
      [ENTRY]: `${RESOLVER}const Cu="${UID}";`,
    });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.via, "the backend is still the manifest's").toBe("manifest");
    expect(r.verdict).toBe("carries_own");
    expect(r.billingUid).toBe("own");
    expect(r.bytesScanned).toBeGreaterThan(0);
    expect(r.scanned).toEqual([`${ORIGIN}/version.json`, ENTRY]);
    // Answered by the entry alone; the preload is not spent on it.
    expect(fetched).not.toContain(`${ORIGIN}${PRELOAD}`);
    expect(r.artefact).toBe(ENTRY);
  });

  it("finds a bundle with no identity of its own, and keys it on the bytes", async () => {
    serve({
      "/version.json": manifest(OWN_REF),
      "/": HTML,
      [ENTRY]: RESOLVER,
      [PRELOAD]: "export const x=1;",
    });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.verdict).toBe("carries_own");
    expect(r.billingUid, "read, and the built-in is what is there").toBe("fallback");
    expect(r.artefact, "content-hashed, so a rebuild that took the id changes it").toBe(ENTRY);
  });

  it("keeps the declaration as the key when the backend it declares is the prime's", async () => {
    serve({
      "/version.json": manifest(PRIME_REF, "fallback"),
      "/": HTML,
      [ENTRY]: RESOLVER,
    });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.verdict).toBe("carries_prime");
    expect(r.billingUid).toBe("fallback");
    expect(r.artefact).toBe(`declared:fallback:${PRIME_REF}`);
  });

  it("widens to the preloads only when the entry answered neither way", async () => {
    serve({
      "/version.json": manifest(OWN_REF),
      "/": HTML,
      [ENTRY]: "export const nothing=0;",
      [PRELOAD]: `${RESOLVER}const Cu="${UID}";`,
    });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.billingUid).toBe("own");
    expect(r.scanned).toEqual([`${ORIGIN}/version.json`, ENTRY, PRELOAD]);
    expect(r.artefact, "still the entry: the page's own chunk is the build's key").toBe(ENTRY);
  });

  it("fetches nothing past the manifest when there is no identity to look for", async () => {
    serve({ "/version.json": manifest(OWN_REF), "/": HTML, [ENTRY]: RESOLVER });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: null,
    });
    expect(r.billingUid).toBe("none");
    expect(fetched).toEqual([`${ORIGIN}/version.json`]);
    expect(r.artefact).toBe(`declared:env:${OWN_REF}`);
  });

  it("says a page that would not answer is a fact about the read", async () => {
    serve({ "/version.json": manifest(OWN_REF), "/": null });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.verdict, "the manifest still answers for the backend").toBe("carries_own");
    expect(r.billingUid, "and nothing is claimed about billing").toBe("not_scanned");
    expect(r.artefact).toBe(`declared:env:${OWN_REF}`);
  });
});

describe("a build that declares nothing is read exactly as before", () => {
  it("takes the backend and the identity from the same bytes", async () => {
    serve({
      "/version.json": JSON.stringify({ buildId: "b-2" }),
      "/": HTML,
      [ENTRY]: `const u="https://${OWN_REF}.supabase.co",p="${PRIME_REF}";${RESOLVER}const Cu="${UID}";`,
    });
    const r = await probeDeployedBundle({
      origin: ORIGIN,
      ownRef: OWN_REF,
      primeRef: PRIME_REF,
      billingUid: UID,
    });
    expect(r.via).toBe("scan");
    expect(r.verdict).toBe("carries_both");
    expect(r.billingUid).toBe("own");
    expect(r.artefact).toBe(ENTRY);
  });
});

describe("verifyCloneBundleIdentity acts on what it found, and says what it found", () => {
  const CLONE = "11111111-2222-3333-4444-555555555555";

  function seed(deployment: Record<string, unknown> = {}) {
    db.rows = {
      clone_deployments: {
        clone_id: CLONE,
        provider_slug: "vercel",
        bundle_resync_artefact: null,
        bundle_billing_uid: null,
        bundle_artefact: null,
        ...deployment,
      },
      clones: {
        id: CLONE,
        name: "NPC CRM Independent",
        deploy_url: ORIGIN,
        billing_user_id: UID,
      },
      clone_backends: { supabase_project_ref: OWN_REF },
      clone_turnstile_identities: null,
    };
  }

  const inserted = (table: string) =>
    db.inserts.filter((i) => i.table === table).map((i) => i.values);

  it("re-syncs a healthy backend's missing identity under the reason it actually has", async () => {
    seed({ bundle_billing_uid: "own", bundle_artefact: "/assets/index-OLD.js" });
    serve({
      "/version.json": manifest(OWN_REF),
      "/": HTML,
      [ENTRY]: RESOLVER,
      [PRELOAD]: "",
    });

    const out = await verifyCloneBundleIdentity(CLONE, { primeRef: PRIME_REF });

    expect(out.resyncRequested).toBe(true);
    expect(db.resyncs).toHaveLength(1);
    // It used to say "names the wrong Supabase project" here whatever the
    // fault was — about a clone serving its own backend correctly.
    expect(db.resyncs[0].reason).not.toMatch(/wrong Supabase project/);
    expect(db.resyncs[0].reason).toMatch(/no billing identity of its own/);
    expect(db.resyncs[0].reason).toMatch(/browse-only/);

    const [event] = inserted("deployment_events");
    expect(event.success).toBe(false);
    expect(event.error_message).toBe(billingFallbackSentence("carries_own"));
    expect((event.payload as Record<string, unknown>).billing_uid).toBe("fallback");

    const patch = db.updates.find((u) => u.table === "clone_deployments")?.patch ?? {};
    expect(patch.bundle_billing_uid).toBe("fallback");
    expect(patch.bundle_resync_artefact, "the guard is the attempt").toBe(ENTRY);

    const [note] = inserted("notifications");
    expect(note.title).toMatch(/No billing identity in the bundle/);
    // Browse-only charges nobody wrongly: a warning, not an error.
    expect(note.severity).toBe("warning");
  });

  it("does not re-sync or re-report the same bundle twice", async () => {
    seed({
      bundle_billing_uid: "fallback",
      bundle_artefact: ENTRY,
      bundle_resync_artefact: ENTRY,
    });
    serve({ "/version.json": manifest(OWN_REF), "/": HTML, [ENTRY]: RESOLVER, [PRELOAD]: "" });

    const out = await verifyCloneBundleIdentity(CLONE, { primeRef: PRIME_REF });

    expect(out.resyncRequested).toBe(false);
    expect(db.resyncs).toHaveLength(0);
    expect(inserted("notifications")).toHaveLength(0);
    // The reading is still recorded — a guard that stops acting must not stop
    // telling.
    const [event] = inserted("deployment_events");
    expect(event.success).toBe(false);
  });

  it("records a bundle that carries its own identity as a success, and reports nothing", async () => {
    seed({ bundle_billing_uid: "not_scanned", bundle_artefact: `declared:env:${OWN_REF}` });
    serve({
      "/version.json": manifest(OWN_REF),
      "/": HTML,
      [ENTRY]: `${RESOLVER}const Cu="${UID}";`,
    });

    const out = await verifyCloneBundleIdentity(CLONE, { primeRef: PRIME_REF });

    expect(out.reading?.billingUid).toBe("own");
    expect(out.resyncRequested).toBe(false);
    const [event] = inserted("deployment_events");
    expect(event.success).toBe(true);
    expect(event.error_message).toBeNull();
    expect(inserted("notifications")).toHaveLength(0);
  });

  it("reports a wrong backend and a missing identity in one notice, as an error", async () => {
    seed();
    serve({
      "/version.json": manifest(PRIME_REF, "fallback"),
      "/": HTML,
      [ENTRY]: RESOLVER,
      [PRELOAD]: "",
    });

    await verifyCloneBundleIdentity(CLONE, { primeRef: PRIME_REF });

    const notes = inserted("notifications");
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toMatch(/Wrong backend in the bundle/);
    expect(notes[0].severity).toBe("error");
    expect(notes[0].body).toMatch(/credits the prime/);
    expect(db.resyncs[0].reason).toMatch(/wrong backend AND carries no billing identity/);
  });
});
