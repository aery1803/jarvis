/**
 * Jarvis Local AI Agent: Runtime Composition Root
 * Authority: CODING_RULES.md section 5 (Action Gateway tiers), jarvis-master-context.md Sections 6-8
 *
 * One place that constructs every subsystem, wires them to each other (shared registry, one governor, one
 * kill switch, one approval broker) and hands the result to the web server and the Telegram bot, so both
 * surfaces run the same chat pipeline (`src/chat/pipeline.ts`) against the same state.
 *
 * Initialisation is resilient: a subsystem that cannot start (MCP spawn, adb missing, Ollama down) is logged
 * and listed in `getStatus().issues`, never fatal.
 */

import path from 'node:path';
import os from 'node:os';
import { DocumentStore } from '../storage/collection.js';
import { SessionManager } from '../sessions/manager.js';
import { MemoryManager, type MemoryManagerOptions } from '../memory/manager.js';
import { KillSwitch, type KillTriggerInfo } from '../security/kill-switch.js';
import { ApprovalBroker, DEFAULT_APPROVAL_TIMEOUT_MS, type ApprovalAuditEvent, type ApprovalRequest } from '../security/approvals.js';
import { OwnActionRegistry } from '../devagent/action-registry.js';
import { ActionGateway } from '../devagent/action-gateway.js';
import { CostLedger } from '../orchestration/ledger.js';
import { ModelRegistry } from '../orchestration/registry.js';
import { CapabilityChecker } from '../orchestration/capability.js';
import { MemoryGovernor } from '../orchestration/governor.js';
import { CascadeRouter } from '../orchestration/router.js';
import { ModelProvisioner } from '../orchestration/provisioner.js';
import { getSharedVramProbe, installedFromDiagnostics, type VramProbe } from '../orchestration/vram.js';
import { OllamaProvider, type LLMProvider, type SpeedProbeClient } from '../services/provider.js';
import { SearXNGClient, type SearchOutcome } from '../services/searxng.js';
import { ContentDistiller } from '../services/scraper.js';
import { ConsensusEngine } from '../services/consensus.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { startMcpServers, createDocumentApprovalStore, type McpRuntime } from '../mcp/client.js';
import { SkillGenerator } from '../skills/generator.js';
import { ReflexCompiler } from '../skills/reflex.js';
import { MultiAgentOrchestrator, type ConsensusPort, type DistillPort } from '../agents/orchestrator.js';
import { EvaluationHarness } from '../eval/harness.js';
import type { EvalToolbox } from '../eval/graders.js';
import { ModelBenchmarkSuite, benchmarkGuard, benchmarkCache, type BenchmarkCache, type BenchmarkGuard } from '../eval/benchmark.js';
import { EmailWatcher } from '../email/watcher.js';
import type { EmailTransport } from '../email/types.js';
import { BrowserAutomationEngine, type BrowserEngineOptions } from '../browser/automation.js';
import { HostBridge, type HostBridgeOptions } from '../bridge/host.js';
import { MobileBridge } from '../bridge/mobile.js';
import { AdbTransport } from '../bridge/adb.js';
import type { MobileTransport } from '../bridge/types.js';
import { MediaService, type MediaServiceOptions } from '../media/service.js';
import { probeOllama, type Diagnostics, type LoadedOllamaModel, type OllamaModelInfo } from '../web/diagnostics.js';
import { config as baseConfig, type JarvisConfig, type McpServerConfig } from '../config.js';
import { DEFAULT_CHAT_USER_ID } from '../storage/chat-store.js';
import { logger } from '../utils/logger.js';
import { registerRuntimeTools } from './tools.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INVENTORY_TTL_MS = 15_000;

/** Owner-tunable ceilings for one chat turn; the pipeline reads them from `rt.limits`. */
export interface RuntimeLimits {
  /** Most tokens one generation call may produce (Ollama `num_predict`). A reply that hits it is reported as truncated. */
  maxOutputTokens: number;
  /** A generation call that stays silent this long is aborted so the lease is freed. */
  inferenceIdleTimeoutMs: number;
  /** Longest a queued turn waits for another heavy model before giving up. */
  leaseWaitMs: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxOutputTokens: 2048,
  inferenceIdleTimeoutMs: 10 * 60 * 1000,
  leaseWaitMs: 15 * 60 * 1000,
};

