/**
 * What Lotsman offers an agent as tools (`lotsman mcp`), and the chat commands that say the same things
 * (ADR 0011). Each is ONE function in `task-commands.ts`; the slash command and the tool both call it, so
 * they cannot answer differently.
 *
 * **Read-only on purpose, and the list is closed.** `/run` is deliberately not a tool yet: running a task
 * can leave the machine, and the shared confirmation rule (ADR 0011 step 3) has to exist, in core and
 * rendered by every surface, before any outward tool is added here. Add a tool to `lotsmanTools` only
 * if it changes nothing and sends nothing.
 *
 * The descriptions are for the model, in English and not translated: a model picks a tool by what its
 * description says, and they name the plain requests a person makes ("what's on today?").
 */

import type { ChatCommands, ToolDefinition } from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { reportText, runReportFromText, statusView, tasksView } from './task-commands.ts';
import type { RunDeps } from '@lotsman/core';

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false } as const;

export const TOOL_STATUS = 'lotsman_status';
export const TOOL_TASKS = 'lotsman_tasks';

/** The read-only tools. Nothing here runs a task, sends a message or changes a file. */
export function lotsmanTools(listen: ListenPaths): readonly ToolDefinition[] {
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
  ];
}

/** `/run`, `/tasks`, `/status` in the chat. `/run` stays a command only (see the header). */
export function chatCommands(listen: ListenPaths, deps: RunDeps): ChatCommands {
  return {
    run: async (args) => reportText(await runReportFromText(args, deps)),
    tasks: () => tasksView(listen).text,
    status: () => statusView(listen).text,
  };
}
