import { describe, expect, it } from "vitest";
import {
  abnContainsAcn,
  agreementColumnsFromParticulars,
  announcesGrantOutcome,
  approvalBasisReason,
  assessWordTerms,
  base64ToBytes,
  BUILDER_ORGANISATION_CUSTOM_FIELD,
  BUILDER_PARTNER_ANCHORS,
  BUILDER_PARTNER_REFERENCE_PATTERN,
  buildBuilderPartnerEnvelopeDefinition,
  builderPartnerSignedRecordPath,
  builderPartnerTitle,
  checkTemplateUpload,
  classifyApproveResult,
  decideBuilderAccessGate,
  decideGrantAttempt,
  describeApprovalCode,
  emptyParticulars,
  formatAbn,
  formatAcn,
  grantApprovalReason,
  isSchemaAbsent,
  isValidAbn,
  isValidAcn,
  newBuilderPartnerReference,
  normaliseParticulars,
  organisationAgreementState,
  particularsChanges,
  particularsGaps,
  readBuilderPartnerSnapshot,
  readParticulars,
  registeredFileName,
  scheduleDocumentName,
  seedParticulars,
  staleCrossReferences,
  STALE_GRANT_ATTEMPT_MS,
  TEMPLATE_MAX_BYTES,
  templateStoragePath,
  termsDocumentName,
  termsFromRegistryRow,
  toAgreementSummary,
  WAIVER_REASON_MIN,
  type BuilderAgreementSummary,
  type BuilderPartnerEnvelopeInput,
  type BuilderPartnerParticulars,
  type GrantFacts,
  type WordPackageFacts,
} from "./builderPartner.pure";
import { AGREEMENT_ID_CUSTOM_FIELD, OFFER_REFERENCE_CUSTOM_FIELD } from "./subscriptionIssue.pure";
import { decideProvisionOnSignature } from "@/server/agreementProvisioning.pure";

/** The ATO's and ASIC's own published examples. */
const ABN = "51824753556";
const ACN = "004085616";
/** The ABN that ACN 004 085 616 produces. */
const ABN_OF_ACN = "53004085616";

function particulars(
  over: {
    partner?: Partial<BuilderPartnerParticulars["partner"]>;
    signatory?: Partial<BuilderPartnerParticulars["signatory"]>;
  } = {},
): BuilderPartnerParticulars {
  const base = emptyParticulars();
  return {
    schema: 1,
    partner: {
      ...base.partner,
      legalName: "Example Homes Pty Ltd",
      tradingName: "Example Homes",
      abn: ABN,
      acn: "",
      address: "1 Builder Street, Parramatta NSW 2150",
      email: "office@examplehomes.test",
      phone: "02 9000 0000",
      ...over.partner,
    },
    signatory: {
      ...base.signatory,
      name: "Sam Builder",
      email: "sam@examplehomes.test",
      title: "Director",
      ...over.signatory,
    },
  };
}

function agreement(over: Partial<BuilderAgreementSummary> = {}): BuilderAgreementSummary {
  return {
    id: "a1",
    status: "draft",
    reference: "AUR-BPA-20260928-ABCDEF",
    signedAt: null,
    createdAt: "2026-09-28T01:00:00.000Z",
    signedRecordPath: null,
    portalAccessStatus: null,
    grantAccessOnSignature: false,
    ...over,
  };
}

describe("the reference", () => {
  it("is AUR-BPA, the Sydney issuing day and six unambiguous characters", () => {
    // 15:00 UTC on the 28th is 01:00 on the 29th in Sydney (AEST, before DST).
    const ref = newBuilderPartnerReference(
      new Date("2026-09-28T15:00:00.000Z"),
      () => new Uint8Array([0, 1, 2, 30, 31, 32]),
    );
    expect(ref).toBe("AUR-BPA-20260929-ABC89A");
    expect(ref).toMatch(BUILDER_PARTNER_REFERENCE_PATTERN);
  });

  it("never uses the characters a person confuses aloud", () => {
    // Every byte value, six at a time, the last window wrapping round to the
    // start. It used to come up four bytes short, so `.slice(-6)` read the
    // issuing day's last digit and the test failed on every Sydney day ending
    // in 0 or 1 — hence a day ending in 0, and the suffix read by its dash.
    const issued = new Date("2026-09-30T02:00:00.000Z");
    let seen = "";
    for (let i = 0; i < 256; i += 6) {
      const ref = newBuilderPartnerReference(issued, (n) =>
        Uint8Array.from({ length: n }, (_, k) => (i + k) % 256),
      );
      seen += ref.slice(ref.lastIndexOf("-") + 1);
    }
    expect(seen).toHaveLength(43 * 6);
    expect(seen).not.toMatch(/[01OI]/);
  });
});

