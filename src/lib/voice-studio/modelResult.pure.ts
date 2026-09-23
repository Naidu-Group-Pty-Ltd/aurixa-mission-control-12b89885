// Turning one model response into a stage's output - or into an error that
// says what went wrong.
//
// A structured-output response is not trustworthy just because it arrived.
// `stop_reason` says whether it finished: `max_tokens` means the JSON was cut
// off mid-object, `refusal` means the model (and every fallback) declined, and
// anything other than `end_turn` means the text is not the answer. Each becomes
// its own error, because each sends an operator to a different remedy - a
// bigger budget, a look at the documents, or a retry.
import type * as z from "zod/v4";
import type { Usage } from "./plannerEngine.pure.ts";

export class ModelStopError extends Error {
  readonly stopReason: string;
  constructor(stopReason: string, message: string) {
    super(message);
    this.name = "ModelStopError";
    this.stopReason = stopReason;
  }
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export interface ResponseLike {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/**
 * Prices per million tokens, used to ESTIMATE a run's cost for the cap. They
 * are deliberately on the high side of the models a fallback chain can reach,
 * so the cap trips early rather than late; the invoice is the authority.
 */
export const PRICE_PER_MTOK = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } as const;

export function estimateUsage(r: ResponseLike): Usage {
  const inputTokens = r.usage.input_tokens ?? 0;
  const outputTokens = r.usage.output_tokens ?? 0;
  const cacheReadTokens = r.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = r.usage.cache_creation_input_tokens ?? 0;
  const costUsd =
    (inputTokens * PRICE_PER_MTOK.input +
      outputTokens * PRICE_PER_MTOK.output +
      cacheReadTokens * PRICE_PER_MTOK.cacheRead +
      cacheWriteTokens * PRICE_PER_MTOK.cacheWrite) /
    1_000_000;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, model: r.model };
}

export function interpretResponse<T>(r: ResponseLike, schema: z.ZodType<T>): T {
  if (r.stop_reason === "refusal") {
    throw new ModelStopError(
      "refusal",
      "the model declined this stage; check the documents for content it will not process",
    );
  }
  if (r.stop_reason === "max_tokens") {
    throw new ModelStopError(
      "max_tokens",
      "the answer was cut off before it finished; the stage needs a larger output budget",
    );
  }
  if (r.stop_reason === "model_context_window_exceeded") {
    throw new ModelStopError(
      "model_context_window_exceeded",
      "the documents are too large to read in one request; remove or split some",
    );
  }
  if (r.stop_reason !== "end_turn") {
    throw new ModelStopError(
      String(r.stop_reason),
      `the model stopped for an unexpected reason (${r.stop_reason})`,
    );
  }
  const text = r.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) throw new ModelOutputError("the model returned no answer text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ModelOutputError("the model's answer was not valid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ModelOutputError(
      `the model's answer did not match the stage schema: ${result.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return result.data;
}
