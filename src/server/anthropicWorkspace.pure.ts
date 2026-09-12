/**
 * One Anthropic workspace per clone — and why that is the answer rather than
 * one key per clone.
 *
 * ## What cannot be done
 *
 * `llmKeyProvisioning.pure.ts` mints a key per clone at four of the five model
 * vendors. Anthropic is the fifth and it is `console_only`, quoting its own
 * documentation: "Can I create new API keys through the Admin API? No. You
 * create API keys in the Claude Console." No amount of engineering changes
 * that, and this module does not try.
 *
 * ## What can
 *
 * The unit of attribution at Anthropic is the WORKSPACE, not the key, and
 * workspaces ARE creatable: `POST /v1/organizations/workspaces`. Three facts
 * make per-clone billing follow from that, and all three are the vendor's:
 *
 *  1. A credential that is not bound to one workspace acts in whichever
 *     workspace each request names in `anthropic-workspace-id`.
 *  2. `usage_report` and `cost_report` accept `group_by[]=workspace_id`.
 *  3. Every answered request carries the resolved workspace back in a
 *     response header, so attribution is VERIFIABLE rather than assumed.
 *
 * So the manual act collapses from once per clone to once in total: a person
 * creates ONE organisation-wide key in the Console, and every clone provisioned
 * after that gets its own workspace automatically and names it on every call.
 *
 * ## Three rules
 *
 * **The workspace id is `identity`, never `vendor`.** It is added to
 * `IDENTITY_SECRETS` for exactly that reason. Left in the default class the
 * fleet sweep would forward the PRIME's `ANTHROPIC_WORKSPACE_ID` to every
 * clone, which attributes the whole fleet's spend to one workspace — while
 * every reading in this product goes green, because a workspace id that
 * resolves is indistinguishable from the right one.
 *
 * **A workspace is found before it is created.** An organisation gets 100 of
 * them and archived ones do not count toward the limit but do keep their
 * names, so a provisioner that created blindly would burn the allowance on
 * retries and leave a clone's spend split across several workspaces.
 *
 * **Creating one can never fail a provisioning run.** A clone with no
 * workspace reaches Anthropic exactly as every clone does today — on the
 * forwarded key, attributed to the organisation's default workspace. That is
 * the status quo, not an outage, and refusing to finish a provisioning over it
 * would trade a working deployment for a billing nicety.
 *
 * Pure: no network, no database, no Node globals.
 */

import { deliveryPending } from "@/lib/anthropicAttribution.pure";

/** The name a clone's project reads to know which workspace it acts in. */
export const ANTHROPIC_WORKSPACE_SECRET = "ANTHROPIC_WORKSPACE_ID";

/**
 * The credential that creates a workspace.
 *
 * Deliberately NOT the same name as the key a clone spends. An Admin key
 * (`sk-ant-admin…`) manages the organisation and cannot make a model call; the
 * organisation key a clone runs on can make model calls and cannot manage the
 * organisation. Naming them the same thing would invite an operator to set one
 * where the other belongs, and each would fail in a way that reads like the
 * other being wrong.
 */
export const ANTHROPIC_ADMIN_ENV = "ANTHROPIC_ADMIN_KEY";

/** Anthropic's own shape for a workspace identifier. */
export const ANTHROPIC_WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;

/**
 * The published per-organisation ceiling.
 *
 * Archived workspaces do not count toward it, and Anthropic raises it on
 * request. It is here so the warning below can be measured against something
 * rather than guessed.
 */
export const ANTHROPIC_WORKSPACE_CAP = 100;

/** Warn with this much headroom left, so the ask is made before it bites. */
const HEADROOM_WARNING_AT = 10;

export type WorkspaceVerdict =
  | { act: true }
  | {
      act: false;
      reason:
        | "already_provisioned"
        | "no_credential"
        | "not_provisioned"
        | "tenant_supplied"
        | "withheld";
      /** Said to an operator. Names the rule where there is nothing to fix. */
      message: string;
      /** False where nothing an operator does on this deployment would change it. */
      actionable: boolean;
    };

/**
 * Whether to create a workspace for this clone, from facts already read.
 *
 * Refusing is the default, and every refusal says whether anything can be done
 * about it — because two of them mean "correct, leave it alone", and a
 * readiness panel that colours those red fills with problems nobody can clear.
 */
