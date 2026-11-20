/**
 * Push to talk — stage 2 of conversation mode (ADR 0010): hold, speak, release, review.
 *
 * idle → recording → transcribing → done | error | cancelled, and back to idle on the next press.
 * Empty audio and empty text end in `idle` with nothing said: a tap is not an error.
 *
 * **It never sends.** The result goes to `onText`, which the widget puts into the entry; sending is
 * the person's Enter. The recorder and the transcriber are ports (`transcribe.ts`), so everything here
 * runs against fakes and makes no sound.
 *
 * **The `voice` policy is checked before the microphone opens**, not after: with `local-only` a cloud
 * engine is refused up front, so speech is never captured for an engine that may not hear it.
 */

import {
  dictationOffered,
  formatBytes,
  termsToPhrases,
  type RecognitionAvailability,
  type Recorder,
  type Transcriber,
} from './transcribe.ts';
import type { VoicePolicy } from './voice-policy.ts';

export type PushToTalkState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'installing' }
  | { readonly kind: 'recording' }
  | { readonly kind: 'transcribing' }
  | { readonly kind: 'done'; readonly text: string; readonly engine: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' };

export interface PushToTalkOptions {
  readonly recorder: Recorder;
  readonly transcriber: Transcriber;
  readonly voice: VoicePolicy | null;
  /** The person's term list, read at each recording so an edit applies at once. */
  readonly terms?: () => readonly string[];
  readonly lang?: string;
  /** Shorter than this is a tap, not speech. Default 100 ms. */
  readonly minSeconds?: number;
  readonly onState?: (state: PushToTalkState) => void;
  readonly onAvailability?: (availability: RecognitionAvailability) => void;
  /** The transcript, non-empty, to be inserted for review. */
  readonly onText: (text: string) => void;
}

export class PushToTalk {
  readonly #opts: PushToTalkOptions;
  #state: PushToTalkState = { kind: 'idle' };
  #availability: RecognitionAvailability = { kind: 'unavailable', reason: 'not checked yet' };
  /** Bumped by every press and cancel, so a late answer from an older recording is dropped. */
  #generation = 0;
  #starting: Promise<void> = Promise.resolve();
  #abort: AbortController | null = null;

  constructor(opts: PushToTalkOptions) {
    this.#opts = opts;
  }

  get state(): PushToTalkState {
    return this.#state;
  }

  get availability(): RecognitionAvailability {
    return this.#availability;
  }

  /** Ask the engine what it can do now. Call at start and after an install. */
  async refresh(): Promise<RecognitionAvailability> {
    let availability: RecognitionAvailability;
    try {
      availability = await this.#opts.transcriber.availability();
    } catch (error) {
      availability = { kind: 'unavailable', reason: describe(error) };
    }
    if (
      availability.kind === 'ready' &&
      !availability.local &&
      this.#opts.voice !== 'any' &&
      this.#opts.voice !== null
    ) {
      availability = { kind: 'unavailable', reason: 'The voice policy allows only engines on this machine.' };
    }
    this.#availability = availability;
    this.#opts.onAvailability?.(availability);
    return availability;
  }

  /** Whether `press` would start a recording now. */
  get ready(): boolean {
    return this.#availability.kind === 'ready' && this.#idleLike();
  }

  /** Download the model `availability` asked for, through the port. */
  async install(): Promise<void> {
    const { transcriber } = this.#opts;
    if (this.#availability.kind !== 'needs-model' || !transcriber.install || !this.#idleLike()) return;
    const generation = ++this.#generation;
    const abort = (this.#abort = new AbortController());
    this.#set({ kind: 'installing' });
    try {
      await transcriber.install(abort.signal);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#set({ kind: 'error', message: describe(error) });
      return;
    }
    if (generation !== this.#generation) return;
    this.#set({ kind: 'idle' });
    await this.refresh();
  }

  /** The button or key went down. */
  press(): void {
    if (!this.ready) return;
    const generation = ++this.#generation;
    this.#set({ kind: 'recording' });
    this.#starting = this.#opts.recorder.start().catch((error: unknown) => {
      if (generation !== this.#generation) return;
      this.#generation++;
      this.#set({ kind: 'error', message: describe(error) });
    });
  }

  /** The button or key came up: stop capturing and transcribe. */
  async release(): Promise<void> {
    if (this.#state.kind !== 'recording') return;
    const generation = this.#generation;
    this.#set({ kind: 'transcribing' });
    await this.#starting;
    if (generation !== this.#generation) return;

    const abort = (this.#abort = new AbortController());
    try {
      const audio = await this.#opts.recorder.stop();
      if (generation !== this.#generation) return;
      const minSamples = Math.floor(audio.sampleRate * (this.#opts.minSeconds ?? 0.1));
      if (audio.samples.length === 0 || audio.samples.length < minSamples) {
        this.#set({ kind: 'idle' });
        return;
      }
      const phrases = termsToPhrases(this.#opts.terms?.() ?? []);
      const result = await this.#opts.transcriber.transcribe(audio, {
        ...(this.#opts.lang ? { lang: this.#opts.lang } : {}),
        ...(phrases.length > 0 ? { phrases } : {}),
        signal: abort.signal,
      });
      if (generation !== this.#generation) return;
      const text = result.text.trim();
      if (text === '') {
        this.#set({ kind: 'idle' });
        return;
      }
      this.#set({ kind: 'done', text, engine: result.engine });
      this.#opts.onText(text);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#set({ kind: 'error', message: describe(error) });
    }
  }

  /** Esc. Drops the recording or the pending transcription; nothing is inserted. */
  cancel(): void {
    const kind = this.#state.kind;
    if (kind !== 'recording' && kind !== 'transcribing' && kind !== 'installing') return;
    this.#generation++;
    this.#abort?.abort();
    this.#abort = null;
    try {
      this.#opts.recorder.cancel();
    } catch {
      // Cancelling must never throw into a key handler.
    }
    this.#set(kind === 'installing' ? { kind: 'idle' } : { kind: 'cancelled' });
  }

  #idleLike(): boolean {
    const kind = this.#state.kind;
    return kind === 'idle' || kind === 'done' || kind === 'error' || kind === 'cancelled';
  }

  #set(state: PushToTalkState): void {
    this.#state = state;
    this.#opts.onState?.(state);
  }
}

export function pushToTalk(opts: PushToTalkOptions): PushToTalk {
  return new PushToTalk(opts);
}

/** `needs <model>, <size>` as data, so the widget translates the sentence and not the pieces. */
export function modelNeedParts(
  availability: RecognitionAvailability,
): { model: string; size: string | null } | null {
  return availability.kind === 'needs-model'
    ? { model: availability.model, size: formatBytes(availability.bytes) }
    : null;
}

export { dictationOffered };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