/**
 * `KillSwitch` with a reset hook: the runtime restarts what the kill closed (MCP servers) once the owner resets it,
 * wherever `reset` is called from (web route, Telegram command).
 */
class RuntimeKillSwitch extends KillSwitch {
  public onReset: (actor: string) => Promise<void> = async () => undefined;

  override async reset(actor: string): Promise<void> {
    await super.reset(actor);
    await this.onReset(actor);
  }
}

/** What the runtime needs from a search engine; `SearXNGClient` fits, and tests inject fakes. */
export interface RuntimeSearchClient {
  searchDetailed(query: string, options?: { maxResults?: number }): Promise<SearchOutcome>;
}

export interface RuntimeOptions {
  /** Directory for `jarvis.db` and `devagent.db`. Defaults to `<cwd>/data`. */
  dataDir?: string;
  /** Pre-built store (tests pass `new DocumentStore(':memory:')`). The runtime does not close a store it was given. */
  store?: DocumentStore;
  /** Pre-built dev-agent action registry; by default a file in `dataDir`, or `:memory:` when `store` was given. */
  ownActions?: OwnActionRegistry;
  ownerUserId?: string;
  ollamaBaseUrl?: string;
  /** Overrides on top of the loaded `JarvisConfig` (for example `allowModelPull`). */
  config?: Partial<JarvisConfig>;

  // Injectable edges, so tests never touch the network, Ollama, adb or a GPU.
  /** Builds the inference provider for a model tag. Defaults to `OllamaProvider` on `ollamaBaseUrl`. */
  providerFactory?: (model: string) => LLMProvider;
  /** Builds the client the speed probe calls Ollama with. Defaults to an `OllamaProvider` on `ollamaBaseUrl`. */
  speedProbeFactory?: (model: string) => SpeedProbeClient;
  /** Reads Ollama's installed and resident models. Defaults to `probeOllama`. */
  fetchInventory?: (baseUrl: string) => Promise<Diagnostics['ollama']>;
  /** Free VRAM in bytes, null when unknown. Defaults to the cached `probeGpu()` probe. */
  probeVram?: () => Promise<number | null>;
  /** Total VRAM in bytes, null when unknown. Defaults to the pool size from the same cached `probeGpu()` probe. */
  probeVramTotal?: () => Promise<number | null>;
  search?: RuntimeSearchClient;
  distiller?: DistillPort;
  consensus?: ConsensusPort;
  /** Host free memory for the Action Gateway headroom check. Defaults to `os.freemem`. */
  getFreeMemory?: () => number;
  capabilityChecker?: CapabilityChecker;
  /** Thermal pacing gap between inferences; defaults to `config.pacingDelayMs`. */
  pacingDelayMs?: number;
  memoryOptions?: MemoryManagerOptions;
  /** Defaults to `config.mcpServers`. */
  mcpServers?: McpServerConfig[];
  startMcp?: typeof startMcpServers;
  mobileTransport?: MobileTransport;
  /** The real mail backend. There is none by default, so `email_send` reports that nothing was sent. */
  emailTransport?: EmailTransport;
  hostOptions?: HostBridgeOptions;
  browserOptions?: BrowserEngineOptions;
  mediaOptions?: MediaServiceOptions;
  /** Directory `file_read` and host listings are confined to. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  approvalTimeoutMs?: number;
  /** Overrides for `rt.limits` (output cap, inference idle timeout, lease wait). */
  limits?: Partial<RuntimeLimits>;
  /**
   * Marks tasks a crashed or restarted process left `queued`/`running`/`waiting_approval` as cancelled at startup.
   * Default true. A second process that shares the database (a separate launcher) must pass false, or it would cancel
   * the first process's live tasks.
   */
  reconcileInterruptedTasks?: boolean;
  inventoryTtlMs?: number;
  /** How often stale reflexes decay. Defaults to daily. */
  decayIntervalMs?: number;
  now?: () => number;
}

export interface InventorySnapshot {
  /** Whether the last attempt reached Ollama. */
  reachable: boolean;
  /** Epoch ms of the last attempt, null before the first. */
  checkedAt: number | null;
  /** Epoch ms of the last attempt that reached Ollama; `installed` and `loaded` come from it. */
  lastGoodAt: number | null;
  installed: OllamaModelInfo[];
  loaded: LoadedOllamaModel[];
  vramFreeBytes: number | null;
  /** `ok`, `never checked`, or `ollama unreachable: <reason>`. */
  status: string;
  error?: string;
}