export function decideWorkspaceProvision(input: {
  /** `clone_anthropic_identity.workspace_id` for this clone, or null. */
  existingWorkspaceId: string | null;
  /**
   * `clone_anthropic_identity.delivered_at` — the raw column, never a
   * judgement about it.
   *
   * Recording a workspace and writing its id onto the project are separate
   * acts and the second fails on its own: the Management API write can be
   * refused after the vendor has created the workspace, and the row is
   * recorded anyway so a retry cannot create a second one. Without this,
   * `existingWorkspaceId` alone reads as done, every later run short-circuits,
   * and the clone bills to the organisation's default line for ever — while
   * the failure message promises that a retry writes the same workspace.
   *
   * It is the COLUMN rather than a `deliveryPending` boolean because the
   * caller computed that boolean too, and two expressions of one fact in two
   * modules is the shape that has cost this branch five review findings. The
   * derivation is `deliveryPending()` in `anthropicAttribution.pure.ts`, here
   * and at the call site both.
   *
   * REQUIRED, not optional. It replaced an optional `deliveryPending` boolean
   * whose absence meant "not pending" — so a caller that forgot it asserted
   * DELIVERED, which is the one direction never safe to assume: a wrongly
   * pending row costs one idempotent re-write of the same id, and a wrongly
   * delivered one is never revisited at all.
   */
  deliveredAt: string | null;
  /** `clone_backend_secrets.status` for ANTHROPIC_API_KEY, or null when absent. */
  anthropicKeyStatus: string | null;
  /** Whether Mission Control holds ANTHROPIC_ADMIN_KEY. */
  credentialPresent: boolean;
  /** Whether the clone has a Supabase project to write the id onto. */
  backendProvisioned: boolean;
}): WorkspaceVerdict {
  // Only the two facts delivery is made of. This function has no federation
  // rule and no business inventing one.
  const pending = deliveryPending({
    workspaceId: input.existingWorkspaceId,
    deliveredAt: input.deliveredAt,
  });

  if (input.existingWorkspaceId && !pending) {
    return {
      act: false,
      reason: "already_provisioned",
      message: `This clone already has the Anthropic workspace ${input.existingWorkspaceId}.`,
      actionable: false,
    };
  }

  /*
   * A tenant who supplied their own Anthropic key is charged nothing for
   * Anthropic, and their key is bound to THEIR organisation — where a
   * workspace we created does not exist. Naming it would turn every one of
   * their calls into a 404 for a workspace their credential has never heard
   * of. This is the same stand-down `decideLlmKeyMint` takes first, for the
   * same reason, and it is permanent rather than a deferral.
   */
  if (input.anthropicKeyStatus === "set") {
    return {
      act: false,
      reason: "tenant_supplied",
      message:
        "This workspace supplied its own Anthropic key, so its calls are billed to its own " +
        "Anthropic organisation. A workspace created in Aurixa's organisation would not exist " +
        "for that credential.",
      actionable: false,
    };
  }

  /*
   * `withheld` is written only by an explicit withdrawal. A reconcile that
   * re-provisioned past it would undo a person's decision on a schedule, with
   * no signal but a row changing state.
   */
  if (input.anthropicKeyStatus === "withheld") {
    return {
      act: false,
      reason: "withheld",
      message:
        "Anthropic was deliberately withheld from this clone, so it has no Anthropic calls to " +
        "attribute.",
      actionable: false,
    };
  }

  if (!input.backendProvisioned) {
    return {
      act: false,
      reason: "not_provisioned",
      message:
        "This clone has no Supabase project yet, so there is nowhere to write the workspace id.",
      actionable: false,
    };
  }

  /*
   * A RECORDED workspace that was never written onto the project needs no
   * vendor call at all: the delivery branch reuses the recorded id by
   * construction — it deliberately does not list or create, because a second
   * listing could match a different workspace by name — and writes one project
   * secret with the Supabase management token. The Anthropic admin credential
   * is not what that step is waiting on.
   *
   * Refusing it here is not a deferral, it is a trap. `20260911090000` clears
   * every presumed `delivered_at`, so on a deployment that has no
   * `ANTHROPIC_ADMIN_KEY` yet — which is every deployment until the owner sets
   * one — every identity row becomes pending and NOTHING can ever settle it,
   * including the rows whose delivery genuinely succeeded. The repair that
   * moved "is delivery owed?" onto its own column has to move the gate in
   * front of the delivery step too, or the old dependency decides anyway.
   */
  if (!input.credentialPresent && !pending) {
    return {
      act: false,
      reason: "no_credential",
      message:
        `Mission Control holds no ${ANTHROPIC_ADMIN_ENV}, so it cannot create an Anthropic ` +
        "workspace. Set it in Mission Control's own environment; until then this clone's " +
        "Anthropic calls are billed to the organisation's default workspace, exactly as they " +
        "are today.",
      actionable: true,
    };
  }

  return { act: true };
}