describe("ABN and ACN", () => {
  it("reads the numbers the way a person types them", () => {
    expect(isValidAbn("51 824 753 556")).toBe(true);
    expect(isValidAbn("ABN: 51-824-753-556")).toBe(true);
    expect(isValidAbn("51 824 753 557")).toBe(false);
    expect(isValidAcn("ACN 004 085 616")).toBe(true);
    expect(isValidAcn("004 085 617")).toBe(false);
  });

  it("writes valid numbers in the registers' grouping and leaves anything else alone", () => {
    expect(formatAbn(ABN)).toBe("51 824 753 556");
    expect(formatAcn(ACN)).toBe("004 085 616");
    expect(formatAbn("  not a number ")).toBe("not a number");
  });

  it("knows a company's ABN contains its ACN", () => {
    expect(abnContainsAcn(ABN_OF_ACN, ACN)).toBe(true);
    expect(abnContainsAcn(ABN, ACN)).toBe(false);
  });
});

describe("the particulars", () => {
  it("are seeded from what the network holds, guessing nothing", () => {
    const seeded = seedParticulars(
      {
        legal_name: "  Example   Homes Pty Ltd ",
        trading_name: null,
        abn: ABN,
        state: "NSW",
        contact_email: "office@examplehomes.test",
      },
      {
        contact_name: "Sam Builder",
        contact_email: "sam@examplehomes.test",
        contact_phone: "0400 000 000",
        suburb: "Parramatta",
        postcode: "2150",
      },
    );
    expect(seeded.partner.legalName).toBe("Example Homes Pty Ltd");
    expect(seeded.partner.abn).toBe("51 824 753 556");
    // The application records a locality, never a street, and never an ACN.
    expect(seeded.partner.address).toBe("Parramatta NSW 2150");
    expect(seeded.partner.acn).toBe("");
    expect(seeded.signatory).toEqual({
      name: "Sam Builder",
      email: "sam@examplehomes.test",
      title: "",
    });
    expect(readParticulars(seeded)).toEqual(seeded);
  });

  it("seed without an application from the organisation alone", () => {
    const seeded = seedParticulars({ legal_name: "Solo Builds", contact_email: "a@b.test" });
    expect(seeded.partner.email).toBe("a@b.test");
    expect(seeded.signatory.email).toBe("a@b.test");
    expect(seeded.signatory.name).toBe("");
  });

  it("record which fields a save changed, by name and never by value", () => {
    const before = particulars();
    const after = particulars({
      partner: { abn: "51824753556" },
      signatory: { email: "new@examplehomes.test" },
    });
    // Re-grouping a number is normalisation, not a change.
    expect(particularsChanges(before, after)).toEqual(["signatory.email"]);
    expect(particularsChanges(null, emptyParticulars())).toEqual([]);
    expect(particularsChanges(null, particulars())).toContain("partner.legalName");
  });

  it("read back only what the schema admits", () => {
    expect(readParticulars({ schema: 2 })).toBeNull();
    expect(readParticulars(null)).toBeNull();
  });
});

