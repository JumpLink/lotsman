/**
 * `frontends/gui/dictation-engine.ts` — the real push-to-talk engine: `@gjsify/speech-recognition` as a
 * `Transcriber` and `@gjsify/media-capture` as a `Recorder` (ADR 0010 stage 2).
 *
 * **The gjsify packages sit behind two small interfaces** (`RecognitionApi`, `MicrophoneApi`), loaded
 * lazily by `loadGjsify`. The adapter's mapping (model states to `RecognitionAvailability`, PCM bytes to
 * `Float32Array`, the sample-rate check) is then testable on Node and GJS with fakes, with no model, no
 * microphone and no native typelib. A host without the native backend gets a clean "unavailable" carrying
 * the reason, never a crash at start-up.
 */

import type { PcmAudio, Recorder, RecognitionAvailability, Transcriber } from '@lotsman/core';

import { _, fmt } from '../../i18n.ts';
import { syntheticAudio, unavailableDictation, type AppDictation } from './dictation-hook.ts';

/** What the engine needs from the offline model: 16 kHz mono, the id the gjsify manifest names. */
export const DICTATION_SAMPLE_RATE = 16_000;

export type ModelState = 'available' | 'downloading' | 'downloadable' | 'unavailable';

export interface RecognitionApi {
  /** Whether a native recogniser exists on this host, and if not, why (technical, for the log). */
  backend(): { readonly ok: boolean; readonly detail: string };
  /** The offline model's id and total size, from the manifest. */
  model(): { readonly id: string; readonly bytes: number | null };
  /** Quiet: never downloads. */
  state(): Promise<ModelState>;
  /** Fetch the model. `true` once cached. */
  install(signal?: AbortSignal): Promise<boolean>;
  transcribe(
    samples: Float32Array | string,
    options: {
      lang?: string;
      phrases?: ReadonlyArray<{ phrase: string; boost: number }>;
      signal?: AbortSignal;
    },
  ): Promise<{ text: string; language: string | null; engine: string }>;
}

/** An open capture: `read` yields little-endian F32 chunks and `null` at the end; `stop` is idempotent. */
export interface MicrophoneSession {
  /** `true` when no real device opened and a test tone stands in. */
  readonly synthetic: boolean;
  start(): void;
  read(): Promise<Uint8Array | null>;
  stop(): void;
}

export interface MicrophoneApi {
  open(): MicrophoneSession;
}

export interface GjsifyApis {
  readonly recognition: RecognitionApi;
  readonly microphone: MicrophoneApi;
}

/** The languages asked of the model: it is multilingual, so this only selects the offline entry. */
const MODEL_LANGS = ['en', 'de'];

