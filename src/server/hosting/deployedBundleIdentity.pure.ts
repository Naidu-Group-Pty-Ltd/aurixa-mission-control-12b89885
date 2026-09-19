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
  /** Which asset paths were read, so "not found" can be judged against what was searched. */
  scanned: string[];
  bytesScanned: number;
  /** One sentence an operator can act on. */
  detail: string;
};

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

  const base = {
    via: "scan" as BundleIdentitySource,
    ownRefSeen: false,
    primeRefSeen: false,
    siteKey,
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
  /** The artefact this reading was taken from, e.g. the entry asset path. */
  artefact: string | null;
  /** The artefact a resync was last requested for, if any. */
  lastResyncArtefact: string | null | undefined;
}): { resync: boolean; reason: string } {
  if (!isWrongBackend(input.verdict)) {
    return { resync: false, reason: "the bundle is not naming the wrong backend" };
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
  return {
    resync: true,
    reason:
      "the published environment may not have reached the build; rebuilding with it is the one remedy that can",
  };
}

export type BundleIdentityCardReading = {
  label: string;
  detail: string;
  tone: "neutral" | "warning" | "destructive" | "success";
};

/**
 * The verdict as an operator reads it.
 *
 * In the deployment card's own vocabulary, and in this module rather than in
 * the component, for the reason the deployment status reading gives: the four
 * outcomes here are four different facts and only one of them is a problem, so
 * a raw verdict string would put the operator in the position of deciding
 * which — the shape that made `not_required` read as `clear` elsewhere in this
 * codebase.
 *
 * **Never probed is not a pass.** `null` renders as its own line rather than
 * as silence, because a deployment nobody has read and a deployment read and
 * found correct look identical on a card that draws nothing for the first.
 */
export function bundleIdentityReading(input: {
  verdict: string | null | undefined;
  detail?: string | null;
  checkedAt?: string | null;
}): BundleIdentityCardReading {
  const detail = (input.detail ?? "").trim();
  switch (input.verdict) {
    case "carries_own":
      return {
        label: "serving its own backend",
        detail: detail || "The deployed bundle names this clone's own Supabase project.",
        tone: "success",
      };
    case "carries_prime":
      return {
        label: "serving the PRIME's backend",
        detail:
          detail ||
          "The deployed bundle names the prime's Supabase project. Sign-ins here authenticate against another tenant's database.",
        tone: "destructive",
      };
    case "carries_both":
      return {
        label: "backend unproven",
        detail:
          detail ||
          "The bundle names this clone's project and the prime's. Which one the browser uses cannot be read off the artefact.",
        tone: "warning",
      };
    case "names_neither":
      return {
        label: "could not tell",
        detail:
          detail ||
          "Neither project appears in the assets the page names. This says what was searched, not what the deployment talks to.",
        tone: "warning",
      };
    case "unreachable":
    case "unreadable":
      return {
        label: "not readable",
        detail: detail || "The deployment could not be read. Nothing is established about it.",
        tone: "neutral",
      };
    default:
      return {
        label: "never read",
        detail:
          "Nothing has fetched this deployment's JavaScript to check which Supabase project it names. " +
          "That is not the same as having checked and found it correct.",
        tone: "neutral",
      };
  }
}
