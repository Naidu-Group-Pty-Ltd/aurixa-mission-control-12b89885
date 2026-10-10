/**
 * Custody of each clone's own Vapi organisation — the orchestration.
 *
 * The rules are in `cloneVapiCustody.pure.ts`; this module reads and writes
 * around them. Five things happen here:
 *
 *   1. **Start / advance** (deployment drain, voice-stack drain, the operator's
 *      button). Once the clone's email identity has a verified sending domain,
 *      Resend RECEIVING is turned on for it, the receiving MX record is
 *      installed through the email identity's own DNS path, and a login is
 *      minted on `voice-agents@<sending domain>` with a strong password, held
 *      encrypted. Idempotent: every pass asks what is already done.
 *   2. **The inbox.** Vapi publishes no sign-up API, so an operator signs up
 *      once with the login. Mission Control reads the clone's received mail
 *      (Resend's received-email API) and shows Vapi's verification code and
 *      link. Only Vapi's mail is opened, and every read is audited.
 *   3. **The reveal.** The password is returned to an admin only on an explicit
 *      reveal, audited each time. Nothing else ever returns it.
 *   4. **The key.** The operator records the org id and its PRIVATE key. It is
 *      judged (never Aurixa's, never another clone's, never another org's),
 *      proved with a real read whose objects must belong to the org named, and
 *      stored encrypted. Only its fingerprint is ever shown.
 *   5. **Use.** `vapiKeyForClone` is the one way the stack builder gets the
 *      key, and it refuses a suspended or unverified custody.
 */
import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptSecret, encryptSecret, isEncryptionEnabled } from "./crypto.server";
import { writeAuditLog } from "./audit.server";
import { isResendConfigured, resendApi, type ResendDnsRecord } from "./resend-client";
import {
  custodyReadiness,
  decideCustodyStart,
  deriveVapiLoginEmail,
  extractVerification,
  isAddressedTo,
  isVapiMail,
  judgeVapiKey,
  mintVapiPassword,
  readingAgreesWithOrg,
  receivingMxRecords,
  type CustodyFacts,
  type CustodyReadiness,
  type VapiCustodyRow,
} from "./cloneVapiCustody.pure";
import { AURIXA_VAPI_ORG_ID } from "./voiceStackTemplate.pure";

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const COLUMNS =
  "clone_id, login_email, password_set_at, sending_domain, resend_domain_id, receiving_enabled_at, receiving_records, receiving_records_installed_via, signed_up_at, vapi_org_id, vapi_org_name, key_fingerprint, key_verified_at, public_key, suspended_at, suspended_reason, last_error, updated_at";

type CustodyDbRow = VapiCustodyRow & {
  resend_domain_id: string | null;
  vapi_org_name: string | null;
  public_key: string | null;
  suspended_reason: string | null;
  receiving_records: unknown;
  updated_at: string | null;
};

async function readRow(cloneId: string): Promise<CustodyDbRow | null> {
  const { data, error } = await supabaseAdmin
    .from("clone_vapi_custody")
    .select(COLUMNS)
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone's Vapi custody: ${error.message}`);
  return (data as CustodyDbRow | null) ?? null;
}

async function patchRow(cloneId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin
    .from("clone_vapi_custody")
    .upsert({ clone_id: cloneId, ...patch } as never, { onConflict: "clone_id" });
  if (error) throw new Error(`Could not store the clone's Vapi custody: ${error.message}`);
}

async function readEmailDomain(cloneId: string): Promise<CustodyFacts["emailDomain"]> {
  const { data, error } = await supabaseAdmin
    .from("clone_email_identities")
    .select("sending_domain, resend_domain_id, domain_status")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the clone's email identity: ${error.message}`);
  if (!data) return null;
  const d = data as {
    sending_domain: string | null;
    resend_domain_id: string | null;
    domain_status: string | null;
  };
  return {
    sendingDomain: d.sending_domain,
    resendDomainId: d.resend_domain_id,
    verified: d.domain_status === "verified",
  };
}

