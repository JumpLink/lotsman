/**
 * The composer: the message entry and the buttons under the conversation.
 *
 * **It is a bottom bar, not a child of the transcript.** A bottom bar does not move when the
 * transcript scrolls, so the text being written stays where it was written. It is also one of the
 * three things `createNavShell` cannot host, which is the measured reason the shell is hand-built
 * (`window.ts`'s header).
 *
 * **The field, the Send/Stop button and the rounded bar are gjsify's own**: `ComposerBar`,
 * `ChatEntry` and `ChatActionButton` from `@gjsify/adwaita-extended`, shared with Curlew. This file
 * only decides what they show. Read-aloud and push to talk are slot buttons in the bar's end slot;
 * the agent's settings row sits under the bar.
 *
 * **The button is one widget whose action is swapped, never two widgets shown and hidden.**
 * `composerView` returns one action and `ChatActionButton.setAction` keeps icon, tooltip and
 * accessible label in step. The label is never blank: it is the action's own name, plus the reason
 * when `composerView` has one.
 *
 * **Nothing here is markup.** `ChatEntry` wraps a `Gtk.TextView`, which has no markup rendering, and
 * the status line is a plain label.
 *
 * **`clearDraft` is a method rather than a side effect of `setState`.** Whether a draft survives a
 * state change is a decision, and it lives in `core/composer-state.ts` as `keepsDraft`.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';
import { ComposerBar } from '@gjsify/adwaita-extended';

import { _, composerView, dictationInsertion, type ComposerInput, type DictationView } from '@lotsman/core';
import { CONTENT_MAX_WIDTH_PX } from './constants.ts';

/**
 * The Send icon. **`send-symbolic` and `arrow-up-symbolic` do not exist** — checked with
 * `Gtk.IconTheme.has_icon` and recorded in `scripts/probes/icon-names.mjs`. An up arrow rather than
 * the paper plane: inside a round button an envelope-and-arrow is not read as one glyph.
 */
const SEND_ICON = 'go-up-symbolic';
/** The Stop icon. A filled square, which is what stopping a running turn looks like. */
const STOP_ICON = 'process-stop-symbolic';
/** **`speaker-symbolic` does not exist**; `audio-speakers-symbolic` does, and is not a volume control. */
const READ_ALOUD_ICON = 'audio-speakers-symbolic';
const DICTATION_ICON = 'audio-input-microphone-symbolic';
/** Labels are functions, not constants: a lookup at module load would run before a translator registers. */
const dictationLabel = () => _('Speak');
const sendLabel = () => _('Send');
const stopLabel = () => _('Stop');
const readAloudLabel = () => _('Conversation');
const readAloudTooltip = () => _("Read the agent's answers aloud.");
const placeholder = () => _('Ask the agent…');

/** Visible lines of the entry: the resting height and where it stops growing and starts scrolling. */
const ENTRY_MIN_LINES = 2;
const ENTRY_MAX_LINES = 7;

export interface ComposerOptions {
  /**
   * Called with the entry's text when Send is pressed. Only reachable while an agent is attached and a
   * session is open, because `composerView` disables the button otherwise.
   *
   * The window's implementation appends the prompt to the store and the transcript itself: the surface
   * that will show it is the one that has to write it, and a controller that recorded it would mean the
   * controller knew about a widget it does not own.
   */
  readonly onSend?: (text: string) => void;
  /** Called when Stop is pressed. Reachable only while a turn runs, so it needs no guard. */
  readonly onStop?: () => void;
  /**
   * Called when the read-aloud toggle is flipped by a person.
   *
   * **Absent means the toggle is not built at all**, and that is the whole gate: `readAloudOffered`
   * says whether the host gave a speech engine and whether the `voice` policy allows one, and a
   * control for a feature that cannot run is worse than no control. Not built rather than built and
   * disabled, because a disabled toggle is a promise with no way to keep it.
   */
  readonly onReadAloud?: (on: boolean) => void;
  /**
   * Push to talk: the microphone button went down / came up. **Absent means no button**, the same
   * gate as `onReadAloud`. What a press means (record, or install the model) is the host's, from
   * `DictationView.installs`; the composer only reports the pointer.
   */
  readonly onDictationPress?: () => void;
  readonly onDictationRelease?: () => void;
  /**
   * The render inputs, read once. See `core/composer-state.ts`: every one of them is somebody else's
   * answer (the turn machine, the agent's life, which session is open), which is what makes the composer
   * a renderer rather than a second opinion.
   */
  readonly input: ComposerInput;
  /**
   * `ConfigRow.widget`, packed along the inside of the card next to Send.
   *
   * **A widget to place, not a row to drive.** The composer never calls a method on it, never reads it
   * and never shows or hides it — `ConfigRow` does all of that on the agent's answer, on its own clock
   * (`window.ts`'s field comment). Passing the widget rather than the object is what keeps that true:
   * there is nothing here to call.
   */
  readonly config: Gtk.Widget;
}

