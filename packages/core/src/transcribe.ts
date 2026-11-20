/**
 * Speech recognition as a port — ADR 0010 points 4, 5, 7 and 9, the listening half of conversation mode.
 *
 * **Lotsman owns the port, gjsify owns the engines.** ADR 0010 point 7 puts `SpeechRecognition` and its
 * local backends in `@gjsify/speech-recognition`; this file is the shape Lotsman needs from it, so the
 * state machine, the widget and the tests are built against a fake first (the order ADR 0009 chose for
 * read-aloud) and the gjsify adapter is one object later. `Transcriber.transcribe` mirrors the facade:
 * PCM or a file in, `{ text, language, engine }` out, with `lang`, W3C-style `phrases` and a signal.
 *
 * What stays Lotsman's, as the ADR says: the candidate table, the 500 ms budget and the term list.
 * Pure, no `gi://`.
 */

import type { VoicePolicy } from './voice-policy.ts';

/** From the end of speech to text, ADR 0010 point 5. A candidate over it is not offered for hands-free. */
export const RECOGNITION_BUDGET_MS = 500;

/** Mono samples in [-1, 1], like the Web Audio `AudioBuffer`'s first channel. */
export interface PcmAudio {
  readonly samples: Float32Array;
  readonly sampleRate: number;
}

/** A W3C `SpeechRecognitionPhrase`: a hint for the engines that accept one. */
export interface SpeechPhrase {
  readonly phrase: string;
  /** 0 to 10, 1 is neutral — the W3C range. */
  readonly boost: number;
}

export interface TranscribeOptions {
  /** BCP 47, e.g. `de-DE`. */
  readonly lang?: string;
  readonly phrases?: readonly SpeechPhrase[];
  readonly signal?: AbortSignal;
}

export interface TranscribeResult {
  readonly text: string;
  readonly language: string;
  /** Which engine answered. Informational: the surface says so while a cloud engine listens. */
  readonly engine: string;
}

/** What a model costs before it can be used, for "needs <model>, <size>". `bytes` is `null` when unknown. */
export interface ModelNeed {
  readonly model: string;
  readonly bytes: number | null;
}

export type RecognitionAvailability =
  /** `local`: the engine runs on this machine. Checked against the `voice` policy before recording. */
  | { readonly kind: 'ready'; readonly local: boolean }
  | ({ readonly kind: 'needs-model' } & ModelNeed)
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface Transcriber {
  availability(): Promise<RecognitionAvailability>;
  /** Fetch the model `availability()` named. Absent when the engine has nothing to download. */
  install?(signal?: AbortSignal): Promise<void>;
  transcribe(input: PcmAudio | string, options?: TranscribeOptions): Promise<TranscribeResult>;
}

/** The microphone. `stop` resolves with everything captured since `start`. */
export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<PcmAudio>;
  /** Drop the capture without returning it. Safe when nothing is recording. */
  cancel(): void;
}

// ── The candidate table ─────────────────────────────────────────────────────────────────────────

export type RecognitionDevice = 'gpu' | 'cpu' | 'cloud';

export interface RecognitionCandidate {
  readonly id: string;
  readonly label: string;
  readonly device: RecognitionDevice;
  /** Runs on this machine. Cloud is the only `false`. */
  readonly local: boolean;
  /** `false`: represented so a policy can exclude it, but no backend exists yet. */
  readonly implemented: boolean;
  readonly diskMb?: number;
  readonly ramMb?: number;
}

/** Best first, as ADR 0010 point 4 lists them. Sizes are the 2026-10-28 measurement; absent = not measured. */
export const RECOGNITION_CANDIDATES: readonly RecognitionCandidate[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'whisper.cpp large-v3-turbo',
    device: 'gpu',
    local: true,
    implemented: false,
    diskMb: 550,
  },
  {
    id: 'parakeet-tdt-0.6b-v3',
    label: 'Parakeet TDT 0.6B v3',
    device: 'cpu',
    local: true,
    implemented: true,
    diskMb: 640,
    ramMb: 1100,
  },
  {
    id: 'zipformer-de-streaming',
    label: 'Streaming Zipformer (German)',
    device: 'cpu',
    local: true,
    implemented: false,
  },
  { id: 'voxtral', label: 'Voxtral', device: 'cloud', local: false, implemented: false },
];

export interface CandidateFilter {
  /** Engines on this device class are skipped, e.g. no `gpu` when the GPU guard pins the CPU. */
  readonly without?: readonly RecognitionDevice[];
  /** The person agreed once that speech leaves the machine (point 6). Without it the cloud is never listed. */
  readonly cloudAgreed?: boolean;
}

/**
 * The candidates a profile allows, best first.
 *
 * `off` leaves none; `local-only` leaves the local ones; `any` adds the cloud **only** with
 * `cloudAgreed`, because the cloud is the last candidate and never a silent fallback (point 6).
 */
export function recognitionCandidates(
  voice: VoicePolicy | null,
  filter: CandidateFilter = {},
): readonly RecognitionCandidate[] {
  if (voice === 'off') return [];
  const skipped = filter.without ?? [];
  return RECOGNITION_CANDIDATES.filter((candidate) => {
    if (skipped.includes(candidate.device)) return false;
    if (candidate.local) return true;
    return voice !== 'local-only' && filter.cloudAgreed === true;
  });
}

/** Whether a surface may offer dictation at all: a transcriber, and a policy that is not `off`. */
export function dictationOffered(
  transcriber: Transcriber | null | undefined,
  voice: VoicePolicy | null,
): transcriber is Transcriber {
  return transcriber != null && voice !== 'off';
}

// ── The term list ───────────────────────────────────────────────────────────────────────────────

/** Slightly above neutral: a nudge, not an override, so ordinary words are not bent towards a term. */
export const TERM_BOOST = 5;
/** Engines take a short hint list; a longer one is trimmed from the end. */
export const MAX_TERMS = 100;

/**
 * The person's own words (ADR 0010 point 9) as W3C phrases: trimmed, blanks dropped, duplicates
 * (case-insensitive) kept once in their first spelling, capped at `MAX_TERMS`.
 */
export function termsToPhrases(terms: readonly string[], boost: number = TERM_BOOST): SpeechPhrase[] {
  const seen = new Set<string>();
  const phrases: SpeechPhrase[] = [];
  for (const raw of terms) {
    const phrase = raw.trim().replace(/\s+/g, ' ');
    if (phrase === '') continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    phrases.push({ phrase, boost });
    if (phrases.length >= MAX_TERMS) break;
  }
  return phrases;
}

// ── Putting the result into the entry ───────────────────────────────────────────────────────────

/** `640 MB`, `1.1 GB`; `null` is "size unknown". Locale-neutral on purpose. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * What to insert at the cursor so dictation reads as words: a space on either side only where the
 * neighbouring text does not already end or begin with whitespace.
 */
export function dictationInsertion(before: string, after: string, text: string): string {
  const body = text.trim();
  if (body === '') return '';
  const lead = before !== '' && !/\s$/.test(before) ? ' ' : '';
  const trail = after !== '' && !/^\s/.test(after) ? ' ' : '';
  return `${lead}${body}${trail}`;
}
