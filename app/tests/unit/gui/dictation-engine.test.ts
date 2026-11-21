/**
 * The dictation adapter over fake gjsify APIs: availability mapping, install, transcribe and the
 * recorder's buffering. No model, no microphone, no native typelib, no sound.
 */
import { describe, expect, it } from '@gjsify/unit';
import { pushToTalk } from '@lotsman/core';

import {
  gjsifyRecorder,
  gjsifyTranscriber,
  joinFloat32,
  realDictation,
  type MicrophoneSession,
  type ModelState,
  type RecognitionApi,
} from '../../../src/frontends/gui/dictation-engine.ts';

function recognition(
  state: ModelState,
  backendOk = true,
): RecognitionApi & { installed: number; seen: unknown[] } {
  const api = {
    installed: 0,
    seen: [] as unknown[],
    backend: () => ({ ok: backendOk, detail: 'no sherpa' }),
    model: () => ({ id: 'parakeet-fake', bytes: 640_000_000 }),
    state: async () => state,
    install: async () => {
      api.installed += 1;
      return true;
    },
    transcribe: async (samples: Float32Array | string, options: unknown) => {
      api.seen.push({ samples, options });
      return { text: 'hallo welt', language: null, engine: 'fake/parakeet' };
    },
  };
  return api;
}

function floats(...values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

function session(chunks: Uint8Array[], synthetic = false): MicrophoneSession & { stopped: number } {
  const queue = [...chunks];
  let waiting: ((value: Uint8Array | null) => void) | null = null;
  const self = {
    synthetic,
    stopped: 0,
    start() {},
    read(): Promise<Uint8Array | null> {
      const next = queue.shift();
      if (next) return Promise.resolve(next);
      if (self.stopped > 0) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    stop() {
      self.stopped += 1;
      waiting?.(null);
    },
  };
  return self;
}

export default async function run(): Promise<void> {
  await describe('the dictation adapter', async () => {
    await it('maps the model states to availability', async () => {
      expect((await gjsifyTranscriber(recognition('available')).availability()).kind).toBe('ready');
      const needs = await gjsifyTranscriber(recognition('downloadable')).availability();
      expect(needs.kind).toBe('needs-model');
      if (needs.kind === 'needs-model') {
        expect(needs.model).toBe('parakeet-fake');
        expect(needs.bytes).toBe(640_000_000);
      }
      expect((await gjsifyTranscriber(recognition('downloading')).availability()).kind).toBe('unavailable');
      expect((await gjsifyTranscriber(recognition('unavailable')).availability()).kind).toBe('unavailable');
    });

    await it('says why when the native backend is absent', async () => {
      const availability = await gjsifyTranscriber(recognition('available', false)).availability();
      expect(availability.kind).toBe('unavailable');
      if (availability.kind === 'unavailable') expect(availability.reason.includes('no sherpa')).toBe(true);
    });

    await it('installs through the api and fails loudly when it does not cache', async () => {
      const api = recognition('downloadable');
      await gjsifyTranscriber(api).install?.();
      expect(api.installed).toBe(1);
      const failing = { ...api, install: async () => false };
      let failed = false;
      try {
        await gjsifyTranscriber(failing).install?.();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    await it('transcribes PCM at 16 kHz and falls back to the lang hint', async () => {
      const api = recognition('available');
      const samples = new Float32Array([0, 0.5]);
      const result = await gjsifyTranscriber(api).transcribe(
        { samples, sampleRate: 16_000 },
        { lang: 'de-DE' },
      );
      expect(result.text).toBe('hallo welt');
      expect(result.language).toBe('de-DE');
      expect(result.engine).toBe('fake/parakeet');
      expect((api.seen[0] as { samples: Float32Array }).samples).toBe(samples);
    });

    await it('refuses PCM at another rate', async () => {
      let failed = false;
      try {
        await gjsifyTranscriber(recognition('available')).transcribe({
          samples: new Float32Array(1),
          sampleRate: 44_100,
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    });

    await it('joins misaligned chunks into whole samples', async () => {
      const all = floats(1, 2, 3);
      const joined = joinFloat32([all.subarray(0, 5), all.subarray(5, 11), all.subarray(11)]);
      expect(joined.length).toBe(3);
      expect(joined[2]).toBe(3);
      expect(joinFloat32([new Uint8Array(7)]).length).toBe(1);
    });

    await it('records until stop and returns the buffer', async () => {
      const mic = session([floats(0.25, 0.5), floats(0.75)]);
      const recorder = gjsifyRecorder({ open: () => mic });
      await recorder.start();
      const audio = await recorder.stop();
      expect(audio.sampleRate).toBe(16_000);
      expect(audio.samples.length).toBe(3);
      expect(audio.samples[2]).toBe(0.75);
      expect(mic.stopped).toBe(1);
    });

    await it('cancel discards, and is safe when idle', async () => {
      const mic = session([floats(1)]);
      const recorder = gjsifyRecorder({ open: () => mic });
      recorder.cancel();
      await recorder.start();
      recorder.cancel();
      expect(mic.stopped).toBe(1);
      expect((await recorder.stop()).samples.length).toBe(0);
    });

    await it('does not record a stand-in tone', async () => {
      const mic = session([], true);
      let failed = false;
      try {
        await gjsifyRecorder({ open: () => mic }).start();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(mic.stopped).toBe(1);
    });

    await it('runs hold → release → text through the whole port', async () => {
      const api = recognition('available');
      const recorder = gjsifyRecorder({
        open: () => session([floats(...Array.from({ length: 4000 }, () => 0.1))]),
      });
      const got: string[] = [];
      const ptt = pushToTalk({
        recorder,
        transcriber: gjsifyTranscriber(api),
        voice: 'local-only',
        onText: (t) => got.push(t),
      });
      await ptt.refresh();
      ptt.press();
      await ptt.release();
      expect(got.length).toBe(1);
      expect(got[0]).toBe('hallo welt');
    });

    await it('offers a clean unavailable when the packages do not load', async () => {
      const { transcriber } = await realDictation(async () => {
        throw new Error('typelib missing');
      });
      const availability = await transcriber.availability();
      expect(availability.kind).toBe('unavailable');
      if (availability.kind === 'unavailable')
        expect(availability.reason.includes('typelib missing')).toBe(true);
    });
  });
}