/** Import the two gjsify packages and wrap them. Throws when either cannot load (no typelib, no native). */
export async function loadGjsify(): Promise<GjsifyApis> {
  const speech = await import('@gjsify/speech-recognition');
  const capture = await import('@gjsify/media-capture');
  const entry = speech.findRecognitionModel(speech.DEFAULT_TRANSCRIBE_MODEL);
  const bytes = entry ? entry.files.reduce((sum, file) => sum + file.bytes, 0) : null;
  const options = { langs: MODEL_LANGS, kind: 'offline', quality: 'conversation' } as const;
  return {
    recognition: {
      backend: () => ({ ok: speech.hasRecognitionBackend(), detail: speech.describeRecognitionBackend() }),
      model: () => ({ id: speech.DEFAULT_TRANSCRIBE_MODEL, bytes }),
      state: () => speech.available(options),
      install: (signal) => speech.install({ ...options, ...(signal ? { signal } : {}) }),
      transcribe: (samples, opts) =>
        speech.transcribe(samples, {
          ...(opts.lang ? { lang: opts.lang } : {}),
          ...(opts.phrases
            ? { phrases: opts.phrases.map((p) => new speech.SpeechRecognitionPhrase(p.phrase, p.boost)) }
            : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
    },
    microphone: {
      open: () => capture.openPcmSource({ sampleRate: DICTATION_SAMPLE_RATE, format: 'F32LE' }),
    },
  };
}

/** `Transcriber` over the offline engine. Phrases are forwarded; the engine ignores them for now. */
export function gjsifyTranscriber(api: RecognitionApi): Transcriber {
  return {
    async availability(): Promise<RecognitionAvailability> {
      const backend = api.backend();
      if (!backend.ok) {
        return {
          kind: 'unavailable',
          reason: fmt(_('Speech recognition is not available here: {detail}'), { detail: backend.detail }),
        };
      }
      switch (await api.state()) {
        case 'available':
          return { kind: 'ready', local: true };
        case 'downloadable': {
          const { id, bytes } = api.model();
          return { kind: 'needs-model', model: id, bytes };
        }
        case 'downloading':
          return {
            kind: 'unavailable',
            reason: _('The speech model is being downloaded. Try again in a moment.'),
          };
        case 'unavailable':
          return { kind: 'unavailable', reason: _('No speech model fits this machine.') };
      }
    },

    async install(signal?: AbortSignal): Promise<void> {
      if (!(await api.install(signal))) throw new Error(_('The speech model could not be installed.'));
    },

    async transcribe(input, options = {}) {
      if (typeof input !== 'string' && input.sampleRate !== DICTATION_SAMPLE_RATE) {
        throw new Error(fmt(_('Expected {rate} Hz audio.'), { rate: String(DICTATION_SAMPLE_RATE) }));
      }
      const result = await api.transcribe(typeof input === 'string' ? input : input.samples, {
        ...(options.lang ? { lang: options.lang } : {}),
        ...(options.phrases ? { phrases: options.phrases } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { text: result.text, language: result.language ?? options.lang ?? '', engine: result.engine };
    },
  };
}

/** Whole little-endian F32 samples from byte chunks of any alignment; a trailing partial sample is dropped. */
export function joinFloat32(chunks: readonly Uint8Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const whole = total - (total % 4);
  const bytes = new Uint8Array(whole);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= whole) break;
    const part = chunk.byteLength <= whole - offset ? chunk : chunk.subarray(0, whole - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new Float32Array(bytes.buffer, 0, whole / 4);
}

/** `Recorder` over a 16 kHz mono F32 capture. `stop` returns the buffer, `cancel` drops it. */
export function gjsifyRecorder(api: MicrophoneApi): Recorder {
  let session: MicrophoneSession | null = null;
  let pump: Promise<Uint8Array[]> | null = null;

  const drain = async (source: MicrophoneSession): Promise<Uint8Array[]> => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await source.read();
      if (chunk === null) return chunks;
      chunks.push(chunk);
    }
  };

  return {
    async start(): Promise<void> {
      if (session) return;
      const source = api.open();
      if (source.synthetic) {
        source.stop();
        throw new Error(_('No microphone could be opened.'));
      }
      source.start();
      session = source;
      pump = drain(source);
    },

    async stop(): Promise<PcmAudio> {
      const source = session;
      const reading = pump;
      session = null;
      pump = null;
      if (!source || !reading) return syntheticAudio(0);
      source.stop();
      return { samples: joinFloat32(await reading), sampleRate: DICTATION_SAMPLE_RATE };
    },

    cancel(): void {
      const source = session;
      const reading = pump;
      session = null;
      pump = null;
      source?.stop();
      reading?.catch(() => {});
    },
  };
}

/** The real engine, or the clean "unavailable" when the packages or their native parts do not load. */
export async function realDictation(load: () => Promise<GjsifyApis> = loadGjsify): Promise<AppDictation> {
  try {
    const { recognition, microphone } = await load();
    return { transcriber: gjsifyTranscriber(recognition), recorder: gjsifyRecorder(microphone) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailableDictation(fmt(_('Speech recognition is not available here: {detail}'), { detail }));
  }
}
