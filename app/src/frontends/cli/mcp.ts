/**
 * `lotsman mcp` — Lotsman's tools as a stdio MCP server (ADR 0011). The agent starts it as a child
 * process from the `mcpServers` of a session; nobody types this by hand.
 *
 * **stdout is the protocol and nothing else**: one JSON message per line. Notes go to stderr. The server
 * ends when the agent closes stdin.
 */

import { createInterface } from 'node:readline';

import { _ } from '../../i18n.ts';
import type { CommandModule } from 'yargs';

import { createToolServer, type LotsmanPaths } from '@lotsman/core';

import type { ListenPaths } from '../../core/paths.ts';
import { migrateConfig } from './listen-deps.ts';
import { lotsmanTools } from './tools.ts';

export const MCP_SERVER_NAME = 'lotsman';
/** The version of the tool surface, not of the app: bump it when a tool's name or arguments change. */
const MCP_SERVER_VERSION = '1';

const command = (_paths: LotsmanPaths, listen: ListenPaths): CommandModule => ({
  command: 'mcp',
  describe: _("serve Lotsman's tools to an agent over MCP (stdio)"),
  builder: (yargs) => yargs.strict(),
  handler: async () => {
    migrateConfig(listen);
    const server = createToolServer({
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
      tools: lotsmanTools(listen),
    });
    const lines = createInterface({ input: process.stdin });
    const pending = new Set<Promise<void>>();
    lines.on('line', (line) => {
      const task = server.handleLine(line).then((reply) => {
        if (reply !== null) process.stdout.write(`${reply}\n`);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    await new Promise<void>((resolve) => lines.on('close', resolve));
    await Promise.all(pending);
  },
});

export const mcpCommand = command;