async function facts(cloneId: string): Promise<CustodyFacts> {
  return {
    resendConfigured: isResendConfigured(),
    encryptionEnabled: isEncryptionEnabled(),
    emailDomain: await readEmailDomain(cloneId),
  };
}

export type VapiCustodyView = {
  readiness: CustodyReadiness;
  loginEmail: string | null;
  passwordHeld: boolean;
  sendingDomain: string | null;
  receivingInstalledVia: "cloudflare" | "manual" | null;
  receivingRecords: ResendDnsRecord[];
  signedUpAt: string | null;
  vapiOrgId: string | null;
  vapiOrgName: string | null;
  keyFingerprint: string | null;
  keyVerifiedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  lastError: string | null;
  resendConfigured: boolean;
  encryptionEnabled: boolean;
};

/** What an operator sees. Never a password or a key: a fingerprint at most. */
export async function getVapiCustodyView(cloneId: string): Promise<VapiCustodyView> {
  const [row, f] = await Promise.all([readRow(cloneId), facts(cloneId)]);
  return {
    readiness: custodyReadiness(row, f),
    loginEmail: row?.login_email ?? null,
    passwordHeld: Boolean(row?.password_set_at),
    sendingDomain: row?.sending_domain ?? f.emailDomain?.sendingDomain ?? null,
    receivingInstalledVia: row?.receiving_records_installed_via ?? null,
    receivingRecords: Array.isArray(row?.receiving_records)
      ? (row!.receiving_records as ResendDnsRecord[])
      : [],
    signedUpAt: row?.signed_up_at ?? null,
    vapiOrgId: row?.vapi_org_id ?? null,
    vapiOrgName: row?.vapi_org_name ?? null,
    keyFingerprint: row?.key_fingerprint ?? null,
    keyVerifiedAt: row?.key_verified_at ?? null,
    suspendedAt: row?.suspended_at ?? null,
    suspendedReason: row?.suspended_reason ?? null,
    lastError: row?.last_error ?? null,
    resendConfigured: f.resendConfigured,
    encryptionEnabled: f.encryptionEnabled,
  };
}

/**
 * Carry custody forward as far as it can go without a person: receiving on,
 * its MX record in place, a login minted. Never creates anything at Vapi and
 * never marks the sign-up done — that is a person's act.
 */
export async function advanceVapiCustody(
  cloneId: string,
): Promise<{ ok: true; advanced: string[] } | Fail> {
  const advanced: string[] = [];
  try {
    const f = await facts(cloneId);
    const domain = f.emailDomain;
    if (!domain?.resendDomainId || !domain.sendingDomain)
      return { ok: true, advanced: ["no sending domain yet"] };
    if (!domain.verified) return { ok: true, advanced: ["sending domain not verified yet"] };
    if (!f.resendConfigured) return fail("RESEND_MASTER_API_KEY is not set on Mission Control");
    if (!f.encryptionEnabled) return fail("CREDENTIALS_ENC_KEY is not set on Mission Control");
    let row = await readRow(cloneId);
    if (row?.suspended_at) return { ok: true, advanced: ["suspended"] };
    if (!row) {
      await patchRow(cloneId, {
        sending_domain: domain.sendingDomain,
        resend_domain_id: domain.resendDomainId,
      });
      advanced.push("custody opened");
      row = await readRow(cloneId);
    }

    // 1. Receiving on, and its MX record in place.
    if (!row?.receiving_enabled_at) {
      await resendApi.setDomainCapabilities(domain.resendDomainId, { receiving: "enabled" });
      await patchRow(cloneId, { receiving_enabled_at: new Date().toISOString(), last_error: null });
      advanced.push("receiving turned on");
    }
    if (!row?.receiving_records_installed_via) {
      const fresh = await resendApi.getDomain(domain.resendDomainId);
      const mx = receivingMxRecords(
        (fresh.records ?? []).map((r) => ({ ...r })),
        domain.sendingDomain,
      );
      // Names may be relative; the installer makes them absolute first.
      const { installSendingDomainRecords } = await import("./email-identity.server");
      if (mx.length === 0) {
        // Resend lists the receiving record once receiving is on. None yet is
        // "not yet", never "done": the step stays open and says so.
        await patchRow(cloneId, {
          last_error: "Resend lists no receiving MX record for the domain yet.",
        });
        advanced.push("waiting for Resend's receiving record");
      } else {
        const res = await installSendingDomainRecords(
          supabaseAdmin,
          cloneId,
          domain.sendingDomain,
          mx,
        );
        await patchRow(cloneId, {
          receiving_records: res.records as unknown as never,
          ...(res.via
            ? { receiving_records_installed_via: res.via, last_error: null }
            : { last_error: res.detail }),
        });
        advanced.push(
          res.via
            ? `receiving record ${res.via === "cloudflare" ? "installed" : "handed to the operator"}`
            : res.detail,
        );
      }
    }

    // 2. The login.
    row = await readRow(cloneId);
    if (!row?.login_email || !row.password_set_at) {
      const login = deriveVapiLoginEmail(domain.sendingDomain);
      if (!login) return fail(`"${domain.sendingDomain}" cannot carry a login`);
      const password = mintVapiPassword((n) => randomBytes(n));
      await patchRow(cloneId, {
        login_email: login,
        password_enc: encryptSecret(password),
        password_set_at: new Date().toISOString(),
      });
      advanced.push(`login minted (${login})`);
    }
    return { ok: true, advanced };
  } catch (e) {
    const error = msg(e);
    await patchRow(cloneId, { last_error: error }).catch(() => undefined);
    return fail(error);
  }
}

