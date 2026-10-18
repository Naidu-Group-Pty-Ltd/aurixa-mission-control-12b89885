import { useQuery } from "@tanstack/react-query";
import { listCloneCodexOverview } from "@/lib/codex-security.functions";
import { getPrimePosture } from "@/lib/codex-findings.functions";

/**
 * Prime + fleet security posture summary, cached and shared across the app.
 * Powers the sidebar severity dot on "Security Overview" and the dashboard
 * security tile so both surfaces stay in lock-step without duplicate fetches.
 */
export function useFleetSecurityBadge() {
  const q = useQuery({
    queryKey: ["clone-codex-overview"],
    queryFn: () => listCloneCodexOverview(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Prime counts too: its findings reach every clone with the next cascade,
  // and the badge used to read "clean" over a Prime full of criticals.
  const primeQ = useQuery({
    queryKey: ["codex-prime-posture"],
    queryFn: () => getPrimePosture(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const prime = ((primeQ.data?.posture as any)?.open_findings ?? {}) as Record<string, number>;

  const clones = q.data?.clones ?? [];
  const totals = clones.reduce(
    (acc, c) => {
      const f = c.openFindings ?? {};
      acc.critical += f.critical ?? 0;
      acc.high += f.high ?? 0;
      acc.medium += f.medium ?? 0;
      acc.low += f.low ?? 0;
      acc.info += f.info ?? 0;
      return acc;
    },
    {
      critical: prime.critical ?? 0,
      high: prime.high ?? 0,
      medium: prime.medium ?? 0,
      low: prime.low ?? 0,
      info: prime.info ?? 0,
    },
  );
  const hotClones = clones.filter(
    (c) => (c.openFindings?.critical ?? 0) + (c.openFindings?.high ?? 0) > 0,
  ).length;

  return {
    isLoading: q.isLoading,
    totals,
    prime: {
      critical: prime.critical ?? 0,
      high: prime.high ?? 0,
      medium: prime.medium ?? 0,
      low: prime.low ?? 0,
      info: prime.info ?? 0,
    },
    hotClones,
    fleetSize: clones.length,
  };
}
