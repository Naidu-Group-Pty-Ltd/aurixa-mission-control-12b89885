/**
 * What the browser actually downloaded — asked of the artefact, not of us.
 *
 * `envPolicy.pure.ts` decides what MAY be published and refuses an environment
 * that names the wrong project. It is a rule about our inputs, and it was
 * written because `npc-client-dashboard` served the prime's production
 * database on a custom domain for a week. It cannot see the failure that
 * followed, which is the same outcome reached from the other direction: the
 * environment is correct, the sync records `env_synced_at`, the build reports
 * READY — and the bundle carries none of it.
 *
 * Measured 19 Sep 2026. `npc-crm-independent` had all five `VITE_*` variables
 * on its hosting project, targeted at production, written 85 minutes before
 * the build that serves its domain. Loading that domain in a real browser
 * opened a realtime socket to `dduzbchuswwbefdunfct` — the PRIME — with the
 * prime's anon key, so the admin password Mission Control had written into the
 * clone's own project could not sign anybody in. The clone's `env.ts` read
 * `import.meta?.env?.[key]`, which no bundler substitutes, so every clone's
 * build had been resolving to its built-in fallback. Three of the four live
 * clones were doing it.
 *
 * Every signal this pipeline held was green, and each one was telling the
 * truth about a different thing: the variables WERE set, the sync DID run, the
 * build DID succeed. Nothing anywhere fetched the JavaScript and asked which
 * project it names. This module is that question, and it is the same rule the
 * rest of the fleet already answers to — **asserted by effect, never by
 * configuration**, the way the retention purge is asserted by
 * `oldest_live_created_time` rather than by its schedule, and
 * `verification_selftest` by a real vendor rejection rather than by a
 * credential being present.
 *
 * ── What a reading may and may not say ───────────────────────────────────────
 *
 * A ref FOUND is a fact about the artefact. A ref NOT found is a fact about
 * the SCAN, and the two must never collapse into one verdict — that is the
 * confident-clear-against-nothing failure the property dashboard has already
 * paid for twice (an empty sanctions register reading as "no match", a failed
 * Places lookup reading as "zero hospitals"). So `names_neither` is its own
 * verdict and it is not a pass.
 *
 * A fetch that never arrived is OURS, not the clone's: `unreachable` says the
 * probe failed, never that the deployment is wrong. A deployment is never
 * demoted on it.
 *
 * And the CAPTCHA site key is deliberately reported as `not_scanned` rather
 * than missing. It is imported lazily and lands in a chunk the served HTML
 * does not name, so the scanned set genuinely cannot see it — measured on this
 * very build, where the key sits in `OtpInput-*.js`. Reporting "absent" from a
 * set that could not contain it would be the same mistake one field down.
 */

import { PRIME_BUILT_IN_BILLING_ID } from "@/server/cloneBillingIdentity.pure";
import {
  billingFallbackConsequence,
  billingFallbackEffect,
} from "@/lib/bundleIdentityReading.pure";

/** The Supabase project ref pattern, as it appears in a URL or a JWT claim. */
const REF = /^[a-z0-9]{16,32}$/;

export type BundleIdentityVerdict =
  /** The artefact names the clone's own project and does not name the prime's. */
  | "carries_own"
  /** The artefact names the prime's project. The customer is signing in to somebody else's database. */
  | "carries_prime"
  /** Both appear. Ambiguous by construction — a fallback constant beside a resolved value looks like this. */
  | "carries_both"
  /** Neither appears anywhere we read. A statement about the scan, not about the clone. */
  | "names_neither"
  /** Bytes arrived and no entry script could be found in them. */
  | "unreadable"
  /** Nothing arrived. Ours. */
  | "unreachable";

/** Whether the scan could have seen the site key at all. */
export type SiteKeyReading = "present" | "not_scanned" | "no_widget";

