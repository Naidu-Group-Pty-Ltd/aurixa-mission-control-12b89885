/**
 * Which Supabase project a clone-scoped secret write is allowed to touch.
 *
 * ## Why this is a module and not an `if`
 *
 * Writing a secret onto a Supabase project is done through the Management API
 * with the platform's own token, which can reach EVERY project this
 * organisation owns — the prime product's, and Mission Control's own. There is
 * no per-project credential to get wrong and no permission boundary to lean on.
 * The only thing standing between "set `ALLOWED_ORIGINS` on a clone" and
 * "overwrite `ALLOWED_ORIGINS` on the prime, taking the prime's own sign-in
 * down" is the ref that reaches `setCloneSecretValue`.
 *
 * So the ref is not an argument a caller supplies. It is the RETURN VALUE of
 * this decision, and the only supported way to obtain one.
 *
 * ## What already protects, and what does not
 *
 * `clone_backends.clone_id` is `uuid NOT NULL UNIQUE`, so the prime cannot have
 * a row in that table at all — its project ref lives in
 * `prime_config.supabase_project_ref`, a different table entirely. A lookup by
 * a non-null `clone_id` is therefore structurally incapable of returning the
 * prime.
 *
 * That is a strong guarantee about the QUERY and no guarantee at all about the
 * DATA. A `clone_backends` row whose `supabase_project_ref` was mistyped, or
 * pasted from the prime's settings page, is a perfectly ordinary row that this
 * query returns happily. Hence rules 3 and 4, which compare the value.
 *
 * ## Fail closed, including on "I could not tell"
 *
 * An unresolvable prime ref is a REFUSAL, not a pass. If the deployment cannot
 * say which project is the prime, it cannot assure anybody that this one is
 * not. That costs nothing real: `resolvePrimeBackendRef()` already throws when
 * `prime_config.supabase_project_ref` is unset, so a deployment that has ever
 * provisioned a clone has it set.
 *
 * A read that FAILED is not a row that is ABSENT — the caller passes the error
 * through and this returns `unreadable`, which is a 503-shaped answer rather
 * than "no such clone".
 */

export type CloneSecretRefusal =
  | "no_clone_id"
  | "unreadable"
  | "clone_not_found"
  | "backend_not_provisioned"
  | "target_is_mission_control"
  | "target_is_prime";

export type CloneSecretTargetDecision =
  | { ok: true; projectRef: string }
  | { ok: false; reason: CloneSecretRefusal; message: string };

/** A Supabase project ref is twenty lowercase alphanumerics. */
const PROJECT_REF = /^[a-z0-9]{20}$/;

const norm = (v: string | null | undefined): string | null => {
  const s = (v ?? "").trim().toLowerCase();
  return s.length > 0 ? s : null;
};

/**
 * Decide, from facts already fetched, whether a secret may be written to this
 * clone's project.
 *
 * Pure so every refusal can be asserted by name without a database, a network,
 * or a token that could actually do the damage the rules exist to prevent.
 */
