/**
 * Fetch what the browser downloads, and record which project it names.
 *
 * The judgement is entirely in `deployedBundleIdentity.pure.ts`; this file is
 * the network and the ledger, so the rule has one implementation and no
 * opinion of its own to drift from it.
 *
 * Read the header of that module for why this exists. In one line: every
 * signal this pipeline held was green while three of four clones served a
 * bundle pointed at the prime's database, because nothing anywhere fetched the
 * JavaScript and asked.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";
import {
  entryAssetPaths,
  isWrongBackend,
  readBundleIdentity,
  shouldRequestResync,
  verdictIsAboutTheClone,
  type BundleIdentityReading,
} from "./deployedBundleIdentity.pure";

const admin = supabaseAdmin;

/**
 * Short, because this runs inside a drain with a 50 s invocation budget shared
 * with everything else it does. A probe that times out is `unreachable`, which
 * is a reading about US and costs the clone nothing.
 */
const FETCH_TIMEOUT_MS = 6000;

/**
 * How much of each asset to read.
 *
 * The entry chunk of this product is ~5 MB and the identity constants sit
 * inside it, so a cap has to be generous or it turns a real answer into
 * `names_neither`. Measured: the resolver's fallback pair is at ~52% of
 * `index-CZeyBDYv.js`. The cap exists to bound a pathological response, not to
 * sample — and when it bites, `bytesScanned` says so in the reading.
 */
const MAX_BYTES_PER_ASSET = 12_000_000;

/** Never read more than the page's own entry plus its declared preloads. */
const MAX_ASSETS = 6;

/** The build id a manifest carries, or null. Used as the artefact identity. */
/**
 * What a corrective rebuild has to produce a different one of.
 *
 * NOT the build id. `shouldRequestResync` stops when the artefact it last
 * requested a rebuild for comes back unchanged — "we tried that and it did not
 * help" — and a build id is different on EVERY deployment by construction,
 * whether or not anything about the fault changed. Keyed on the build id, the
 * guard could therefore never fire: each corrective rebuild minted a new id,
 * the next probe read a new artefact, and the sweep queued another rebuild,
 * indefinitely. Raised by an automated review on this branch before it merged.
 *
 * The declaration is the fault. A rebuild that still declares the same wrong
 * project ref has demonstrated the same thing the guard was written to notice,
 * however many build ids it burned getting there — and a build that is wrong a
 * DIFFERENT way is a different fault and legitimately earns one more attempt.
 *
 * The hashed-asset path is untouched and needs no equivalent: an asset path
 * carries a content hash, so an unchanged source already yields an unchanged
 * artefact there.
 */
function declaredFaultOf(declaredRef: string, declaredSource: string | null): string {
  return `declared:${declaredSource ?? "unknown"}:${declaredRef}`;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal, redirect: "follow" });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > MAX_BYTES_PER_ASSET ? text.slice(0, MAX_BYTES_PER_ASSET) : text;
  } catch {
    return null;
  }
}

export type BundleProbe = BundleIdentityReading & {
  /** The entry asset the verdict was taken from, or null when none was found. */
  artefact: string | null;
};

/**
 * Read a deployment's served bundle.
 *
 * Pure-ish: takes an origin and the three names to look for, returns a reading.
 * Every failure resolves to a verdict rather than throwing, because a probe
 * that throws inside a drain step turns a healthy deployment into a failed one.
 */