/** The deployment drain's entry: start custody once, never repeat a start. */
export async function startVapiCustodyIfDue(cloneId: string): Promise<string> {
  try {
    const [row, f] = await Promise.all([readRow(cloneId), facts(cloneId)]);
    const verdict = decideCustodyStart({
      hasCustodyRow: Boolean(row),
      resendDomainId: f.emailDomain?.resendDomainId ?? null,
      sendingDomain: f.emailDomain?.sendingDomain ?? null,
      resendConfigured: f.resendConfigured,
      encryptionEnabled: f.encryptionEnabled,
    });
    if (!verdict.act) return `not started (${verdict.reason})`;
    const res = await advanceVapiCustody(cloneId);
    return res.ok ? res.advanced.join("; ") || "started" : res.error;
  } catch (e) {
    return msg(e);
  }
}

export type InboxMessage = {
  id: string;
  from: string | null;
  subject: string | null;
  receivedAt: string;
  fromVapi: boolean;
  codes: string[];
  links: string[];
};

/**
 * The clone's received mail for its Vapi login, newest first. Vapi's own mail
 * is opened for its verification code and link; any other message is listed
 * by sender and subject only. Audited, because a code is a way into the org.
 */
export async function readVapiInbox(
  cloneId: string,
  actorUserId: string,
): Promise<{ ok: true; messages: InboxMessage[]; complete: boolean } | Fail> {
  try {
    const row = await readRow(cloneId);
    if (!row?.login_email) return fail("No login has been minted for this clone yet.");
    if (!isResendConfigured()) return fail("RESEND_MASTER_API_KEY is not set on Mission Control");
    const { items, complete } = await resendApi.listReceivedEmails({ maxPages: 3 });
    const mine = items
      .filter((e) => isAddressedTo(e.to, row.login_email!))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, 10);
    const messages: InboxMessage[] = [];
    let opened = 0;
    for (const e of mine) {
      const fromVapi = isVapiMail({ from: e.from, subject: e.subject });
      let codes: string[] = [];
      let links: string[] = [];
      if (fromVapi && opened < 5) {
        opened += 1;
        const full = await resendApi.getReceivedEmail(e.id);
        ({ codes, links } = extractVerification({
          text: full.text ?? null,
          html: full.html ?? null,
        }));
      }
      messages.push({
        id: e.id,
        from: e.from,
        subject: e.subject,
        receivedAt: e.created_at,
        fromVapi,
        codes,
        links,
      });
    }
    await writeAuditLog({
      action: "vapi_custody.inbox_read",
      entityType: "clone",
      entityId: cloneId,
      actorUserId,
      metadata: { messages: messages.length, vapi_messages_opened: opened },
    });
    return { ok: true, messages, complete };
  } catch (e) {
    return fail(msg(e));
  }
}

