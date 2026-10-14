/**
 * Jarvis Local AI Agent: Model Context Protocol (MCP) Client
 * Authority: Section 5.3, 5.4 (tool pinning), OpenClaw Connectors
 *
 * Speaks JSON-RPC 2.0 over newline-delimited stdio to servers named in the owner's own configuration,
 * discovers their tools, and bridges them into Jarvis's ToolRegistry as Tier 2 (third-party code) tools.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { ApprovalStore, MCPServerConnection, MCPTool, McpServerConfig } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { GatewayTier } from '../devagent/types.js';
import type { DocumentStore } from '../storage/collection.js';
import { logger } from '../utils/logger.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INIT_TIMEOUT_MS = 15_000;
const MAX_LINE_CHARS = 5 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const MAX_LIST_PAGES = 20;
const MAX_DESCRIPTION_CHARS = 500;
const CLOSE_GRACE_MS = 2_000;

/** Only these host variables reach a server; the owner's tokens in `process.env` do not. */
const INHERITED_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'LANG'];

export class MockMCPServer implements MCPServerConnection {
  private tools: Array<MCPTool & { handler: (args: any) => Promise<any> }>;

  constructor(tools: Array<MCPTool & { handler: (args: any) => Promise<any> }> = []) {
    this.tools = tools;
  }

  public async listTools(): Promise<MCPTool[]> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  public async callTool(name: string, args: any): Promise<any> {
    const found = this.tools.find((t) => t.name === name);
    if (!found) {
      throw new Error(`MCP Tool not found: ${name}`);
    }
    return found.handler(args);
  }
}

