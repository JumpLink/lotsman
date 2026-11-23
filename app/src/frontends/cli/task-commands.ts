/**
 * What `lotsman run`, `lotsman tasks` and `lotsman status` do, and what the chat commands `/run`, `/tasks`
 * and `/status` say: one implementation, two surfaces (ADR 0007 §9–11). Nothing here calls a model
 * except `runTask` itself.
 */

import { _, fmt } from '../../i18n.ts';

import {
  formatQuestionId,
  isOpen,
  LOCKED,
  localTime,
  parseRunArgs,
  renderTask,
  runTask,
  TaskFileError,
  TaskUsageError,
  type ConfirmationAction,
  type ConfirmationOutcome,
  type ConfirmedRun,
  type RunDeps,
  type SkillTask,
  type TaskRun,
} from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { questionBook } from '../../core/question-state.ts';
import { runningTasks, runState, type RunRecord } from '../../core/run-state.ts';
import { listTasks, type TaskEntry } from '../../core/skills.ts';

/** `lotsman run`'s exit codes: done, failed, usage error, needs a person. */
export const EXIT = { done: 0, failed: 1, usage: 2, 'needs-person': 3 } as const;

export type RunReport =
  | { readonly code: 0 | 1 | 3; readonly result: TaskRun }
  | { readonly code: 2; readonly result: { readonly status: 'usage'; readonly reason: string } };

/** Run one task; a unknown task or a bad parameter is code 2, not an exception. */
export async function runReport(
  id: string,
  params: Readonly<Record<string, string>>,
  deps: RunDeps,
): Promise<RunReport> {
  try {
    const result = await runTask(id, params, deps);
    return { code: EXIT[result.status], result };
  } catch (error) {
    if (error instanceof TaskUsageError)
      return { code: 2, result: { status: 'usage', reason: error.message } };
    throw error;
  }
}

/** How a surface asks the person: `AgentSession.confirm` in the window, `confirmInChat` in the chat. */
export type Confirm = <T>(action: ConfirmationAction, run: () => Promise<T>) => Promise<ConfirmedRun<T>>;

/**
 * What a confirmed run says it will do — built once from the same task and parameters the run uses.
 *
 * The prompt is the exact text the agent is sent and the directory is where the session starts: a task
 * has no shell command of its own, the prompt is what it runs. Throws `TaskUsageError` for an unknown
 * task or bad parameters, so a request that could never run is refused before anyone is asked.
 */
export function runAction(
  lookup: (id: string) => SkillTask | null,
  id: string,
  params: Readonly<Record<string, string>>,
): ConfirmationAction {
  const skill = lookup(id);
  if (!skill) throw new TaskUsageError(fmt(_('there is no task "{id}"; `lotsman tasks` lists them'), { id }));
  const { prompt } = renderTask(skill, params);
  const given = Object.entries(params).map(([name, value]) => `${name}=${value}`);
  return {
    kind: 'run-task',
    summary: fmt(_('Run the task "{id}" in {cwd}'), { id, cwd: skill.cwd }),
    details: [
      { label: _('Task'), value: id },
      ...(given.length > 0 ? [{ label: _('Parameters'), value: given.join(' ') }] : []),
      { label: _('Directory'), value: skill.cwd },
      { label: _('Prompt'), value: prompt },
    ],
  };
}

export function notRunText(outcome: ConfirmationOutcome): string {
  return outcome.type === 'declined'
    ? _('Not run: you said no.')
    : _('Not run: the question expired before it was answered.');
}

/**
 * The one way a run is started on someone's behalf — `/run` in the chat and the `lotsman_run` tool
 * both end here. Nothing runs unless `confirm` comes back approved; the text says what happened.
 */
export async function confirmedRun(
  id: string,
  params: Readonly<Record<string, string>>,
  deps: RunDeps,
  confirm: Confirm,
): Promise<string> {
  let action: ConfirmationAction;
  try {
    action = runAction(deps.skill, id, params);
  } catch (error) {
    if (error instanceof TaskUsageError)
      return reportText({ code: 2, result: { status: 'usage', reason: error.message } });
    if (error instanceof TaskFileError) return fmt(_('Failed: {reason}'), { reason: error.message });
    throw error;
  }
  const done = await confirm(action, () => runReport(id, params, deps));
  return done.type === 'ran' ? reportText(done.value) : notRunText(done.outcome);
}

/** The words after `/run`, confirmed and run. */
export async function confirmedRunFromText(args: string, deps: RunDeps, confirm: Confirm): Promise<string> {
  try {
    const { id, params } = parseRunArgs(args);
    return await confirmedRun(id, params, deps, confirm);
  } catch (error) {
    if (error instanceof TaskUsageError)
      return reportText({ code: 2, result: { status: 'usage', reason: error.message } });
    throw error;
  }
}

