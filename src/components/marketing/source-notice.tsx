// Why a section is empty — said in place of the section, never as zeros.
//
// A source that is not connected names the fields it still needs and links to
// the Connections tab; one that failed says which of the engine's failure
// words it was, because "credentials refused" and "the vendor is down" send an
// operator to opposite remedies.
import { Link } from "@tanstack/react-router";
import { RecordRow } from "@/components/record-row";
import { SOURCE_ERROR_WORDS } from "@/lib/marketing/labels.pure";
import type { SourceState } from "@/lib/marketing/marketingEngine";

export function SourceNotice({
  source,
  state,
  provides,
  compact,
}: {
  source: string;
  state: SourceState | null | undefined;
  provides?: string;
  compact?: boolean;
}) {
  if (!state || state.state === "ok" || state.state === "not_requested") return null;
  if (state.state === "not_configured") {
    return (
      <RecordRow spine="idle" className="px-4 py-3 text-sm" role="status">
        <p className="font-medium">{source} is not connected</p>
        {provides && !compact && <p className="mt-1 text-muted-foreground">{provides}</p>}
        {state.missing.length > 0 && (
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            Still needed: {state.missing.join(", ")}
          </p>
        )}
        <Link
          to="/marketing/connections"
          className="mt-1 inline-block font-mono text-[11px] uppercase tracking-[0.14em] text-primary"
        >
          Open connections →
        </Link>
      </RecordRow>
    );
  }
  const words = SOURCE_ERROR_WORDS[state.reason] ?? SOURCE_ERROR_WORDS.unknown;
  return (
    <RecordRow spine="warn" className="px-4 py-3 text-sm" role="alert">
      <p className="font-medium">
        {source}: {words.title}
        {state.status ? (
          <span className="ml-2 font-mono text-[11px] text-muted-foreground">
            HTTP {state.status}
          </span>
        ) : null}
      </p>
      <p className="mt-1 text-muted-foreground">{words.remedy}</p>
      {state.message && !compact && (
        <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          The vendor said: “{state.message}”
        </p>
      )}
    </RecordRow>
  );
}