export class McpProtocolError extends Error {
  constructor(
    message: string,
    public readonly code?: number
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface StdioMcpServerOptions {
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
  requestTimeoutMs?: number;
  initTimeoutMs?: number;
  /** Variables of the host environment to pass on, on top of the safe defaults. */
  inheritEnv?: string[];
}

/** A real MCP server child process. No shell is involved: `command` and `args` are fixed by the owner's config. */
export class StdioMcpServer implements MCPServerConnection {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  private exitError: Error | null = null;
  public serverInfo: { name?: string; version?: string } = {};

  constructor(
    private readonly config: McpServerConfig,
    private readonly options: StdioMcpServerOptions = {}
  ) {}

  public get name(): string {
    return this.config.name;
  }

  public getStderr(): string {
    return this.stderrTail;
  }

  /** Spawns the server and completes the `initialize` handshake. */
  public async start(): Promise<void> {
    if (this.child) {
      throw new McpProtocolError(`MCP server '${this.config.name}' is already started`);
    }
    const env: Record<string, string> = {};
    for (const key of [...INHERITED_ENV, ...(this.options.inheritEnv ?? [])]) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    Object.assign(env, this.config.env ?? {});

    const spawnFn = this.options.spawnFn ?? spawn;
    const child = spawnFn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin?.on('error', () => {
      // A write after the child died surfaces through the `exit`/`error` handlers below.
    });
    child.on('error', (err: Error) => this.onTerminated(new McpProtocolError(`MCP server '${this.config.name}' failed to run: ${err.message}`)));
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim().slice(-300);
      this.onTerminated(
        new McpProtocolError(`MCP server '${this.config.name}' exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})${tail ? `: ${tail}` : ''}`)
      );
    });

    try {
      const init = await this.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'jarvis', version: '1.0.0' },
        },
        this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
      );
      this.serverInfo = { name: init?.serverInfo?.name, version: init?.serverInfo?.version };
      this.notify('notifications/initialized');
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  public async listTools(): Promise<MCPTool[]> {
    const tools: MCPTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      for (const raw of Array.isArray(result?.tools) ? result.tools : []) {
        if (raw && typeof raw.name === 'string') {
          tools.push({
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object' ? { type: 'object', ...raw.inputSchema } : { type: 'object', properties: {} },
          });
        }
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) {
        break;
      }
    }
    return tools;
  }

  public async callTool(name: string, args: any): Promise<any> {
    const result = await this.request('tools/call', { name, arguments: args ?? {} });
    const parts: any[] = Array.isArray(result?.content) ? result.content : [];
    const textParts = parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
    if (result?.isError) {
      throw new McpProtocolError(textParts.join('\n') || `MCP tool '${name}' reported an error`);
    }
    if (result?.structuredContent !== undefined) {
      return result.structuredContent;
    }
    if (parts.length === textParts.length) {
      return textParts.join('\n');
    }
    return {
      content: parts.map((p) => (p?.type === 'text' ? { type: 'text', text: p.text } : { type: String(p?.type ?? 'unknown'), omitted: true })),
    };
  }

  /** Ends stdin, then kills the process if it has not exited after a short grace period. */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failAll(new McpProtocolError(`MCP server '${this.config.name}' was closed`));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
      }, CLOSE_GRACE_MS);
      killer.unref();
      child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      try {
        child.stdin?.end();
        child.kill();
      } catch {
        child.kill('SIGKILL');
      }
    });
  }

  private request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.closed || !this.child) {
      return Promise.reject(this.exitError ?? new McpProtocolError(`MCP server '${this.config.name}' is not running`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } });
        reject(new McpProtocolError(`MCP '${method}' on '${this.config.name}' timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      if (!this.send({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.exitError ?? new McpProtocolError(`Could not write to MCP server '${this.config.name}'`));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private send(message: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return false;
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_CHARS && !this.buffer.includes('\n')) {
      this.buffer = '';
      this.failAll(new McpProtocolError(`MCP server '${this.config.name}' sent an oversized message`));
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.onMessage(line);
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private onMessage(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      logger.debug(`[MCP:${this.config.name}] Ignoring non-JSON stdout line`);
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.method !== undefined) {
      // Server-initiated request or notification. Jarvis declares no client capabilities, so only `ping` is answered.
      if (message.id !== undefined) {
        this.send(
          message.method === 'ping'
            ? { jsonrpc: '2.0', id: message.id, result: {} }
            : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported by Jarvis' } }
        );
      }
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new McpProtocolError(String(message.error.message ?? 'MCP error'), typeof message.error.code === 'number' ? message.error.code : undefined));
    } else {
      entry.resolve(message.result);
    }
  }

  private onTerminated(error: Error): void {
    if (!this.exitError) {
      this.exitError = error;
    }
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of Array.from(this.pending.entries())) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(error);
    }
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private hashes = new Map<string, string>();

  get(key: string): string | undefined {
    return this.hashes.get(key);
  }

  set(key: string, hash: string): void {
    this.hashes.set(key, hash);
  }
}

interface PinDoc {
  id: string;
  hash: string;
  approvedAt: string;
}

/** Pins survive restarts: stored in the `mcp_tool_pins` collection of the document store. */
export function createDocumentApprovalStore(store: DocumentStore): ApprovalStore {
  const collection = store.getCollection<PinDoc>('mcp_tool_pins');
  return {
    get: (key) => collection.findOne({ id: key })?.hash,
    set: (key, hash) => {
      collection.insertOne({ id: key, hash, approvedAt: new Date().toISOString() });
    },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)])
    );
  }
  return value;
}

/** sha256 over the tool's description and input schema, independent of key order. */
export function hashMcpTool(tool: MCPTool): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize({ description: tool.description, inputSchema: tool.inputSchema })))
    .digest('hex');
}

export interface MCPClientOptions {
  server: MCPServerConnection;
  /** Used in pin keys and descriptions; required for real servers so two servers cannot share pins. */
  serverName?: string;
  approvalStore?: ApprovalStore;
  /** Prepended to every bridged tool name, e.g. `mcp_files_`. */
  toolPrefix?: string;
  /** Defaults to 2: a third-party process is never Tier 1. Lowering below 2 is ignored. */
  tier?: GatewayTier;
}

export interface McpBridgeReport {
  registered: string[];
  /** Tools seen for the first time and pinned now. */
  newlyPinned: string[];
  /** Tools whose description or schema changed since approval; NOT registered until `approveChangedTool`. */
  changed: Array<{ name: string; previousHash: string; newHash: string }>;
  rejected: Array<{ name: string; reason: string }>;
}

function sanitizeDescription(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return clean.length > MAX_DESCRIPTION_CHARS ? `${clean.slice(0, MAX_DESCRIPTION_CHARS)}...` : clean;
}

export class MCPClient {
  private server: MCPServerConnection;
  private serverName: string;
  private approvalStore: ApprovalStore;
  private toolPrefix: string;
  private tier: GatewayTier;
  private lastChanged = new Map<string, string>();
  private bridgedNames = new Set<string>();
  private registry: ToolRegistry | null = null;

  constructor(options: MCPClientOptions) {
    this.server = options.server;
    this.serverName = options.serverName ?? 'mcp';
    this.approvalStore = options.approvalStore ?? new InMemoryApprovalStore();
    this.toolPrefix = options.toolPrefix ?? '';
    this.tier = Math.max(2, options.tier ?? 2) as GatewayTier;
  }

  public async listTools(): Promise<MCPTool[]> {
    return this.server.listTools();
  }

  public async callTool(name: string, args: any): Promise<any> {
    return this.server.callTool(name, args);
  }

  public async close(): Promise<void> {
    if (this.registry) {
      for (const name of this.bridgedNames) {
        this.registry.unregister(name);
      }
    }
    this.bridgedNames.clear();
    await this.server.close?.();
  }

  private pinKey(toolName: string): string {
    return `${this.serverName}:${toolName}`;
  }

  /**
   * Discovers the server's tools and registers each into Jarvis's ToolRegistry as a Tier 2 tool whose output is
   * untrusted. First-seen tools are pinned; a tool whose description or schema changed is withheld and reported.
   */
  public async bridgeToRegistry(registry: ToolRegistry): Promise<McpBridgeReport> {
    this.registry = registry;
    const mcpTools = await this.listTools();
    const report: McpBridgeReport = { registered: [], newlyPinned: [], changed: [], rejected: [] };
    logger.info(`[MCPClient] Bridging ${mcpTools.length} tools from '${this.serverName}' into ToolRegistry...`);

    for (const tool of mcpTools) {
      const hash = hashMcpTool(tool);
      const approved = await this.approvalStore.get(this.pinKey(tool.name));
      if (approved === undefined) {
        await this.approvalStore.set(this.pinKey(tool.name), hash);
        report.newlyPinned.push(tool.name);
      } else if (approved !== hash) {
        this.lastChanged.set(tool.name, hash);
        report.changed.push({ name: tool.name, previousHash: approved, newHash: hash });
        logger.warn(`[MCPClient] Tool '${tool.name}' on '${this.serverName}' changed since it was approved; withheld until re-approved.`);
        continue;
      }

      const registeredName = `${this.toolPrefix}${tool.name}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
      try {
        registry.registerTool({
          name: registeredName,
          description: sanitizeDescription(tool.description),
          tier: this.tier,
          source: 'mcp',
          parameters: {
            type: 'object',
            properties: tool.inputSchema.properties ?? {},
            required: tool.inputSchema.required ?? [],
            ...(tool.inputSchema.additionalProperties === true ? { additionalProperties: true } : {}),
          },
          handler: async (args: any) => this.callTool(tool.name, args),
        });
        this.bridgedNames.add(registeredName);
        report.registered.push(registeredName);
      } catch (err) {
        report.rejected.push({ name: tool.name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  /** Records the owner's approval of a tool's new description/schema. Call `bridgeToRegistry` again afterwards. */
  public async approveChangedTool(toolName: string): Promise<boolean> {
    const hash = this.lastChanged.get(toolName);
    if (hash === undefined) {
      return false;
    }
    await this.approvalStore.set(this.pinKey(toolName), hash);
    this.lastChanged.delete(toolName);
    return true;
  }
}

export interface ParsedMcpConfig {
  servers: McpServerConfig[];
  errors: string[];
}

/** Validates the owner's `JARVIS_MCP_SERVERS` JSON; invalid entries are reported, never guessed at. */
export function parseMcpServerConfigs(raw: string | undefined): ParsedMcpConfig {
  const result: ParsedMcpConfig = { servers: [], errors: [] };
  if (!raw || raw.trim() === '') {
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push(`JARVIS_MCP_SERVERS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }
  if (!Array.isArray(parsed)) {
    result.errors.push('JARVIS_MCP_SERVERS must be a JSON array of {name, command, args?, env?}.');
    return result;
  }
  const seen = new Set<string>();
  parsed.forEach((entry, index) => {
    const label = `JARVIS_MCP_SERVERS[${index}]`;
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      result.errors.push(`${label} must be an object.`);
      return;
    }
    const { name, command, args, env } = item;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
      result.errors.push(`${label}.name must be 1-32 letters, digits, '_' or '-'.`);
      return;
    }
    if (seen.has(name)) {
      result.errors.push(`${label}.name '${name}' is duplicated.`);
      return;
    }
    if (typeof command !== 'string' || command.trim() === '' || command.includes('\0')) {
      result.errors.push(`${label}.command must be a non-empty string.`);
      return;
    }
    if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string' && !a.includes('\0')))) {
      result.errors.push(`${label}.args must be an array of strings.`);
      return;
    }
    if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env) || !Object.values(env).every((v) => typeof v === 'string'))) {
      result.errors.push(`${label}.env must be an object of string values.`);
      return;
    }
    seen.add(name);
    result.servers.push({
      name,
      command,
      ...(args ? { args: args as string[] } : {}),
      ...(env ? { env: env as Record<string, string> } : {}),
    });
  });
  return result;
}

/** Servers come only from the owner's config; returns [] when `JARVIS_MCP_SERVERS` is unset or unusable. */
export function loadMcpServersFromSettings(getSetting: (key: string) => string | undefined): McpServerConfig[] {
  const { servers, errors } = parseMcpServerConfigs(getSetting('JARVIS_MCP_SERVERS'));
  for (const error of errors) {
    logger.warn(`[MCP] ${error}`);
  }
  return servers;
}

export interface McpRuntime {
  clients: MCPClient[];
  reports: Array<{ server: string; report: McpBridgeReport }>;
  failures: Array<{ server: string; error: string }>;
  closeAll(): Promise<void>;
}

/** Starts every configured server, bridges its tools into `registry`, and reports failures instead of throwing. */
export async function startMcpServers(
  configs: McpServerConfig[],
  registry: ToolRegistry,
  options: { approvalStore?: ApprovalStore; serverOptions?: StdioMcpServerOptions } = {}
): Promise<McpRuntime> {
  const runtime: McpRuntime = {
    clients: [],
    reports: [],
    failures: [],
    closeAll: async () => {
      await Promise.allSettled(runtime.clients.map((c) => c.close()));
      runtime.clients.length = 0;
    },
  };
  for (const config of configs) {
    const server = new StdioMcpServer(config, options.serverOptions);
    try {
      await server.start();
      const client = new MCPClient({
        server,
        serverName: config.name,
        approvalStore: options.approvalStore,
        toolPrefix: `mcp_${config.name}_`,
      });
      runtime.clients.push(client);
      runtime.reports.push({ server: config.name, report: await client.bridgeToRegistry(registry) });
    } catch (err) {
      await server.close();
      runtime.failures.push({ server: config.name, error: err instanceof Error ? err.message : String(err) });
      logger.warn(`[MCP] Server '${config.name}' unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return runtime;
}