export interface RuntimeStatus {
  killSwitch: { engaged: boolean; reason: string };
  inventory: {
    status: string;
    reachable: boolean;
    checkedAt: string | null;
    ageMs: number | null;
    installed: string[];
    error?: string;
  };
  vram: { freeBytes: number | null };
  host: { freeMemoryBytes: number; totalMemoryBytes: number };
  loadedModels: LoadedOllamaModel[];
  /** The heavy model currently holding the governor lease, and how many turns wait behind it. */
  activeHeavyModel: string | null;
  queueLength: number;
  pendingApprovals: ApprovalRequest[];
  mcp: {
    servers: string[];
    failures: Array<{ server: string; error: string }>;
    changed: Array<{ server: string; name: string; previousHash: string; newHash: string }>;
  };
  toolCount: number;
  email: { transportConfigured: boolean };
  inFlight: number;
  /** Subsystems that failed to start or are degraded, in plain words. */
  issues: string[];
  closed: boolean;
}

export interface JarvisRuntime {
  readonly config: JarvisConfig;
  readonly ownerUserId: string;
  readonly store: DocumentStore;
  readonly sessions: SessionManager;
  readonly memory: MemoryManager;
  readonly killSwitch: KillSwitch;
  readonly approvals: ApprovalBroker;
  readonly ownActions: OwnActionRegistry;
  readonly gateway: ActionGateway;
  readonly ledger: CostLedger;
  readonly registry: ModelRegistry;
  readonly capability: CapabilityChecker;
  readonly governor: MemoryGovernor;
  readonly router: CascadeRouter;
  readonly tools: ToolRegistry;
  readonly executor: ToolExecutor;
  /** The live MCP runtime; replaced when the owner resets the kill switch and the servers restart. */
  readonly mcp: McpRuntime;
  readonly skills: SkillGenerator;
  readonly reflexes: ReflexCompiler;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly evalHarness: EvaluationHarness;
  readonly benchmark: { suite: ModelBenchmarkSuite; guard: BenchmarkGuard; cache: BenchmarkCache };
  readonly email: EmailWatcher;
  readonly browser: BrowserAutomationEngine;
  readonly host: HostBridge;
  readonly mobile: MobileBridge;
  readonly media: MediaService;
  readonly search: RuntimeSearchClient;
  readonly distiller: DistillPort;
  readonly consensus: ConsensusPort;
  readonly limits: RuntimeLimits;
  readonly closed: boolean;

