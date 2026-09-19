// Reading what this deployment can actually do, for the page that is about to
// spend it.
//
// Split from `provisioning-readiness-panel.tsx` because a module that exports
// a hook beside its components breaks React Fast Refresh — the components
// remount on every edit instead of preserving state, which on an eight-section
// wizard means losing a half-filled form. `react-refresh/only-export-components`
// is the lint rule that says so.
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { fetchReadiness, type ReadinessReport } from "@/lib/readiness.functions";

type Capability = ReadinessReport["capabilities"][number];

export type ProvisioningReadiness = {
  report: ReadinessReport | null;
  /** Verdict for one capability key, or null while unread. */
  verdictFor: (key: string) => Capability["verdict"] | null;
  loading: boolean;
};

/**
 * Read readiness once for the page.
 *
 * Exposed as a hook so the wizard's own sections can render the LIVE answer
 * ("Cloudflare is not configured — this subdomain will be recorded and stay
 * dormant") instead of the conditional hypothetical they carried, without
 * every section firing its own request.
 */
export function useProvisioningReadiness(): ProvisioningReadiness & { reload: () => void } {
  const fetchFn = useServerFn(fetchReadiness);
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      setReport(await fetchFn({ data: {} } as never));
    } catch {
      // A failed read is NOT a deployment with nothing configured. Leaving the
      // report null renders "could not check", which is a third answer and the
      // honest one — reporting it as unconfigured would send an operator to
      // Settings to fix something that is not broken.
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    report,
    loading,
    reload: () => void load(),
    verdictFor: (key: string) => report?.capabilities.find((c) => c.key === key)?.verdict ?? null,
  };
}