export function decideCloneSecretTarget(input: {
  cloneId: string | null | undefined;
  /** True when a `clones` row with this id was found. */
  cloneExists: boolean;
  /** `clone_backends.supabase_project_ref` for this clone. */
  backendRef: string | null | undefined;
  /** `ownProjectRef()` — Mission Control's own project. */
  ownRef: string | null | undefined;
  /**
   * The prime BACKEND's project ref. `null` means it could not be resolved,
   * which is a refusal rather than a pass — see the header.
   */
  primeBackendRef: string | null | undefined;
  /** Set when any of the reads errored. Never conflated with "not found". */
  readError?: string | null;
}): CloneSecretTargetDecision {
  const cloneId = (input.cloneId ?? "").trim();
  if (!cloneId) {
    return {
      ok: false,
      reason: "no_clone_id",
      message:
        "No clone id. A clone-scoped secret write is addressed by clone, never by project ref — " +
        "there is no supported way to name a project directly.",
    };
  }

  if (input.readError) {
    return {
      ok: false,
      reason: "unreadable",
      message:
        `Could not read this clone's backend (${input.readError}). A read that failed is not a ` +
        "clone that is absent, and neither is a licence to write.",
    };
  }

  if (!input.cloneExists) {
    return {
      ok: false,
      reason: "clone_not_found",
      message: `No clone ${cloneId}. Nothing to write a secret onto.`,
    };
  }

  const ref = norm(input.backendRef);
  if (!ref || !PROJECT_REF.test(ref)) {
    return {
      ok: false,
      reason: "backend_not_provisioned",
      message: ref
        ? `clone_backends.supabase_project_ref for ${cloneId} is not a project ref (${ref}).`
        : `Clone ${cloneId} has no provisioned Supabase project yet.`,
    };
  }

  const own = norm(input.ownRef);
  if (own && ref === own) {
    return {
      ok: false,
      reason: "target_is_mission_control",
      message:
        `Refusing to write a clone secret onto ${ref}: that is THIS deployment's own project — ` +
        "the database holding clones, prime_config and cascade_events. A clone_backends row " +
        "naming it is a data fault, not an instruction.",
    };
  }

  const prime = norm(input.primeBackendRef);
  if (!prime) {
    return {
      ok: false,
      reason: "target_is_prime",
      message:
        "Refusing to write a clone secret: the prime backend's project ref could not be " +
        "resolved, so nothing here can confirm this target is not the prime. Set " +
        "prime_config.supabase_project_ref (Settings → Prime) and retry.",
    };
  }
  if (ref === prime) {
    return {
      ok: false,
      reason: "target_is_prime",
      message:
        `Refusing to write a clone secret onto ${ref}: that is the PRIME product's project. ` +
        `Clone ${cloneId} has the prime's ref recorded against it in clone_backends, which is a ` +
        "data fault. Writing ALLOWED_ORIGINS there would replace the prime's own origins with a " +
        "clone's and take the prime's sign-in down.",
    };
  }

  return { ok: true, projectRef: ref };
}

/**
 * Refusals that mean "not yet" rather than "no".
 *
 * A clone's own credentials are armed the moment provisioning writes the
 * clone row, while its Supabase project is still being created — measured on
 * `npc-crm-independent-6505dc`, the Turnstile mint ran ONE SECOND after the
 * clone row and the backend was still replicating RLS policies ten minutes
 * later. `backend_not_provisioned` there is a statement about the clock, not
 * about the configuration: the ref appears on its own, unattended, and every
 * sweep that follows would have succeeded.
 *
 * Recording that as a failure costs three separate things, and the third is
 * the expensive one. It spends a Cloudflare create-then-delete round trip on
 * a widget nobody can use. It writes an alarming `last_error` onto a clone
 * whose provisioning is proceeding normally. And because
 * `decideTurnstileSweep` reads `last_error` to hold off on a recent FAILURE,
 * it starts a thirty-minute cooling-off period against a condition that
 * clears in ten — so the penalty for trying too early is a longer wait than
 * never having tried at all.
 *
 * `unreadable` joins it for the reason the module header already gives: a
 * read that failed is a 503-shaped answer, not a fact about the clone.
 *
 * The other four are permanent and must keep their alarm. `no_clone_id` is a
 * programming fault; `clone_not_found` means the row is gone; and both
 * `target_is_*` are the data faults this whole module exists to refuse —
 * waiting changes none of them, and quietly retrying a write aimed at the
 * prime is the one outcome worth a loud error.
 *
 * Exhaustive by construction: the switch names every member of
 * `CloneSecretRefusal`, so adding a reason without classifying it fails the
 * typecheck rather than defaulting to one side.
 */
export function isTransientCloneSecretRefusal(reason: CloneSecretRefusal): boolean {
  switch (reason) {
    case "backend_not_provisioned":
    case "unreadable":
      return true;
    case "no_clone_id":
    case "clone_not_found":
    case "target_is_mission_control":
    case "target_is_prime":
      return false;
  }
}