describe("what stands between the particulars and a send", () => {
  it("nothing, for complete particulars", () => {
    expect(particularsGaps(particulars())).toEqual({ blockers: [], warnings: [] });
  });

  it("blocks on a missing party or signatory and a failed check digit", () => {
    const gaps = particularsGaps(
      particulars({
        partner: { legalName: " ", abn: "51 824 753 557", acn: "004 085 617", email: "nope" },
        signatory: { name: "", email: "not-an-address" },
      }),
    );
    expect(gaps.blockers).toHaveLength(6);
    expect(gaps.blockers.join(" ")).toMatch(/legal name/);
    expect(gaps.blockers.join(" ")).toMatch(/ABN fails/);
    expect(gaps.blockers.join(" ")).toMatch(/ACN fails/);
  });

  it("warns, and does not block, on what the schedule can say is absent", () => {
    const gaps = particularsGaps(
      particulars({ partner: { abn: "", address: "" }, signatory: { title: "" } }),
    );
    expect(gaps.blockers).toEqual([]);
    expect(gaps.warnings).toHaveLength(3);
  });

  it("asks a question, never refuses, when the ABN does not contain the ACN", () => {
    const trust = particularsGaps(particulars({ partner: { abn: ABN, acn: ACN } }));
    expect(trust.blockers).toEqual([]);
    expect(trust.warnings.join(" ")).toMatch(/trust with a corporate trustee/);
    const company = particularsGaps(particulars({ partner: { abn: ABN_OF_ACN, acn: ACN } }));
    expect(company.warnings).toEqual([]);
  });

  it("the row's own columns follow the particulars", () => {
    expect(agreementColumnsFromParticulars(particulars())).toEqual({
      client_name: "Sam Builder",
      client_email: "sam@examplehomes.test",
      client_org: "Example Homes Pty Ltd",
      service_tier: "Builder Partner",
    });
    // NOT NULL columns are never overwritten with nothing.
    const bare = agreementColumnsFromParticulars(emptyParticulars());
    expect(bare).not.toHaveProperty("client_name");
    expect(bare).not.toHaveProperty("client_email");
  });
});

