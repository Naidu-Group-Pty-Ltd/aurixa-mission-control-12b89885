/**
 * A warmup schedule's fields — the ramp, the reply and mark-important rates,
 * the window — shared by the enrol and edit dialogs. Controlled: the parent
 * holds the schedule and validates it with `scheduleProblems`.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SCHEDULE_LIMITS,
  dailyTarget,
  describeRamp,
  type WarmupSchedule,
} from "@/lib/email/warmupPlan.pure";

const ZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Adelaide",
  "Australia/Hobart",
  "Australia/Darwin",
  "Australia/Perth",
  "Pacific/Auckland",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "UTC",
];

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) => onChange(Math.round(Number(event.target.value)))}
      />
      {hint ? <p className="font-mono text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function ScheduleFields({
  value,
  onChange,
  idPrefix,
}: {
  value: WarmupSchedule;
  onChange: (next: WarmupSchedule) => void;
  idPrefix: string;
}) {
  const set =
    <K extends keyof WarmupSchedule>(key: K) =>
    (next: WarmupSchedule[K]) =>
      onChange({ ...value, [key]: next });
  const zones = ZONES.includes(value.timezone) ? ZONES : [value.timezone, ...ZONES];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField
          id={`${idPrefix}-start`}
          label="Start at"
          hint="new conversations on day one"
          value={value.startPerDay}
          {...SCHEDULE_LIMITS.startPerDay}
          onChange={set("startPerDay")}
        />
        <NumberField
          id={`${idPrefix}-increase`}
          label="Add each day"
          hint="per day it actually warms"
          value={value.increasePerDay}
          {...SCHEDULE_LIMITS.increasePerDay}
          onChange={set("increasePerDay")}
        />
        <NumberField
          id={`${idPrefix}-max`}
          label="Daily maximum"
          hint="30–40 is plenty for most"
          value={value.maxPerDay}
          {...SCHEDULE_LIMITS.maxPerDay}
          onChange={set("maxPerDay")}
        />
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">
        {describeRamp(value)} · day 7: {dailyTarget(value, 7)}, day 14: {dailyTarget(value, 14)}.
        Replies are on top of this.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          id={`${idPrefix}-reply`}
          label="Reply rate (%)"
          hint="share of warmup mail this mailbox answers"
          value={value.replyRate}
          {...SCHEDULE_LIMITS.replyRate}
          onChange={set("replyRate")}
        />
        <NumberField
          id={`${idPrefix}-important`}
          label="Mark important (%)"
          hint="share it flags — Outlook's “important”"
          value={value.importantRate}
          {...SCHEDULE_LIMITS.importantRate}
          onChange={set("importantRate")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-from`}>Send from</Label>
          <Input
            id={`${idPrefix}-from`}
            type="time"
            value={value.windowStart}
            onChange={(event) => set("windowStart")(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-to`}>Until</Label>
          <Input
            id={`${idPrefix}-to`}
            type="time"
            value={value.windowEnd}
            onChange={(event) => set("windowEnd")(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-zone`}>Time zone</Label>
          <Select value={value.timezone} onValueChange={set("timezone")}>
            <SelectTrigger id={`${idPrefix}-zone`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className="flex items-center justify-between gap-3 text-sm">
        <span>
          Weekdays only
          <span className="block font-mono text-[10px] text-muted-foreground">
            nothing sent on Saturday or Sunday in this zone
          </span>
        </span>
        <Switch checked={value.weekdaysOnly} onCheckedChange={set("weekdaysOnly")} />
      </label>
    </div>
  );
}