/** The login, for an admin who is about to sign in. Audited every time. */
export async function revealVapiLogin(
  cloneId: string,
  actorUserId: string,
): Promise<{ ok: true; email: string; password: string } | Fail> {
  if (!isEncryptionEnabled()) return fail("CREDENTIALS_ENC_KEY is not set on Mission Control");
  const { data, error } = await supabaseAdmin
    .from("clone_vapi_custody")
    .select("login_email, password_enc")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) return fail(error.message);
  const r = data as { login_email: string | null; password_enc: string | null } | null;
  if (!r?.login_email || !r.password_enc)
    return fail("No login has been minted for this clone yet.");
  await writeAuditLog({
    action: "vapi_custody.password_revealed",
    entityType: "clone",
    entityId: cloneId,
    actorUserId,
    metadata: { login_email: r.login_email },
  });
  return { ok: true, email: r.login_email, password: decryptSecret(r.password_enc) };
}

export async function markVapiSignedUp(
  cloneId: string,
  actorUserId: string,
): Promise<{ ok: true } | Fail> {
  const row = await readRow(cloneId);
  if (!row?.login_email) return fail("No login has been minted for this clone yet.");
  await patchRow(cloneId, {
    signed_up_at: row.signed_up_at ?? new Date().toISOString(),
    signed_up_by: actorUserId,
  });
  await writeAuditLog({
    action: "vapi_custody.signed_up",
    entityType: "clone",
    entityId: cloneId,
    actorUserId,
  });
  return { ok: true };
}