describe("a terms file", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n...");
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);

  it("is what its bytes say, not what its name claims", () => {
    expect(checkTemplateUpload(pdf, "Terms.pdf")).toMatchObject({ ok: true, extension: "pdf" });
    expect(checkTemplateUpload(zip, "Terms.docx")).toMatchObject({ ok: true, extension: "docx" });
    expect(checkTemplateUpload(zip, "Terms.pdf")).toMatchObject({ ok: false });
    expect(checkTemplateUpload(pdf, "Terms.doc")).toMatchObject({ ok: false });
    expect(checkTemplateUpload(new TextEncoder().encode("hello"), "t.pdf")).toMatchObject({
      ok: false,
    });
    expect(checkTemplateUpload(new Uint8Array(), "t.pdf")).toMatchObject({ ok: false });
    expect(checkTemplateUpload(new Uint8Array(TEMPLATE_MAX_BYTES + 1), "t.pdf")).toMatchObject({
      ok: false,
    });
  });

  const clean: WordPackageFacts = {
    partNames: ["[Content_Types].xml", "word/document.xml", "word/_rels/document.xml.rels"],
    contentTypesXml:
      '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    storyXml: [
      "<w:document><w:body><w:tbl><w:tblBorders><w:insideH/></w:tblBorders></w:tbl><w:p><w:r><w:t>Terms</w:t></w:r></w:p></w:body></w:document>",
    ],
    documentRelsXml:
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://aurixa.test" TargetMode="External"/></Relationships>',
  };

  it("in Word is accepted when it is one settled text", () => {
    // `<w:insideH>` is a table border, not an insertion; a hyperlink is not a linked file.
    expect(assessWordTerms(clean)).toEqual({ ok: true, warnings: [] });
  });

  it("in Word is refused with active content, tracked changes or parts held elsewhere", () => {
    expect(
      assessWordTerms({ ...clean, partNames: [...clean.partNames, "word/vbaProject.bin"] }),
    ).toMatchObject({ ok: false });
    expect(
      assessWordTerms({
        ...clean,
        contentTypesXml: "application/vnd.ms-word.document.macroEnabled.main+xml",
      }),
    ).toMatchObject({ ok: false });
    expect(
      assessWordTerms({
        ...clean,
        storyXml: ['<w:p><w:ins w:id="1"><w:r><w:t>new</w:t></w:r></w:ins></w:p>'],
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/tracked changes/) });
    expect(
      assessWordTerms({
        ...clean,
        documentRelsXml:
          '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/subDocument" Target="part2.docx" TargetMode="External"/></Relationships>',
      }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/master document/) });
  });

  it("in Word warns, without refusing, on comments, linked files and no text", () => {
    const result = assessWordTerms({
      ...clean,
      partNames: [...clean.partNames, "word/comments.xml"],
      storyXml: ["<w:p><w:r><w:drawing/></w:r></w:p>"],
      documentRelsXml:
        '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="file:///C:/logo.png" TargetMode="External"/></Relationships>',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings).toHaveLength(3);
  });

  /**
   * BD1's shape: the fee is typed once, on "Your transaction-fee arrangement",
   * inside a bookmark, and clause 14.3 quotes it through a REF field whose
   * stored result is what DocuSign prints.
   */
  const feePage = (fee: string) =>
    '<w:p><w:r><w:t xml:space="preserve">New Build Fee: </w:t></w:r>' +
    '<w:bookmarkStart w:id="7" w:name="BD1_Fee_NewBuild_ExGST"/>' +
    `<w:r><w:t>${fee}</w:t></w:r><w:bookmarkEnd w:id="7"/>` +
    '<w:r><w:t xml:space="preserve"> excluding GST</w:t></w:r></w:p>';
  const clause = (shown: string, instruction = " REF BD1_Fee_NewBuild_ExGST \\h ") =>
    '<w:p><w:r><w:t xml:space="preserve">14.3 The New Build Fee is </w:t></w:r>' +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${shown}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const story = (...paragraphs: string[]) =>
    `<w:document><w:body>${paragraphs.join("")}</w:body></w:document>`;

  it("in Word is accepted when every clause quoting the fee page says what it says", () => {
    const facts = { ...clean, storyXml: [story(feePage("$6,000"), clause("$6,000"))] };
    expect(staleCrossReferences(facts.storyXml)).toEqual([]);
    expect(assessWordTerms(facts)).toEqual({ ok: true, warnings: [] });
    // The formatting switches change nothing a reader sees.
    expect(
      staleCrossReferences([
        story(feePage("$6,000"), clause("$6,000", " REF BD1_Fee_NewBuild_ExGST \\* MERGEFORMAT ")),
      ]),
    ).toEqual([]);
    // Nor does a simple field, or a non-breaking space Word put in the result.
    expect(
      staleCrossReferences([
        story(
          feePage("$6,000"),
          '<w:p><w:fldSimple w:instr=" REF BD1_Fee_NewBuild_ExGST \\h "><w:r><w:t>$6,000\u00a0</w:t></w:r></w:fldSimple></w:p>',
        ),
      ]),
    ).toEqual([]);
  });

  it("in Word is refused when a fee changed on its page and not in the clause quoting it", () => {
    const facts = { ...clean, storyXml: [story(feePage("$7,500"), clause("$6,000"))] };
    expect(staleCrossReferences(facts.storyXml)).toEqual([
      { bookmark: "BD1_Fee_NewBuild_ExGST", shown: "$6,000", source: "$7,500" },
    ]);
    const result = assessWordTerms(facts);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toMatch(/\$6,000/);
      expect(result.error).toMatch(/\$7,500/);
      expect(result.error).toMatch(/F9/);
    }
  });

  it("in Word is refused when the quoted text was retyped over and its bookmark lost", () => {
    const retyped = "<w:p><w:r><w:t>New Build Fee: $7,500 excluding GST</w:t></w:r></w:p>";
    expect(staleCrossReferences([story(retyped, clause("$6,000"))])).toEqual([
      { bookmark: "BD1_Fee_NewBuild_ExGST", shown: "$6,000", source: null },
    ]);
    expect(
      assessWordTerms({ ...clean, storyXml: [story(retyped, clause("$6,000"))] }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/no longer marked/) });
  });

  it("does not judge a reference that prints a number, a position or a changed case", () => {
    // `\\n` prints the paragraph number the bookmark sits in, `\\p` "above" or
    // "below": neither is the marked text, so neither can be compared with it.
    for (const instruction of [
      " REF BD1_Fee_NewBuild_ExGST \\n \\h ",
      " REF BD1_Fee_NewBuild_ExGST \\p ",
    ]) {
      expect(staleCrossReferences([story(feePage("$6,000"), clause("14.3", instruction))])).toEqual(
        [],
      );
    }
    // A PAGEREF or any other field is not a quotation at all.
    expect(
      staleCrossReferences([
        story(feePage("$6,000"), clause("3", " PAGEREF BD1_Fee_NewBuild_ExGST ")),
      ]),
    ).toEqual([]);
  });

  it("is stored by digest and named safely", () => {
    const sha = "a".repeat(64);
    expect(templateStoragePath(sha, "docx")).toBe(`builder-partner/${sha}.docx`);
    expect(() => templateStoragePath("../x", "pdf")).toThrow();
    expect(registeredFileName("C:\\Users\\me\\Builder Terms v1.docx", "docx")).toBe(
      "Builder Terms v1.docx",
    );
    expect(registeredFileName("terms.doc", "pdf")).toBe("terms.pdf");
    expect(registeredFileName("", "pdf")).toBe("terms.pdf");
    expect(
      termsDocumentName({
        name: "Builder Partner Agreement",
        versionLabel: "v1/2026",
        mediaType: "application/pdf",
      }),
    ).toBe("Builder Partner Agreement (v1 2026).pdf");
    expect(scheduleDocumentName("AUR-BPA-20260928-ABCDEF", true)).toBe(
      "PREVIEW - Execution Schedule AUR-BPA-20260928-ABCDEF.pdf",
    );
    expect(builderPartnerSignedRecordPath("a/../b", "env id")).toBe(
      "builder-partner/ab/envid-signed.pdf",
    );
  });

  it("reads a registry row only when its media type is one this reads", () => {
    const row = {
      id: "t1",
      name: "Terms",
      version_label: "v1",
      file_name: "terms.pdf",
      media_type: "application/pdf",
      sha256: "b".repeat(64),
      byte_size: 10,
      page_count: 3,
      countersignature_required: true,
      execution_statement: "Executed as an agreement by the parties.",
    };
    expect(termsFromRegistryRow(row)).toMatchObject({ id: "t1", countersignatureRequired: true });
    expect(termsFromRegistryRow({ ...row, media_type: "text/plain" })).toBeNull();
  });
});

