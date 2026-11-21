/** `lotsman status [--json]` — what is running, the last run of each task, the open questions (ADR 0007 §9). */

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import type { LotsmanPaths } from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { out, pickArgv } from './output.ts';
import { statusView } from './task-commands.ts';

const command = (_paths: LotsmanPaths, listen: ListenPaths): CommandModule => ({
  command: 'status',
  describe: _('show running tasks, recent runs and open questions'),
  builder: (yargs) =>
    yargs.option('json', { type: 'boolean', describe: _('print the status as JSON') }).strict(),
  handler: (argv) => {
    const { report, text } = statusView(listen);
    if (pickArgv<boolean>(argv as Record<string, unknown>, 'json') === true)
      out(JSON.stringify(report, null, 2));
    else out(text);
  },
});

export const statusCommand = command;