/**
 * Which billing identity the bundle is actually carrying.
 *
 * The same shape of question as `SiteKeyReading` and for the same reason —
 * `VITE_AURIXA_BILLING_UID` is inlined at BUILD time, so a value published to
 * the hosting project and a value in the artefact are different claims — but
 * with one extra state, because this one has a wrong answer and not merely an
 * absent one. A clone whose bundle carries no identity of its own falls
 * through to the prime's built-in, and its customers' purchases credit the
 * PRIME's balance. Nothing fails: the build is green and the link works.
 *
 * `fallback` and `not_scanned` are kept apart for `names_neither`'s reason.
 * Seeing the built-in and not the clone's own means we read the chunk that
 * carries the identity and the identity there is wrong — a statement about the
 * CLONE. Seeing neither means we did not reach that chunk — a statement about
 * the SCAN. Only the first is worth a rebuild.
 */
export type BillingUidReading =
  /** The artefact carries this clone's own identity. */
  | "own"
  /** It does not, and the prime's built-in is there instead: purchases credit the prime. */
  | "fallback"
  /** It has one and neither it nor the built-in was in what we read. */
  | "not_scanned"
  /** The clone has no identity recorded, so there is nothing to look for. */
  | "none";

/**
 * How the verdict was reached.
 *
 * `manifest` is the build stating what it resolved, through the same pure
 * function the running client calls. `scan` is us inferring it from the text
 * of the bundle, which cannot be conclusive in one direction: the prime's ref
 * is compiled into every build as the fallback constant, so a CORRECTLY
 * configured clone names both its own project and the prime's. That is why
 * `carries_both` exists and why it is not a pass — and why a build that
 * declares is trusted over a scan that guesses.
 */
export type BundleIdentitySource = "manifest" | "scan";

export type BundleIdentityReading = {
  verdict: BundleIdentityVerdict;
  via: BundleIdentitySource;
  ownRefSeen: boolean;
  primeRefSeen: boolean;
  siteKey: SiteKeyReading;
  billingUid: BillingUidReading;
  /** Which asset paths were read, so "not found" can be judged against what was searched. */
  scanned: string[];
  bytesScanned: number;
  /** One sentence an operator can act on. */
  detail: string;
};

/**
 * Does the artefact carry this billing identity as a VALUE?
 *
 * Not `source.includes(uid)`, which is what this was, and the difference
 * stopped being theoretical the day identities started being derived from
 * slugs. A slug is an ordinary string that a bundle has every other reason to
 * contain: `preflight-property-group` is also the first label of that clone's
 * hostname, and every clone's slug is the last segment of its repository URL.
 * A substring match reads either of those as "the artefact carries this
 * clone's identity" — a pass, on a bundle whose purchases fall through to
 * somebody else — which is the green-while-true-of-nothing reading this whole
 * module exists to end.
 *
 * So the identity must stand as a whole value: nothing that continues a name
 * on either side (letters, digits, `-`, `_`), and none of the three characters
 * that make it part of something larger — a `.` joins a hostname label, a `/`
 * a URL path segment, an `@` an address. Every form the bundler actually emits
 * for an inlined `VITE_*` survives that: a quoted literal (`"acme-corp"`), and
 * the literal folded into a constant query string (`"?uid=acme-corp"`), which
 * is what a minifier makes of a template interpolating a compile-time constant.
 *
 * Case-sensitive on purpose. The id is canonical lowercase, and the bundler
 * inlines the published value byte for byte; an upper-case look-alike is a
 * different string that happens to spell the same word.
 */
