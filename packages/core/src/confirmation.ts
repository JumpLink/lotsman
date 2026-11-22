/**
 * Confirming an action Lotsman itself is about to take — pure, no surface, no clock of its own.
 *
 * [ADR 0011](../../../docs/adr/0011-language-first-commands-as-shortcuts.md) point 3: before anything
 * that leaves the machine or cannot be undone, Lotsman reads the action back and waits for an
 * explicit "yes". This file is that rule, once. The window, the messenger and (later) voice only
 * render a `Confirmation` and report what the person said; none decides anything.
 *
 * - **A confirmation says exactly what will happen** (`ConfirmationAction`): the kind, one sentence,
 *   and labelled details such as the command and its directory, or the recipient. What is shown is
 *   what is run — the caller builds the action once and runs that same data.
 * - **Nothing outward happens without an explicit approval.** There is no auto-approve and no
 *   default: `confirmThen` runs its action only on `approved`, and every other outcome is a refusal.
 * - **No timeout, on purpose.** A pending confirmation waits until it is answered. It *expires*
 *   when the situation it was asked in is gone: the person wrote something else, the turn was
 *   cancelled, the session ended, Lotsman restarted, or a different action was proposed in its
 *   place. A yes that arrives after any of that must not run work nobody was looking at — the same
 *   argument as `PermissionDesk.answer`'s id check.
 * - **First answer wins, everywhere.** `answer` closes the confirmation for every frontend; a later
 *   answer changes nothing and is reported as `late`, with the status it lost to.
 * - **Pending ones are never resumed.** The book lives in memory only. A restart starts with an empty
 *   book, so nothing from before it can be approved afterwards.
 * - **One pending per scope.** A scope is one place a person answers: the window, or one chat. A new
 *   proposal in a scope supersedes the pending one, so "yes" always means the one thing on screen.
 *
 * **Why `PermissionDesk` is not this.** An ACP `session/request_permission` offers the agent's own
 * option ids, may queue several at once and has an answer shape (`selected` + id) a yes/no cannot
 * carry, so folding it in would either drop the agent's options or let one proposal supersede an
 * unrelated tool call. The two share the rules that matter (fail closed, no timeout, first answer
 * wins) and the card in the window is drawn for both; the decision logic stays separate.
 */
import { _, _n, fmt } from './i18n.ts';

/** One labelled fact about the action, shown verbatim: `Command` → `git push`. */
export interface ConfirmationDetail {
  readonly label: string;
  readonly value: string;
}

/** What will happen if the person says yes. */
export interface ConfirmationAction {
  /** A machine-readable kind: `run-command`, `send-message`, `call`, `delete`… */
  readonly kind: string;
  /** One plain sentence: "Run a command in /home/me/project". */
  readonly summary: string;
  /** The specifics: command and directory, recipient and text. May be empty. */
  readonly details: readonly ConfirmationDetail[];
}

/** Why a pending confirmation can no longer be answered. */
export type ExpiryReason =
  /** The person sent a message that was not an answer. */
  | 'new-message'
  /** The person cancelled the turn. */
  | 'turn-cancelled'
  /** The session or the window ended. */
  | 'session-ended'
  /** Lotsman restarted (only ever seen through `expireAll`, since the book is not persisted). */
  | 'restart'
  /** A different action was proposed in the same scope. */
  | 'superseded';

export type ConfirmationStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface Confirmation {
  readonly id: string;
  /** Where it is answered: `window`, or `chat:<peer>`. */
  readonly scope: string;
  readonly action: ConfirmationAction;
  /** ISO timestamp. */
  readonly createdAt: string;
  readonly status: ConfirmationStatus;
  /** ISO timestamp of the approval, decline or expiry. */
  readonly decidedAt?: string;
  /** Set exactly when `status` is `expired`. */
  readonly reason?: ExpiryReason;
}

/** What the proposer gets back: the only three ways it can end. */
export type ConfirmationOutcome =
  | { readonly type: 'approved' }
  | { readonly type: 'declined' }
  | { readonly type: 'expired'; readonly reason: ExpiryReason };

/** What an answer did. `late` means someone else, or the situation, already closed it. */
export type ConfirmAnswerResult =
  | { readonly type: 'decided'; readonly confirmation: Confirmation }
  | { readonly type: 'late'; readonly confirmation: Confirmation | null };

export interface ConfirmationBookOptions {
  readonly now?: () => Date;
}

type Listener = (confirmation: Confirmation) => void;

interface Slot {
  current: Confirmation;
  readonly settle: (outcome: ConfirmationOutcome) => void;
}

export class ConfirmationBook {
  readonly #now: () => Date;
  readonly #slots = new Map<string, Slot>();
  readonly #listeners = new Set<Listener>();
  #next = 1;

