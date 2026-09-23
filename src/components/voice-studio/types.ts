import type { getStudioProject } from "@/lib/voice-studio.functions";

export type StudioProjectData = Awaited<ReturnType<typeof getStudioProject>>;