  /** The inference provider for a model tag. A new provider per call: they hold no connection state. */
  providerFor(model: string): LLMProvider;
  /** The client `POST /api/probe/speed` measures a model with (Ollama's own counters). */
  speedProbeFor(model: string): SpeedProbeClient;
  /** A provisioner on the shared registry and governor; `provider` only serves its `pullModel`/`setModel` calls. */
  createProvisioner(provider?: LLMProvider): ModelProvisioner;
  /** Probes Ollama and VRAM (cached about 15 s, concurrent calls share one probe) and reconciles the shared registry. Never throws. */
  refreshInventory(options?: { force?: boolean }): Promise<InventorySnapshot>;
  getStatus(): RuntimeStatus;
  /** Registers work the kill switch must halt: it is aborted when the switch trips (immediately if already tripped). */
  registerAbort(controller: AbortController): void;
  unregisterAbort(controller: AbortController): void;
  /** Idempotent: stops timers, aborts in-flight work, denies pending approvals, closes MCP servers and any store the runtime created. */
  close(): Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function auditTypeFor(event: ApprovalAuditEvent): 'ACTION_APPROVED' | 'ACTION_REJECTED' | null {
  if (event.type === 'requested') return null;
  return event.type === 'approved' ? 'ACTION_APPROVED' : 'ACTION_REJECTED';
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<JarvisRuntime> {
  const cfg: JarvisConfig = {
    ...baseConfig,
    ...options.config,
    ...(options.ollamaBaseUrl ? { ollamaBaseUrl: options.ollamaBaseUrl } : {}),
  };
  const now = options.now ?? Date.now;
  const issues: string[] = [];
  const noteIssue = (message: string): void => {
    issues.push(message);
    logger.warn(`[Runtime] ${message}`);
  };

  // --- Storage, sessions, memory ---
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
  const ownsStore = options.store === undefined;
  const store = options.store ?? new DocumentStore(path.join(dataDir, 'jarvis.db'));
  const ownerUserId = options.ownerUserId ?? DEFAULT_CHAT_USER_ID;
  const sessions = new SessionManager(store);
  const memory = new MemoryManager(store, options.memoryOptions);
  const killSwitch = new RuntimeKillSwitch(store, sessions);
  const limits: RuntimeLimits = { ...DEFAULT_RUNTIME_LIMITS, ...options.limits };

  const approvals = new ApprovalBroker({
    timeoutMs: options.approvalTimeoutMs,
    audit: (event) => {
      const eventType = auditTypeFor(event);
      if (!eventType) return;
      killSwitch
        .logAudit({
          eventType,
          actor: event.decision?.decidedBy ?? 'system',
          details: { approvalType: event.type, actionType: event.request.actionType, requestId: event.request.id, reason: event.decision?.reason },
        })
        .catch((err: unknown) => logger.warn(`[Runtime] Approval audit write failed: ${errorMessage(err)}`));
    },
  });

  // --- Action Gateway (Tier 2 approvals, kill switch, memory headroom) ---
  const openActionRegistry = (): OwnActionRegistry => {
    const dbPath = options.store ? ':memory:' : path.join(dataDir, 'devagent.db');
    try {
      return new OwnActionRegistry(dbPath);
    } catch (err: unknown) {
      noteIssue(`Action registry at ${dbPath} could not be opened (${errorMessage(err)}); actions are audited in memory only.`);
      return new OwnActionRegistry(':memory:');
    }
  };
  const ownsActions = options.ownActions === undefined;
  const ownActions = options.ownActions ?? openActionRegistry();
  const gateway = new ActionGateway(ownActions, {
    minFreeMemoryBytes: cfg.minFreeMemoryBytes,
    getFreeMemory: options.getFreeMemory,
    broker: approvals,
    killSwitch,
  });

  // --- Models: one registry, one VRAM-aware capability checker, one governor ---
  const ledger = new CostLedger(store);
  const registry = new ModelRegistry();
  // Unknown VRAM must not turn the host-RAM comparison (the wrong pool on this box) into a hard refusal.
  const capability = options.capabilityChecker ?? new CapabilityChecker({ unknownVramPolicy: 'allow' });
  const governor = new MemoryGovernor({ capabilityChecker: capability, pacingDelayMs: options.pacingDelayMs ?? cfg.pacingDelayMs });
  const router = new CascadeRouter(registry, governor);
  const sharedProbe: VramProbe | null = options.probeVram ? null : getSharedVramProbe();
  const probeVram = options.probeVram ?? (sharedProbe as VramProbe);
  const probeVramTotal: () => Promise<number | null> = options.probeVramTotal ?? (sharedProbe ? sharedProbe.total : async () => null);
  const fetchInventory = options.fetchInventory ?? ((baseUrl: string) => probeOllama(baseUrl));
  const inventoryTtlMs = options.inventoryTtlMs ?? DEFAULT_INVENTORY_TTL_MS;

  const providerFor = (model: string): LLMProvider =>
    options.providerFactory
      ? options.providerFactory(model)
      : new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl, model, defaultContextTokens: cfg.contextTokens });

  const speedProbeFor = (model: string): SpeedProbeClient =>
    options.speedProbeFactory ? options.speedProbeFactory(model) : new OllamaProvider({ baseUrl: cfg.ollamaBaseUrl, model });

  let snapshot: InventorySnapshot = {
    reachable: false,
    checkedAt: null,
    lastGoodAt: null,
    installed: [],
    loaded: [],
    vramFreeBytes: null,
    status: 'never checked',
  };
  let refreshing: Promise<InventorySnapshot> | null = null;

