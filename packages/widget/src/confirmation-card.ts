/**
 * The confirmation card: what Lotsman is about to do, and the two buttons that decide it.
 *
 * **This file renders and nothing else.** What a confirmation is, who wins a double answer and when
 * it expires is `core/confirmation.ts`; the card reads a `Confirmation` and reports a yes or a no
 * through `onAnswer`. It is a transcript row, not a dialog, so it stays where it was asked: after the
 * decision the buttons go and the card says what became of it.
 *
 * Neither button takes the initial focus and there is no default response — a stray Enter must not
 * approve an outward action, the same rule `permission-dialog.ts` keeps.
 */
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import { _, confirmationAge, confirmationStatusText, type Confirmation } from '@lotsman/core';

import { CSS } from './css.ts';

function label(text: string, cssClasses: readonly string[], selectable = true): Gtk.Label {
  return new Gtk.Label({
    label: text,
    useMarkup: false,
    wrap: true,
    selectable,
    xalign: 0,
    hexpand: true,
    ellipsize: Pango.EllipsizeMode.NONE,
    cssClasses: [...cssClasses],
  });
}

export function buildConfirmationCard(
  confirmation: Confirmation,
  now: Date,
  onAnswer: (id: string, approve: boolean) => void,
): Gtk.Widget {
  const card = new Gtk.Box({
    orientation: Gtk.Orientation.VERTICAL,
    spacing: 8,
    cssClasses: ['card', CSS.toolCard, CSS.confirmCard],
  });
  const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
  head.append(new Gtk.Image({ iconName: 'dialog-warning-symbolic', pixelSize: 16 }));
  head.append(label(confirmation.action.summary, [CSS.toolTitle], false));
  card.append(head);

  for (const detail of confirmation.action.details) {
    const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    row.append(label(detail.label, [CSS.dim, 'caption'], false));
    row.append(label(detail.value, [CSS.mono, CSS.confirmDetail]));
    card.append(row);
  }

  const age = confirmationAge(confirmation.createdAt, now);
  if (confirmation.status === 'pending') {
    card.append(label(age, [CSS.dim, 'caption'], false));
    const buttons = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
      halign: Gtk.Align.END,
    });
    const no = new Gtk.Button({ label: _('No') });
    const yes = new Gtk.Button({ label: _('Yes'), cssClasses: ['suggested-action'] });
    no.set_focus_on_click(false);
    yes.set_focus_on_click(false);
    no.connect('clicked', () => onAnswer(confirmation.id, false));
    yes.connect('clicked', () => onAnswer(confirmation.id, true));
    buttons.append(no);
    buttons.append(yes);
    card.append(buttons);
  } else {
    const tone = { approved: 'success', declined: 'dim-label', expired: 'warning' }[confirmation.status];
    card.add_css_class(CSS.confirmClosed);
    card.append(
      label(`${confirmationStatusText(confirmation)} · ${age}`, [tone ?? CSS.dim, 'caption'], false),
    );
  }
  return card;
}