export async function probeDeployedBundle(input: {
  origin: string;
  ownRef: string | null | undefined;
  primeRef: string | null | undefined;
  siteKey?: string | null;
  billingUid?: string | null;
}): Promise<BundleProbe> {
  const base = input.origin.replace(/\/+$/, "");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);

  try {
    // The build's own declaration first. `/version.json` is a few hundred bytes
    // and it is the build stating what `resolveSupabaseTarget` gave it — the
    // same function the running client calls — so nothing has to be inferred
    // from five megabytes of minified JavaScript. A build made before that
    // field shipped simply has no `supabase` block, and the scan below answers
    // for it.
    let declaredRef: string | null = null;
    let declaredSource: "env" | "fallback" | null = null;
    const manifest = await fetchText(`${base}/version.json`, ctl.signal);
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest) as {
          supabase?: { projectRef?: unknown; source?: unknown };
        };
        const ref = parsed?.supabase?.projectRef;
        const src = parsed?.supabase?.source;
        // Read whole or not at all: a half-read manifest asserting a project
        // ref it does not have is worse than one that says nothing.
        if (typeof ref === "string" && (src === "env" || src === "fallback")) {
          declaredRef = ref;
          declaredSource = src;
        }
      } catch {
        declaredRef = null;
      }
    }

    // A declaration settles it, so the bundle is never fetched. That is the
    // difference between a few hundred bytes and five megabytes per clone per
    // sweep, and it is also the difference between an answer and an inference.
    if (declaredRef) {
      const settled = readBundleIdentity({
        source: "",
        scanned: [`${base}/version.json`],
        ownRef: input.ownRef,
        primeRef: input.primeRef,
        siteKey: input.siteKey,
        billingUid: input.billingUid,
        declaredRef,
        declaredSource,
      });
      // The artefact is the DECLARATION, not the build that carried it — see
      // `declaredFaultOf`. A build id changes on every rebuild, so keying the
      // re-sync guard on one meant it never fired.
      return { ...settled, artefact: declaredFaultOf(declaredRef, declaredSource) };
    }

    const html = await fetchText(`${base}/`, ctl.signal);
    if (html === null) {
      return {
        ...readBundleIdentity({
          source: "",
          scanned: [],
          ownRef: input.ownRef,
          primeRef: input.primeRef,
          siteKey: input.siteKey,
          billingUid: input.billingUid,
          declaredRef,
          declaredSource,
        }),
        artefact: null,
      };
    }

    const paths = entryAssetPaths(html).slice(0, MAX_ASSETS);
    const scanned: string[] = [];
    const parts: string[] = [];

    const readInto = async (path: string) => {
      const body = await fetchText(`${base}${path}`, ctl.signal);
      if (body === null) return;
      scanned.push(path);
      parts.push(body);
    };

    const judge = () =>
      readBundleIdentity({
        // No asset read at all: the page named some and none answered. That is
        // our probe failing, not the deployment — `unreadable` is reserved for
        // an HTML that named nothing.
        source: paths.length > 0 && scanned.length === 0 ? "" : parts.join("\n"),
        scanned,
        ownRef: input.ownRef,
        primeRef: input.primeRef,
        siteKey: input.siteKey,
        billingUid: input.billingUid,
        declaredRef,
        declaredSource,
      });

    // The entry alone, first. Measured on every build of this product, the
    // module that resolves the Supabase target compiles into the entry chunk —
    // the client every page imports is built from it — so one ~5 MB fetch
    // answers the question almost always, and a sweep that pulled every
    // preloaded vendor chunk as well would spend three times the egress per
    // clone per run to learn the same thing.
    if (paths[0]) await readInto(paths[0]);
    let reading = judge();

    // …and widen only when the narrow scan could not say. This is the whole
    // reason `names_neither` is a verdict and not a pass: an absence is a fact
    // about what was searched, so the honest response to one is to search more
    // before recording it.
    if (reading.via === "scan" && reading.verdict === "names_neither" && paths.length > 1) {
      for (const path of paths.slice(1)) await readInto(path);
      reading = judge();
    }

    return { ...reading, artefact: paths[0] ?? null };
  } finally {
    clearTimeout(timer);
  }
}

export type BundleVerification = {
  probed: boolean;
  reading: BundleProbe | null;
  resyncRequested: boolean;
  /** Why no probe was made, when none was. */
  skipped?: string;
};

/**
 * Probe a live deployment, record the reading, and act on it.
 *
 * Three things, in this order and for these reasons.
 *
 * **Recorded always**, including the verdicts that are about our own probe.
 * `bundle_checked_at` with a `names_neither` is a different state from never
 * having looked, and an operator reading the card has to be able to tell them
 * apart.
 *
 * **Reported when it is about the clone and wrong.** A notification rather
 * than a status change: the deployment IS live and demoting it would be a
 * worse lie than the one this finds — the same judgement `onLive` already
 * makes about a failed auth-config re-apply.
 *
 * **Re-synced at most once per artefact.** See `shouldRequestResync`.
 */
