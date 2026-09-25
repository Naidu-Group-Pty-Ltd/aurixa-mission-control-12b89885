// /agreements/issuing-profile — Aurixa's standing facts for Subscription
// Agreements: the Schedule E5 service disclosures and contacts, the section
// 03 correction route and documents, the Schedule A4 spend authorities and
// the default payment method.
//
// They are copied into each offer when it is prepared, so every issued offer
// carries the facts it was issued with rather than pointing at a profile that
// may have moved since. Changing the profile changes offers prepared from now
// on; a draft already prepared can take it up from its own page, and an
// issued offer never changes. An administrator edits it — the database holds
// the same rule — because it is printed into everything Aurixa offers.
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, RefreshCw, Save } from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { RouteError } from "@/components/route-error";
import { PageHeaderSkeleton } from "@/components/route-loading";
import { CardRowSkeleton } from "@/components/list-skeletons";
import { EmptyState } from "@/components/empty-state";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { IssuingProfileForm } from "@/components/agreements/issuing-profile-form";
import { getSubscriptionContext, saveIssuingProfile } from "@/lib/agreements.functions";
import { issuingProfileGaps } from "@/lib/agreements/offerEditor.pure";
import { issuingProfileSchema, type IssuingProfile } from "@/lib/agreements/subscriptionOffer.pure";
import { useUserRoles } from "@/lib/use-user-roles";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/agreements/issuing-profile")({
  errorComponent: RouteError,
  component: () => (
    <ProtectedRoute>
      <IssuingProfilePage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Issuing profile — Aurixa Mission Control" }] }),
});

type Context = Awaited<ReturnType<typeof getSubscriptionContext>>;

function IssuingProfilePage() {
  const contextQ = useQuery({
    queryKey: ["agreements", "subscription-context"],
    queryFn: () => getSubscriptionContext(),
    staleTime: 60_000,
  });
  const roles = useUserRoles();

  if (contextQ.isPending || roles.loading) {
    return (
      <div className="space-y-6 p-6">
        <PageHeaderSkeleton />
        <CardRowSkeleton />
        <CardRowSkeleton />
      </div>
    );
  }
  if (contextQ.error) {
    return (
      <div className="space-y-6 p-6">
        <BackLink />
        <EmptyState
          icon={<AlertTriangle />}
          title="The issuing profile could not be loaded"
          description={(contextQ.error as Error).message}
          action={
            <Button variant="outline" onClick={() => void contextQ.refetch()}>
              <RefreshCw className="mr-1.5 h-4 w-4" /> Try again
            </Button>
          }
        />
      </div>
    );
  }
  return <ProfileEditor context={contextQ.data} canEdit={roles.isAdmin} />;
}

function BackLink() {
  return (
    <Link
      to="/agreements"
      className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="mr-1 h-4 w-4" /> Agreements
    </Link>
  );
}

function newer(a: string | null, than: string | null): boolean {
  if (!a) return false;
  if (!than) return true;
  return Date.parse(a) > Date.parse(than);
}

function ProfileEditor({ context, canEdit }: { context: Context; canEdit: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [profile, setProfile] = useState<IssuingProfile>(context.profile);
  const [base, setBase] = useState(() => ({
    json: JSON.stringify(context.profile),
    updatedAt: context.profileUpdatedAt,
  }));
  const dirty = canEdit && JSON.stringify(profile) !== base.json;
  const savedElsewhere = newer(context.profileUpdatedAt, base.updatedAt);

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Saved in another tab, or by another administrator, while this page held
  // nothing unsaved: show what is stored now.
  useEffect(() => {
    if (!savedElsewhere || dirtyRef.current) return;
    setProfile(context.profile);
    setBase({ json: JSON.stringify(context.profile), updatedAt: context.profileUpdatedAt });
  }, [savedElsewhere, context.profile, context.profileUpdatedAt]);

  useBlocker({
    shouldBlockFn: async () => {
      if (!dirtyRef.current) return false;
      const leave = await confirm({
        title: "Leave without saving?",
        description: "The issuing profile has changes that have not been saved.",
        confirmText: "Discard changes",
        cancelText: "Keep editing",
        destructive: true,
      });
      return !leave;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  const saveM = useMutation({
    mutationFn: async () => {
      const parsed = issuingProfileSchema.safeParse(profile);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${issue.path.join(".")}: ${issue.message}`);
      }
      const res = await saveIssuingProfile({ data: { profile: parsed.data } });
      return { res, json: JSON.stringify(profile) };
    },
    onSuccess: ({ res, json }) => {
      setBase({ json, updatedAt: res.updatedAt });
      toast.success("Issuing profile saved", {
        description:
          "Offers prepared from now on carry it. Drafts already prepared can take it up from their own page.",
      });
      void qc.invalidateQueries({ queryKey: ["agreements", "subscription-context"] });
    },
    onError: (err: Error) =>
      toast.error("The issuing profile was not saved", { description: err.message }),
  });

  const gaps = useMemo(() => issuingProfileGaps(profile), [profile]);
  const required = gaps.filter((g) => g.weight === "required").length;
  const conditional = gaps.filter((g) => g.weight === "conditional").length;

  return (
    <div className="space-y-6 p-6">
      <BackLink />

      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="label-mono">subscription agreements</p>
          <h1 className="mt-1 font-display text-[1.75rem] leading-[1.1]">Issuing profile</h1>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            The facts every Subscription Agreement states about Aurixa itself — copied into each
            offer when it is prepared, so an offer carries the facts it was issued with.
          </p>
        </div>
        {canEdit && (
          <Button disabled={!dirty || saveM.isPending} onClick={() => saveM.mutate()}>
            <Save className="mr-1.5 h-4 w-4" /> {dirty ? "Save profile" : "Saved"}
          </Button>
        )}
      </header>

      <div
        className={cn(
          "glass spine p-4",
          required > 0 ? "spine-warn" : conditional > 0 ? "spine-idle" : "spine-ok",
        )}
      >
        <p className="text-sm font-medium text-foreground">
          {required > 0
            ? `${required} ${required === 1 ? "fact" : "facts"} every offer prints ${required === 1 ? "is" : "are"} still missing`
            : conditional > 0
              ? "Complete for offers without email, SMS or voice"
              : "Complete"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {required > 0
            ? "Until they are recorded here, each new offer starts with the same gaps, and an offer with a gap cannot be sent."
            : conditional > 0
              ? "The communications authorities are still blank: any offer that sends email, SMS or voice — every Scale offer, for one — needs them."
              : "Every fact a new offer needs from Aurixa is recorded."}
          {context.profileUpdatedAt
            ? ` Last saved ${format(new Date(context.profileUpdatedAt), "d MMM yyyy, h:mm a")}.`
            : " Not saved yet."}
        </p>
      </div>

      {!canEdit && (
        <div className="glass spine spine-idle p-4 text-sm text-muted-foreground">
          Only an administrator can change the issuing profile, because it is printed into every
          offer Aurixa issues. An offer's own copy of these facts can still be edited on the offer.
        </div>
      )}
      {!context.profileValid && (
        <div className="glass spine spine-bad p-4 text-sm text-muted-foreground">
          The stored profile could not be read by this build, so an empty one is shown. Saving
          replaces it.
        </div>
      )}
      {dirty && savedElsewhere && (
        <div className="glass spine spine-warn p-4 text-sm text-muted-foreground">
          The profile was saved elsewhere since you opened it. Saving replaces that version with
          yours.
        </div>
      )}

      <IssuingProfileForm profile={profile} onChange={setProfile} readOnly={!canEdit} />
    </div>
  );
}
