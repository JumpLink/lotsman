/**
 * Lotsman's own tool server (`lotsman mcp`) as an entry for a session's `mcpServers` (ADR 0011).
 *
 * Every session Lotsman opens gets it, merged with the servers the person configured. It is a stdio
 * server the agent starts as a child process, so the entry names **the running binary itself**: the
 * CLI bundle (`dist/lotsman.gjs.mjs`, `/app/bin/lotsman` in the Flatpak), reached from the GUI bundle
 * by its sibling name. Nothing else about the machine is guessed; where no entry point can be found the
 * answer is "no server", never a path that fails when the agent tries it.
 *
 * Off with `ownMcp: false` in settings.json or `LOTSMAN_MCP=0`/`false` (a hook set to `0` or `false` is
 * off). Two tools read; `lotsman_run` only files a request that the window or `listen` asks the person about (`cli/tools.ts`).
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { McpServer } from '@lotsman/acp';
import { envKnob } from '@lotsman/core';

import { readSettings, type Settings } from './settings.ts';

/** The server's name in `mcpServers`; also what the widget's per-conversation toggle shows. */
export const OWN_MCP_NAME = 'lotsman';

export interface OwnMcpFacts {
  /** `process.argv`: the entry script is the second element. */
  readonly argv: readonly string[];
  /** The interpreter that runs a `.mjs` entry (`process.execPath`). */
  readonly execPath: string;
  readonly exists?: (path: string) => boolean;
}

/** Whether the person left the server on: the environment beats the settings file. */
export function ownMcpEnabled(
  settings: Pick<Settings, 'ownMcp'>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const knob = envKnob(env, 'MCP');
  if (knob !== undefined) return knob !== '0' && knob.toLowerCase() !== 'false';
  return settings.ownMcp !== false;
}

/** The CLI's entry next to the one running: the GUI bundle `lotsman-app…` has the CLI `lotsman…` beside it. */
function cliEntry(entry: string, exists: (path: string) => boolean): string | null {
  const name = basename(entry);
  const sibling = join(dirname(entry), name.replace(/^lotsman-app(?=[.]|$)/, 'lotsman'));
  for (const candidate of [entry, sibling]) {
    if (/^lotsman([.]|$)/.test(basename(candidate)) && exists(candidate)) return candidate;
  }
  return null;
}

/**
 * How to start the CLI with this binary, before any subcommand: the command and its leading arguments,
 * or `null` when the CLI cannot be found. `ownMcpServer` adds `mcp`; the window adds `run`.
 */
export function lotsmanCli(facts: OwnMcpFacts): { command: string; args: string[] } | null {
  const entry = facts.argv[1];
  if (!entry) return null;
  const found = cliEntry(entry, facts.exists ?? existsSync);
  if (!found) return null;
  // A bundle is run by the interpreter; a launcher script (the Flatpak's `/app/bin/lotsman`) runs itself.
  return /[.]m?js$/.test(found) ? { command: facts.execPath, args: [found] } : { command: found, args: [] };
}

/** The `mcpServers` entry that starts `lotsman mcp` with this binary, or `null` when it cannot be found. */
export function ownMcpServer(facts: OwnMcpFacts): McpServer | null {
  const cli = lotsmanCli(facts);
  if (!cli) return null;
  return { name: OWN_MCP_NAME, command: cli.command, args: [...cli.args, 'mcp'], env: [] };
}

/**
 * `servers` plus Lotsman's own, unless it is off or the person already configured a server called
 * `lotsman` (theirs wins: it is a decision, ours a default).
 */
export function withOwnMcp(servers: readonly McpServer[], own: McpServer | null): McpServer[] {
  if (!own || servers.some((server) => server.name === own.name)) return [...servers];
  return [...servers, own];
}

/** What `start`, `resume`, the window and chat requests add to their `mcpServers`: one entry or none. */
export function liveOwnMcp(settingsFile: string): McpServer | null {
  const { settings } = readSettings(settingsFile);
  if (!ownMcpEnabled(settings)) return null;
  return ownMcpServer({ argv: process.argv, execPath: process.execPath });
}

/** `servers` with Lotsman's own added when it is on — the one call a session opener makes. */
export function mcpServersFor(settingsFile: string, servers: readonly McpServer[] = []): McpServer[] {
  return withOwnMcp(servers, liveOwnMcp(settingsFile));
}
