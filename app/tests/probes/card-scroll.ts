/**
 * Whether a freshly proposed confirmation card is fully on screen, buttons included — measured on the
 * real `TranscriptView`, because the defect lived in how the follow meets a row whose height settles
 * after it is appended, which `core/scroll.ts` cannot see.
 *
 * Run under a private compositor, never the real desktop:
 *
 * ```sh
 * ./node_modules/.bin/gjsify build app/tests/probes/card-scroll.ts --app gjs --outfile /tmp/card-scroll.gjs.mjs
 * <werkstatt>/scripts/headless-run -- ./node_modules/.bin/gjsify run /tmp/card-scroll.gjs.mjs
 * ```
 *
 * Exits 1 when a case fails. Cases: a card at the end of a long transcript (buttons inside the
 * viewport), the same card decided (no jump), and a reader who scrolled up (not yanked).
 */
import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import { ConfirmationBook, CONFIRMATION_HOST_TYPE, type ConfirmationAction } from '@lotsman/core';
import type { TranscriptEntry } from '@lotsman/session';
// Reached past the barrel on purpose: the follow is the view's own, and a host never constructs one.
import { TranscriptView } from '../../../packages/widget/src/transcript-view.ts';

Adw.init();
const loop = new GLib.MainLoop(null, false);
const SETTLE_MS = 700;

const action: ConfirmationAction = {
  kind: 'run',
  summary: 'Run the task “tests” in /tmp/lotsman-demo',
  details: [
    { label: 'Task', value: 'tests' },
    { label: 'Directory', value: '/tmp/lotsman-demo' },
    { label: 'Prompt', value: 'Run the tests' },
  ],
};

function text(kind: 'user' | 'agent', index: number): TranscriptEntry {
  return {
    kind,
    text: `${kind} message ${index}. `.repeat(12),
    at: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  };
}

function cardEntry(id: string, at: number): TranscriptEntry {
  return {
    kind: 'host',
    text: action.summary,
    at: new Date(2026, 0, 1, 1, 0, at).toISOString(),
    host: { type: CONFIRMATION_HOST_TYPE, icon: 'dialog-warning-symbolic', data: { id, action } },
  };
}

function findButton(root: Gtk.Widget, label: string): Gtk.Button | null {
  if (root instanceof Gtk.Button && root.get_label() === label) return root;
  for (let child = root.get_first_child(); child; child = child.get_next_sibling()) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

/** The buttons' bottom edge in the viewport's own coordinates, or null when not allocated. */
function bottomOf(view: TranscriptView, label: string): number | null {
  const button = findButton(view.widget, label);
  if (!button) return null;
  const [ok, rect] = button.compute_bounds(view.widget);
  return ok ? rect.get_y() + rect.get_height() : null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (resolve(), GLib.SOURCE_REMOVE)),
  );
}

function build(): {
  view: TranscriptView;
  book: ConfirmationBook;
  window: Adw.Window;
  entries: TranscriptEntry[];
} {
  const book = new ConfirmationBook();
  const view = new TranscriptView();
  view.setConfirmations(book);
  const entries = Array.from({ length: 10 }, (_unused, i) => text(i % 2 === 0 ? 'user' : 'agent', i));
  view.setEntries(entries);
  const window = new Adw.Window({ defaultWidth: 640, defaultHeight: 520, content: view.widget });
  window.present();
  return { view, book, window, entries };
}

async function propose(view: TranscriptView, book: ConfirmationBook, n: number): Promise<string> {
  const { confirmation } = book.propose('window', action);
  view.appendEntries([cardEntry(confirmation.id, n)]);
  return confirmation.id;
}

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  print(`${ok ? 'ok     ' : 'FAILED '} ${name} — ${detail}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  {
    const { view, book, window } = build();
    await pause(SETTLE_MS);
    await propose(view, book, 1);
    await pause(SETTLE_MS);
    const height = view.widget.get_height();
    const bottom = bottomOf(view, 'Yes');
    check(
      'card at the end shows its buttons',
      bottom !== null && bottom <= height,
      `yes bottom ${bottom}, viewport ${height}`,
    );
    const adj = (view.widget as Gtk.ScrolledWindow).get_vadjustment();
    const before = adj.get_value();
    book.answer(book.pending()[0]!.id, true);
    await pause(SETTLE_MS);
    const after = adj.get_value();
    const atEnd = adj.get_upper() - adj.get_page_size() - after <= 1;
    check(
      'a decided card keeps the end in view',
      atEnd,
      `value ${before} → ${after}, upper ${adj.get_upper()}, page ${adj.get_page_size()}`,
    );
    window.destroy();
  }
  {
    const { view, book, window } = build();
    await pause(SETTLE_MS);
    const adj = (view.widget as Gtk.ScrolledWindow).get_vadjustment();
    adj.set_value(0);
    await pause(200);
    await propose(view, book, 1);
    await pause(SETTLE_MS);
    check('a reader who scrolled up is not moved', adj.get_value() === 0, `value ${adj.get_value()}`);
    window.destroy();
  }
  print(failures === 0 ? '\nall cases passed' : `\n${failures} case(s) failed`);
  loop.quit();
}

main().catch((error) => {
  print(`FAILED: ${error}`);
  failures += 1;
  loop.quit();
});
loop.run();
imports.system.exit(failures === 0 ? 0 : 1);
