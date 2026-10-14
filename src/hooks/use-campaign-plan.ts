import { useQuery } from "@tanstack/react-query";
import { campaignPlan } from "@/lib/email-campaigns.functions";

/**
 * A campaign's plan — capacity, forecast, per-segment counts, recent sending
 * times. One query key, so the Rules and Segments tabs read one answer.
 */
export function useCampaignPlan(campaignId: string) {
  return useQuery({
    queryKey: ["email", "plan", campaignId],
    queryFn: () => campaignPlan({ data: { id: campaignId } }),
    refetchInterval: 30_000,
  });
}
