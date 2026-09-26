/**
 * Issuing each real template end to end: compose a complete offer, complete
 * the approved `.docx`, then reopen the result and check what a customer —
 * and DocuSign — would receive.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentText } from "./docxFill.pure";
import {
  completeSubscriptionDocument,
  issuedCoreProperties,
  partText,
  readDocx,
  sha256Hex,
  type IssuedDocumentMeta,
} from "./docxPackage.pure";
import { completeOffer, RATE_CARD } from "./subscriptionFixtures";
import {
  composeSubscriptionOffer,
  fieldValueText,
  PREVIEW_ACCEPTANCE_NOTICE,
  SUBSCRIPTION_FIELD_TAGS,
  toDocumentFill,
  type SubscriptionOffer,
} from "./subscriptionOffer.pure";
import {
  SUBSCRIPTION_ANCHOR_LIST,
  SUBSCRIPTION_ANCHORS,
  SUBSCRIPTION_TEMPLATES,
  SUBSCRIPTION_TIER_SLUGS,
  type SubscriptionTierSlug,
} from "./subscriptionTemplates";

const templateBytes = (tier: SubscriptionTierSlug) =>
  new Uint8Array(readFileSync(`public${SUBSCRIPTION_TEMPLATES[tier].path}`));

const META: IssuedDocumentMeta = {
  title: "Aurixa Systems Subscription Agreement — Example Property Advisory Pty Ltd",
  subject: "Subscription Agreement offer AUR-SA-20260925-ABCDEF",
  keywords: "Aurixa, subscription, offer",
  description: "Issued offer.",
  issuedAt: "2026-09-25T03:04:05.678Z",
};

/** Byte equality without a deep-equality walk over megabytes of artwork. */
function sameBytes(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Each template shades its acceptance panel in its own tier colour. */
const ACCEPTANCE_PANEL_FILL: Record<SubscriptionTierSlug, string> = {
  launch: "EAF4F4",
  growth: "EAF2F8",
  scale: "F7F2EC",
};

async function issue(offer: SubscriptionOffer) {
  const composed = composeSubscriptionOffer(offer, {
    offerReference: "AUR-SA-20260925-ABCDEF",
    rateCard: RATE_CARD,
  });
  const doc = await completeSubscriptionDocument(
    templateBytes(offer.tier),
    toDocumentFill(composed),
    {
      anchors: SUBSCRIPTION_ANCHOR_LIST,
      meta: META,
    },
  );
  return { composed, doc };
}

describe.each(SUBSCRIPTION_TIER_SLUGS)("issuing the %s template", (tier) => {
  it("prints every composed value, leaves no control or placeholder, and keeps everything else", async () => {
    const offer = completeOffer(tier, (o) => {
      o.extraSeats = 1;
      o.addons = [
        {
          id: "l1",
          itemKey: "aurixa-agent",
          quantity: 1,
          discountMonthlyCents: 0,
          term: "flexible",
          purchaser: "",
          scope: "",
          usageAndCosts: "",
          permissions: "",
        },
      ];
    });
    const { composed, doc } = await issue(offer);
    const reopened = await readDocx(doc.bytes);
    const document = partText(reopened, "word/document.xml");

    expect(document).toBe(doc.documentXml);
    expect(document).not.toMatch(/<w:sdt(?=[\s>])/);
    const text = documentText(document);
    expect(text).not.toContain("[");
    for (const tag of SUBSCRIPTION_FIELD_TAGS) {
      // The e-sign field's anchors are separate runs; its plain text is checked below.
      if (tag === "signatory.esign_reference") continue;
      for (const line of fieldValueText(composed.fields[tag]).split("\n")) {
        expect(text, tag).toContain(line);
      }
    }
    for (const line of composed.lines) {
      for (const value of Object.values(line.record)) expect(text).toContain(value);
    }

    // Every part except the two that were completed is byte-for-byte the template's.
    const template = await readDocx(templateBytes(tier));
    expect(reopened.order).toEqual(template.order);
    for (const name of template.order) {
      if (name === "word/document.xml" || name === "docProps/core.xml") continue;
      expect(sameBytes(reopened.parts.get(name), template.parts.get(name)), name).toBe(true);
    }
    expect(partText(reopened, "docProps/core.xml")).toBe(issuedCoreProperties(META));
  });

  it("places each DocuSign anchor once, painted in that template's acceptance-panel colour", async () => {
    const { doc } = await issue(completeOffer(tier));
    for (const anchor of Object.values(SUBSCRIPTION_ANCHORS)) {
      const run =
        `<w:r><w:rPr><w:color w:val="${ACCEPTANCE_PANEL_FILL[tier]}"/><w:sz w:val="12"/><w:szCs w:val="12"/></w:rPr>` +
        `<w:t xml:space="preserve">${anchor}</w:t></w:r>`;
      expect(doc.documentXml.split(run)).toHaveLength(2);
    }
    const text = documentText(doc.documentXml);
    expect(text).toContain(
      "Electronic acceptance: Signed through DocuSign for offer AUR-SA-20260925-ABCDEF.",
    );
    expect(text).toContain("No additional purchases.");
  });

  it("issues the same bytes for the same offer, and says which bytes they are", async () => {
    const first = await issue(completeOffer(tier));
    const second = await issue(completeOffer(tier));
    expect(second.doc.sha256).toBe(first.doc.sha256);
    expect(first.doc.sha256).toBe(await sha256Hex(first.doc.bytes));
    expect(first.doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a preview copy", () => {
  it("passes the same issuing checks but says, where a signer looks, that it is not an offer", async () => {
    const offer = completeOffer("launch");
    const composed = composeSubscriptionOffer(offer, {
      offerReference: "AUR-SA-20260925-ABCDEF",
      rateCard: RATE_CARD,
      preview: true,
    });
    const doc = await completeSubscriptionDocument(
      templateBytes("launch"),
      toDocumentFill(composed),
      { anchors: SUBSCRIPTION_ANCHOR_LIST, meta: { ...META, title: `PREVIEW — ${META.title}` } },
    );
    const text = documentText(doc.documentXml);
    expect(text).toContain(`Electronic acceptance: ${PREVIEW_ACCEPTANCE_NOTICE}`);
    expect(text).not.toContain("Your authorised representative signs below.");
    for (const anchor of SUBSCRIPTION_ANCHOR_LIST) {
      expect(doc.documentXml.split(anchor)).toHaveLength(2);
    }
    const reopened = await readDocx(doc.bytes);
    expect(partText(reopened, "docProps/core.xml")).toContain("<dc:title>PREVIEW — ");
  });
});

describe("issuedCoreProperties", () => {
  it("carries only the issuer and the offer, never the template's draft notice or editor", () => {
    const xml = issuedCoreProperties({ ...META, title: "A & B <offer>" });
    expect(xml).toContain("<dc:title>A &amp; B &lt;offer&gt;</dc:title>");
    expect(xml).toContain("<dc:creator>Aurixa Systems Pty Ltd</dc:creator>");
    expect(xml).toContain("<cp:lastModifiedBy>Aurixa Systems Pty Ltd</cp:lastModifiedBy>");
    expect(xml).toContain(
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-25T03:04:05Z</dcterms:created>',
    );
    expect(xml).not.toMatch(/draft/i);
  });
});