export async function verifyCloneBundleIdentity(
  cloneId: string,
  opts: { origin?: string | null; primeRef?: string | null } = {},
): Promise<BundleVerification> {
  const { data: row } = await admin
    .from("clone_deployments")
    .select("clone_id, provider_slug, bundle_resync_artefact")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (!row)
    return { probed: false, reading: null, resyncRequested: false, skipped: "no_deployment_row" };

  const { data: clone } = await admin
    .from("clones")
    .select("id, name, deploy_url, billing_user_id")
    .eq("id", cloneId)
    .maybeSingle();

  const origin = (opts.origin ?? clone?.deploy_url ?? "").trim();
  if (!origin) {
    return { probed: false, reading: null, resyncRequested: false, skipped: "no_origin" };
  }

  const { data: backend } = await admin
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", cloneId)
    .maybeSingle();

  const { data: turnstile } = await admin
    .from("clone_turnstile_identities")
    .select("site_key, status")
    .eq("clone_id", cloneId)
    .maybeSingle();

  const reading = await probeDeployedBundle({
    origin,
    ownRef: backend?.supabase_project_ref ?? null,
    primeRef: opts.primeRef ?? (await resolvePrimeRef()),
    siteKey: turnstile?.status === "provisioned" ? turnstile.site_key : null,
    // Asked of the bytes rather than of the column. The column is what the
    // clone SHOULD be spending against; whether the artefact its customers
    // downloaded carries it is a different fact, and the only one that decides
    // where a purchase goes.
    billingUid: clone?.billing_user_id ?? null,
  });

  const decision = shouldRequestResync({
    verdict: reading.verdict,
    billingUid: reading.billingUid,
    artefact: reading.artefact,
    lastResyncArtefact: row.bundle_resync_artefact,
  });

  const patch: Record<string, unknown> = {
    bundle_identity: reading.verdict,
    bundle_identity_detail: reading.detail,
    bundle_checked_at: new Date().toISOString(),
    bundle_artefact: reading.artefact,
    // Beside the backend verdict because it is the same KIND of fact — what
    // the artefact carries, not what was published to the project — and it is
    // the one an operator asking "is this clone billing correctly?" needs.
    bundle_billing_uid: reading.billingUid,
  };
  // Stamped BEFORE the re-sync is requested and whether or not it succeeds —
  // the guard is the attempt, never its outcome.
  if (decision.resync) patch.bundle_resync_artefact = reading.artefact;

  // Both writes are checked, and for the same reason the probe exists: this
  // whole module is about a signal that was green while being true of nothing.
  // A verdict that failed to land leaves the PREVIOUS verdict on the card with
  // a stale `bundle_checked_at` beside it — a reading an operator would take
  // as current — so a write nobody looked at would reproduce the defect one
  // layer out.
  const { error: patchErr } = await admin
    .from("clone_deployments")
    .update(asRow<TablesUpdate<"clone_deployments">>(patch))
    .eq("clone_id", cloneId);
  if (patchErr) {
    console.error(
      `[bundle-identity] could not record the verdict for ${cloneId}; the card still ` +
        `shows whatever it showed before: ${patchErr.message}`,
    );
  }

  const { error: eventErr } = await admin.from("deployment_events").insert({
    clone_id: cloneId,
    provider_slug: row.provider_slug ?? "vercel",
    action: "verify_bundle_identity",
    // A bundle that serves the right database while crediting the prime for
    // every purchase made on it is not a successful probe.
    success: !isWrongBackend(reading.verdict) && reading.billingUid !== "fallback",
    error_message: isWrongBackend(reading.verdict)
      ? reading.detail
      : reading.billingUid === "fallback"
        ? "The artefact carries no billing identity of its own and falls through to the prime's, " +
          "so purchases made from this workspace credit the prime."
        : null,
    payload: {
      verdict: reading.verdict,
      artefact: reading.artefact,
      scanned: reading.scanned,
      bytes_scanned: reading.bytesScanned,
      site_key: reading.siteKey,
      billing_uid: reading.billingUid,
      resync: decision.resync,
      resync_reason: decision.reason,
    },
  });
  if (eventErr) {
    console.error(`[bundle-identity] could not log the probe for ${cloneId}: ${eventErr.message}`);
  }

  let resyncRequested = false;
  if (decision.resync) {
    try {
      const { requestEnvResync } = await import("./redeploy.server");
      const res = await requestEnvResync({
        cloneId,
        reason: `the deployed bundle names the wrong Supabase project (${reading.verdict})`,
      });
      resyncRequested = res.queued;
    } catch {
      // Non-fatal: the reading is recorded and an operator has the button. A
      // throw here would take a correct finding down with a failed remedy.
      resyncRequested = false;
    }
  }

  if (verdictIsAboutTheClone(reading.verdict) && isWrongBackend(reading.verdict)) {
    await admin.from("notifications").insert({
      kind: "deployment_bundle_identity",
      severity: "error",
      title: `Wrong backend in the bundle: ${clone?.name ?? cloneId}`,
      body:
        `${reading.detail} ` +
        (resyncRequested
          ? "An environment re-sync and rebuild have been requested."
          : decision.reason),
      clone_id: cloneId,
      url: `/clones/${cloneId}`,
      metadata: {
        verdict: reading.verdict,
        artefact: reading.artefact,
        scanned: reading.scanned,
        resync_requested: resyncRequested,
      },
    });
  }

  return { probed: true, reading, resyncRequested };
}

/**
 * The prime backend's project ref, read the same way the env policy reads it.
 *
 * Returns null rather than guessing: a wrong prime ref would report every
 * clone as carrying it, and a reading that fires on everything is one people
 * switch off.
 */
async function resolvePrimeRef(): Promise<string | null> {
  try {
    const { resolvePrimeBackendRef } = await import("@/server/prime-backend.server");
    return (await resolvePrimeBackendRef(admin)) || null;
  } catch {
    return null;
  }
}
