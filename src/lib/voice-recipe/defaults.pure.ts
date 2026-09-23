// Assistant settings measured to work on the live fleets.
//
// NPC's assistants and Mission Control's copy of them run on exactly these, and
// docs/voice-fleet-capabilities.md records why each was chosen. A plan does not
// choose any of them; only the persona's voice changes between agents.

export const MODEL_DEFAULT = { provider: "openai", model: "gpt-5.6-luna" } as const;

/**
 * deepgram flux with end-of-turn tuning. The keyterms are the words a
 * transcriber mishears most - the business's own name first - and are filled
 * per business at compile time.
 */
export const TRANSCRIBER_DEFAULT = {
  provider: "deepgram",
  model: "flux-general-en",
  language: "en",
  eotThreshold: 0.7,
  eotTimeoutMs: 5000,
} as const;

export const VOICE_DEFAULT = {
  provider: "11labs",
  model: "eleven_flash_v2_5",
  stability: 0.5,
  similarityBoost: 0.75,
} as const;

/**
 * Personas a plan may use, each with an ElevenLabs voice. These are the
 * voices of ElevenLabs' public library, which any account can use; NPC's own
 * voice ids may be private to NPC's account and are deliberately not listed.
 * Deploy reads each assistant back, so a voice an org cannot use is caught
 * there rather than on a call.
 */
export const VOICE_PALETTE = [
  { key: "warm_female", label: "Warm, female", voiceId: "EXAVITQu4vr4xnSDxMaL" },
  { key: "calm_female", label: "Calm, female", voiceId: "21m00Tcm4TlvDq8ikWAM" },
  { key: "bright_female", label: "Bright, female", voiceId: "MF3mGyEYCl7XYWbV9V6O" },
  { key: "warm_male", label: "Warm, male", voiceId: "TxGEqnHWrfWFTfGW9XjX" },
  { key: "steady_male", label: "Steady, male", voiceId: "ErXwobaYiN019PkySvjV" },
] as const;
export type VoiceKey = (typeof VOICE_PALETTE)[number]["key"];
export const VOICE_KEYS = VOICE_PALETTE.map((v) => v.key) as unknown as readonly [VoiceKey, ...VoiceKey[]];

/** NPC waits four seconds before speaking over a caller who pauses. */
export const START_SPEAKING_PLAN = { waitSeconds: 4 } as const;

/**
 * Office ambience on the assistants a person rings and can be transferred
 * from: silence between turns is what makes synthesised speech sound
 * synthesised. Derived from binding the transfer tool, as in
 * apply-fleet-upgrade.py.
 */
export const BACKGROUND_SOUND_FOR_TRANSFER = "office" as const;

export const END_CALL_MESSAGE = "Goodbye.";