describe("base64 from a browser", () => {
  it("tolerates a data URL prefix and line breaks", () => {
    expect([...base64ToBytes("data:application/pdf;base64,JVBE\nRi0=")]).toEqual([
      0x25, 0x50, 0x44, 0x46, 0x2d,
    ]);
  });

  it("refuses anything that is not base64 rather than decoding it", () => {
    expect(() => base64ToBytes("not base64!")).toThrow(/not valid base64/);
    expect(() => base64ToBytes("abc")).toThrow();
  });
});

describe("a schema this database has not reached", () => {
  it("is read from the codes PostgREST and Postgres actually send", () => {
    for (const code of ["PGRST205", "PGRST204", "42P01", "42703"]) {
      expect(isSchemaAbsent({ code })).toBe(true);
    }
    expect(isSchemaAbsent({ code: "42501" })).toBe(false);
    expect(isSchemaAbsent(null)).toBe(false);
  });
});

describe("the envelope", () => {
  const input: BuilderPartnerEnvelopeInput = {
    agreementId: "0b7f4c1e-5d2a-4e8b-9c3f-1a2b3c4d5e6f",
    builderOrganisationId: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
    reference: "AUR-BPA-20260928-ABCDEF",
    partnerLegalName: "Example Homes Pty Ltd",
    terms: { name: "Builder Partner Agreement (v1).pdf", extension: "pdf", base64: "VEVSTVM=" },
    schedule: { name: "Execution Schedule AUR-BPA-20260928-ABCDEF.pdf", base64: "U0NIRUQ=" },
    signer: { name: "Sam Builder", email: "sam@examplehomes.test", title: "Director" },
    countersigner: null,
    carbonCopy: { name: "Aurixa Operations", email: "ops@aurixa.test" },
    correctionContact: "partners@aurixa.test",
  };

  it("carries the terms first and the schedule second, traced back three ways", () => {
    const envelope = buildBuilderPartnerEnvelopeDefinition(input) as {
      documents: Array<{ documentId: string; fileExtension: string; documentBase64: string }>;
      customFields: { textCustomFields: Array<{ name: string; value: string }> };
      emailBlurb: string;
      status: string;
    };
    expect(envelope.documents.map((d) => [d.documentId, d.fileExtension])).toEqual([
      ["1", "pdf"],
      ["2", "pdf"],
    ]);
    expect(envelope.documents[0].documentBase64).toBe("VEVSTVM=");
    const fields = Object.fromEntries(
      envelope.customFields.textCustomFields.map((f) => [f.name, f.value]),
    );
    expect(fields[AGREEMENT_ID_CUSTOM_FIELD]).toBe(input.agreementId);
    expect(fields[OFFER_REFERENCE_CUSTOM_FIELD]).toBe(input.reference);
    expect(fields[BUILDER_ORGANISATION_CUSTOM_FIELD]).toBe(input.builderOrganisationId);
    expect(envelope.emailBlurb).toContain("partners@aurixa.test");
    expect(envelope.status).toBe("sent");
  });

  it("places strict tabs, and asks for a title only when none is printed", () => {
    type Recip = {
      signers: Array<{ tabs: Record<string, Array<Record<string, string>>> }>;
      carbonCopies?: unknown[];
    };
    const titled = buildBuilderPartnerEnvelopeDefinition(input).recipients as Recip;
    expect(titled.signers).toHaveLength(1);
    expect(titled.carbonCopies).toHaveLength(1);
    expect(titled.signers[0].tabs.titleTabs).toBeUndefined();
    for (const tabs of Object.values(titled.signers[0].tabs)) {
      for (const tab of tabs) expect(tab.anchorIgnoreIfNotPresent).toBe("false");
    }
    expect(titled.signers[0].tabs.signHereTabs[0].anchorString).toBe(
      BUILDER_PARTNER_ANCHORS.partnerSignature,
    );

    const untitled = buildBuilderPartnerEnvelopeDefinition({
      ...input,
      signer: { ...input.signer, title: null },
    }).recipients as Recip;
    expect(untitled.signers[0].tabs.titleTabs[0].anchorString).toBe(
      BUILDER_PARTNER_ANCHORS.partnerTitle,
    );
  });

  it("routes Aurixa's countersignature after the partner's, in place of a copy", () => {
    const recipients = buildBuilderPartnerEnvelopeDefinition({
      ...input,
      countersigner: { name: "Aurixa Director", email: "director@aurixa.test" },
    }).recipients as {
      signers: Array<{ routingOrder: string; email: string }>;
      carbonCopies?: unknown;
    };
    expect(recipients.signers.map((s) => [s.routingOrder, s.email])).toEqual([
      ["1", "sam@examplehomes.test"],
      ["2", "director@aurixa.test"],
    ]);
    expect(recipients.carbonCopies).toBeUndefined();
  });

  it("names the partner in its title", () => {
    expect(builderPartnerTitle(" Example  Homes ")).toBe(
      "Aurixa Systems Builder Partner Agreement — Example Homes",
    );
    expect(builderPartnerTitle("")).toMatch(/— Builder Partner$/);
  });
});

