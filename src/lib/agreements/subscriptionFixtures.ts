/**
 * Test fixtures for the subscription agreements: an issuing profile with
 * every standing fact stated, and a fully prepared offer.
 *
 * Only the tests import this. Every contact is on the reserved `.test`
 * domain and every identifier is a published example number (the ATO's
 * example ABN, an ASIC example ACN), so nothing here can be mistaken for — or
 * accidentally sent to — a real customer.
 */
import {
  issuingProfileSchema,
  newSubscriptionOffer,
  type IssuingProfile,
  type RateCard,
  type SubscriptionOffer,
} from "./subscriptionOffer.pure";
import type { SubscriptionTierSlug } from "./subscriptionTemplates";

/** The ATO's published example ABN. */
export const EXAMPLE_ABN = "51 824 753 556";
/** An ASIC example ACN. */
export const EXAMPLE_ACN = "004 085 616";

export const COMPLETE_PROFILE: IssuingProfile = issuingProfileSchema.parse({
  service: {
    serviceProfile: "Aurixa Standard Cloud Profile, version 1, effective 1 October 2026",
    supabase:
      "Database and Storage in Australia (Sydney region); dedicated Aurixa-managed project for the Customer",
    edge: "Cloudflare network protection and application hosting; location record in Disclosure Record DR-1",
    processing:
      "Core reporting AI and transactional email as listed in Disclosure Record DR-1 (version 1)",
    lifecycle:
      "Daily database backups; object recovery by request; 30-day standard export on exit, then Schedule C deletion",
    legalContact: "legal@aurixa.test; Level 1, 1 Example Street, Sydney NSW 2000",
    supportContact:
      "Portal support; fallback support@aurixa.test; security@aurixa.test for security and escalation; status page",
    privacyContact: "privacy@aurixa.test; Privacy Notice supplied with this offer",
    continuations: "Disclosure Record DR-1 (version 1)",
    correctionRoute: "offers@aurixa.test",
    applicableDocuments: "Schedule E5 Disclosure Record DR-1 (version 1)",
  },
  usage: {
    apiAllowance: "Ordinary platform API use; 50 GB storage per organisation each monthly cycle",
    apiBasis: "No extra-use authority: no extra rate, no authorised payer, period cap $0.00",
    amlAllowance: "20 identity verifications and 20 screenings each monthly cycle",
    amlBasis: "No extra-check authority: period cap $0.00",
    commsAllowance: "Transactional email only; 2,000 emails each monthly cycle",
    commsBasis: "No extra-use authority: period cap $0.00",
  },
  defaultPaymentMethod: "Card through Stripe",
});

export const RATE_CARD: RateCard = {
  rows: [
    { slug: "investment-report", name: "Investment report", credit_cost: 1_200 },
    { slug: "cash-flow-10y", name: "10-year cash flow", credit_cost: 400 },
    { slug: "report-comparison", name: "Report comparison", credit_cost: 1 },
  ],
  version: "rc-2026-09-25",
};

/** An offer with every input an issued document needs. */
export function completeOffer(
  tier: SubscriptionTierSlug = "growth",
  patch: (offer: SubscriptionOffer) => void = () => {},
): SubscriptionOffer {
  const offer = newSubscriptionOffer(tier, COMPLETE_PROFILE, {
    customer: {
      legalName: "Example Property Advisory Pty Ltd",
      identifier: EXAMPLE_ABN,
      address: "Level 2, 10 Sample Road, Parramatta NSW 2150",
      noticeEmail: "notices@customer.test",
      billingContact: "",
    },
    signatory: {
      name: "Alex Example",
      role: "Director",
      email: "alex@customer.test",
    },
  });
  offer.activationDate = "2026-10-31";
  patch(offer);
  return offer;
}
