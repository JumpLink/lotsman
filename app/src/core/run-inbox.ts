/**
 * Where `lotsman_run` leaves a request for the surface that can ask the person (ADR 0011 step 3).
 *
 * **Why a directory and not a socket or a held-open call.** The tool runs in `lotsman mcp`, a stdio child
 * the *agent* starts; the confirmation book lives in memory in the window or in `lotsman listen`, which
 * are other processes, and a restart empties it on purpose. So the child cannot ask anyone itself and
 * must not run anything on its own. It files the request here and answers "pending"; a surface that owns
 * a book takes the file, asks the person through the shared confirmation and only then runs the task.
 * A held-open call would have the person's yes race the agent's tool timeout, and a yes after a timeout
 * is exactly what the confirmation rule forbids.
 *
 * A request is the task id and its parameters — never a command or a prompt. What is shown and run is
 * built again by the surface from the task file (`runAction`), so a file dropped in here cannot choose
 * what the person is asked about, only which of their own tasks is proposed. Nothing is kept after it
 * is taken: a request nobody serves stays until a surface starts, and is then asked about like any other.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { isId } from '@lotsman/core';

import { ensureDir, writePrivateFile } from './private-file.ts';

export interface RunRequest {
  readonly id: string;
  readonly task: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface RunInbox {
  /** File a request; returns its id. */
  submit(task: string, params: Readonly<Record<string, string>>): string;
  /** Every request filed, oldest first, each removed as it is returned. A malformed file is dropped. */
  take(): RunRequest[];
}

function parse(text: string): RunRequest | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { id, task, params } = value as Record<string, unknown>;
    if (typeof id !== 'string' || typeof task !== 'string' || !isId(task)) return null;
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
    const given: Record<string, string> = {};
    for (const [name, v] of Object.entries(params)) {
      if (typeof v !== 'string') return null;
      given[name] = v;
    }
    return { id, task, params: given };
  } catch {
    return null;
  }
}

export function runInbox(stateDir: string): RunInbox {
  const dir = join(stateDir, 'run-requests');
  return {
    submit: (task, params) => {
      const id = randomUUID();
      ensureDir(dir);
      writePrivateFile(
        join(dir, `${Date.now()}-${id}.json`),
        `${JSON.stringify({ id, task, params })}\n`,
        'run',
      );
      return id;
    },
    take: () => {
      if (!existsSync(dir)) return [];
      const taken: RunRequest[] = [];
      for (const name of readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()) {
        const file = join(dir, name);
        // A rename is the claim: with the window and `listen` both up, only one of them gets the file.
        const claimed = `${file}.taken`;
        try {
          renameSync(file, claimed);
        } catch {
          continue;
        }
        let request: RunRequest | null = null;
        try {
          request = parse(readFileSync(claimed, 'utf8'));
        } finally {
          rmSync(claimed, { force: true });
        }
        if (request) taken.push(request);
      }
      return taken;
    },
  };
}