/**
 * The name a clone's workspace carries at the vendor.
 *
 * It exists to be read by a person looking at Anthropic's console trying to
 * work out whose spend a line is, so it leads with the clone. Anthropic does
 * not constrain a workspace name the way it constrains a federation
 * resource's, but the same slug is used for both so one clone is recognisably
 * one clone across every object this platform creates for it.
 */
export function workspaceNameFor(cloneName: string, cloneId?: string, max = 120): string {
  const slug = cloneName
    .replace(/\s+/g, "-")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  /*
   * EVERY name carries the clone's id, not just one that slugs to nothing.
   *
   * The provisioner finds a workspace by NAME before creating one, so two
   * clones resolving to the same name are handed the SAME workspace and their
   * spend merges back into a single line — the state this whole module exists
   * to leave behind. The unique index refuses the second ledger row, but only
   * after the vendor has already been told the wrong thing and the id has been
   * written onto the second project.
   *
   * A first version suffixed only the empty-slug case, which is a narrower
   * rule than the hazard: clone names are not unique, and `Foo!` and `foo`
   * normalise identically. Nothing about "the slug came out non-empty" makes
   * it distinguishing. The id is what is unique, so the id always travels.
   *
   * Safe to change the scheme because no workspace has ever been created under
   * the old one: this code has not been released, and every existing clone
   * therefore has no identity row and no workspace to adopt.
   */
  const suffix = (cloneId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const named = slug
    ? suffix
      ? `aurixa-${slug}-${suffix}`
      : `aurixa-${slug}`
    : `aurixa-clone-${suffix}`;

  const trimmed = named.replace(/-+$/, "");
  /*
   * Truncation takes it out of the FRONT of the slug rather than the back, so
   * the id survives: a name cut to the cap from the right would drop exactly
   * the part that makes it unique, and two long clone names sharing a prefix
   * would collide again at the cap.
   */
  if (trimmed.length <= max) return trimmed;
  const tail = suffix ? `-${suffix}` : "";
  return `${trimmed.slice(0, Math.max(1, max - tail.length))}`.replace(/-+$/, "") + tail;
}

/** A workspace id we are willing to store and forward, or null. */
export function readWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return ANTHROPIC_WORKSPACE_ID.test(value) ? value : null;
}

/**
 * Whether the organisation is close enough to its workspace ceiling to say so.
 *
 * Returned as a warning rather than a refusal. Anthropic raises the limit on
 * request, so the useful moment is before provisioning starts failing — not
 * after, and not by declining to provision a clone that would still fit.
 */
export function workspaceCapWarning(liveWorkspaceCount: number): string | null {
  const remaining = ANTHROPIC_WORKSPACE_CAP - liveWorkspaceCount;
  if (remaining > HEADROOM_WARNING_AT) return null;
  if (remaining > 0) {
    return (
      `Anthropic allows ${ANTHROPIC_WORKSPACE_CAP} workspaces per organisation and ` +
      `${liveWorkspaceCount} are in use, so ${remaining} more clone${remaining === 1 ? "" : "s"} ` +
      "can be attributed before provisioning has nothing to create. Ask your Anthropic account " +
      "team to raise the limit."
    );
  }
  return (
    `Anthropic's ${ANTHROPIC_WORKSPACE_CAP}-workspace limit is reached, so a new clone's Anthropic ` +
    "calls will be billed to the organisation's default workspace with no per-tenant figure. " +
    "Ask your Anthropic account team to raise the limit."
  );
}

/**
 * Whether the workspace a call actually ran in is the one we asked for.
 *
 * Read from Anthropic's own `anthropic-workspace-id` response header. A
 * mismatch is not a vendor fault: it means the credential is bound to a single
 * workspace and quietly ignored what we sent, which bills somebody else's line
 * while every status in this product stays green.
 */
export function workspaceMismatch(input: {
  expected: string;
  resolved: string | null | undefined;
}): string | null {
  const resolved = (input.resolved ?? "").trim();
  if (!resolved) {
    return (
      "Anthropic did not say which workspace this call ran in, so attribution could not be " +
      "confirmed. The call itself succeeded."
    );
  }
  if (resolved === input.expected) return null;
  return (
    `This call was attributed to ${resolved} rather than ${input.expected}. The credential in use ` +
    "is bound to a single workspace and ignores the workspace header, so this clone's spend is " +
    "landing on another line."
  );
}