export function carriesIdentityLiteral(source: string, identity: string): boolean {
  const id = identity.trim();
  if (!id || !source) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_\\-./@])${escaped}(?![A-Za-z0-9_\\-./@])`).test(source);
}

/** Is this verdict one that says the deployment is serving the wrong backend? */
export function isWrongBackend(verdict: BundleIdentityVerdict): boolean {
  return verdict === "carries_prime" || verdict === "carries_both";
}

/** Is this verdict a statement about the clone at all, or about our probe? */
export function verdictIsAboutTheClone(verdict: BundleIdentityVerdict): boolean {
  return verdict !== "unreachable" && verdict !== "unreadable";
}

/**
 * Every same-origin JavaScript asset the served HTML names.
 *
 * Both `<script type="module" src>` and `<link rel="modulepreload" href>`,
 * because Vite emits the entry as the first and its static dependencies as the
 * second, and the module that resolves the Supabase target is reachable from
 * the entry by construction — the client every page imports is built from it.
 *
 * Deliberately does NOT crawl the chunk graph. A bounded crawl that stops
 * early reports a smaller scan as the whole scan, which is precisely the
 * distinction the verdict vocabulary exists to keep. What the HTML names is a
 * fixed, complete, cheap set, and `scanned` carries it so any absence can be
 * read against it.
 */
export function entryAssetPaths(html: string): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined) => {
    if (!p) return;
    const clean = p.trim();
    if (!clean.startsWith("/") || !clean.endsWith(".js")) return;
    out.add(clean);
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+\.js)["'][^>]*>/gi)) {
    if (/rel\s*=\s*["']modulepreload["']/i.test(m[0])) add(m[1]);
  }
  return [...out];
}

export type BundleIdentityInput = {
  /** The concatenated text of every asset that was read. */
  source: string;
  /** Paths that produced that text. */
  scanned: string[];
  /** The clone's own Supabase project ref. */
  ownRef: string | null | undefined;
  /** The prime backend's project ref, when this deployment has one configured. */
  primeRef: string | null | undefined;
  /** The site key this clone's widget was minted with, when it has one. */
  siteKey?: string | null;
  /** The billing identity this clone is recorded as spending against, when it has one. */
  billingUid?: string | null;
  /**
   * The project ref this build DECLARED in `/version.json`, when it publishes
   * one. Authoritative: it comes from the same resolver the client runs, so
   * nothing has to be inferred from minified text.
   */
  declaredRef?: string | null;
  /** Whether that declaration came from the environment or the fallback. */
  declaredSource?: "env" | "fallback" | null;
};

/**
 * Read the identity out of what was downloaded.
 *
 * A pure function over text, so the rule is testable without a network and the
 * probe has no judgement of its own to drift from this one.
 */
export function readBundleIdentity(input: BundleIdentityInput): BundleIdentityReading {
  const scanned = [...input.scanned];
  const bytesScanned = input.source.length;
  const ownRef = (input.ownRef ?? "").trim().toLowerCase();
  const primeRef = (input.primeRef ?? "").trim().toLowerCase();

  const siteKeyValue = (input.siteKey ?? "").trim();
  const siteKey: SiteKeyReading = !siteKeyValue
    ? "no_widget"
    : input.source.includes(siteKeyValue)
      ? "present"
      : "not_scanned";

  // Asked of the bytes, never of the configuration — the whole reason this
  // module exists. `own` is checked FIRST and wins outright: the built-in is
  // compiled into every build by construction, so a correctly configured
  // clone's artefact contains both, exactly as `carries_both` records for the
  // backend ref. Reading "the prime's is present" as a fault would condemn
  // every healthy clone in the fleet.
  //
  // Both are asked as whole values rather than substrings — see
  // `carriesIdentityLiteral` for the hostname and repository URL that a slug
  // also spells.
  const ownUid = (input.billingUid ?? "").trim().toLowerCase();
  const billingUid: BillingUidReading = !ownUid
    ? "none"
    : carriesIdentityLiteral(input.source, ownUid)
      ? "own"
      : carriesIdentityLiteral(input.source, PRIME_BUILT_IN_BILLING_ID)
        ? "fallback"
        : "not_scanned";

  const base = {
    via: "scan" as BundleIdentitySource,
    ownRefSeen: false,
    primeRefSeen: false,
    siteKey,
    billingUid,
    scanned,
    bytesScanned,
  };

  // A build that declares what it resolved settles it. Nothing here is
  // inferred, so none of the scan's caveats apply: `ownRefSeen` and
  // `primeRefSeen` describe the declaration, not a text match.
  const declared = (input.declaredRef ?? "").trim().toLowerCase();
  if (REF.test(declared)) {
    const viaManifest = { ...base, via: "manifest" as BundleIdentitySource };
    const from =
      input.declaredSource === "fallback"
        ? "its built-in fallback, not the environment"
        : "its environment";
    if (ownRef && declared === ownRef) {
      return {
        ...viaManifest,
        ownRefSeen: true,
        verdict: "carries_own",
        detail: `The build declares it resolved this clone's own project (${declared}), from ${from}.`,
      };
    }
    if (primeRef && declared === primeRef) {
      return {
        ...viaManifest,
        primeRefSeen: true,
        verdict: "carries_prime",
        detail:
          `The build declares it resolved the PRIME's project (${declared}), from ${from}. ` +
          "Everyone signing in to this deployment is authenticating against another tenant's " +
          "database, and credentials issued for this clone cannot work.",
      };
    }
    return {
      ...viaManifest,
      verdict: "names_neither",
      detail:
        `The build declares it resolved project "${declared}", which is neither this clone's ` +
        `(${ownRef || "unrecorded"}) nor the prime's. Nothing is signing in where this ` +
        "deployment's records are.",
    };
  }

  if (scanned.length === 0) {
    return {
      ...base,
      verdict: bytesScanned === 0 ? "unreachable" : "unreadable",
      detail:
        bytesScanned === 0
          ? "The deployment could not be read. Nothing is established about it."
          : "The deployment answered, but its HTML names no JavaScript entry. Nothing is established about it.",
    };
  }

  // A ref this short or this malformed would match half the bundle. Refusing to
  // look is the honest answer: a search we cannot run is not a search that
  // found nothing.
  const ownUsable = REF.test(ownRef);
  const primeUsable = REF.test(primeRef);

  const ownRefSeen = ownUsable && input.source.includes(ownRef);
  const primeRefSeen = primeUsable && input.source.includes(primeRef);
  const seen = { ...base, ownRefSeen, primeRefSeen };

  if (!ownUsable) {
    return {
      ...seen,
      verdict: "names_neither",
      detail:
        "This clone has no readable Supabase project ref on record, so there is nothing to look for in its bundle.",
    };
  }

  if (ownRefSeen && primeRefSeen) {
    return {
      ...seen,
      verdict: "carries_both",
      detail:
        `The bundle names this clone's project (${ownRef}) and the prime's (${primeRef}). ` +
        "That is what a resolved value beside a built-in fallback looks like, and which one the " +
        "browser uses cannot be read off the text — treat it as unproven until it names one.",
    };
  }
  if (primeRefSeen) {
    return {
      ...seen,
      verdict: "carries_prime",
      detail:
        `The bundle names the PRIME's project (${primeRef}) and not this clone's (${ownRef}). ` +
        "Everyone signing in to this deployment is authenticating against another tenant's database, " +
        "and credentials issued for this clone cannot work.",
    };
  }
  if (ownRefSeen) {
    return {
      ...seen,
      verdict: "carries_own",
      detail: `The bundle names this clone's own project (${ownRef}).`,
    };
  }
  return {
    ...seen,
    verdict: "names_neither",
    detail:
      `Neither ${ownRef} nor ${primeRef || "any prime ref"} appears in the ${scanned.length} ` +
      "asset(s) the page names. This says what was searched, not what the deployment talks to.",
  };
}

