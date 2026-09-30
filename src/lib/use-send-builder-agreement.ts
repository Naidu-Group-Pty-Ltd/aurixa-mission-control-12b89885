import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { createBuilderPartnerAgreement } from "@/lib/builderPartnerAgreements.functions";

/**
 * Draft (or reopen) an organisation's Builder Partner Agreement and go to it.
 *
 * An organisation holds at most one agreement in flight, so pressing this on
 * an organisation that already has one opens that one rather than a second.
 * The draft is seeded from what the network already knows — the organisation
 * and, where the builder applied on the website, their application — and
 * nothing is sent until an admin checks it on the agreement's own page.
 */
export function useSendBuilderAgreement() {
  const navigate = useNavigate();
  const createFn = useServerFn(createBuilderPartnerAgreement);
  const [busy, setBusy] = useState<string | null>(null);
  const send = async (organisationId: string) => {
    setBusy(organisationId);
    try {
      const result = await createFn({ data: { organisationId } });
      toast.success(
        result.existing
          ? `Opened agreement ${result.reference} — it was already in progress`
          : `Drafted agreement ${result.reference} — check the particulars, then send it`,
      );
      void navigate({
        to: "/agreements/$agreementId",
        params: { agreementId: result.agreementId },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The agreement could not be drafted.");
    } finally {
      setBusy(null);
    }
  };
  return { send, busy };
}
