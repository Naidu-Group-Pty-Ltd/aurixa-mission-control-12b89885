// How much to trust a plan - from what can be measured, never from the model's
// own opinion of itself (the rule computeConfidence in fit-analysis follows).
//
// The one strong signal is whether the citations are real: a quote that
// appears verbatim in the document it names is evidence; one that does not is
// a model paraphrasing, or inventing. PDFs are read by the model directly and
// their text is not held here, so their citations are counted as asserted
// rather than verified - honest about what was checked.
import type { BusinessProfile, Citation, KbPartDraft, PlanConfidence, ValidationIssue } from "./schemas.pure.ts";

export interface CitationCheck {
  total: number;
  verified: number;
  asserted: number;
  unverified: Citation[];
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/**
 * @param sources extracted text by docId; a docId absent here (a PDF, which
 *   the model read natively) makes its citations `asserted`.
 */
export function checkCitations(citations: Citation[], sources: Record<string, string>): CitationCheck {
  const normalised = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, norm(v)]));
  const out: CitationCheck = { total: 0, verified: 0, asserted: 0, unverified: [] };
  for (const c of citations) {
    out.total++;
    const text = normalised[c.docId];
    if (text === undefined) {
      out.asserted++;
      continue;
    }
    const q = norm(c.quote);
    if (q.length >= 8 && text.includes(q)) out.verified++;
    else out.unverified.push(c);
  }
  return out;
}

export function collectCitations(profile: BusinessProfile, kb: KbPartDraft[]): Citation[] {
  return [
    ...profile.services.flatMap((s) => s.citations),
    ...profile.systems.flatMap((s) => s.citations),
    ...kb.flatMap((p) => p.blocks.flatMap((b) => b.citations)),
  ];
}

export function computePlanConfidence(input: {
  citations: CitationCheck;
  gapCount: number;
  issues: ValidationIssue[];
  openItemCount: number;
}): PlanConfidence {
  const reasons: string[] = [];
  let score = 100;
  const checkable = input.citations.total - input.citations.asserted;
  if (checkable > 0) {
    const ratio = input.citations.verified / checkable;
    score -= Math.round((1 - ratio) * 40);
    reasons.push(`${input.citations.verified} of ${checkable} checkable citations found verbatim in their source`);
  } else {
    score -= 15;
    reasons.push("No citation could be checked against extracted text");
  }
  if (input.citations.asserted) reasons.push(`${input.citations.asserted} citations point at PDFs and are model-asserted`);
  const errors = input.issues.filter((i) => i.severity === "error").length;
  const warnings = input.issues.length - errors;
  score -= Math.min(30, errors * 10);
  score -= Math.min(10, warnings * 2);
  score -= Math.min(15, input.gapCount * 3);
  score -= Math.min(10, input.openItemCount * 2);
  if (errors) reasons.push(`${errors} validation error${errors === 1 ? "" : "s"}`);
  if (input.gapCount) reasons.push(`${input.gapCount} question${input.gapCount === 1 ? "" : "s"} the documents did not answer`);
  if (input.openItemCount) reasons.push(`${input.openItemCount} open item${input.openItemCount === 1 ? "" : "s"}`);
  score = Math.max(0, Math.min(100, score));
  const band = errors ? "low" : score >= 75 ? "high" : score >= 50 ? "medium" : "low";
  return { score, band, reasons };
}
