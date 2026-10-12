/**
 * Choosing which mailbox in the Microsoft tenant a campaign sends from.
 *
 * The list comes from the tenant's directory, each entry marked with whether
 * this application may actually use it — read from Exchange, not assumed. A
 * mailbox an access policy excludes is shown and disabled, with the reason,
 * because "it is not in the list" is a worse answer than "it is blocked, and
 * here is why". One that has not been checked yet is checked when chosen.
 *
 * When the directory cannot be listed (the application holds no directory
 * permission), the picker still offers every mailbox this deployment already
 * uses, and any address can be typed and checked.
 *
 * The value is the address, or "" for the deployment's default — kept as
 * "default" rather than pinned to today's address, so a change to
 * MICROSOFT_MAILBOX_EMAIL carries the campaign with it.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ChevronsUpDown, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { mayChoose, type MailboxAccess, type MailboxOption } from "@/lib/email/mailboxes.pure";
import { listMailboxes, verifyMailbox } from "@/lib/email-campaigns.functions";

const QUERY_KEY = ["email", "mailboxes"] as const;

function AccessBadge({ access }: { access: MailboxAccess | null }) {
  const state = access?.state ?? "unchecked";
  const label =
    state === "reachable"
      ? "can send"
      : state === "denied"
        ? "blocked"
        : state === "no_mailbox"
          ? "no mailbox"
          : state === "unknown"
            ? "not answered"
            : state === "unverifiable"
              ? "can't check"
              : "unchecked";
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 font-mono text-[10px]",
        state === "reachable" && "text-success",
        (state === "denied" || state === "no_mailbox") && "text-destructive",
        (state === "unknown" || state === "unverifiable") && "text-warning",
      )}
    >
      {label}
    </Badge>
  );
}

function optionLabel(option: { address: string; displayName: string | null }): string {
  return option.displayName ? `${option.displayName} <${option.address}>` : option.address;
}

export function MailboxPicker({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string;
  onChange: (address: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");

  const directory = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => listMailboxes({ data: {} }),
    staleTime: 60_000,
  });

  const refresh = useMutation({
    mutationFn: () => listMailboxes({ data: { refresh: true } }),
    onSuccess: (data) => qc.setQueryData(QUERY_KEY, data),
    onError: (error: Error) =>
      toast.error("Could not read the tenant's mailboxes", { description: error.message }),
  });

  const verify = useMutation({
    mutationFn: (address: string) => verifyMailbox({ data: { address } }),
    onSuccess: (result) => {
      // Fold the answer into the list so it is not asked again.
      qc.setQueryData(QUERY_KEY, (current: typeof directory.data) => {
        if (!current) return current;
        const known = current.options.some((option) => option.address === result.address);
        const options: MailboxOption[] = known
          ? current.options.map((option) =>
              option.address === result.address ? { ...option, access: result.access } : option,
            )
          : [
              ...current.options,
              {
                address: result.address,
                displayName: result.displayName,
                isDefault: false,
                sources: ["entered"],
                access: result.access,
              },
            ];
        return { ...current, options };
      });
      if (mayChoose(result.access)) {
        onChange(result.address);
        setTyped("");
        setOpen(false);
        if (result.access.state === "reachable") toast.success(`${result.address} can be used`);
        else
          toast.warning(`${result.address} chosen, unchecked`, {
            description: result.access.reason ?? undefined,
          });
      } else {
        toast.error(`${result.address} cannot be used`, {
          description: result.access.reason ?? undefined,
        });
      }
    },
    onError: (error: Error) =>
      toast.error("Could not check that mailbox", { description: error.message }),
  });

  const data = directory.data;
  const options = data?.options ?? [];
  const chosen = value ? value.trim().toLowerCase() : "";
  const selected = chosen ? options.find((option) => option.address === chosen) : null;
  const defaultOption = options.find((option) => option.isDefault) ?? null;

  const choose = (option: MailboxOption) => {
    if (mayChoose(option.access)) {
      onChange(option.address);
      setOpen(false);
      return;
    }
    // Not yet known — ask now, and choose it only if Exchange says yes.
    verify.mutate(option.address);
  };

  const triggerLabel = chosen
    ? selected
      ? optionLabel(selected)
      : chosen
    : data?.defaultMailbox
      ? `Deployment default — ${data.defaultMailbox}`
      : "Choose a mailbox";
  const triggerAccess = chosen ? (selected?.access ?? null) : (defaultOption?.access ?? null);

  if (data && !data.configured) {
    return (
      <Input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Microsoft Graph is not configured"
      />
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between gap-2 font-normal"
        >
          <span className="min-w-0 truncate text-left">{triggerLabel}</span>
          <span className="flex shrink-0 items-center gap-1">
            {directory.isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : (
              <AccessBadge access={triggerAccess} />
            )}
            <ChevronsUpDown className="h-3 w-3 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(32rem,90vw)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search the tenant's mailboxes…" />
          <CommandList className="max-h-72">
            <CommandEmpty>No mailbox matches.</CommandEmpty>
            {defaultOption && (
              <CommandGroup heading="Deployment default (MICROSOFT_MAILBOX_EMAIL)">
                <CommandItem
                  value={`default ${defaultOption.address} ${defaultOption.displayName ?? ""}`}
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("h-3 w-3", chosen ? "opacity-0" : "opacity-100")} />
                  <span className="min-w-0 flex-1 truncate">{optionLabel(defaultOption)}</span>
                  <AccessBadge access={defaultOption.access} />
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Mailboxes in this tenant">
              {options.map((option) => {
                const blocked =
                  option.access?.state === "denied" || option.access?.state === "no_mailbox";
                return (
                  <CommandItem
                    key={option.address}
                    value={`${option.displayName ?? ""} ${option.address}`}
                    disabled={blocked || verify.isPending}
                    onSelect={() => choose(option)}
                    className="items-start"
                  >
                    <Check
                      className={cn(
                        "mt-0.5 h-3 w-3",
                        chosen === option.address ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{optionLabel(option)}</span>
                      {blocked && option.access?.reason ? (
                        <span className="block font-mono text-[10px] leading-snug text-muted-foreground">
                          {option.access.reason}
                        </span>
                      ) : null}
                    </span>
                    {verify.isPending && verify.variables === option.address ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <AccessBadge access={option.access} />
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>

        <div className="space-y-2 border-t border-border/50 p-3">
          {data?.directory.error ? (
            <p className="flex gap-2 font-mono text-[10px] leading-snug text-muted-foreground">
              <ShieldAlert className="h-3 w-3 shrink-0 text-warning" />
              {data.directory.error}
            </p>
          ) : null}
          {options.find((option) => option.access?.state === "unverifiable")?.access?.reason ? (
            <p className="flex gap-2 font-mono text-[10px] leading-snug text-muted-foreground">
              <ShieldAlert className="h-3 w-3 shrink-0 text-warning" />
              {options.find((option) => option.access?.state === "unverifiable")?.access?.reason}
            </p>
          ) : null}
          {data?.directory.truncated ? (
            <p className="font-mono text-[10px] text-muted-foreground">
              The directory is larger than this list shows — type the address below if yours is
              missing.
            </p>
          ) : null}
          {data && data.unchecked > 0 ? (
            <p className="font-mono text-[10px] text-muted-foreground">
              {data.unchecked.toLocaleString()} mailbox{data.unchecked === 1 ? " is" : "es are"}{" "}
              listed but not checked yet — each is checked when you choose it.
            </p>
          ) : null}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (typed.trim()) verify.mutate(typed.trim());
            }}
          >
            <Input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="Or type any address in the tenant"
              className="h-8 text-xs"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={!typed.trim() || verify.isPending}
            >
              Check
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Re-read the directory and re-check every mailbox"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <RefreshCw className={cn("h-3 w-3", refresh.isPending && "animate-spin")} />
            </Button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
