/**
 * What Lotsman offers an agent as tools (`lotsman mcp`), and the chat commands that say the same things
 * (ADR 0011). Each is ONE function in `task-commands.ts`; the slash command and the tool both call it, so
 * they cannot answer differently.
 *
 * **Two tools read, one asks.** `lotsman_status` and `lotsman_tasks` change nothing. `lotsman_run` runs a
 * task, which can leave the machine, so it never runs one itself: it checks the request and files it in
 * the run inbox (`core/run-inbox.ts`); the window or `lotsman listen` takes it, asks the person through
 * the shared confirmation (ADR 0011 step 3) and runs it only after a yes. `/run` in the chat goes through
 * the same `confirmedRun`. Add a tool that changes or sends anything only the same way.
 *
 * The descriptions are for the model, in English and not translated: a model picks a tool by what its
 * description says, and they name the plain requests a person makes ("what's on today?").
 */

import type { ChatCommands, ToolDefinition } from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { runInbox, type RunInbox } from '../../core/run-inbox.ts';
import { readSkill } from '../../core/skills.ts';
import { confirmedRunFromText, runAction, statusView, tasksView, type Confirm } from './task-commands.ts';
import { parseParamPairs, type RunDeps } from '@lotsman/core';

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false } as const;

export const TOOL_STATUS = 'lotsman_status';
export const TOOL_TASKS = 'lotsman_tasks';
export const TOOL_RUN = 'lotsman_run';

/** The tools. Two read; `lotsman_run` only proposes — nothing here runs a task, sends a message or changes a file. */
export function lotsmanTools(
  listen: ListenPaths,
  inbox: RunInbox = runInbox(listen.stateDir),
): readonly ToolDefinition[] {
  return [
    {
      name: TOOL_STATUS,
      description:
        "What is going on in the person's Lotsman right now: which tasks are running, how the latest run " +
        'of each task ended and when, and which questions are waiting for the person to answer. Use it ' +
        'for requests like "what\'s on today?", "anything going on?", "what did my tasks do?", "is ' +
        'something waiting for me?" or "any news?". Read-only: it changes nothing.',
      inputSchema: NO_ARGUMENTS,
      run: () => {
        const { report, text } = statusView(listen);
        return { text, data: { ...report } };
      },
    },
    {
      name: TOOL_TASKS,
      description:
        'The tasks Lotsman can run for the person: each with its name, the parameters it takes and a ' +
        'short description. Use it for requests like "what can you do for me?", "which tasks or routines ' +
        'are set up?" or "what could you run?". Read-only: it lists tasks and starts none.',
      inputSchema: NO_ARGUMENTS,
      run: () => {
        const { entries, text } = tasksView(listen);
        return { text, data: { tasks: entries } };
      },
    },
    {
      name: TOOL_RUN,
      description:
        'Run one of the tasks Lotsman has set up for the person (see lotsman_tasks for the names and ' +
        'parameters). Use it for requests like "run the tests", "start my backup" or "do the nightly ' +
        'check". It does NOT run anything yet: the person is asked first, shown the exact prompt and ' +
        'directory, and the task starts only if they say yes. The answer is "pending" — the outcome ' +
        'is shown to the person, not returned to you, so do not call it again and do not claim the task ' +
        'ran. A task that does not exist, or a wrong parameter, is an error and asks nobody.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task id, as lotsman_tasks lists it.' },
          params: {
            type: 'object',
            description: 'The task parameters by name, each a string. Omit when the task takes none.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      run: (args) => {
        const task = args['task'];
        if (typeof task !== 'string' || task === '') throw new Error('task must be the id of a task');
        const given = args['params'] ?? {};
        if (typeof given !== 'object' || given === null || Array.isArray(given))
          throw new Error('params must be an object of strings');
        const pairs: string[] = [];
        for (const [name, value] of Object.entries(given)) {
          if (typeof value !== 'string') throw new Error(`parameter "${name}" must be a string`);
          pairs.push(`${name}=${value}`);
        }
        const params = parseParamPairs(pairs);
        // The same check the surface makes before it asks: a request that could never run asks nobody.
        runAction((id) => readSkill(listen.tasksDir, id), task, params);
        const id = inbox.submit(task, params);
        return {
          text:
            `Pending: the person has been asked to confirm running "${task}". Nothing has run yet, and ` +
            'it runs only if they say yes. Do not call this again.',
          data: { status: 'pending', id, task, params },
        };
      },
    },
  ];
}

/** `/run`, `/tasks`, `/status` in the chat. `/run` asks first, through `confirm`, like the tool does. */
export function chatCommands(listen: ListenPaths, deps: RunDeps, confirm: Confirm): ChatCommands {
  return {
    run: (args) => confirmedRunFromText(args, deps, confirm),
    tasks: () => tasksView(listen).text,
    status: () => statusView(listen).text,
  };
}
