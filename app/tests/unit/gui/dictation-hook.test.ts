/**
 * The dictation hook: off means the honest "not available" engine, on means the silent fake that
 * drives the whole flow with synthetic audio. No microphone, no sound.
 */
import { describe, expect, it } from '@gjsify/unit';
import { pushToTalk } from '@lotsman/core';

import { FAKE_DICTATION_TEXT, dictationFromHook } from '../../../src/frontends/gui/dictation-hook.ts';

export default async function run(): Promise<void> {
  await describe('the dictation hook', async () => {
    await it('is unavailable, with a reason, when the flag is off', async () => {
      const availability = await dictationFromHook(false).transcriber.availability();
      expect(availability.kind).toBe('unavailable');
    });

    await it('runs hold → release → text through the fake when on', async () => {
      const { recorder, transcriber } = dictationFromHook(true);
      const got: string[] = [];
      const ptt = pushToTalk({ recorder, transcriber, voice: 'local-only', onText: (t) => got.push(t) });
      await ptt.refresh();
      ptt.press();
      await ptt.release();
      expect(got.length).toBe(1);
      expect(got[0]).toBe(FAKE_DICTATION_TEXT);
    });
  });
}
