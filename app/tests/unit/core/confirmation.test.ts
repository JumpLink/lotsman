/**
 * The confirmation rule, tested without a window: what waits, what expires, who wins, and — above
 * all — that nothing runs unless somebody said yes.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
  ConfirmationBook,
  confirmThen,
  confirmationAge,
  confirmationStatusText,
  readConfirmReply,
  type ConfirmationAction,
} from '@lotsman/core';

const RUN: ConfirmationAction = {
  kind: 'run-command',
  summary: 'Run a command',
  details: [
    { label: 'Command', value: 'echo hello' },
    { label: 'Directory', value: '/tmp/work' },
  ],
};

function bookAt(start = '2026-01-01T10:00:00.000Z') {
  let now = new Date(start);
  const book = new ConfirmationBook({ now: () => now });
  return {
    book,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

export default async () => {
  await describe('ConfirmationBook — the state machine', async () => {
    await it('starts pending, with the action and its creation time', async () => {
      const { book } = bookAt();
      const { confirmation } = book.propose('window', RUN);
      expect(confirmation.status).toBe('pending');
      expect(confirmation.action.details[0]!.value).toBe('echo hello');
      expect(confirmation.createdAt).toBe('2026-01-01T10:00:00.000Z');
      expect(book.pendingIn('window')?.id).toBe(confirmation.id);
    });

    await it('approves on an explicit yes and resolves the outcome', async () => {
      const { book } = bookAt();
      const { confirmation, outcome } = book.propose('window', RUN);
      const result = book.answer(confirmation.id, true);
      expect(result.type).toBe('decided');
      expect(await outcome).toStrictEqual({ type: 'approved' });
      expect(book.get(confirmation.id)?.status).toBe('approved');
      expect(book.pendingIn('window')).toBe(null);
    });

    await it('declines on an explicit no', async () => {
      const { book } = bookAt();
      const { confirmation, outcome } = book.propose('window', RUN);
      book.answer(confirmation.id, false);
      expect(await outcome).toStrictEqual({ type: 'declined' });
    });

    await it('never times out: a day later it is still pending and still answerable', async () => {
      const { book, advance } = bookAt();
      const { confirmation, outcome } = book.propose('window', RUN);
      advance(48 * 3_600_000);
      expect(book.get(confirmation.id)?.status).toBe('pending');
      book.answer(confirmation.id, true);
      expect(await outcome).toStrictEqual({ type: 'approved' });
    });

    await it('first answer wins; a late one changes nothing and says what it lost to', async () => {
      const { book } = bookAt();
      const { confirmation, outcome } = book.propose('window', RUN);
      book.answer(confirmation.id, false);
      const late = book.answer(confirmation.id, true);
      expect(late.type).toBe('late');
      if (late.type === 'late') expect(late.confirmation?.status).toBe('declined');
      expect(await outcome).toStrictEqual({ type: 'declined' });
      expect(book.get(confirmation.id)?.status).toBe('declined');
    });

    await it('an answer for an id the book never saw is late', async () => {
      const { book } = bookAt();
      const result = book.answer('c99', true);
      expect(result.type).toBe('late');
      if (result.type === 'late') expect(result.confirmation).toBe(null);
    });

    await it('a different proposal in the same scope supersedes the pending one', async () => {
      const { book } = bookAt();
      const first = book.propose('window', RUN);
      const second = book.propose('window', { ...RUN, summary: 'Run another command' });
      expect(await first.outcome).toStrictEqual({ type: 'expired', reason: 'superseded' });
      expect(book.pendingIn('window')?.id).toBe(second.confirmation.id);
      expect(book.answer(first.confirmation.id, true).type).toBe('late');
    });

    await it('scopes are independent: a chat proposal does not touch the window one', async () => {
      const { book } = bookAt();
      const window = book.propose('window', RUN);
      const chat = book.propose('chat:alice', RUN);
      expect(book.pendingIn('window')?.id).toBe(window.confirmation.id);
      expect(book.pendingIn('chat:alice')?.id).toBe(chat.confirmation.id);
      book.expireScope('chat:alice', 'new-message');
      expect(await chat.outcome).toStrictEqual({ type: 'expired', reason: 'new-message' });
      expect(book.get(window.confirmation.id)?.status).toBe('pending');
    });

    await it('expireAll closes everything and keeps the reason on the record', async () => {
      const { book } = bookAt();
      const a = book.propose('window', RUN);
      const b = book.propose('chat:alice', RUN);
      book.expireAll('session-ended');
      expect(await a.outcome).toStrictEqual({ type: 'expired', reason: 'session-ended' });
      expect(await b.outcome).toStrictEqual({ type: 'expired', reason: 'session-ended' });
      expect(book.get(a.confirmation.id)?.reason).toBe('session-ended');
      expect(book.pending().length).toBe(0);
    });

    await it('a yes after expiry is late and approves nothing', async () => {
      const { book } = bookAt();
      const { confirmation, outcome } = book.propose('window', RUN);
      book.expire(confirmation.id, 'turn-cancelled');
      expect(book.answer(confirmation.id, true).type).toBe('late');
      expect(await outcome).toStrictEqual({ type: 'expired', reason: 'turn-cancelled' });
      expect(book.get(confirmation.id)?.status).toBe('expired');
    });

    await it('a new book has nothing pending: a restart resumes nothing', async () => {
      const first = bookAt().book;
      const { confirmation } = first.propose('window', RUN);
      const fresh = bookAt().book;
      expect(fresh.pending().length).toBe(0);
      expect(fresh.answer(confirmation.id, true).type).toBe('late');
    });

    await it('tells subscribers of every change, and survives one that throws', async () => {
      const { book } = bookAt();
      const seen: string[] = [];
      book.subscribe(() => {
        throw new Error('broken surface');
      });
      const stop = book.subscribe((confirmation) => seen.push(confirmation.status));
      const { confirmation } = book.propose('window', RUN);
      book.answer(confirmation.id, true);
      stop();
      book.propose('window', RUN);
      expect(seen).toStrictEqual(['pending', 'approved']);
    });

    await it('latestIn finds the closed one, for a late yes in a chat', async () => {
      const { book } = bookAt();
      const { confirmation } = book.propose('chat:alice', RUN);
      book.expire(confirmation.id, 'new-message');
      expect(book.latestIn('chat:alice')?.status).toBe('expired');
      expect(book.latestIn('chat:bob')).toBe(null);
    });
  });

  await describe('confirmThen — nothing outward without a yes', async () => {
    const outcomes: Array<[string, (book: ConfirmationBook, id: string) => void]> = [
      ['a no', (book, id) => void book.answer(id, false)],
      ['an expiry', (book, id) => book.expire(id, 'new-message')],
      ['a superseding proposal', (book) => void book.propose('window', RUN)],
      ['the session ending', (book) => book.expireAll('session-ended')],
    ];
    for (const [name, close] of outcomes) {
      await it(`never runs the action after ${name}`, async () => {
        const { book } = bookAt();
        let ran = 0;
        const done = confirmThen(
          book,
          'window',
          RUN,
          () => ++ran,
          (confirmation) => {
            close(book, confirmation.id);
          },
        );
        const result = await done;
        expect(result.type).toBe('not-run');
        expect(ran).toBe(0);
      });
    }

    await it('never runs while the confirmation is still pending', async () => {
      const { book } = bookAt();
      let ran = 0;
      void confirmThen(book, 'window', RUN, () => ++ran);
      await Promise.resolve();
      expect(book.pendingIn('window') === null).toBe(false);
      expect(ran).toBe(0);
    });

    await it('runs the action exactly once, and only after an approval', async () => {
      const { book } = bookAt();
      let ran = 0;
      const done = confirmThen(
        book,
        'window',
        RUN,
        () => ++ran,
        (confirmation) => {
          expect(ran).toBe(0);
          book.answer(confirmation.id, true);
          book.answer(confirmation.id, true);
        },
      );
      const result = await done;
      expect(result.type).toBe('ran');
      expect(ran).toBe(1);
    });

    await it('does not leave an unseen question open when showing it failed', async () => {
      const { book } = bookAt();
      let ran = 0;
      const result = await confirmThen(
        book,
        'window',
        RUN,
        () => ++ran,
        () => {
          throw new Error('no surface');
        },
      );
      expect(result.type).toBe('not-run');
      expect(ran).toBe(0);
      expect(book.pending().length).toBe(0);
    });
  });

  await describe('readConfirmReply — the words that answer', async () => {
    await it('reads yes, ja, no and nein in any case, trimmed', async () => {
      expect(readConfirmReply('yes')).toBe(true);
      expect(readConfirmReply('  JA \n')).toBe(true);
      expect(readConfirmReply('No')).toBe(false);
      expect(readConfirmReply('nein')).toBe(false);
    });

    await it('reads anything else as not an answer', async () => {
      for (const text of ['', 'yes please', 'ok', 'y', 'jawohl', 'no, wait', 'A3 yes', '/run x']) {
        expect(readConfirmReply(text)).toBe(null);
      }
    });
  });

  await describe('age and status text', async () => {
    const at = '2026-01-01T10:00:00.000Z';
    await it('counts in minutes, hours and days', async () => {
      const after = (ms: number) => new Date(Date.parse(at) + ms);
      expect(confirmationAge(at, after(5_000))).toBe('just now');
      expect(confirmationAge(at, after(60_000))).toBe('1 minute ago');
      expect(confirmationAge(at, after(5 * 60_000))).toBe('5 minutes ago');
      expect(confirmationAge(at, after(3 * 3_600_000))).toBe('3 hours ago');
      expect(confirmationAge(at, after(2 * 86_400_000))).toBe('2 days ago');
      expect(confirmationAge('garbage', after(0))).toBe('');
    });

    await it('says what became of a closed one', async () => {
      const { book } = bookAt();
      const a = book.propose('window', RUN).confirmation;
      expect(confirmationStatusText(a)).toBe('Waiting for your answer');
      book.answer(a.id, true);
      expect(confirmationStatusText(book.get(a.id)!)).toBe('Approved');
      const b = book.propose('window', RUN).confirmation;
      book.expire(b.id, 'new-message');
      expect(confirmationStatusText(book.get(b.id)!)).toBe('Expired: you wrote something else');
    });
  });
};
