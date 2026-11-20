/**
 * What the microphone button and the line under the entry say, as data — the `composerView` of push to talk.
 *
 * A renderer reads this and nothing else, so the states can be tested without a display. Sentences are
 * translated here (the library domain), with the model and size as named placeholders.
 */

import { _, fmt } from './i18n.ts';
import type { PushToTalkState } from './push-to-talk.ts';
import { formatBytes, type RecognitionAvailability } from './transcribe.ts';

export interface DictationView {
  /** The button works: it can start a recording, or install the model. */
  readonly buttonEnabled: boolean;
  /** Pressed while recording; the button shows it. */
  readonly recording: boolean;
  /** The next press installs a model instead of recording. */
  readonly installs: boolean;
  readonly tooltip: string;
  /** The line under the entry; `''` when there is nothing to say. */
  readonly status: string;
}

export function dictationView(state: PushToTalkState, availability: RecognitionAvailability): DictationView {
  const hold = _('Hold to speak. The text is added to the message, not sent.');
  switch (state.kind) {
    case 'recording':
      return {
        buttonEnabled: true,
        recording: true,
        installs: false,
        tooltip: hold,
        status: _('Listening… release to transcribe, Esc cancels.'),
      };
    case 'transcribing':
      return {
        buttonEnabled: false,
        recording: false,
        installs: false,
        tooltip: hold,
        status: _('Transcribing…'),
      };
    case 'installing':
      return {
        buttonEnabled: false,
        recording: false,
        installs: false,
        tooltip: hold,
        status: _('Downloading the speech model…'),
      };
    case 'error':
      return {
        buttonEnabled: availability.kind === 'ready' || availability.kind === 'needs-model',
        recording: false,
        installs: availability.kind === 'needs-model',
        tooltip: hold,
        status: fmt(_('Dictation failed: {message}'), { message: state.message }),
      };
    default:
      break;
  }
  switch (availability.kind) {
    case 'unavailable':
      return {
        buttonEnabled: false,
        recording: false,
        installs: false,
        tooltip: availability.reason,
        status: '',
      };
    case 'needs-model': {
      const size = formatBytes(availability.bytes);
      const tooltip = size
        ? fmt(_('Needs {model}, {size}. Click to download.'), { model: availability.model, size })
        : fmt(_('Needs {model}. Click to download.'), { model: availability.model });
      return { buttonEnabled: true, recording: false, installs: true, tooltip, status: '' };
    }
    case 'ready':
      return { buttonEnabled: true, recording: false, installs: false, tooltip: hold, status: '' };
  }
}
