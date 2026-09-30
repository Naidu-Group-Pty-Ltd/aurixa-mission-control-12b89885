import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { dollarsInputText, parseDollars } from "@/lib/agreements/offerEditor.pure";

/**
 * Dollars in, integer cents out. The operator's text is kept as typed while
 * the field has focus — reformatting "49.5" to "49.50" mid-keystroke fights
 * the cursor — and an amount it cannot read exactly is marked rather than
 * rounded, because the offer prints what it stores.
 */
export function MoneyInput({
  id,
  cents,
  onChange,
  disabled,
  placeholder = "0.00",
  className,
  "aria-describedby": describedBy,
}: {
  id?: string;
  cents: number;
  onChange: (cents: number) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-describedby"?: string;
}) {
  const [text, setText] = useState(() => dollarsInputText(cents));
  const focused = useRef(false);

  // Follow the stored amount whenever it changes from outside the field.
  useEffect(() => {
    if (!focused.current) setText(dollarsInputText(cents));
  }, [cents]);

  const invalid = parseDollars(text) === null;

  return (
    <div className={cn("relative", className)}>
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground"
      >
        $
      </span>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn("pl-6 font-mono tabular-nums", invalid && "border-destructive")}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          const parsed = parseDollars(text);
          if (parsed !== null) setText(dollarsInputText(parsed));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseDollars(e.target.value);
          if (parsed !== null) onChange(parsed);
        }}
      />
    </div>
  );
}
