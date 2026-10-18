import { useQuery } from "@tanstack/react-query";
import { getPrimePosture } from "@/lib/codex-findings.functions";

/**
 * Prime's security posture summary, cached and shared across the app. Powers
 * the sidebar severity dot on "Security Overview" so it stays in lock-step
 * with the overview without duplicate fetches.
 *
 * Prime only: clones are no longer scanned (src/lib/codex-scan-policy.ts) —
 * they receive Prime's fixes through the cascade, so Prime's open findings are
 * the fleet's.
 */
export function useFleetSecurityBadge() {
  const primeQ = useQuery({
    queryKey: ["codex-prime-posture"],
    queryFn: () => getPrimePosture(),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
  const prime = ((primeQ.data?.posture as any)?.open_findings ?? {}) as Record<string, number>;
  const totals = {
    critical: prime.critical ?? 0,
    high: prime.high ?? 0,
    medium: prime.medium ?? 0,
    low: prime.low ?? 0,
    info: prime.info ?? 0,
  };
  return { isLoading: primeQ.isLoading, totals, prime: totals };
}
