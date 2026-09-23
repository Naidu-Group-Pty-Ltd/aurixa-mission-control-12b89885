// The planning agent's model: Claude over the Anthropic API.
//
// ## The key is VOICE_STUDIO_ANTHROPIC_API_KEY, never ANTHROPIC_API_KEY
//
// Mission Control forwards named secrets from its own environment into every
// clone (cloneSecretForward.server.ts reads `process.env[name]`), and
// ANTHROPIC_API_KEY is one of the LLM names that list covers. Setting Aurixa's
// key under that name here would hand it to every tenant. This name is on no
// forwarding list, and prime-backend.server.ts classifies it never-forward.
//
// ## What every call does
//
// - Streams (a stage can think for minutes; a non-streaming request that long
//   is at the mercy of every idle timeout between here and the API) and reads
//   the final message.
// - Sends the recipe book as the first system block with a cache breakpoint,
//   so every call in a run - and every run until the book changes - reads it
//   from cache.
// - Asks for adaptive thinking and structured output against the stage's
//   schema, and lets the API fall back to another model on a refusal
//   (server-side fallbacks). The response is still checked: stop_reason,
//   JSON, schema (modelResult.pure.ts).
// - Logs usage to ai_usage_log with the model that actually answered.
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { serializeRecipeBook } from "@/lib/voice-recipe/recipeBook.pure";
import { STUDIO_RULES } from "@/lib/voice-studio/plannerPrompts.pure";
import {
  estimateUsage,
  interpretResponse,
  type ResponseLike,
} from "@/lib/voice-studio/modelResult.pure";
import {
  STAGE_EFFORT,
  type PlannerModel,
  type StructuredCall,
} from "@/lib/voice-studio/plannerEngine.pure";

export const VOICE_STUDIO_MODEL = "claude-opus-5";
const MAX_OUTPUT_TOKENS = 64_000;
const BETAS = ["server-side-fallback-2026-07-01", "files-api-2025-04-14"] as const;

export class StudioNotConfiguredError extends Error {
  constructor() {
    super("VOICE_STUDIO_ANTHROPIC_API_KEY is not set, so the planning agent cannot run");
    this.name = "StudioNotConfiguredError";
  }
}

function client(): Anthropic {
  const apiKey = process.env.VOICE_STUDIO_ANTHROPIC_API_KEY;
  if (!apiKey) throw new StudioNotConfiguredError();
  return new Anthropic({ apiKey, maxRetries: 3, timeout: 15 * 60 * 1000 });
}

export function studioModelConfigured(): boolean {
  return Boolean(process.env.VOICE_STUDIO_ANTHROPIC_API_KEY);
}

/** Upload a PDF once; the run references it by id instead of sending its bytes on every call. */
export async function uploadPdfToFiles(bytes: Uint8Array, fileName: string): Promise<string> {
  const file = await toFile(bytes, fileName, { type: "application/pdf" });
  const meta = await client().beta.files.upload({ file, betas: ["files-api-2025-04-14"] });
  return meta.id;
}

export function anthropicPlannerModel(opts: {
  runId: string;
  userId: string | null;
}): PlannerModel {
  const anthropic = client();
  const system = [
    {
      type: "text" as const,
      text: serializeRecipeBook(),
      cache_control: { type: "ephemeral" as const },
    },
    { type: "text" as const, text: STUDIO_RULES },
  ];

  return {
    async structured<T>(call: StructuredCall<T>) {
      const documents = call.prompt.documents.map((d) =>
        d.fileId
          ? {
              type: "document" as const,
              title: d.title,
              context: `Source ${d.docId}`,
              source: { type: "file" as const, file_id: d.fileId },
            }
          : {
              type: "document" as const,
              title: d.title,
              context: `Source ${d.docId}`,
              source: {
                type: "text" as const,
                media_type: "text/plain" as const,
                data: d.text ?? "",
              },
            },
      );

      const stream = anthropic.beta.messages.stream({
        model: VOICE_STUDIO_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        betas: [...BETAS],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: STAGE_EFFORT[call.stage], format: zodOutputFormat(call.schema) },
        system,
        messages: [
          {
            role: "user",
            content: [...documents, { type: "text", text: call.prompt.instructions }],
          },
        ],
      });
      const message = (await stream.finalMessage()) as unknown as ResponseLike;
      const usage = estimateUsage(message);

      const { error: logError } = await supabaseAdmin.from("ai_usage_log").insert({
        feature: `voice_studio.${call.stage}`,
        model: message.model,
        prompt_tokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        completion_tokens: usage.outputTokens,
        total_tokens:
          usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens,
        cost_estimate_usd: usage.costUsd,
        user_id: opts.userId,
        metadata: {
          run_id: opts.runId,
          key: call.key,
          stop_reason: message.stop_reason,
          cache_read: usage.cacheReadTokens,
        },
      });
      // Metering is bookkeeping; a failed log line must not fail a stage that
      // has already been paid for.
      if (logError) console.error("[voice-studio] usage log failed:", logError.message);

      return { data: interpretResponse(message, call.schema), usage };
    },
  };
}