/** Aurixa's own orgs: never a tenant's. */
function aurixaOrgIds(): string[] {
  const extra = (process.env.AURIXA_VAPI_ORG_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [AURIXA_VAPI_ORG_ID, ...extra];
}

export async function recordVapiOrgKey(input: {
  cloneId: string;
  orgId: string;
  privateKey: string;
  publicKey?: string | null;
  orgName?: string | null;
  actorUserId: string;
}): Promise<{ ok: true; fingerprint: string } | Fail> {
  if (!isEncryptionEnabled()) return fail("CREDENTIALS_ENC_KEY is not set on Mission Control");
  const row = await readRow(input.cloneId);
  if (!row?.login_email)
    return fail("Mint the clone's login first: the org must be created under it.");
  if (row.suspended_at) return fail("This clone's Vapi custody is suspended.");
  const key = input.privateKey.trim();
  const orgId = input.orgId.trim().toLowerCase();
  const { fingerprintOf } = await import("./voice-studio/credentials.server");
  const fingerprint = fingerprintOf(key);
  const { data: others, error: othersErr } = await supabaseAdmin
    .from("clone_vapi_custody")
    .select("clone_id, key_fingerprint, vapi_org_id")
    .neq("clone_id", input.cloneId);
  if (othersErr) return fail(`Could not read other clones' custody: ${othersErr.message}`);
  const judgement = judgeVapiKey({
    key,
    orgId,
    fingerprint,
    aurixaKey: process.env.VAPI_API_KEY ?? null,
    aurixaOrgIds: aurixaOrgIds(),
    others: (
      (others ?? []) as {
        clone_id: string;
        key_fingerprint: string | null;
        vapi_org_id: string | null;
      }[]
    ).map((o) => ({ cloneId: o.clone_id, fingerprint: o.key_fingerprint, orgId: o.vapi_org_id })),
  });
  if (!judgement.ok) {
    await writeAuditLog({
      action: "vapi_custody.key_refused",
      entityType: "clone",
      entityId: input.cloneId,
      actorUserId: input.actorUserId,
      metadata: { reason: judgement.reason },
    });
    return fail(judgement.message);
  }
  // Proof the key works AND reads the org named: whatever it can see must be that org's.
  try {
    const { vapiClient } = await import("./voice-studio/vapi-client.server");
    const api = vapiClient(key);
    const [assistants, tools] = await Promise.all([
      api.get("/assistant?limit=10"),
      api.get("/tool?limit=10"),
    ]);
    const objects = [
      ...(Array.isArray(assistants) ? assistants : []),
      ...(Array.isArray(tools) ? tools : []),
    ] as { orgId?: unknown }[];
    if (!readingAgreesWithOrg(orgId, objects))
      return fail(
        "The key reads objects that belong to a different organisation than the one named.",
      );
  } catch (e) {
    const status = (e as { status?: number }).status;
    return fail(
      status === 401 || status === 403
        ? "Vapi refused this key. Use the org's PRIVATE key, not the public one."
        : `Vapi could not be reached: ${msg(e)}`,
    );
  }
  const now = new Date().toISOString();
  await patchRow(input.cloneId, {
    vapi_org_id: orgId,
    vapi_org_name: input.orgName?.trim().slice(0, 120) || null,
    private_key_enc: encryptSecret(key),
    public_key: input.publicKey?.trim() || null,
    key_fingerprint: fingerprint,
    key_verified_at: now,
    key_set_by: input.actorUserId,
    signed_up_at: row.signed_up_at ?? now,
    last_error: null,
  });
  await writeAuditLog({
    action: "vapi_custody.key_recorded",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { vapi_org_id: orgId, fingerprint },
  });
  return { ok: true, fingerprint };
}

export async function setVapiCustodySuspended(input: {
  cloneId: string;
  suspended: boolean;
  reason: string | null;
  actorUserId: string;
}): Promise<{ ok: true } | Fail> {
  if (input.suspended && (input.reason ?? "").trim().length < 10)
    return fail("Say why (at least 10 characters).");
  await patchRow(input.cloneId, {
    suspended_at: input.suspended ? new Date().toISOString() : null,
    suspended_reason: input.suspended ? input.reason!.trim().slice(0, 500) : null,
  });
  await writeAuditLog({
    action: input.suspended ? "vapi_custody.suspended" : "vapi_custody.resumed",
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { reason: input.reason },
  });
  return { ok: true };
}

/**
 * The clone org's private key, for the stack builder and nothing else.
 * Refuses an unverified or suspended custody: a stack is never built into an
 * org this module has not proved belongs to the clone.
 */
export async function vapiKeyForClone(
  cloneId: string,
): Promise<{ ok: true; key: string; orgId: string } | Fail> {
  const { data, error } = await supabaseAdmin
    .from("clone_vapi_custody")
    .select("private_key_enc, vapi_org_id, key_verified_at, suspended_at")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (error) return fail(error.message);
  const r = data as {
    private_key_enc: string | null;
    vapi_org_id: string | null;
    key_verified_at: string | null;
    suspended_at: string | null;
  } | null;
  if (!r?.private_key_enc || !r.key_verified_at || !r.vapi_org_id)
    return fail("The clone's Vapi org is not active.");
  if (r.suspended_at) return fail("The clone's Vapi custody is suspended.");
  if (!isEncryptionEnabled()) return fail("CREDENTIALS_ENC_KEY is not set on Mission Control");
  return { ok: true, key: decryptSecret(r.private_key_enc), orgId: r.vapi_org_id };
}

/** Whether the clone's custody is active (the stack gate asks this). */
export async function isVapiCustodyActive(cloneId: string): Promise<boolean> {
  const [row, f] = await Promise.all([readRow(cloneId), facts(cloneId)]);
  return custodyReadiness(row, f).status === "active";
}

/** The drain's pass: advance every custody that is not finished or suspended. */
export async function sweepVapiCustody(limit = 20): Promise<{ advanced: number; errors: number }> {
  const { data, error } = await supabaseAdmin
    .from("clone_vapi_custody")
    .select("clone_id")
    .is("suspended_at", null)
    .or("login_email.is.null,receiving_records_installed_via.is.null")
    .limit(limit);
  if (error) throw new Error(error.message);
  let advanced = 0;
  let errors = 0;
  for (const r of (data ?? []) as { clone_id: string }[]) {
    const res = await advanceVapiCustody(r.clone_id);
    if (res.ok) advanced += res.advanced.length > 0 ? 1 : 0;
    else errors += 1;
  }
  return { advanced, errors };
}