export class Composer {
  /** Pack this into the `Adw.ToolbarView` as its bottom bar. */
  readonly widget: Gtk.Widget;

  readonly #bar: ComposerBar;
  /** The read-aloud toggle, or `null` when the host offered no speech engine. */
  readonly #readAloud: Gtk.ToggleButton | null;
  /** The microphone button, or `null` when the host offered no recogniser. */
  readonly #dictation: Gtk.Button | null;
  #dictationView: DictationView | null = null;
  readonly #onSend: ((text: string) => void) | undefined;
  readonly #onStop: (() => void) | undefined;
  readonly #onReadAloud: ((on: boolean) => void) | undefined;
  /** True while `setReadAloud` moves the toggle, so the host is not told about its own change. */
  #syncingReadAloud = false;
  #input: ComposerInput;

  constructor(options: ComposerOptions) {
    this.#input = options.input;
    this.#onSend = options.onSend;
    this.#onStop = options.onStop;
    this.#onReadAloud = options.onReadAloud;

    this.#bar = new ComposerBar();
    this.#bar.entry.setPlaceholder(placeholder());
    this.#bar.entry.setLines(ENTRY_MIN_LINES, ENTRY_MAX_LINES);
    // Enter sends, Shift/Ctrl+Enter breaks the line (the entry decides). It goes through the SAME
    // `#activate()` as the button, so there is one send path rather than two that can disagree.
    // A signal registered through `registerClass` is not in the generated signatures.
    (this.#bar.entry as GObject.Object).connect('submit' as never, () => this.#activate());
    this.#bar.actionButton.connect('clicked', () => this.#activate());

    // Read-aloud and push to talk are slot buttons, and only when there is something to use.
    this.#readAloud = this.#onReadAloud ? this.#buildReadAloud() : null;
    if (this.#readAloud) this.#bar.addEnd(this.#readAloud);
    this.#dictation =
      options.onDictationPress && options.onDictationRelease
        ? this.#buildDictation(options.onDictationPress, options.onDictationRelease)
        : null;
    if (this.#dictation) this.#bar.addEnd(this.#dictation);

    // The bar lifts off the window's edges by margins, bottom larger than top: below it there is only
    // the window edge, above it the transcript's own margin. The bottom bar is `flat` (`chat.blp`).
    this.#bar.set_margin_top(6);
    this.#bar.set_margin_bottom(12);
    this.#bar.set_margin_start(12);
    this.#bar.set_margin_end(12);

    // **The agent's settings under the bar.** The wrapper is always visible: the config row hides
    // itself whenever the agent offers no settings (`config-row.ts`), and the column must not shift.
    const settings = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      hexpand: true,
      marginStart: 12,
      marginEnd: 12,
      marginBottom: 6,
    });
    settings.append(options.config);

    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    column.append(this.#bar);
    column.append(settings);

    // **The same clamp maximum as the transcript, imported rather than written out**: the
    // conversation and the thing you type into it are one column.
    this.widget = new Adw.Clamp({
      child: column,
      maximumSize: CONTENT_MAX_WIDTH_PX,
      tighteningThreshold: CONTENT_MAX_WIDTH_PX,
    });

    this.#render();
  }

  /** New render inputs. Renders through `composerView` and nothing else. */
  setInput(input: ComposerInput): void {
    this.#input = input;
    this.#render();
  }

  /** Whether reading aloud is on. `false` when the toggle was never built. */
  get readAloudOn(): boolean {
    return this.#readAloud?.active ?? false;
  }

  /**
   * Move the toggle without telling the host about it, so a host that mirrors the toggle has no loop.
   */
  setReadAloud(on: boolean): void {
    if (!this.#readAloud || this.#readAloud.active === on) return;
    this.#syncingReadAloud = true;
    this.#readAloud.active = on;
    this.#syncingReadAloud = false;
  }

  /** Render the microphone button and its line from `dictationView`. */
  setDictation(view: DictationView): void {
    this.#dictationView = view;
    if (this.#dictation) {
      this.#dictation.sensitive = view.buttonEnabled;
      this.#dictation.tooltipText = view.tooltip;
      this.#dictation.remove_css_class('destructive-action');
      if (view.recording) this.#dictation.add_css_class('destructive-action');
    }
    this.#render();
  }

  /**
   * Put dictated text into the entry at the cursor, for review. **Never sends.** The spacing is
   * core's `dictationInsertion`, so words do not run together or double a space.
   */
  insertAtCursor(text: string): void {
    const view = this.#bar.entry.textView;
    const buffer = view.get_buffer();
    const start = buffer.get_start_iter();
    const end = buffer.get_end_iter();
    const cursor = buffer.get_iter_at_mark(buffer.get_insert());
    const insertion = dictationInsertion(
      buffer.get_text(start, cursor, false),
      buffer.get_text(cursor, end, false),
      text,
    );
    if (insertion === '') return;
    buffer.insert_at_cursor(insertion, -1);
    this.#bar.entry.grabFocus();
  }

  /**
   * Press and hold, not click: a capture-phase gesture on the button, so the button's own `clicked`
   * (which fires on release) is not the trigger. Keyboard activation does nothing here — the hold
   * key (chat.ts) is the keyboard path.
   */
  #buildDictation(onPress: () => void, onRelease: () => void): Gtk.Button {
    const button = new Gtk.Button({
      iconName: DICTATION_ICON,
      valign: Gtk.Align.END,
      cssClasses: ['circular', 'flat'],
    });
    button.update_property([Gtk.AccessibleProperty.LABEL], [dictationLabel()]);
    const gesture = new Gtk.GestureClick({ button: 1, propagationPhase: Gtk.PropagationPhase.CAPTURE });
    gesture.connect('pressed', () => onPress());
    gesture.connect('released', () => onRelease());
    gesture.connect('cancel', () => onRelease());
    button.add_controller(gesture);
    return button;
  }

  /**
   * The toggle, named in the tooltip and the accessible label: an icon-only button with neither is
   * announced as nothing at all.
   */
  #buildReadAloud(): Gtk.ToggleButton {
    const toggle = new Gtk.ToggleButton({
      iconName: READ_ALOUD_ICON,
      valign: Gtk.Align.END,
      tooltipText: readAloudTooltip(),
      cssClasses: ['circular', 'flat'],
    });
    toggle.update_property([Gtk.AccessibleProperty.LABEL], [readAloudLabel()]);
    toggle.connect('toggled', () => {
      if (this.#syncingReadAloud) return;
      this.#onReadAloud?.(toggle.active);
    });
    return toggle;
  }

  /**
   * Press the composer's own button, the way a pointer press does.
   *
   * **`emit('clicked')` and not the callback**: calling `onStop` directly would be a second way to
   * press Stop, and the two would drift the moment the handler grew a step. **A no-op when the button
   * is not Stop**: the turn may have settled since the hook fired, and clicking Send would send a prompt.
   */
  stop(): void {
    if (composerView(this.#input).action !== 'stop') return;
    this.#bar.actionButton.emit('clicked');
  }

  /** Empty the entry. The *caller* decides whether to — see `keepsDraft`. */
  clearDraft(): void {
    this.#bar.entry.clear();
  }

  /** The entry's text, trimmed. Trimmed here so "did I type anything" has exactly one answer. */
  text(): string {
    return this.#bar.entry.getText().trim();
  }

  /**
   * The one send path, reached from the button and from Enter.
   *
   * It asks `composerView` again rather than trusting the last render: a key press can arrive
   * between a cancel going out and the next frame, and a control acting on a stale view is the
   * control this window forbids.
   */
  #activate(): void {
    const view = composerView(this.#input);
    if (!view.buttonEnabled) return;
    if (view.action === 'stop') {
      this.#onStop?.();
      return;
    }
    this.#onSend?.(this.text());
  }

  /** Render the whole composer from `composerView`; rebuilt rather than diffed. */
  #render(): void {
    const view = composerView(this.#input);
    const isStop = view.action === 'stop';
    const name = isStop ? stopLabel() : sendLabel();

    // `ChatActionButton` keeps icon, tooltip and accessible label in step. The label is never blank:
    // `view.reason` is `''` exactly when the button works, so it is the action's own name plus the
    // reason when there is one. `suggested` is off for Stop; it is styled destructive instead.
    const button = this.#bar.actionButton;
    button.setAction({
      iconName: isStop ? STOP_ICON : SEND_ICON,
      label: view.reason ? `${name} — ${view.reason}` : name,
      sensitive: view.buttonEnabled,
      suggested: !isStop,
    });
    button.remove_css_class('destructive-action');
    if (isStop) button.add_css_class('destructive-action');

    // Editable, not insensitive: a read-only entry keeps its text and its colours.
    this.#bar.entry.textView.editable = view.entryEditable;
    this.#bar.entry.tooltipText = view.reason;

    // **On screen, not only on hover.** The reason wins over the status; a reason the page above
    // already states (`reasonOnPage`) stays in the tooltip and the accessible name only.
    this.#bar.setStatus((view.reasonOnPage ? '' : view.reason) || this.#dictationView?.status || view.status);
  }
}
