/**
 * Lotsman's own MCP server (ADR 0011): the protocol (initialize, tools/list, tools/call), that a tool
 * and its slash command answer the same, and the entry a session gets. Synthetic temp directories only.
 */

import { describe, expect, it } from '@gjsify/unit';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolServer, type ChatCommands, type RunDeps } from '@lotsman/core';

import { ownMcpEnabled, ownMcpServer, withOwnMcp } from '../../../src/core/own-mcp.ts';
import { parseSettings } from '../../../src/core/settings.ts';
import type { ListenPaths } from '../../../src/core/paths.ts';
import { readSkill } from '../../../src/core/skills.ts';
import { runState } from '../../../src/core/run-state.ts';
import { statusView, tasksView, type Confirm } from '../../../src/frontends/cli/task-commands.ts';
import {
  chatCommands,
  lotsmanTools,
  TOOL_RUN,
  TOOL_STATUS,
  TOOL_TASKS,
} from '../../../src/frontends/cli/tools.ts';

const SKILL = `---
name: demo
description: A demo task
allowed-tools: a
metadata:
  lotsman-profile: p
  lotsman-params: topic, day=today
---
Report on {{topic}} for {{day}}.
`;

async function withListen(body: (listen: ListenPaths) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lotsman-mcp-'));
  try {
    const tasksDir = join(dir, 'tasks');
    mkdirSync(join(tasksDir, 'demo'), { recursive: true });
    writeFileSync(join(tasksDir, 'demo', 'SKILL.md'), SKILL);
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir);
    runState(stateDir).record({
      task: 'demo',
      startedAt: '2026-10-10T11:00:00.000Z',
      endedAt: '2026-10-10T11:01:00.000Z',
      outcome: 'done',
      sessionId: null,
      stopReason: null,
      questionId: null,
      reason: null,
    } as never);
    await body({ stateDir, tasksDir, usersFile: '', profilesFile: '', tasksFile: '' } as ListenPaths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// oxlint-disable-next-line typescript/no-explicit-any -- a reply is read by path in assertions
type Reply = { id: number; result?: Record<string, any>; error?: { code: number; message: string } };

const send = async (
  server: ReturnType<typeof createToolServer>,
  id: number,
  method: string,
  params?: unknown,
): Promise<Reply> => {
  const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return JSON.parse(line!) as Reply;
};

export default async () => {
  await describe('lotsman mcp: protocol', async () => {
    await it('initialize, tools/list and tools/call, one message per line', async () => {
      await withListen(async (listen) => {
        const server = createToolServer({ name: 'lotsman', version: '1', tools: lotsmanTools(listen) });

        const init = await send(server, 1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        });
        expect(init.result!['protocolVersion']).toBe('2025-06-18');
        expect(init.result!['serverInfo']).toStrictEqual({ name: 'lotsman', version: '1' });
        expect(Object.keys(init.result!['capabilities'])).toStrictEqual(['tools']);

        // A notification is never answered.
        expect(
          await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
        ).toBe(null);

        const list = await send(server, 2, 'tools/list');
        const tools = list.result!['tools'] as {
          name: string;
          description: string;
          inputSchema: { type: string };
        }[];
        expect(tools.map((tool) => tool.name)).toStrictEqual([TOOL_STATUS, TOOL_TASKS, TOOL_RUN]);
        for (const tool of tools) expect(tool.inputSchema.type).toBe('object');
        for (const tool of tools.slice(0, 2)) expect(tool.description).toContain('Read-only');
        expect(tools[2]!.description).toContain('run the tests');

        const status = await send(server, 3, 'tools/call', { name: TOOL_STATUS, arguments: {} });
        expect(status.result!['isError']).toBe(false);
        expect(status.result!['content'][0].type).toBe('text');
        expect(status.result!['content'][0].text).toContain('Nothing is running.');
        expect(status.result!['content'][0].text).toContain('demo: done');
        expect(status.result!['structuredContent'].running).toStrictEqual([]);

        const tasks = await send(server, 4, 'tools/call', { name: TOOL_TASKS });
        expect(tasks.result!['content'][0].text).toContain('demo (topic, day=today)');
      });
    });

    await it('answers a bad call with a protocol error, not a crash', async () => {
      await withListen(async (listen) => {
        const server = createToolServer({ name: 'lotsman', version: '1', tools: lotsmanTools(listen) });
        expect((await send(server, 1, 'tools/call', { name: 'no_such_tool' })).error!.code).toBe(-32602);
        expect((await send(server, 2, 'nope')).error!.code).toBe(-32601);
        expect(JSON.parse((await server.handleLine('{not json'))!).error.code).toBe(-32700);
        expect((await send(server, 3, 'ping')).result).toStrictEqual({});
        // An unknown protocol version is answered with the one this server speaks.
        const init = await send(server, 4, 'initialize', { protocolVersion: '1999-01-01' });
        expect(init.result!['protocolVersion']).toBe('2025-06-18');
      });
    });

    await it('a failing tool is a tool error the model can read', async () => {
      const server = createToolServer({
        name: 'x',
        version: '1',
        tools: [
          {
            name: 'boom',
            description: 'd',
            inputSchema: { type: 'object' },
            run: () => {
              throw new Error('went wrong');
            },
          },
        ],
      });
      const reply = await send(server, 1, 'tools/call', { name: 'boom' });
      expect(reply.result!['isError']).toBe(true);
      expect(reply.result!['content'][0].text).toBe('went wrong');
    });

    await it('lotsman_run only files a request: nothing runs without the person saying yes', async () => {
      await withListen(async (listen) => {
        const filed: { task: string; params: Record<string, string> }[] = [];
        const inbox = {
          submit: (task: string, params: Readonly<Record<string, string>>) => {
            filed.push({ task, params: { ...params } });
            return 'req-1';
          },
          take: () => [],
        };
        const tools = lotsmanTools(listen, inbox);
        expect(tools.map((tool) => tool.name)).toStrictEqual([TOOL_STATUS, TOOL_TASKS, TOOL_RUN]);
        const run = tools.find((tool) => tool.name === TOOL_RUN)!;
        const reply = await run.run({ task: 'demo', params: { topic: 'x' } });
        expect(reply.text).toContain('Pending');
        expect((reply.data as { status: string }).status).toBe('pending');
        expect(filed).toStrictEqual([{ task: 'demo', params: { topic: 'x' } }]);

        // A request that could never run asks nobody and files nothing.
        let failed = 0;
        for (const args of [{ task: 'nope' }, { task: 'demo' }, { task: 'demo', params: { bad: 'x' } }, {}]) {
          try {
            await run.run(args);
          } catch {
            failed++;
          }
        }
        expect(failed).toBe(4);
        expect(filed.length).toBe(1);
      });
    });

    await it('the /run command runs only after an approval', async () => {
      await withListen(async (listen) => {
        let asked = 0;
        const decline: Confirm = (_action, _run) => {
          asked++;
          return Promise.resolve({ type: 'not-run', outcome: { type: 'declined' } } as never);
        };
        const commands = chatCommands(
          listen,
          { skill: (id: string) => readSkill(listen.tasksDir, id) } as unknown as RunDeps,
          decline,
        );
        const text = await commands.run('demo topic=x');
        expect(asked).toBe(1);
        expect(text).toContain('Not run');
      });
    });
  });

  await describe('lotsman mcp: one implementation behind command and tool', async () => {
    await it('/tasks and /status say what the tools say', async () => {
      await withListen(async (listen) => {
        const commands: ChatCommands = chatCommands(
          listen,
          {} as RunDeps,
          (() => Promise.reject(new Error('not asked'))) as Confirm,
        );
        const [status, tasks] = lotsmanTools(listen);
        expect(commands.tasks()).toBe((await tasks!.run({})).text);
        expect(commands.status()).toBe((await status!.run({})).text);
        expect(commands.tasks()).toBe(tasksView(listen).text);
        expect(commands.status()).toBe(statusView(listen).text);
        expect(commands.tasks()).toContain('demo (topic, day=today) — A demo task');
      });
    });
  });

  await describe('lotsman mcp: the entry a session gets', async () => {
    const present = () => true;

    await it('runs a bundle with the interpreter and a launcher by itself', async () => {
      expect(
        ownMcpServer({
          argv: ['gjs', '/x/dist/lotsman.gjs.mjs', 'start'],
          execPath: '/usr/bin/gjs',
          exists: present,
        }),
      ).toStrictEqual({
        name: 'lotsman',
        command: '/usr/bin/gjs',
        args: ['/x/dist/lotsman.gjs.mjs', 'mcp'],
        env: [],
      });
      expect(
        ownMcpServer({ argv: ['gjs', '/app/bin/lotsman'], execPath: '/usr/bin/gjs', exists: present }),
      ).toStrictEqual({ name: 'lotsman', command: '/app/bin/lotsman', args: ['mcp'], env: [] });
    });

    await it('finds the CLI beside the GUI bundle, and gives up when there is none', async () => {
      const gui = { argv: ['gjs', '/app/bin/lotsman-app'], execPath: '/usr/bin/gjs' };
      expect(ownMcpServer({ ...gui, exists: present })?.command).toBe('/app/bin/lotsman');
      expect(ownMcpServer({ ...gui, exists: (path) => path === '/app/bin/lotsman-app' })).toBe(null);
      expect(ownMcpServer({ argv: ['node'], execPath: 'node', exists: present })).toBe(null);
    });

    await it('is merged with the configured servers, and theirs wins on a clash', async () => {
      const own = { name: 'lotsman', command: 'a', args: ['mcp'], env: [] };
      const theirs = { name: 'curlew', command: 'c', args: [], env: [] };
      expect(withOwnMcp([theirs], own)).toStrictEqual([theirs, own]);
      expect(withOwnMcp([theirs], null)).toStrictEqual([theirs]);
      const same = { name: 'lotsman', command: 'mine', args: [], env: [] };
      expect(withOwnMcp([same], own)).toStrictEqual([same]);
    });

    await it('can be switched off in settings.json or by LOTSMAN_MCP', async () => {
      expect(ownMcpEnabled({}, {})).toBe(true);
      expect(ownMcpEnabled({ ownMcp: false }, {})).toBe(false);
      expect(ownMcpEnabled({ ownMcp: false }, { LOTSMAN_MCP: '1' })).toBe(true);
      expect(ownMcpEnabled({}, { LOTSMAN_MCP: '0' })).toBe(false);
      const parsed = parseSettings('{"version":1,"agent":null,"ownMcp":false}');
      expect('settings' in parsed && parsed.settings.ownMcp).toBe(false);
      expect('problem' in parseSettings('{"version":1,"ownMcp":"no"}')).toBe(true);
    });
  });
};