/**
 * Whether an automatic environment re-sync is the right remedy for this reading.
 *
 * ONE attempt, ever, per artefact — the same discipline as the Passport's
 * `portrait_backfill` stamp, and for the same reason. A re-sync fixes a
 * CONFIGURATION cause: the value never reached the build's environment. It
 * cannot fix a CODE cause: a bundle that reads its variables in a form no
 * bundler substitutes comes out byte-identical however many times it is
 * rebuilt, which is exactly what happened here and to the Turnstile key before
 * it. So the guard is the attempt, never its outcome — and a second wrong
 * reading on a NEW artefact is a fact about the clone's source, to be reported
 * to a person rather than ground at.
 */
export function shouldRequestResync(input: {
  verdict: BundleIdentityVerdict;
  /**
   * What the artefact says about the clone's billing identity, when that was
   * read. `fallback` is a second, independent reason to rebuild and is kept
   * separate from the backend verdict because they fail apart: a clone can
   * serve its own database perfectly while every purchase from it credits the
   * prime. Optional so that a caller which did not read it is unchanged.
   */
  billingUid?: BillingUidReading;
  /** The artefact this reading was taken from, e.g. the entry asset path. */
  artefact: string | null;
  /** The artefact a resync was last requested for, if any. */
  lastResyncArtefact: string | null | undefined;
}): { resync: boolean; reason: string } {
  const wrongBackend = isWrongBackend(input.verdict);
  const wrongBilling = input.billingUid === "fallback";
  if (!wrongBackend && !wrongBilling) {
    return {
      resync: false,
      reason: "the bundle names neither the wrong backend nor the wrong billing identity",
    };
  }
  if (!input.artefact) {
    return { resync: false, reason: "no artefact to attribute the reading to" };
  }
  if (input.lastResyncArtefact === input.artefact) {
    return {
      resync: false,
      reason:
        "a re-sync was already requested for this exact artefact and the rebuild produced the same one. " +
        "That is a fault in the clone's own source, not in what was published to it.",
    };
  }
  // What a missing identity COSTS depends on the backend beside it — see
  // `billingFallbackConsequence`. This reason is written into the event log and
  // onto the re-sync, so it may not claim the prime is being credited on a
  // build whose own pairing check refuses the prime's identity.
  const fault = wrongBackend
    ? wrongBilling
      ? "the bundle names the wrong backend AND carries no billing identity of its own"
      : "the bundle names the wrong backend"
    : `the bundle carries no billing identity of its own — ${billingFallbackEffect(
        billingFallbackConsequence(input.verdict),
      )}`;
  return {
    resync: true,
    reason: `${fault}; the published environment may not have reached the build, and rebuilding with it is the one remedy that can`,
  };
}

