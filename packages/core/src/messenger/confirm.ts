/**
 * Confirming an outward action in the chat — by text, because the channel has no buttons.
 *
 * `MessengerChannel` and `sendToPeer` carry Markdown to one peer and nothing else; no contract field
 * offers a reply button, so none is invented here. The question is a message that says what will
 * happen and how to answer, and the answer is a word (`readConfirmReply`).
 *
 * The scope is the chat — one configured peer — so "yes" always means the one pending confirmation.
 * `receive.ts` closes it: a yes or no answers it, anything else expires it (`new-message`) and is then
 * processed normally. What is decided lives in `confirmation.ts`; this file words the question.
 */
import {
  confirmThen,
  type Confirmation,
  type ConfirmationAction,
  type ConfirmationBook,
  type ConfirmedRun,
} from '../confirmation.ts';
import type { McpLink } from './link.ts';
import { sendToPeer } from './channel.ts';
import type { MessengerSettings } from './settings.ts';
import { STRINGS, msg } from './strings.ts';

/** The scope of the chat with the configured peer. */
export function chatScope(settings: MessengerSettings): string {
  return `chat:${settings.peer}`;
}

/** The question as the chat shows it: what will happen, then how to answer. */
export function confirmationText(confirmation: Confirmation): string {
  const lines = [confirmation.action.summary];
  for (const detail of confirmation.action.details) lines.push(`${detail.label}: \`${detail.value}\``);
  lines.push('', msg(STRINGS.confirmHint));
  return lines.join('\n');
}

/**
 * Ask in the chat and run `run` only after a yes there. Fails closed: a question that could not be
 * sent is expired, and nothing runs (`confirmThen`).
 */
export function confirmInChat<T>(
  book: ConfirmationBook,
  link: McpLink,
  settings: MessengerSettings,
  action: ConfirmationAction,
  run: () => T | Promise<T>,
): Promise<ConfirmedRun<T>> {
  return confirmThen(book, chatScope(settings), action, run, (confirmation) =>
    sendToPeer(link, settings, confirmationText(confirmation)),
  );
}
