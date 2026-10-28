/**
 * Operator RPCs for free-trial lengths: the platform default the pickers show,
 * and trial offers.
 *
 * Reads are `requireOperator`, so anybody provisioning or answering a customer
 * can see what an offer gives. Creating, changing and retiring an offer is
 * `requireAdmin`, like every other act on Payment Gates, because an offer is a
 * promise the website makes on Aurixa's behalf.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { normaliseOfferCode, TRIAL_MAX_DAYS, TRIAL_MIN_DAYS } from "@/lib/trialOffers.pure";
import { defaultGateSettings } from "./payment-gate.server";
import { createTrialOffer, listTrialOffers, updateTrialOffer } from "./trial-offers.server";

const days = z.number().int().min(TRIAL_MIN_DAYS).max(TRIAL_MAX_DAYS);
const label = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(2).max(80));
const notes = z
  .string()
  .max(1000)
  .transform((s) => s.trim() || null)
  .nullable()
  .optional();
const expiresAt = z.string().datetime({ offset: true }).nullable().optional();

/**
 * Everything a trial picker needs in one read: the live platform default and
 * the offers. `offersError` is carried rather than thrown, so a picker whose
 * offers could not be read still offers the default and typed days — and says
 * why its offers are missing.
 */
export const getTrialSettings = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const [defaults, offers] = await Promise.all([defaultGateSettings(), listTrialOffers()]);
    return {
      defaults,
      offers: offers.ok ? offers.offers : [],
      offersError: offers.ok ? null : offers.schemaPending ? "schema_pending" : offers.error,
    };
  });

export const createTrialOfferFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        code: z.string().max(64),
        label,
        trialDays: days,
        expiresAt,
        notes,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const code = normaliseOfferCode(data.code);
    if (!code.ok) {
      return {
        ok: false as const,
        error: "A code is 2 to 32 letters, digits or hyphens, starting with a letter or digit.",
      };
    }
    const result = await createTrialOffer({
      code: code.code,
      label: data.label,
      trialDays: data.trialDays,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes ?? null,
      actorId: context.userId,
    });
    if (!result.ok) {
      return {
        ok: false as const,
        error:
          result.error === "code_taken"
            ? `${code.code} is already an offer's code.`
            : result.error === "schema_pending"
              ? "Trial offers are not in the database yet — the migration that adds them has not applied."
              : result.error,
      };
    }
    return { ok: true as const, offer: result.offer };
  });

export const updateTrialOfferFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        label: label.optional(),
        trialDays: days.optional(),
        active: z.boolean().optional(),
        expiresAt,
        notes,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await updateTrialOffer({ ...data, actorId: context.userId });
    if (!result.ok) {
      return {
        ok: false as const,
        error: result.error === "not_found" ? "That offer no longer exists." : result.error,
      };
    }
    return { ok: true as const, offer: result.offer };
  });