/**
 * What the re-sync guard is keyed on when the build DECLARED its backend.
 *
 * Two faults, two keys, because a rebuild answers each of them differently.
 *
 * A wrong DECLARATION is keyed on the declaration itself (the server's
 * `declaredFaultOf`). A build id changes on every deployment by construction,
 * so a key built from one let the guard mint a fresh artefact per corrective
 * rebuild and never fire; a rebuild that still declares the same wrong project
 * has shown the same thing however many ids it burned.
 *
 * A missing BILLING identity on a build whose declaration is right is keyed on
 * the entry chunk the identity was looked for in. That path carries a content
 * hash and `VITE_AURIXA_BILLING_UID` is inlined into those bytes, so a rebuild
 * that took the published identity changes it, and one that did not — a
 * bundle reading the variable in a form no bundler substitutes — reproduces it
 * byte for byte and the guard fires. Keyed on the declaration instead, a clone
 * would get ONE billing rebuild for as long as its declaration stood, which is
 * the life of the deployment, and none at all after an operator changed its
 * identity.
 *
 * Nothing read — no identity to look for, or a page that would not answer —
 * leaves the declaration as the key, exactly as before.
 */
export function declaredPathArtefact(input: {
  verdict: BundleIdentityVerdict;
  /** The declaration, as `declared:<source>:<ref>`. */
  declaredFault: string;
  /** The entry chunk that was actually read for the identity, or null. */
  entryAsset: string | null;
}): string {
  if (isWrongBackend(input.verdict) || !input.entryAsset) return input.declaredFault;
  return input.entryAsset;
}

/**
 * Re-exported, not redefined.
 *
 * The reading lives in `src/lib` because the deployment card renders it and
 * the import-protection plugin denies every path under `src/server` to the client bundle —
 * a constraint only the production build can see. Every server-side caller
 * keeps the import path it had, and there is still one implementation.
 */
export { bundleIdentityReading } from "@/lib/bundleIdentityReading.pure";
export type { BundleIdentityCardReading } from "@/lib/bundleIdentityReading.pure";
// What a missing billing identity costs, for the same reason and in the same
// place: the card renders it and the probe records it, from one sentence.
export {
  billingFallbackConsequence,
  billingFallbackSentence,
} from "@/lib/bundleIdentityReading.pure";
export type { BillingFallbackConsequence } from "@/lib/bundleIdentityReading.pure";
