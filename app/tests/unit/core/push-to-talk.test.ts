/**
 * Push to talk against a fake recorder and a fake transcriber: the state machine, the candidate
 * table per `voice` policy, the term list as phrases, and where dictated text lands. Nothing here
 * records or plays sound; the audio is synthetic zeros.
 */

import { describe, expect, it } from '@gjsify/unit';

import {
  dictationInsertion,
  dictationOffered,
  dictationView,
  pushToTalk,
  recognitionCandidates,
  termsToPhrases,
  type PcmAudio,
  type PushToTalkState,
  type RecognitionAvailability,
  type Recorder,
  type TranscribeOptions,
  type Transcriber,
} from '@lotsman/core';

function same(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const audio = (seconds: number): PcmAudio => ({
  samples: new Float32Array(Math.round(16000 * seconds)),
  sampleRate: 16000,
});

function fakes(opts: { availability?: RecognitionAvailability; text?: string; seconds?: number } = {}) {
  const log = {
    starts: 0,
    stops: 0,
    cancels: 0,
    options: [] as (TranscribeOptions | undefined)[],
    inserted: [] as string[],
  };
  const recorder: Recorder = {
    start: async () => void log.starts++,
    stop: async () => (log.stops++, audio(opts.seconds ?? 0.5)),
    cancel: () => void log.cancels++,
  };
  const transcriber: Transcriber = {
    availability: async () => opts.availability ?? { kind: 'ready', local: true },
    transcribe: async (_input, options) => (
      log.options.push(options),
      { text: opts.text ?? ' hallo welt ', language: 'de-DE', engine: 'fake' }
    ),
  };
  return { log, recorder, transcriber };
}

export default async function run(): Promise<void> {
  await describe('push to talk', async () => {
    await it('goes idle → recording → transcribing → done and hands the text over, trimmed', async () => {
      const { log, recorder, transcriber } = fakes();
      const seen: string[] = [];
      const ptt = pushToTalk({
        recorder,
        transcriber,
        voice: 'local-only',
        onState: (s: PushToTalkState) => seen.push(s.kind),
        onText: (t) => log.inserted.push(t),
      });
      await ptt.refresh();
      ptt.press();
      await ptt.release();
      same(seen, ['recording', 'transcribing', 'done']);
      same(log.inserted, ['hallo welt']);
    });

    await it('treats empty audio and a tap as nothing, not an error', async () => {
      for (const seconds of [0, 0.02]) {
        const { log, recorder, transcriber } = fakes({ seconds });
        const ptt = pushToTalk({ recorder, transcriber, voice: null, onText: (t) => log.inserted.push(t) });
        await ptt.refresh();
        ptt.press();
        await ptt.release();
        expect(ptt.state.kind).toBe('idle');
        same(log.options, []);
        same(log.inserted, []);
      }
    });

    await it('treats an empty transcript as nothing', async () => {
      const { log, recorder, transcriber } = fakes({ text: '   ' });
      const ptt = pushToTalk({ recorder, transcriber, voice: null, onText: (t) => log.inserted.push(t) });
      await ptt.refresh();
      ptt.press();
      await ptt.release();
      expect(ptt.state.kind).toBe('idle');
      same(log.inserted, []);
    });

    await it('cancel drops the recording and inserts nothing', async () => {
      const { log, recorder, transcriber } = fakes();
      const ptt = pushToTalk({ recorder, transcriber, voice: null, onText: (t) => log.inserted.push(t) });
      await ptt.refresh();
      ptt.press();
      ptt.cancel();
      await ptt.release();
      expect(ptt.state.kind).toBe('cancelled');
      expect(log.cancels).toBe(1);
      same(log.inserted, []);
    });

    await it('cancel during transcription drops the late answer', async () => {
      const { log, recorder } = fakes();
      let finish: (() => void) | undefined;
      const transcriber: Transcriber = {
        availability: async () => ({ kind: 'ready', local: true }),
        transcribe: () =>
          new Promise(
            (resolve) => (finish = () => resolve({ text: 'spät', language: 'de', engine: 'fake' })),
          ),
      };
      const ptt = pushToTalk({ recorder, transcriber, voice: null, onText: (t) => log.inserted.push(t) });
      await ptt.refresh();
      ptt.press();
      const released = ptt.release();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      ptt.cancel();
      finish?.();
      await released;
      expect(ptt.state.kind).toBe('cancelled');
      same(log.inserted, []);
    });

    await it('does not record when the engine is unavailable or the policy is off for the cloud', async () => {
      const unavailable = fakes({ availability: { kind: 'unavailable', reason: 'no' } });
      const a = pushToTalk({
        recorder: unavailable.recorder,
        transcriber: unavailable.transcriber,
        voice: null,
        onText: () => {},
      });
      await a.refresh();
      a.press();
      expect(unavailable.log.starts).toBe(0);

      const cloud = fakes({ availability: { kind: 'ready', local: false } });
      const b = pushToTalk({
        recorder: cloud.recorder,
        transcriber: cloud.transcriber,
        voice: 'local-only',
        onText: () => {},
      });
      await b.refresh();
      expect(b.availability.kind).toBe('unavailable');
      b.press();
      expect(cloud.log.starts).toBe(0);
    });

    await it('passes the term list as phrases and the language', async () => {
      const { log, recorder, transcriber } = fakes();
      const ptt = pushToTalk({
        recorder,
        transcriber,
        voice: null,
        lang: 'de-DE',
        terms: () => ['Lotsman', 'lotsman'],
        onText: () => {},
      });
      await ptt.refresh();
      ptt.press();
      await ptt.release();
      expect(log.options[0]?.lang).toBe('de-DE');
      same(log.options[0]?.phrases, [{ phrase: 'Lotsman', boost: 5 }]);
    });
  });

  await describe('recognition candidates', async () => {
    const ids = (voice: Parameters<typeof recognitionCandidates>[0], filter = {}) =>
      recognitionCandidates(voice, filter).map((c) => c.id);

    await it('off leaves none, local-only leaves no cloud', async () => {
      same(ids('off'), []);
      expect(recognitionCandidates('local-only').every((c) => c.local)).toBe(true);
    });

    await it('lists the cloud last and only after agreement under any', async () => {
      expect(ids('any').includes('voxtral')).toBe(false);
      const agreed = ids('any', { cloudAgreed: true });
      expect(agreed[agreed.length - 1]).toBe('voxtral');
      expect(ids('local-only', { cloudAgreed: true }).includes('voxtral')).toBe(false);
    });

    await it('can skip the GPU class', async () => {
      expect(ids(null, { without: ['gpu'] }).includes('whisper-large-v3-turbo')).toBe(false);
    });

    await it('offers dictation only with a transcriber and a policy that is not off', async () => {
      const { transcriber } = fakes();
      expect(dictationOffered(transcriber, 'off')).toBe(false);
      expect(dictationOffered(undefined, null)).toBe(false);
      expect(dictationOffered(transcriber, 'local-only')).toBe(true);
    });
  });

  await describe('term list and insertion', async () => {
    await it('trims, drops blanks and case-insensitive duplicates', async () => {
      same(termsToPhrases([' Pascal ', '', 'pascal', 'GJS  Test']), [
        { phrase: 'Pascal', boost: 5 },
        { phrase: 'GJS Test', boost: 5 },
      ]);
    });

    await it('spaces dictated text only where needed', async () => {
      expect(dictationInsertion('', '', ' hi ')).toBe('hi');
      expect(dictationInsertion('Hallo', '', 'Welt')).toBe(' Welt');
      expect(dictationInsertion('Hallo ', 'x', 'Welt')).toBe('Welt ');
      expect(dictationInsertion('a', 'b', '  ')).toBe('');
    });
  });

  await describe('the dictation view', async () => {
    await it('says why the button is disabled', async () => {
      const v = dictationView({ kind: 'idle' }, { kind: 'unavailable', reason: 'not built yet' });
      expect(v.buttonEnabled).toBe(false);
      expect(v.tooltip).toBe('not built yet');
    });

    await it('names the model and size and routes the click to install', async () => {
      const v = dictationView({ kind: 'idle' }, { kind: 'needs-model', model: 'parakeet', bytes: 640e6 });
      expect(v.installs).toBe(true);
      expect(v.tooltip.includes('parakeet')).toBe(true);
      expect(v.tooltip.includes('640 MB')).toBe(true);
    });

    await it('shows recording', async () => {
      const v = dictationView({ kind: 'recording' }, { kind: 'ready', local: true });
      expect(v.recording).toBe(true);
    });
  });
}