describe("the access gate", () => {
  it("is satisfied by a signature, whatever terms are in force", () => {
    const signed = agreement({ status: "signed", signedAt: "2026-09-28T03:00:00.000Z" });
    for (const termsInForce of [true, false]) {
      expect(decideBuilderAccessGate({ termsInForce, agreements: [signed] })).toMatchObject({
        allow: true,
        basis: "signed",
      });
    }
  });

  it("is not enforced while no terms are in force", () => {
    expect(decideBuilderAccessGate({ termsInForce: false, agreements: [agreement()] })).toEqual({
      allow: true,
      basis: "not_enforced",
    });
  });

  it("names the agreement in flight, and never counts it", () => {
    const sent = agreement({ id: "sent", status: "sent" });
    const decision = decideBuilderAccessGate({ termsInForce: true, agreements: [sent] });
    expect(decision).toMatchObject({ allow: false, reason: "agreement_in_flight" });
    if (!decision.allow) expect(decision.openAgreement?.id).toBe("sent");
  });

  it("asks for an agreement when there is none, declined and voided ones included", () => {
    const ended = [agreement({ status: "declined" }), agreement({ id: "v", status: "voided" })];
    expect(decideBuilderAccessGate({ termsInForce: true, agreements: ended })).toMatchObject({
      allow: false,
      reason: "agreement_required",
      openAgreement: null,
    });
  });

  it("accepts a waiver only in words", () => {
    expect(
      decideBuilderAccessGate({ termsInForce: true, agreements: [], waiverReason: "  ok  " }),
    ).toMatchObject({ allow: false, reason: "waiver_reason_too_short" });
    const reason = "Signed   on paper\nat the meeting";
    expect(reason.replace(/\s+/g, " ").length).toBeGreaterThanOrEqual(WAIVER_REASON_MIN);
    expect(
      decideBuilderAccessGate({
        termsInForce: true,
        agreements: [agreement()],
        waiverReason: reason,
      }),
    ).toEqual({ allow: true, basis: "waived", waiverReason: "Signed on paper at the meeting" });
  });

  it("writes the basis down for the network's log", () => {
    const signed = agreement({ status: "signed", signedAt: "2026-09-28T03:00:00.000Z" });
    expect(approvalBasisReason({ allow: true, basis: "signed", agreement: signed })).toBe(
      "Builder Partner Agreement AUR-BPA-20260928-ABCDEF signed 2026-09-28 (Mission Control agreement a1).",
    );
    expect(
      approvalBasisReason({ allow: true, basis: "waived", waiverReason: "Paper copy held" }),
    ).toBe("Approved without a signed Builder Partner Agreement: Paper copy held");
    expect(approvalBasisReason({ allow: true, basis: "not_enforced" })).toMatch(/No Builder/);
  });
});

