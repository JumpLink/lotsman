/**
 * The window's half of `lotsman_run` (ADR 0011 step 3): what it takes from the run inbox, what it
 * asks the person, and how it runs the task after a yes.
 *
 * **The task runs in `lotsman run`, a child process, not in the window.** A run needs the agent
 * profiles, the users and the question channel that `lotsman listen` and `lotsman run` assemble; the
 * window has none of them and should not grow a second copy that drifts. The child is the same
 * implementation the command line uses, so a window run and a terminal run end the same way and are
 * recorded the same way. Its text is what the person is shown.
 */

import Gio from '@girs/gio-2.0';

import type { ConfirmationAction } from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { lotsmanCli, type OwnMcpFacts } from '../../core/own-mcp.ts';
import { runInbox, type RunRequest } from '../../core/run-inbox.ts';
import { readSkill } from '../../core/skills.ts';
import { runAction } from '../cli/task-commands.ts';

export interface RunRequestHost {
  take(): RunRequest[];
  /** What the person is asked. Throws `TaskUsageError` for a task that is gone or a parameter that no longer fits. */
  action(request: RunRequest): ConfirmationAction;
  /** Run it and say how it ended, in words. Only ever called after a yes. */
  run(request: RunRequest): Promise<string>;
}

/** `null` where the CLI cannot be found: nothing is taken then, so nothing is lost. */
export function runRequestHost(listen: ListenPaths, facts: OwnMcpFacts): RunRequestHost | null {
  const cli = lotsmanCli(facts);
  if (!cli) return null;
  const inbox = runInbox(listen.stateDir);
  return {
    take: () => inbox.take(),
    action: (request) => runAction((id) => readSkill(listen.tasksDir, id), request.task, request.params),
    run: (request) =>
      new Promise<string>((resolve, reject) => {
        const params = Object.entries(request.params).flatMap(([name, value]) => [
          '--param',
          `${name}=${value}`,
        ]);
        const process = Gio.Subprocess.new(
          [cli.command, ...cli.args, 'run', request.task, ...params, '--quiet'],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
        );
        process.communicate_utf8_async(null, null, (_source, result) => {
          try {
            const [, text] = process.communicate_utf8_finish(result);
            resolve((text ?? '').trim() || `exit ${process.get_exit_status()}`);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }),
  };
}
