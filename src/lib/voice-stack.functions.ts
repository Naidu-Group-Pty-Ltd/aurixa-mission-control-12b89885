// Voice-stack server functions — the OPERATOR surface over
// `src/server/voice-stack.server.ts` and `src/server/clone-vapi-custody.server.ts`:
// each clone's own Vapi organisation (custody: inbox, sign-up, the key), the
// dependent line's GoHighLevel requirement, the tenant's business details, and
// the build of the clone's voice stack from its CRM line's template.
//
// Admin-only throughout. Nothing here returns a key, a token or a secret: a
// fingerprint at most. Two exceptions, both handed to an admin who is about to
// act on them: `revealCloneVapiLogin` returns the clone's Vapi login password,
// audited each time; and `getCloneVoiceStack` carries the Make authorisation
// link for a pending GoHighLevel grant, which the admin sends to the tenant and
// which stops being returned once the grant is accepted.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

const stack = () => import(/* @vite-ignore */ "@/lib/_server-shims/voice-stack.server");
const custody = () => import(/* @vite-ignore */ "@/lib/_server-shims/clone-vapi-custody.server");

type WithClone = { cloneId: string };
const needClone = <T extends WithClone>(input: T): T => {
  if (!input?.cloneId?.trim()) throw new Error("cloneId is required");
  return input;
};

/** Throws the refusal so the card's toast says what was refused. */
function unwrap<T extends { ok: boolean }>(
  r: T | { ok: false; error: string },
): Exclude<T, { ok: false }> {
  if (!r.ok) throw new Error((r as { error: string }).error);
  return r as Exclude<T, { ok: false }>;
}

export const getCloneVoiceStack = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data }) => {
    const [s, c] = await Promise.all([stack(), custody()]);
    const [view, custodyView] = await Promise.all([
      s.getVoiceStackView(data.cloneId),
      c.getVapiCustodyView(data.cloneId),
    ]);
    return { view, custody: custodyView };
  });

export const advanceCloneVapiCustody = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data }) => unwrap(await (await custody()).advanceVapiCustody(data.cloneId)));

export const readCloneVapiInbox = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data, context }) =>
    unwrap(await (await custody()).readVapiInbox(data.cloneId, context.userId)),
  );

export const revealCloneVapiLogin = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data, context }) =>
    unwrap(await (await custody()).revealVapiLogin(data.cloneId, context.userId)),
  );

export const markCloneVapiSignedUp = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data, context }) =>
    unwrap(await (await custody()).markVapiSignedUp(data.cloneId, context.userId)),
  );

export const recordCloneVapiOrg = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (
      input: WithClone & {
        orgId: string;
        privateKey: string;
        publicKey?: string;
        orgName?: string;
      },
    ) => {
      needClone(input);
      if (!input.orgId?.trim() || !input.privateKey?.trim())
        throw new Error("The organisation id and its private key are required.");
      return input;
    },
  )
  .handler(async ({ data, context }) => {
    const r = unwrap(
      await (
        await custody()
      ).recordVapiOrgKey({
        cloneId: data.cloneId,
        orgId: data.orgId,
        privateKey: data.privateKey,
        publicKey: data.publicKey ?? null,
        orgName: data.orgName ?? null,
        actorUserId: context.userId,
      }),
    );
    return { ok: true as const, fingerprint: r.fingerprint };
  });

export const setCloneVapiSuspended = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { suspended: boolean; reason?: string }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await custody()
      ).setVapiCustodySuspended({
        cloneId: data.cloneId,
        suspended: data.suspended,
        reason: data.reason ?? null,
        actorUserId: context.userId,
      }),
    ),
  );

export const setCloneGhlCredentials = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { apiKey: string; locationId: string }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).setGhlCredentials({
        cloneId: data.cloneId,
        apiKey: data.apiKey,
        locationId: data.locationId,
        actorUserId: context.userId,
      }),
    ),
  );

export const requestCloneGhlGrant = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { name: string; email: string }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).requestGhlGrant({
        cloneId: data.cloneId,
        authoriserName: data.name,
        authoriserEmail: data.email,
        actorUserId: context.userId,
      }),
    ),
  );

export const setCloneVoiceIdentity = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(
    (input: WithClone & { cloneLabel: string; replacements: { from: string; to: string }[] }) =>
      needClone(input),
  )
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).setStackIdentity({
        cloneId: data.cloneId,
        cloneLabel: data.cloneLabel,
        replacements: data.replacements,
        actorUserId: context.userId,
      }),
    ),
  );

export const buildCloneVoiceStack = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator(needClone)
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).buildVoiceStackNow({ cloneId: data.cloneId, actorUserId: context.userId }),
    ),
  );

export const retryCloneVoiceStackStep = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { stepKey: string }) => needClone(input))
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).retryStackStep({
        cloneId: data.cloneId,
        stepKey: data.stepKey,
        actorUserId: context.userId,
      }),
    ),
  );

export const parkCloneVoiceStack = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input: WithClone & { crmMode: "dependent" | "independent"; reason: string }) => {
    needClone(input);
    if ((input.reason ?? "").trim().length < 10)
      throw new Error("Say why (at least 10 characters).");
    return input;
  })
  .handler(async ({ data, context }) =>
    unwrap(
      await (
        await stack()
      ).parkVoiceStack({
        cloneId: data.cloneId,
        crmMode: data.crmMode,
        reason: data.reason,
        actorUserId: context.userId,
      }),
    ),
  );

/** Every clone's voice line and status, for the Yggdrasil tree. */
export const getVoiceLineage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async () => (await stack()).getVoiceLineageSummary());