  constructor(options: ConfirmationBookOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Put an action to the person. Resolves with the outcome — and only once somebody answered or the
   * situation changed; there is no deadline. A pending confirmation in the same scope is expired as
   * `superseded` first.
   */
  propose(
    scope: string,
    action: ConfirmationAction,
  ): { readonly confirmation: Confirmation; readonly outcome: Promise<ConfirmationOutcome> } {
    this.expireScope(scope, 'superseded');
    const confirmation: Confirmation = {
      id: `c${this.#next++}`,
      scope,
      action,
      createdAt: this.#now().toISOString(),
      status: 'pending',
    };
    let settle!: (outcome: ConfirmationOutcome) => void;
    const outcome = new Promise<ConfirmationOutcome>((resolve) => {
      settle = resolve;
    });
    this.#slots.set(confirmation.id, { current: confirmation, settle });
    this.#emit(confirmation);
    return { confirmation, outcome };
  }

  /** A person's yes or no. The first one wins; anything after it is `late` and changes nothing. */
  answer(id: string, approve: boolean): ConfirmAnswerResult {
    const slot = this.#slots.get(id);
    if (slot === undefined) return { type: 'late', confirmation: null };
    if (slot.current.status !== 'pending') return { type: 'late', confirmation: slot.current };
    const status = approve ? 'approved' : 'declined';
    const confirmation = this.#close(slot, { status, decidedAt: this.#now().toISOString() });
    slot.settle({ type: status });
    return { type: 'decided', confirmation };
  }

  /** The situation changed for this one. A no-op when it is already closed. */
  expire(id: string, reason: ExpiryReason): void {
    const slot = this.#slots.get(id);
    if (slot === undefined || slot.current.status !== 'pending') return;
    this.#close(slot, { status: 'expired', decidedAt: this.#now().toISOString(), reason });
    slot.settle({ type: 'expired', reason });
  }

  /** The situation changed for everything pending in one place. */
  expireScope(scope: string, reason: ExpiryReason): void {
    for (const confirmation of this.pending(scope)) this.expire(confirmation.id, reason);
  }

  /** The situation changed for everything pending anywhere (session end, shutdown). */
  expireAll(reason: ExpiryReason): void {
    for (const confirmation of this.pending()) this.expire(confirmation.id, reason);
  }

  get(id: string): Confirmation | null {
    return this.#slots.get(id)?.current ?? null;
  }

  /** What is waiting, oldest first; in one scope or in all. */
  pending(scope?: string): Confirmation[] {
    return this.all().filter(
      (confirmation) =>
        confirmation.status === 'pending' && (scope === undefined || confirmation.scope === scope),
    );
  }

  /** The single pending confirmation of a scope, or `null`. */
  pendingIn(scope: string): Confirmation | null {
    return this.pending(scope)[0] ?? null;
  }

  /** The newest confirmation of a scope, pending or closed — for answering a late yes. */
  latestIn(scope: string): Confirmation | null {
    const all = this.all().filter((confirmation) => confirmation.scope === scope);
    return all[all.length - 1] ?? null;
  }

  /** Everything the book has seen this run, oldest first. */
  all(): Confirmation[] {
    return Array.from(this.#slots.values(), (slot) => slot.current);
  }

  /** Hear every change (proposed, approved, declined, expired). Returns the way to stop. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #close(slot: Slot, change: Pick<Confirmation, 'status' | 'decidedAt' | 'reason'>): Confirmation {
    slot.current = { ...slot.current, ...change };
    this.#emit(slot.current);
    return slot.current;
  }

  #emit(confirmation: Confirmation): void {
    for (const listener of this.#listeners) {
      try {
        listener(confirmation);
      } catch {
        // A surface that throws must not decide, or fail to decide, for the others.
      }
    }
  }
}

/** The result of `confirmThen`: the action ran, or it did not and here is why. */
export type ConfirmedRun<T> =
  | { readonly type: 'ran'; readonly value: T }
  | { readonly type: 'not-run'; readonly outcome: ConfirmationOutcome };

/**
 * The one door for an outward action: propose, wait, and run `run` **only** on an explicit approval.
 * `onProposed` is how a surface is told what to show (the chat sends its text from here).
 * A throwing `onProposed` expires the confirmation rather than leaving an unseen question open.
 */
export async function confirmThen<T>(
  book: ConfirmationBook,
  scope: string,
  action: ConfirmationAction,
  run: () => T | Promise<T>,
  onProposed?: (confirmation: Confirmation) => void | Promise<void>,
): Promise<ConfirmedRun<T>> {
  const { confirmation, outcome } = book.propose(scope, action);
  if (onProposed !== undefined) {
    try {
      await onProposed(confirmation);
    } catch {
      book.expire(confirmation.id, 'session-ended');
    }
  }
  const settled = await outcome;
  if (settled.type !== 'approved') return { type: 'not-run', outcome: settled };
  return { type: 'ran', value: await run() };
}

/** A typed reply read as an answer: `yes`/`ja` and `no`/`nein`, trimmed, any case. Else `null`. */
export function readConfirmReply(text: string): boolean | null {
  const word = text.trim().toLowerCase();
  if (word === 'yes' || word === 'ja') return true;
  if (word === 'no' || word === 'nein') return false;
  return null;
}

/** How long ago, in the person's words. No clock inside: the caller says what "now" is. */
export function confirmationAge(createdAt: string, now: Date): string {
  const made = Date.parse(createdAt);
  if (Number.isNaN(made)) return '';
  const minutes = Math.max(0, Math.floor((now.getTime() - made) / 60_000));
  if (minutes < 1) return _('just now');
  if (minutes < 60) return fmt(_n('{count} minute ago', '{count} minutes ago', minutes), { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return fmt(_n('{count} hour ago', '{count} hours ago', hours), { count: hours });
  const days = Math.floor(hours / 24);
  return fmt(_n('{count} day ago', '{count} days ago', days), { count: days });
}

/** The sentence under a closed card: what became of it. */
export function confirmationStatusText(confirmation: Confirmation): string {
  switch (confirmation.status) {
    case 'pending':
      return _('Waiting for your answer');
    case 'approved':
      return _('Approved');
    case 'declined':
      return _('Declined');
    case 'expired':
      return fmt(_('Expired: {reason}'), { reason: expiryText(confirmation.reason) });
  }
}

/** Why it expired, in words. */
export function expiryText(reason: ExpiryReason | undefined): string {
  switch (reason) {
    case 'new-message':
      return _('you wrote something else');
    case 'turn-cancelled':
      return _('the turn was cancelled');
    case 'session-ended':
      return _('the session ended');
    case 'restart':
      return _('Lotsman restarted');
    case 'superseded':
      return _('a different action was proposed');
    default:
      return _('the situation changed');
  }
}
