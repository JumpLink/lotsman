/**
 * `frontends/gui/dictation-hook.ts` — the app's push-to-talk engine, and what `LOTSMAN_APP_DICTATION`
 * stands in for.
 *
 * `LotsmanChat` takes an optional `dictation` (a `Transcriber` and a `Recorder`, ports from core).
 * The real adapter is `@gjsify/speech-recognition` plus `@gjsify/media-capture`, and neither is
 * released yet, so until it is, **the app offers the microphone button disabled**, with the reason in
 * its tooltip (`unavailableDictation`). One object replaces it when the release lands.
 *
 * **The fake never touches a microphone or a speaker.** It "records" a quarter second of synthetic
 * silence and "transcribes" it to a fixed line, so the whole flow — hold, release, text in the entry,
 * not sent — can be exercised and photographed headless. It is the only engine a test or screenshot run
 * may use.
 */

import { _, type PcmAudio, type Recorder, type Transcriber } from '@lotsman/core';

export interface AppDictation {
  readonly transcriber: Transcriber;
  readonly recorder: Recorder;
}

/** The text the fake answers with, so a run and a test can look for it. */
export const FAKE_DICTATION_TEXT = 'Dies ist ein Diktat.';

const SAMPLE_RATE = 16_000;

/** Quarter of a second of zeros: long enough to pass the tap threshold, and silent by construction. */
export function syntheticAudio(seconds = 0.25): PcmAudio {
  return { samples: new Float32Array(Math.round(SAMPLE_RATE * seconds)), sampleRate: SAMPLE_RATE };
}

export class FakeRecorder implements Recorder {
  recording = false;
  async start(): Promise<void> {
    this.recording = true;
    console.log('lotsman: would record');
  }
  async stop(): Promise<PcmAudio> {
    this.recording = false;
    console.log('lotsman: would stop recording');
    return syntheticAudio();
  }
  cancel(): void {
    this.recording = false;
  }
}

export class FakeTranscriber implements Transcriber {
  readonly heard: Array<{ phrases: number; lang?: string }> = [];
  async availability() {
    return { kind: 'ready', local: true } as const;
  }
  async transcribe(_input: PcmAudio | string, options?: { lang?: string; phrases?: readonly unknown[] }) {
    this.heard.push({
      phrases: options?.phrases?.length ?? 0,
      ...(options?.lang ? { lang: options.lang } : {}),
    });
    return { text: FAKE_DICTATION_TEXT, language: options?.lang ?? 'de-DE', engine: 'fake' };
  }
}

/** The honest default: no engine yet. `availability()` says why, and the button shows it. */
export function unavailableDictation(): AppDictation {
  const reason = _('Speech recognition is not part of this build yet.');
  return {
    transcriber: {
      availability: async () => ({ kind: 'unavailable', reason }),
      transcribe: async () => {
        throw new Error(reason);
      },
    },
    recorder: {
      start: async () => {
        throw new Error(reason);
      },
      stop: async () => syntheticAudio(0),
      cancel: () => {},
    },
  };
}

/** The hook's flag as an engine: the fake when on, the unavailable one otherwise. */
export function dictationFromHook(on: boolean): AppDictation {
  return on ? { transcriber: new FakeTranscriber(), recorder: new FakeRecorder() } : unavailableDictation();
}