describe("an organisation's standing on the console", () => {
  it("leads with the signature and keeps a re-papering beside it", () => {
    const signed = agreement({ id: "s", status: "signed", signedAt: "2026-09-01T00:00:00Z" });
    const redo = agreement({ id: "r", status: "draft", createdAt: "2026-09-27T00:00:00Z" });
    expect(organisationAgreementState([redo, signed])).toEqual({
      kind: "signed",
      agreement: signed,
      inFlight: redo,
    });
  });

  it("says what ended rather than reading it as never sent", () => {
    const declined = agreement({ status: "declined", createdAt: "2026-09-20T00:00:00Z" });
    const voided = agreement({ id: "v", status: "voided", createdAt: "2026-09-10T00:00:00Z" });
    expect(organisationAgreementState([voided, declined])).toEqual({
      kind: "none",
      lastEnded: declined,
    });
    expect(organisationAgreementState([])).toEqual({ kind: "none", lastEnded: null });
  });

  it("reads a row's columns into the summary", () => {
    expect(
      toAgreementSummary({
        id: "x",
        status: "sent",
        offer_reference: "R",
        docusign_signed_at: null,
        created_at: "2026-09-28T00:00:00Z",
        signed_record_path: null,
        portal_access_status: null,
        grant_access_on_signature: null,
      }).grantAccessOnSignature,
    ).toBe(false);
  });
});