  const probeInventory = async (): Promise<InventorySnapshot> => {
    let vram: number | null = null;
    try {
      vram = await probeVram();
    } catch (err: unknown) {
      logger.debug(`[Runtime] VRAM probe failed: ${errorMessage(err)}`);
    }
    capability.setVramFree(vram);
    try {
      capability.setVramTotal(await probeVramTotal());
    } catch (err: unknown) {
      logger.debug(`[Runtime] VRAM total probe failed: ${errorMessage(err)}`);
      capability.setVramTotal(null);
    }

    let result: Diagnostics['ollama'];
    try {
      result = await fetchInventory(cfg.ollamaBaseUrl);
    } catch (err: unknown) {
      result = { baseUrl: cfg.ollamaBaseUrl, reachable: false, installed: [], loaded: [], error: errorMessage(err) };
    }

    const at = now();
    // What Ollama holds right now: the free-VRAM figure above already excludes it, so the checker adds it back for the
    // model that holds it (a resident model must not be refused for occupying its own space).
    capability.setResidentModels(result.reachable ? result.loaded.map((entry) => ({ name: entry.name, sizeVramBytes: entry.sizeVramBytes })) : []);
    if (result.reachable) {
      try {
        registry.reconcileInstalled(installedFromDiagnostics(result.installed));
      } catch (err: unknown) {
        logger.warn(`[Runtime] Could not reconcile the installed model list: ${errorMessage(err)}`);
      }
      snapshot = { reachable: true, checkedAt: at, lastGoodAt: at, installed: result.installed, loaded: result.loaded, vramFreeBytes: vram, status: 'ok' };
    } else {
      const error = result.error ?? 'no response';
      if (snapshot.reachable || snapshot.checkedAt === null) logger.warn(`[Runtime] Ollama unreachable at ${cfg.ollamaBaseUrl}: ${error}`);
      // The last good inventory (and the registry reconciled from it) stays in force.
      snapshot = { ...snapshot, reachable: false, checkedAt: at, vramFreeBytes: vram, status: `ollama unreachable: ${error}`, error };
    }
    return snapshot;
  };

