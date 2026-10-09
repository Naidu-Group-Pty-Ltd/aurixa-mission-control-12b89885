// The drill-down state of an advertising channel: which level is shown, which
// campaign or ad group it is narrowed to, and the breadcrumb back.
import { useCallback, useMemo, useState } from "react";
import type { EntityRow } from "@/lib/marketing/marketingEngine";

export type AdLevel = "campaign" | "adgroup" | "ad";

export interface Crumb {
  level: AdLevel;
  label: string;
}

export interface Drill {
  campaignId: string | null;
  adGroupId: string | null;
}

export function useAdDrill(adGroupWord: string) {
  const all = useMemo<Record<AdLevel, string>>(
    () => ({ campaign: "Campaigns", adgroup: `All ${adGroupWord.toLowerCase()}s`, ad: "All ads" }),
    [adGroupWord],
  );
  const [level, setLevel] = useState<AdLevel>("campaign");
  const [drill, setDrill] = useState<Drill>({ campaignId: null, adGroupId: null });
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ level: "campaign", label: "Campaigns" }]);

  const onDrill = useCallback(
    (row: EntityRow) => {
      if (level === "campaign") {
        setDrill({ campaignId: row.id, adGroupId: null });
        setLevel("adgroup");
        setCrumbs((c) => [...c, { level: "adgroup", label: row.name }]);
      } else if (level === "adgroup") {
        setDrill((d) => ({ campaignId: d.campaignId ?? row.parentId, adGroupId: row.id }));
        setLevel("ad");
        setCrumbs((c) => [...c, { level: "ad", label: row.name }]);
      }
    },
    [level],
  );

  const onCrumb = useCallback(
    (index: number) => {
      const next = crumbs.slice(0, index + 1);
      const target = next[next.length - 1];
      if (!target) return;
      setCrumbs(next);
      setLevel(target.level);
      if (index === 0) setDrill({ campaignId: null, adGroupId: null });
      else if (target.level === "adgroup")
        setDrill((d) => ({ campaignId: d.campaignId, adGroupId: null }));
    },
    [crumbs],
  );

  const onLevel = useCallback(
    (next: AdLevel) => {
      setLevel(next);
      setDrill({ campaignId: null, adGroupId: null });
      setCrumbs(
        next === "campaign"
          ? [{ level: "campaign", label: all.campaign }]
          : [
              { level: "campaign", label: all.campaign },
              { level: next, label: all[next] },
            ],
      );
    },
    [all],
  );

  return { level, drill, crumbs, onDrill, onCrumb, onLevel };
}
