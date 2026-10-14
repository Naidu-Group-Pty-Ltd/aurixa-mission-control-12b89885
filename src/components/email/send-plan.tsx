/**
 * What a campaign's sending times will do with its list.
 *
 * Four answers an operator otherwise works out on paper: how much one sending
 * time, one day and one week carry; what each of the next sending times will
 * send, and to which segments; when each segment and the list run out; and
 * what the last few sending times actually sent. The first three are the
 * dispatcher's own rules replayed (`forecastSlots`), so they are the EARLIEST
 * the list can finish — quotas, throttling and a stalled scheduler only make
 * it later, and the panel says so. The last is read from the ledger.
 */
import { formatDistanceToNow } from "date-fns";
import { CalendarClock, History } from "lucide-react";
import { MetricCell } from "@/components/metric-bar";
import { RecordRow } from "@/components/record-row";
import { formatInZone } from "@/lib/email/campaignRules.pure";
import type { Throughput } from "@/lib/email/segments.pure";
import { useCampaignPlan } from "@/hooks/use-campaign-plan";

const count = (n: number) => n.toLocaleString("en-AU");

function throughput(value: Throughput): { value: string; note: string } {
  if (value.contacts == null) return { value: "no limit", note: "nothing caps it" };
  return {
    value: count(value.contacts),
    note:
      value.messages == null
        ? "contacts"
        : `contacts · ${count(value.messages)} message${value.messages === 1 ? "" : "s"}`,
  };
}

export function SendPlan({ campaignId }: { campaignId: string }) {
  const plan = useCampaignPlan(campaignId);
  const data = plan.data;
  if (!data) return null;

  if (data.mode === "window" || !data.capacity || !data.forecast) {
    return (
      <div className="glass-inset flex items-start gap-3 px-4 py-3">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Sending across a window, the pace is the gap between messages and the daily caps. Choose{" "}
          <span className="text-foreground">At set times</span> above for a plan of what each
          sending time carries and when the list runs out.
        </p>
      </div>
    );
  }

  const { capacity, forecast, timezone } = data;
  const slot = throughput(capacity.perSlot);
  const day = throughput(capacity.perDay);
  const week = throughput(capacity.perWeek);
  const when = (iso: string) => formatInZone(new Date(iso), timezone);

  // With segments, the plan covers what the enabled segments hold; anybody
  // outside them is held, and the sentence must not promise them a date.
  const planned = forecast.segments.length
    ? forecast.segments.reduce((sum, segment) => sum + segment.pending, 0)
    : data.pending;
  const held = data.outside?.pending ?? 0;
  const heldNote =
    held > 0 ? ` ${count(held)} more are outside every enabled segment and are not planned.` : "";

  const finish =
    forecast.outcome === "finishes" && forecast.finishesAt ? (
      <>
        At this pace the last of the {count(planned)} waiting contacts goes in the{" "}
        <span className="text-foreground">{when(forecast.finishesAt)}</span> sending time (
        {formatDistanceToNow(new Date(forecast.finishesAt), { addSuffix: true })}). That is the
        earliest it can: per-parameter quotas, a throttled mailbox or a stalled scheduler only make
        it later.{heldNote}
      </>
    ) : forecast.outcome === "nothing_waiting" ? (
      <>Nothing in an enabled segment is waiting.{heldNote}</>
    ) : forecast.outcome === "calendar_ends" ? (
      <>
        The campaign&apos;s end date comes before the list runs out — some waiting contacts will not
        be sent.{heldNote}
      </>
    ) : (
      <>At this pace the list outlasts a year of sending times.{heldNote}</>
    );

  return (
    <div className="space-y-4">
      <div className="glass overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <MetricCell label="each sending time" value={slot.value} note={slot.note} />
          <MetricCell
            label="each day"
            value={day.value}
            note={`${capacity.slotsPerDay} sending time${capacity.slotsPerDay === 1 ? "" : "s"} · ${day.note}`}
          />
          <MetricCell
            label="each week"
            value={week.value}
            note={`${capacity.sendDaysPerWeek} day${capacity.sendDaysPerWeek === 1 ? "" : "s"} · ${week.note}`}
          />
          <MetricCell label="waiting" value={count(data.pending)} note="contacts" />
        </div>
        <p className="border-t border-border/50 px-5 py-3 text-sm text-muted-foreground">
          {finish}
        </p>
      </div>

      {forecast.segments.length > 0 && (
        <div className="glass space-y-2 p-5">
          <p className="label-mono">when each segment runs out</p>
          {forecast.segments.map((segment) => (
            <RecordRow
              key={segment.id}
              spine={segment.pending === 0 ? "idle" : segment.finishesAt ? "ok" : "warn"}
              className="flex items-center gap-3 px-4 py-2"
            >
              <span className="w-28 truncate text-sm font-medium">{segment.label}</span>
              <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
                {segment.pending === 0
                  ? "nothing waiting"
                  : `${count(segment.pending)} waiting · ${count(segment.messages)} message${segment.messages === 1 ? "" : "s"}`}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {segment.finishesAt
                  ? `last ${when(segment.finishesAt)}`
                  : segment.pending
                    ? "—"
                    : ""}
              </span>
            </RecordRow>
          ))}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass space-y-2 p-5">
          <p className="label-mono">next sending times</p>
          {forecast.upcoming.length === 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              Nothing is planned — no contact in an enabled segment is waiting, or the calendar does
              not open again.
            </p>
          ) : (
            forecast.upcoming.map((slotPlan) => (
              <RecordRow key={slotPlan.at} spine="live" className="px-4 py-2">
                <p className="text-sm">
                  {when(slotPlan.at)}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    · {count(slotPlan.messages)} message{slotPlan.messages === 1 ? "" : "s"},{" "}
                    {count(slotPlan.contacts)} contacts
                  </span>
                </p>
                {slotPlan.segments.length > 0 && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {slotPlan.segments.join(", ")}
                  </p>
                )}
              </RecordRow>
            ))
          )}
        </div>

        <div className="glass space-y-2 p-5">
          <p className="label-mono flex items-center gap-2">
            <History className="h-3 w-3" /> what recent sending times sent
          </p>
          {data.history.length === 0 ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              None yet — the campaign has not been running over a sending time in the last three
              days.
            </p>
          ) : (
            data.history.map((entry) => (
              <RecordRow
                key={entry.at}
                spine={
                  entry.open
                    ? "live"
                    : entry.refused > 0 || entry.unconfirmed > 0
                      ? "warn"
                      : entry.messages > 0
                        ? "ok"
                        : "idle"
                }
                className="px-4 py-2"
              >
                <p className="text-sm">
                  {when(entry.at)}{" "}
                  <span className="font-mono text-xs text-muted-foreground">
                    ·{" "}
                    {entry.messages > 0
                      ? `${count(entry.messages)} message${entry.messages === 1 ? "" : "s"}, ${count(entry.contacts)} contacts`
                      : entry.open
                        ? "open now"
                        : "nothing went — paused, finished, or the scheduler did not reach it"}
                    {entry.unconfirmed > 0 ? ` · ${entry.unconfirmed} unconfirmed` : ""}
                    {entry.refused > 0 ? ` · ${entry.refused} refused` : ""}
                  </span>
                </p>
                {entry.segments.length > 0 && (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {entry.segments.join(", ")}
                  </p>
                )}
              </RecordRow>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