  const refreshInventory = async (refreshOptions: { force?: boolean } = {}): Promise<InventorySnapshot> => {
    if (!refreshOptions.force && snapshot.checkedAt !== null && now() - snapshot.checkedAt < inventoryTtlMs) return snapshot;
    refreshing ??= probeInventory()
      .catch((err: unknown): InventorySnapshot => {
        const error = errorMessage(err);
        snapshot = { ...snapshot, reachable: false, checkedAt: now(), status: `ollama unreachable: ${error}`, error };
        return snapshot;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };

  const createProvisioner = (provider?: LLMProvider): ModelProvisioner =>
    new ModelProvisioner(provider ?? providerFor(cfg.defaultModel), {
      registry,
      governor,
      defaultModel: cfg.defaultModel,
      // The same probe moment as `snapshot.loaded`, so free VRAM and the resident list never disagree.
      getVramFreeBytes: async () => (await refreshInventory()).vramFreeBytes,
      listInstalled: async () => {
        const inventory = await refreshInventory();
        // Throwing keeps the registry's "installed" state unknown rather than reconciling it to an empty list.
        if (inventory.lastGoodAt === null) throw new Error(inventory.status);
        return installedFromDiagnostics(inventory.installed);
      },
    });

  // --- Tools, MCP, executor ---
  const search: RuntimeSearchClient =
    options.search ??
    new SearXNGClient({
      baseUrl: cfg.searxngBaseUrl,
      // With the fallback switch on, an unreachable SearXNG comes back as `source: 'none'` plus a reason instead of throwing.
      enableFallback: true,
      enableLiveFallback: cfg.searchLiveFallback,
    });
  const distiller: DistillPort = options.distiller ?? new ContentDistiller();
  const consensus: ConsensusPort = options.consensus ?? new ConsensusEngine();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  const tools = new ToolRegistry();
  tools.registerBuiltinTools({ searchClient: search, workspaceRoot });

  // --- Bridges ---
  // The bridges get the gateway so a direct caller is audited and memory-checked. An owner-approved action is forwarded
  // as pre-approved, so it is never asked twice; the runtime tools hold the one broker approval themselves.
  const host = new HostBridge(gateway, { workspaceRoot, ...options.hostOptions });
  const browser = new BrowserAutomationEngine(gateway, options.browserOptions);
  const mobile = new MobileBridge({ transport: options.mobileTransport ?? new AdbTransport() });
  const media = new MediaService({ baseUrl: cfg.ollamaBaseUrl, ...options.mediaOptions });
  const email = new EmailWatcher(store, gateway, { transport: options.emailTransport, llm: providerFor(cfg.defaultModel), thinkingMode: cfg.thinkingMode });
  const emailTransportConfigured = options.emailTransport !== undefined;

  const skills = new SkillGenerator(store);
  const reflexes = new ReflexCompiler(store);
  const orchestrator = new MultiAgentOrchestrator({
    llmProvider: providerFor(cfg.defaultModel),
    ledger,
    search,
    distill: distiller,
    consensus,
    lane: 'resident',
    thinkingMode: cfg.thinkingMode,
    health: async () => {
      const inventory = await refreshInventory();
      const vram = inventory.vramFreeBytes === null ? 'unknown VRAM' : `${(inventory.vramFreeBytes / 2 ** 30).toFixed(1)} GiB VRAM free`;
      return {
        ok: inventory.reachable,
        summary: `Ollama: ${inventory.status}; ${vram}; host RAM ${(os.freemem() / 2 ** 30).toFixed(1)} of ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB free.`,
      };
    },
  });

  const executor = new ToolExecutor({ registry: tools, gateway, broker: approvals, killSwitch });
  registerRuntimeTools({
    tools,
    ownerUserId,
    memory,
    skills,
    orchestrator,
    host,
    mobile,
    email,
    emailTransportConfigured,
    browser,
    gateway,
    broker: approvals,
    approvalTimeoutMs: options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
  });

  const startMcp = options.startMcp ?? startMcpServers;
  const mcpConfigs = options.mcpServers ?? cfg.mcpServers;
  const stoppedMcp = (failures: McpRuntime['failures'] = []): McpRuntime => ({ clients: [], reports: [], failures, closeAll: async () => undefined });
  const connectMcp = async (): Promise<McpRuntime> => {
    let started: McpRuntime;
    try {
      started = await startMcp(mcpConfigs, tools, { approvalStore: createDocumentApprovalStore(store) });
    } catch (err: unknown) {
      noteIssue(`MCP startup failed: ${errorMessage(err)}`);
      return stoppedMcp([{ server: '*', error: errorMessage(err) }]);
    }
    for (const failure of started.failures) noteIssue(`MCP server '${failure.server}' is unavailable: ${failure.error}`);
    return started;
  };
  // A kill that survived a restart keeps the servers down until the owner resets it.
  let mcpStoppedByKill = killSwitch.isKilled();
  let mcp: McpRuntime = mcpStoppedByKill ? stoppedMcp() : await connectMcp();
  // Kill and reset can overlap (a quick /kill then /resume); one chain keeps close-then-restart in order.
  let mcpChain: Promise<void> = Promise.resolve();
  const queueMcp = (work: () => Promise<void>): Promise<void> => {
    mcpChain = mcpChain.then(work, work);
    return mcpChain;
  };

  // --- Kill switch: halt in-flight turns, deny waiting approvals, drop MCP servers ---
  const inFlight = new Set<AbortController>();
  const unsubscribeKill = killSwitch.onTrigger(({ reason }: KillTriggerInfo) => {
    for (const controller of [...inFlight]) controller.abort(`Kill switch engaged: ${reason}`);
    const denied = approvals.denyAll(`Kill switch engaged: ${reason}`);
    if (denied > 0) logger.warn(`[Runtime] Kill switch denied ${denied} pending approval(s).`);
    return queueMcp(async () => {
      mcpStoppedByKill = true;
      const closing = mcp;
      // The status must stop listing servers the moment they are closed, not after the next restart.
      mcp = stoppedMcp();
      await closing.closeAll().catch((err: unknown) => logger.warn(`[Runtime] Closing MCP servers failed: ${errorMessage(err)}`));
    });
  });
  // The kill closed the MCP servers (and unregistered their tools); a reset brings them back.
  killSwitch.onReset = () =>
    queueMcp(async () => {
      if (closed || !mcpStoppedByKill) return;
      mcpStoppedByKill = false;
      mcp = await connectMcp();
      logger.info(`[Runtime] MCP servers restarted after the kill switch reset: ${mcp.reports.length} connected, ${mcp.failures.length} failed.`);
    });

  // --- Housekeeping ---
  try {
    const purged = await sessions.purgeOrphanedRows();
    if (purged.messages + purged.tasks + purged.pointers + purged.memories > 0) logger.info(`[Runtime] Purged orphaned rows: ${JSON.stringify(purged)}`);
  } catch (err: unknown) {
    noteIssue(`Orphaned-row cleanup failed: ${errorMessage(err)}`);
  }
  if (options.reconcileInterruptedTasks !== false) {
    try {
      const interrupted = await sessions.reconcileInterruptedTasks('Interrupted by restart');
      if (interrupted > 0) logger.info(`[Runtime] Marked ${interrupted} task(s) left active by a previous run as cancelled.`);
    } catch (err: unknown) {
      noteIssue(`Interrupted-task cleanup failed: ${errorMessage(err)}`);
    }
  }
  const decayTimer = setInterval(() => {
    reflexes.decayStale().catch((err: unknown) => logger.warn(`[Runtime] Reflex decay failed: ${errorMessage(err)}`));
  }, options.decayIntervalMs ?? DAY_MS);
  decayTimer.unref();

  let closed = false;
  let closing: Promise<void> | null = null;

  // The same registry and parser the chat pipeline uses, so tool cases are offered and judged exactly as a chat turn is.
  const evalToolbox: EvalToolbox = { registry: tools, parseCalls: (text) => executor.parseModelToolCalls(text) };

  const runtime: JarvisRuntime = {
    config: cfg,
    ownerUserId,
    store,
    sessions,
    memory,
    killSwitch,
    approvals,
    ownActions,
    gateway,
    ledger,
    registry,
    capability,
    governor,
    router,
    tools,
    executor,
    get mcp() {
      return mcp;
    },
    skills,
    reflexes,
    orchestrator,
    evalHarness: new EvaluationHarness(providerFor(cfg.defaultModel), { thinkingMode: cfg.thinkingMode, toolbox: evalToolbox }),
    benchmark: { suite: new ModelBenchmarkSuite({ thinkingMode: cfg.thinkingMode, toolbox: evalToolbox }), guard: benchmarkGuard, cache: benchmarkCache },
    email,
    browser,
    host,
    mobile,
    media,
    search,
    distiller,
    consensus,
    limits,
    get closed() {
      return closed;
    },
    providerFor,
    speedProbeFor,
    createProvisioner,
    refreshInventory,

    getStatus(): RuntimeStatus {
      const checkedAt = snapshot.checkedAt;
      return {
        killSwitch: { engaged: killSwitch.isKilled(), reason: killSwitch.getKillReason() },
        inventory: {
          status: snapshot.status,
          reachable: snapshot.reachable,
          checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
          ageMs: checkedAt === null ? null : Math.max(0, now() - checkedAt),
          installed: snapshot.installed.map((model) => model.name),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
        vram: { freeBytes: capability.getVramFree() },
        host: { freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem() },
        loadedModels: snapshot.loaded,
        activeHeavyModel: governor.getActiveHeavyModel(),
        queueLength: governor.getQueueLength(),
        pendingApprovals: approvals.pending(),
        mcp: {
          servers: mcp.reports.map((entry) => entry.server),
          failures: [...mcp.failures],
          changed: mcp.reports.flatMap((entry) => entry.report.changed.map((change) => ({ server: entry.server, ...change }))),
        },
        toolCount: tools.getAllTools().length,
        email: { transportConfigured: emailTransportConfigured },
        inFlight: inFlight.size,
        issues: [
          ...issues,
          ...(mcpStoppedByKill ? ['MCP servers are stopped by the kill switch; they restart when it is reset.'] : []),
          ...(snapshot.checkedAt !== null && !snapshot.reachable ? [`Ollama: ${snapshot.status}`] : []),
        ],
        closed,
      };
    },

    registerAbort(controller: AbortController): void {
      if (killSwitch.isKilled()) {
        controller.abort(`Kill switch engaged: ${killSwitch.getKillReason()}`);
        return;
      }
      inFlight.add(controller);
    },

    unregisterAbort(controller: AbortController): void {
      inFlight.delete(controller);
    },

    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        clearInterval(decayTimer);
        unsubscribeKill();
        for (const controller of [...inFlight]) controller.abort('Runtime closing');
        inFlight.clear();
        approvals.denyAll('Runtime closing');
        await queueMcp(async () => {
          const closingMcp = mcp;
          mcp = stoppedMcp();
          await closingMcp.closeAll().catch((err: unknown) => logger.warn(`[Runtime] Closing MCP servers failed: ${errorMessage(err)}`));
        });
        if (ownsActions) {
          try {
            ownActions.close();
          } catch (err: unknown) {
            logger.warn(`[Runtime] Closing the action registry failed: ${errorMessage(err)}`);
          }
        }
        if (ownsStore) {
          try {
            store.close();
          } catch (err: unknown) {
            logger.warn(`[Runtime] Closing the store failed: ${errorMessage(err)}`);
          }
        }
      })();
      return closing;
    },
  };

  logger.info(`[Runtime] Ready: ${tools.getAllTools().length} tools, default model ${cfg.defaultModel}${issues.length > 0 ? `, ${issues.length} issue(s)` : ''}.`);
  return runtime;
}