describe("granting access", () => {
  const now = Date.parse("2026-09-28T05:00:00.000Z");
  const ready: GrantFacts = {
    document_kind: "builder_partner",
    status: "signed",
    builder_organisation_id: "org",
    grant_access_on_signature: true,
    portal_access_status: null,
    portal_access_attempted_at: null,
    signed_record_path: "builder-partner/a/e-signed.pdf",
  };
  const auto = (over: Partial<GrantFacts>) =>
    decideGrantAttempt({ ...ready, ...over }, now, { manual: false });
  const manual = (over: Partial<GrantFacts>) =>
    decideGrantAttempt({ ...ready, ...over }, now, { manual: true });

  it("goes ahead automatically only when armed, signed and retained", () => {
    expect(auto({})).toEqual({ action: "grant" });
    expect(auto({ grant_access_on_signature: false })).toMatchObject({ reason: "not_armed" });
    expect(auto({ status: "delivered" })).toMatchObject({ reason: "not_signed" });
    expect(auto({ signed_record_path: null })).toMatchObject({ reason: "not_retained" });
    expect(auto({ document_kind: "subscription" })).toMatchObject({
      reason: "not_builder_partner",
    });
    expect(auto({ builder_organisation_id: null })).toMatchObject({ reason: "no_organisation" });
  });

  it("never re-decides a refusal by itself", () => {
    expect(auto({ portal_access_status: "refused" })).toMatchObject({
      reason: "refused_needs_person",
    });
    expect(manual({ portal_access_status: "refused" })).toEqual({ action: "grant" });
    expect(auto({ portal_access_status: "failed" })).toEqual({ action: "grant" });
  });

  it("lets an admin decide on the signature alone", () => {
    expect(manual({ grant_access_on_signature: false, signed_record_path: null })).toEqual({
      action: "grant",
    });
    expect(manual({ status: "sent" })).toMatchObject({ reason: "not_signed" });
  });

  it("does not start twice, and takes over an attempt that died", () => {
    expect(manual({ portal_access_status: "granted" })).toMatchObject({
      reason: "already_granted",
    });
    const recent = new Date(now - 60_000).toISOString();
    expect(
      auto({ portal_access_status: "pending", portal_access_attempted_at: recent }),
    ).toMatchObject({ reason: "in_flight" });
    const stale = new Date(now - STALE_GRANT_ATTEMPT_MS - 1).toISOString();
    expect(auto({ portal_access_status: "pending", portal_access_attempted_at: stale })).toEqual({
      action: "grant",
    });
  });

  it("tells the network's refusals from our own failures", () => {
    expect(classifyApproveResult({ ok: true, body: { already_active: true } })).toEqual({
      kind: "granted",
      alreadyActive: true,
    });
    expect(
      classifyApproveResult({ ok: false, error: "a_closed_organisation_is_terminal" }),
    ).toEqual({ kind: "refused", code: "a_closed_organisation_is_terminal" });
    expect(classifyApproveResult({ ok: false, error: "network_unreachable" })).toEqual({
      kind: "failed",
      code: "network_unreachable",
    });
  });

  it("describes every answer as a sentence", () => {
    for (const code of [
      "organisation_not_found",
      "a_closed_organisation_is_terminal",
      "not_approvable_from_current_status",
      "operate_switch_off",
      "signing_key_missing",
      "network_url_unconfigured",
      "network_unreachable",
      "http_502",
    ]) {
      expect(describeApprovalCode(code)).toMatch(/\.$/);
    }
  });

  it("carries the agreement and who decided to the network's log", () => {
    const signed = agreement({ status: "signed", signedAt: "2026-09-28T03:00:00.000Z" });
    expect(grantApprovalReason(signed, "manual")).toMatch(/granted by an admin from the agreement/);
    expect(grantApprovalReason(signed, "signature")).toMatch(/on signature, as armed/);
  });

  it("announces what nobody watched, and not every retry", () => {
    const announce = (
      outcome: "granted" | "refused" | "failed",
      trigger: "signature" | "sweep" | "manual",
      previousStatus: string | null,
    ) => announcesGrantOutcome({ outcome, trigger, previousStatus });
    expect(announce("granted", "sweep", "failed")).toBe(true);
    expect(announce("failed", "manual", null)).toBe(false);
    expect(announce("refused", "sweep", "failed")).toBe(true);
    expect(announce("failed", "signature", null)).toBe(true);
    expect(announce("failed", "sweep", null)).toBe(true);
    expect(announce("failed", "sweep", "failed")).toBe(false);
  });
});

describe("a builder is admitted, never provisioned", () => {
  it("refuses to provision a clone from a Builder Partner Agreement, armed or not", () => {
    const decision = decideProvisionOnSignature({
      status: "signed",
      provision_on_signature: true,
      provision_status: "armed",
      document_kind: "builder_partner",
    } as never);
    expect(decision).toMatchObject({ action: "skip", reason: "builder_partner_never_provisions" });
  });
});

describe("the issued snapshot", () => {
  it("reads back only a complete Builder Partner snapshot", () => {
    const snapshot = {
      schema: 1,
      kind: "builder_partner",
      reference: "AUR-BPA-20260928-ABCDEF",
      issuedAt: "2026-09-28T01:00:00.000Z",
      issuingDay: "2026-09-28",
      builderOrganisationId: "org",
      particulars: normaliseParticulars(particulars()),
      terms: {
        templateId: "t1",
        name: "Terms",
        versionLabel: "v1",
        fileName: "terms.pdf",
        mediaType: "application/pdf",
        sha256: "c".repeat(64),
        bytes: 10,
        pageCount: 2,
        countersignatureRequired: false,
        executionStatement: "Executed as an agreement by the parties.",
        documentName: "Terms (v1).pdf",
      },
      schedule: {
        name: "Execution Schedule",
        sha256: "d".repeat(64),
        bytes: 20,
        layoutVersion: 1,
        pageCount: 1,
        base64: "U0NIRUQ=",
      },
      signer: { name: "Sam Builder", email: "sam@examplehomes.test", title: "Director" },
      countersigner: null,
      carbonCopy: null,
      grantAccessOnSignature: true,
    };
    expect(readBuilderPartnerSnapshot(snapshot)).toEqual(snapshot);
    expect(readBuilderPartnerSnapshot({ ...snapshot, kind: "subscription" })).toBeNull();
    expect(readBuilderPartnerSnapshot({ ...snapshot, schedule: undefined })).toBeNull();
  });
});
