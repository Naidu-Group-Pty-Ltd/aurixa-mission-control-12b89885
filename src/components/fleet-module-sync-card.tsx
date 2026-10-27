import { useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Boxes, Search, Trash2, Waves, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useClones, useModules, type Module, type Clone } from "@/lib/queries";
import { bulkSyncModuleFn } from "@/server/module-sync.functions";
import { StatusPill } from "@/components/status-pill";

type Mode = "pr" | "auto_merge" | "notify";
type Action = "install" | "remove";

export function FleetModuleSyncCard() {
  const { data: modules, loading: modulesLoading } = useModules();
  const { data: clones, loading: clonesLoading, refresh: refreshClones } = useClones();
  const sync = useServerFn(bulkSyncModuleFn);

  const approvedModules = useMemo(() => modules.filter((m) => m.status === "approved"), [modules]);

  const [moduleId, setModuleId] = useState<string>("");
  const [action, setAction] = useState<Action>("install");
  const [mode, setMode] = useState<Mode>("pr");
  const [cascade, setCascade] = useState(true);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const selectedModule: Module | undefined = useMemo(
    () => approvedModules.find((m) => m.id === moduleId),
    [approvedModules, moduleId],
  );

  const filteredClones = useMemo(() => {
    const needle = q.toLowerCase();
    return clones.filter(
      (c) =>
        !needle ||
        c.name.toLowerCase().includes(needle) ||
        c.tags?.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [clones, q]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(filteredClones.map((c) => c.id)));
  const clearAll = () => setSelected(new Set());

  const onRun = async () => {
    if (!selectedModule) {
      toast.error("Pick a module first");
      return;
    }
    if (selected.size === 0) {
      toast.error("Select at least one clone");
      return;
    }
    setBusy(true);
    try {
      const res = await sync({
        data: {
          moduleId: selectedModule.id,
          cloneIds: Array.from(selected),
          action,
          cascade: action === "install" ? cascade : false,
          cascadeMode: mode,
        },
      });
      if (!res.ok) {
        toast.error(res.error ?? "Module sync failed");
      } else if (res.cascade_event_id) {
        toast.success(
          `${selectedModule.name} ${action === "install" ? "installed" : "removed"} on ${res.affected_clone_ids.length} clone(s) · cascade running`,
          {
            action: {
              label: "View cascade",
              onClick: () => {
                window.location.href = `/cascades/${res.cascade_event_id}`;
              },
            },
          },
        );
      } else {
        toast.success(
          `${selectedModule.name} ${action === "install" ? "installed" : "removed"} on ${res.affected_clone_ids.length} clone(s)`,
        );
      }
      refreshClones();
      setSelected(new Set());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Module sync failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-primary" />
          <CardTitle className="text-base">Fleet module sync</CardTitle>
        </div>
        <CardDescription>
          Install or remove an approved module across many clones at once. An install can fire a
          cascade: a module-scoped clone receives only the module&apos;s files, and a mirror its
          whole tree, as every cascade delivers it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1">
            <Label>Module</Label>
            <Select value={moduleId} onValueChange={setModuleId} disabled={modulesLoading}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    approvedModules.length === 0 ? "No approved modules" : "Pick a module…"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {approvedModules.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <span className="font-mono">{m.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Action</Label>
            <Select value={action} onValueChange={(v) => setAction(v as Action)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="install">
                  <span className="inline-flex items-center gap-1.5">
                    <Boxes className="h-3.5 w-3.5" /> Install
                  </span>
                </SelectItem>
                <SelectItem value="remove">
                  <span className="inline-flex items-center gap-1.5">
                    <Trash2 className="h-3.5 w-3.5" /> Remove
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Cascade mode</Label>
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as Mode)}
              disabled={action === "remove" || !cascade}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pr">PR (open pull request)</SelectItem>
                <SelectItem value="auto_merge">Auto-merge (push to default)</SelectItem>
                <SelectItem value="notify">Notify-only (open issue)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>After install</Label>
            <label className="flex h-9 items-center gap-2 border border-input px-3 text-sm">
              <Checkbox
                checked={cascade}
                onCheckedChange={(v) => setCascade(Boolean(v))}
                disabled={action === "remove"}
              />
              <span className="text-muted-foreground">Trigger scoped cascade</span>
            </label>
          </div>
        </div>

        {selectedModule && (
          <div className="border bg-muted/30 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              file_globs scope
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {(selectedModule.file_globs ?? []).slice(0, 8).map((g) => (
                <code key={g} className="bg-background px-1.5 py-0.5 font-mono text-[11px]">
                  {g}
                </code>
              ))}
              {(selectedModule.file_globs ?? []).length > 8 && (
                <span className="text-[11px] text-muted-foreground">
                  +{(selectedModule.file_globs ?? []).length - 8} more
                </span>
              )}
              {(selectedModule.file_globs ?? []).length === 0 && (
                <span className="font-mono text-[11px] text-warning">
                  No file_globs — cascade will be skipped
                </span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>Target clones</Label>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary" className="font-mono">
                {selected.size} selected
              </Badge>
              <button
                type="button"
                onClick={selectAll}
                className="font-mono text-[11px] uppercase tracking-wider hover:text-foreground"
              >
                select all
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={clearAll}
                className="font-mono text-[11px] uppercase tracking-wider hover:text-foreground"
              >
                clear
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter clones by name or tag…"
              className="pl-9 font-mono text-sm"
            />
          </div>
          <div className="max-h-72 overflow-y-auto border">
            {clonesLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading clones…</div>
            ) : filteredClones.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No clones match.</div>
            ) : (
              <ul className="divide-y divide-border/60">
                {filteredClones.map((c) => (
                  <CloneRow
                    key={c.id}
                    clone={c}
                    checked={selected.has(c.id)}
                    onToggle={() => toggle(c.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button onClick={onRun} disabled={busy || !moduleId || selected.size === 0}>
            {action === "install" ? (
              <Boxes className="mr-2 h-4 w-4" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}
            {busy
              ? "Running…"
              : action === "install"
                ? cascade
                  ? `Install + cascade (${selected.size})`
                  : `Install (${selected.size})`
                : `Remove (${selected.size})`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CloneRow({
  clone,
  checked,
  onToggle,
}: {
  clone: Clone;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40">
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <div className="flex-1 min-w-0">
        <Link
          to="/clones/$cloneId"
          params={{ cloneId: clone.id }}
          className="block truncate text-sm font-medium hover:text-primary"
        >
          {clone.name}
        </Link>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {clone.github_owner}/{clone.github_repo}
        </div>
      </div>
      <StatusPill status={clone.sync_status} behind={clone.commits_behind} />
      {clone.github_url && (
        <a
          href={clone.github_url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </li>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

// Re-export so `Waves` is available if needed elsewhere; not used now.
export { Waves };