export function reportText(report: RunReport): string {
  const { result } = report;
  switch (result.status) {
    case 'done':
      return result.output || _('Done.');
    case 'needs-person':
      return fmt(_('Waiting for you: {id}. Answer it with `lotsman answer {id} <text>`.'), {
        id: formatQuestionId(result.questionId),
      });
    case 'usage':
      return fmt(_('Not started: {reason}'), { reason: result.reason });
    default:
      return fmt(_('Failed: {reason}'), {
        reason: result.reason === LOCKED ? _('another run of this task is still in progress') : result.reason,
      });
  }
}

export function tasksText(entries: readonly TaskEntry[]): string {
  if (entries.length === 0) return _('No tasks.');
  return entries
    .map((entry) => {
      const params = entry.params.length > 0 ? ` (${entry.params.join(', ')})` : '';
      const note = entry.problem ? ` — ${entry.problem}` : entry.description ? ` — ${entry.description}` : '';
      return `${entry.id}${params}${note}`;
    })
    .join('\n');
}

export interface StatusReport {
  readonly running: readonly string[];
  readonly recent: Readonly<Record<string, RunRecord>>;
  readonly questions: readonly { id: string; task: string; kind: string; expiresAt: string }[];
}

export function statusReport(listen: ListenPaths, now: Date = new Date()): StatusReport {
  const book = questionBook(
    listen.stateDir,
    () => now,
    () => {},
  ).read();
  return {
    running: runningTasks(listen.stateDir),
    recent: runState(listen.stateDir).all(),
    questions: book
      .filter((question) => isOpen(question, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ id, task, kind, expiresAt }) => ({ id: formatQuestionId(id), task, kind, expiresAt })),
  };
}

/** How many finished runs `/status` and `lotsman status` list. */
const RECENT_RUNS = 10;

/** A run's outcome in words. */
function outcomeText(outcome: RunRecord['outcome']): string {
  switch (outcome) {
    case 'done':
      return _('done');
    case 'asked':
      return _('waiting for you');
    case 'declined':
      return _('declined');
    case 'nothing':
      return _('nothing to do');
    case 'skipped':
      return _('skipped');
    default:
      return _('failed');
  }
}

export interface StatusTextOptions {
  /** The ids of the tasks that exist; a run of any other task is left out. Everything, when absent. */
  readonly known?: ReadonlySet<string>;
  /** For tests; people get the host's locale. */
  readonly locale?: string;
}

export function statusText(report: StatusReport, options: StatusTextOptions = {}): string {
  const { known, locale } = options;
  const lines: string[] = [];
  lines.push(
    report.running.length > 0
      ? fmt(_('Running: {tasks}'), { tasks: report.running.join(', ') })
      : _('Nothing is running.'),
  );
  const recent = Object.entries(report.recent)
    .filter(([task]) => !known || known.has(task))
    .sort((a, b) => b[1].endedAt.localeCompare(a[1].endedAt));
  for (const [task, run] of recent.slice(0, RECENT_RUNS))
    lines.push(
      fmt(_('{task}: {outcome} at {time}'), {
        task,
        outcome: outcomeText(run.outcome),
        time: localTime(run.endedAt, locale),
      }),
    );
  for (const question of report.questions)
    lines.push(
      fmt(_('Open: {id} ({task}) until {time}'), {
        id: question.id,
        task: question.task,
        time: localTime(question.expiresAt, locale),
      }),
    );
  return lines.join('\n');
}

/** The ids of the tasks in `tasksDir`, for `statusText`. */
export function knownTasks(tasksDir: string): ReadonlySet<string> {
  return new Set(listTasks(tasksDir).map((entry) => entry.id));
}

/**
 * `/tasks` and `lotsman tasks`, and the agent's tasks tool: the entries and their text, from one read.
 * The three surfaces differ only in how they carry it (a chat message, a terminal line, a tool result).
 */
export function tasksView(listen: ListenPaths): {
  readonly entries: readonly TaskEntry[];
  readonly text: string;
} {
  const entries = listTasks(listen.tasksDir);
  return { entries, text: tasksText(entries) };
}

/** `/status` and `lotsman status`, and the agent's status tool: the report and its text, from one read. */
export function statusView(
  listen: ListenPaths,
  options: { readonly now?: Date; readonly locale?: string } = {},
): { readonly report: StatusReport; readonly text: string } {
  const report = statusReport(listen, options.now);
  return {
    report,
    text: statusText(report, {
      known: knownTasks(listen.tasksDir),
      ...(options.locale ? { locale: options.locale } : {}),
    }),
  };
}
