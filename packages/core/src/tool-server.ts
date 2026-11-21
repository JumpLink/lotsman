/**
 * The server half of MCP, as far as Lotsman's own tools need it: `initialize`, `tools/list`, `tools/call`
 * and `ping` over JSON-RPC, one message per line (ADR 0011).
 *
 * **Hand-written, not the SDK's `McpServer`.** The SDK is already here for the messenger's *client*
 * (`messenger/mcp-client.ts`), but its server half pulls in a schema library and an HTTP stack that the
 * GJS bundle would carry for three methods, and it needs a stdio transport that runs on GJS
 * ([gjsify#2389](https://github.com/gjsify/gjsify/issues/2389)). Three methods over a line are less code
 * than the glue, and the protocol test in `app/tests/unit/mcp` holds them to the spec's wire shapes.
 *
 * Pure: `handle` takes one parsed message and returns the reply (or `null` for a notification), so the
 * process side (stdin, stdout) stays out of core and a test needs no process.
 */

/** The protocol versions this server speaks, newest first. A client asking for another is answered with the first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** JSON-RPC error codes this server answers with. */
export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

export interface ToolDefinition {
  readonly name: string;
  /** What the model reads to decide whether this tool fits a request. English, written for the model. */
  readonly description: string;
  /** JSON Schema of the arguments; an object, as MCP requires. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** The result's text, and the same facts as data. A throw becomes a tool error (`isError`), not a protocol error. */
  readonly run: (args: Readonly<Record<string, unknown>>) => Promise<ToolResult> | ToolResult;
}

export interface ToolResult {
  readonly text: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface ToolServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly ToolDefinition[];
}

export interface ToolServer {
  /** The reply to one message; `null` when it was a notification or carried no id. */
  handle(message: unknown): Promise<Record<string, unknown> | null>;
  /** The reply to one line of text, as the line to write back; `null` for nothing to say. */
  handleLine(line: string): Promise<string | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function createToolServer(options: ToolServerOptions): ToolServer {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]));

  const call = async (params: unknown): Promise<Record<string, unknown> | string> => {
    if (!isRecord(params) || typeof params['name'] !== 'string') return 'tools/call needs a tool name';
    const tool = byName.get(params['name']);
    if (!tool) return `unknown tool "${params['name']}"`;
    const args = params['arguments'];
    if (args !== undefined && !isRecord(args)) return 'arguments must be an object';
    try {
      const result = await tool.run(args ?? {});
      return {
        content: [{ type: 'text', text: result.text }],
        ...(result.data ? { structuredContent: result.data } : {}),
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  };

  const handle = async (message: unknown): Promise<Record<string, unknown> | null> => {
    if (!isRecord(message) || typeof message['method'] !== 'string')
      return isRecord(message) && 'id' in message ? null : failure(null, RPC.invalidRequest, 'not a request');
    const { method, id, params } = message as { method: string; id?: unknown; params?: unknown };
    // A message without an id is a notification (`notifications/initialized`, `…/cancelled`): never answered.
    if (id === undefined || id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize': {
        const asked = isRecord(params) ? params['protocolVersion'] : undefined;
        const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
          ? asked
          : MCP_PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: options.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
      case 'tools/call': {
        const result = await call(params);
        return typeof result === 'string' ? failure(id, RPC.invalidParams, result) : ok(result);
      }
      default:
        return failure(id, RPC.methodNotFound, `method not found: ${method}`);
    }
  };

  return {
    handle,
    async handleLine(line) {
      if (line.trim() === '') return null;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return JSON.stringify(failure(null, RPC.parse, 'parse error'));
      }
      const reply = await handle(message);
      return reply ? JSON.stringify(reply) : null;
    },
  };
}
