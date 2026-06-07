// 服务实现: MCP terminal.await_stop_hook + bundled install_stop_hook。
// 设计来源: ported from Nous packages/shells/shell/src/external-cli-bridge/{hook-completion-waiter,parse-payload,settings-templates}.ts
// 与 Nous 差异:
//  - app-singleton broker (Continuo 端只一个实例,不是 per-call)
//  - matched-only unlink (P0-3) + maxEntries=500 + maxAgeMs=600_000 stale cleanup (P1-1)
//  - ambiguity guard (P0-1): 同 (windowId, runner, cwd) 第二 pending → AWAIT_STOP_HOOK_ALREADY_PENDING
//  - Codex hook filename 加 windowId (P0-4)
//  - settings merge 不 parse TOML, block-level regex + marker-only path drift (P1-3)
//  - raw default omit (P1-4) — broker 返回完整 payload, awaitStopHookTool.run() 仅 input.include_raw=true 时加 output
//  - start fail degrade (P2-1) — broker.start throw → 上层 startMcpHost 不注册 tool

import { watch, type FSWatcher } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';

import {
  awaitStopHookInputSchema,
  MCP_TOOL_AWAIT_STOP_HOOK,
  type AwaitStopHookInput,
  type AwaitStopHookOutput,
} from '../../shared/mcp-terminal-schemas';
import { ERROR_CODES } from '../../shared/error-codes';
import type { McpCallCtx, McpToolDef } from './mcp-host.service';

export type RunnerKind = 'cc' | 'codex' | 'unknown';

interface TerminalSessionMetaLike {
  readonly id: string;
  readonly cwd: string;
  readonly agentLabel?: string;
  readonly autorun?: string;
}

interface NormalizedPayload {
  readonly runner: 'cc' | 'codex';
  readonly cliSessionId: string;
  readonly turnId: string | null;
  readonly cwd: string | null;
  readonly transcriptPath: string | null;
  readonly lastAssistantMessage: string | null;
  readonly raw: Record<string, unknown>;
}

interface AwaitFilter {
  readonly windowId: number;
  readonly runner: 'cc' | 'codex';
  readonly cwd: string;
  readonly timeoutMs: number;
}

const HOOK_FILE_PREFIX = { cc: 'cc_', codex: 'codex_' } as const;
const BROKER_DEFAULTS = {
  maxEntries: 500,
  maxAgeMs: 600_000,
  cleanupIntervalMs: 60_000,
} as const;

export function inferRunner(session: TerminalSessionMetaLike): RunnerKind {
  const label = session.agentLabel?.toLowerCase() ?? '';
  if (label === 'cc' || label === 'claude' || label === 'claude-code') {
    return 'cc';
  }
  if (label === 'codex') return 'codex';

  const autorun = session.autorun?.toLowerCase() ?? '';
  const match = /^(claude|codex)(?:\s|$)/.exec(autorun);
  if (match?.[1] === 'claude') return 'cc';
  if (match?.[1] === 'codex') return 'codex';
  return 'unknown';
}

export function inferRunnerFromFilename(
  fileName: string,
): 'cc' | 'codex' | null {
  if (fileName.startsWith(HOOK_FILE_PREFIX.cc)) return 'cc';
  if (fileName.startsWith(HOOK_FILE_PREFIX.codex)) return 'codex';
  return null;
}

export function parseStopPayload(
  runner: 'cc' | 'codex',
  _fileName: string,
  jsonText: string,
): NormalizedPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const r = raw as Record<string, unknown>;
  const sessionId =
    typeof r.session_id === 'string' && r.session_id.length > 0
      ? r.session_id
      : null;
  if (sessionId === null) return null;

  return {
    runner,
    cliSessionId: sessionId,
    turnId:
      typeof r.turn_id === 'string' && r.turn_id.length > 0
        ? r.turn_id
        : null,
    cwd: typeof r.cwd === 'string' && r.cwd.length > 0 ? r.cwd : null,
    transcriptPath:
      typeof r.transcript_path === 'string' && r.transcript_path.length > 0
        ? r.transcript_path
        : null,
    lastAssistantMessage:
      typeof r.last_assistant_message === 'string' &&
      r.last_assistant_message.length > 0
        ? r.last_assistant_message
        : null,
    raw: r,
  };
}

interface BufferedEntry {
  readonly fileName: string;
  readonly payload: NormalizedPayload;
  readonly windowId: number | null;
  readonly ingestedAt: number;
}

interface PendingWaiter {
  readonly filter: AwaitFilter;
  readonly resolve: (entry: BufferedEntry) => void;
  readonly reject: (err: Error) => void;
  readonly key: string;
  timer: NodeJS.Timeout | null;
}

type AwaitNextResult =
  | BufferedEntry
  | { readonly status: 'timeout'; readonly elapsedMs: number };

function filterKey(filter: AwaitFilter): string {
  return `${filter.windowId}|${filter.runner}|${filter.cwd}`;
}

function parseFilenameForWindowId(fileName: string): number | null {
  const match = /^(cc|codex)_([0-9]+)_/.exec(fileName);
  if (match?.[2] === undefined) return null;
  return Number.parseInt(match[2], 10);
}

export interface HookFileBroker {
  start(): Promise<void>;
  awaitNext(filter: AwaitFilter): Promise<AwaitNextResult>;
  stop(): Promise<void>;
  readonly hookEventsDir: string;
}

export function createHookFileBroker(
  hookEventsDir: string,
  config: {
    maxEntries?: number;
    maxAgeMs?: number;
    cleanupIntervalMs?: number;
  } = {},
): HookFileBroker {
  const maxEntries = config.maxEntries ?? BROKER_DEFAULTS.maxEntries;
  const maxAgeMs = config.maxAgeMs ?? BROKER_DEFAULTS.maxAgeMs;
  const cleanupIntervalMs =
    config.cleanupIntervalMs ?? BROKER_DEFAULTS.cleanupIntervalMs;

  let watcher: FSWatcher | null = null;
  let cleanupTimer: NodeJS.Timeout | null = null;
  let started = false;
  let stopped = false;
  const processed = new Set<string>();
  const buffered: BufferedEntry[] = [];
  const pendingByKey = new Map<string, PendingWaiter>();

  function matchesFilter(entry: BufferedEntry, filter: AwaitFilter): boolean {
    if (entry.payload.runner !== filter.runner) return false;
    if (entry.windowId !== null && entry.windowId !== filter.windowId) {
      return false;
    }
    if (entry.payload.cwd !== null && entry.payload.cwd !== filter.cwd) {
      return false;
    }
    return true;
  }

  async function ingestFile(fileName: string): Promise<void> {
    if (stopped || processed.has(fileName)) return;

    const runner = inferRunnerFromFilename(fileName);
    if (runner === null) return;

    const filePath = path.join(hookEventsDir, fileName);
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(filePath);
    } catch {
      return;
    }

    if (Date.now() - fileStat.mtimeMs > maxAgeMs) {
      processed.add(fileName);
      void unlink(filePath).catch(() => {});
      return;
    }

    processed.add(fileName);

    let jsonText: string;
    try {
      jsonText = await readFile(filePath, 'utf8');
    } catch {
      return;
    }

    const payload = parseStopPayload(runner, fileName, jsonText);
    if (payload === null) {
      void unlink(filePath).catch(() => {});
      return;
    }

    const entry: BufferedEntry = {
      fileName,
      payload,
      windowId: parseFilenameForWindowId(fileName),
      ingestedAt: Date.now(),
    };

    for (const [key, pending] of pendingByKey) {
      if (matchesFilter(entry, pending.filter)) {
        pendingByKey.delete(key);
        if (pending.timer !== null) clearTimeout(pending.timer);
        void unlink(filePath).catch(() => {});
        pending.resolve(entry);
        return;
      }
    }

    buffered.push(entry);
    if (buffered.length > maxEntries) {
      const dropped = buffered.shift();
      if (dropped !== undefined) {
        void unlink(path.join(hookEventsDir, dropped.fileName)).catch(() => {});
      }
    }
  }

  function cleanupStale(): void {
    const now = Date.now();
    for (let i = buffered.length - 1; i >= 0; i -= 1) {
      const entry = buffered[i];
      if (entry !== undefined && now - entry.ingestedAt > maxAgeMs) {
        const stale = buffered.splice(i, 1)[0];
        if (stale !== undefined) {
          void unlink(path.join(hookEventsDir, stale.fileName)).catch(() => {});
        }
      }
    }
  }

  return {
    hookEventsDir,
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      await mkdir(hookEventsDir, { recursive: true });
      try {
        const entries = await readdir(hookEventsDir);
        for (const name of entries) {
          await ingestFile(name);
        }
      } catch {
        // Ignore startup directory races; watcher handles later files.
      }

      watcher = watch(
        hookEventsDir,
        { persistent: false, encoding: 'utf8' },
        (_eventType, fileName) => {
          if (typeof fileName === 'string' && fileName.length > 0) {
            void ingestFile(fileName);
          }
        },
      );
      watcher.on('error', () => {});
      cleanupTimer = setInterval(cleanupStale, cleanupIntervalMs);
    },
    awaitNext(filter) {
      return new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error('broker stopped'));
          return;
        }

        const key = filterKey(filter);
        if (pendingByKey.has(key)) {
          reject(
            Object.assign(
              new Error(
                'await_stop_hook already pending for same (windowId, runner, cwd)',
              ),
              { code: ERROR_CODES.AWAIT_STOP_HOOK_ALREADY_PENDING },
            ),
          );
          return;
        }

        for (let i = 0; i < buffered.length; i += 1) {
          const hit = buffered[i];
          if (hit !== undefined && matchesFilter(hit, filter)) {
            buffered.splice(i, 1);
            void unlink(path.join(hookEventsDir, hit.fileName)).catch(() => {});
            resolve(hit);
            return;
          }
        }

        const startedAt = Date.now();
        const pending: PendingWaiter = {
          filter,
          key,
          resolve,
          reject,
          timer: null,
        };
        pending.timer = setTimeout(() => {
          pendingByKey.delete(key);
          resolve({ status: 'timeout', elapsedMs: Date.now() - startedAt });
        }, filter.timeoutMs);
        pendingByKey.set(key, pending);
      });
    },
    async stop() {
      stopped = true;
      started = false;
      if (watcher !== null) {
        try {
          watcher.close();
        } catch {
          // ignore close races
        }
        watcher = null;
      }
      if (cleanupTimer !== null) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      for (const [, pending] of pendingByKey) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(new Error('broker stopped'));
      }
      pendingByKey.clear();
      buffered.length = 0;
      processed.clear();
    },
  };
}

type InstallStopHookResult = {
  readonly installed: boolean;
  readonly reason?:
    | 'already-installed'
    | 'parse-error'
    | 'unknown-runner'
    | 'no-cwd'
    | 'unrecognized-existing-stop-hook';
};

export async function installStopHookForSession(
  cwd: string,
  runner: RunnerKind,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  if (cwd.length === 0) return { installed: false, reason: 'no-cwd' };
  if (runner === 'unknown') {
    return { installed: false, reason: 'unknown-runner' };
  }
  if (runner === 'cc') return mergeClaudeCodeSettings(cwd, hookEventsDir);
  return mergeCodexConfig(cwd, hookEventsDir);
}

async function mergeClaudeCodeSettings(
  cwd: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const settingsPath = path.join(cwd, '.claude', 'settings.local.json');
  let existing: Record<string, unknown> = {};
  let fileExists = false;

  try {
    const text = await readFile(settingsPath, 'utf8');
    fileExists = true;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      return { installed: false, reason: 'parse-error' };
    }
  } catch {
    // file missing, create new
  }

  const hooks =
    existing.hooks !== null &&
    typeof existing.hooks === 'object' &&
    !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const stopArr = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];

  for (const entry of stopArr) {
    const inner = (entry as { hooks?: unknown[] } | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const marker = (hook as { _continuo_managed?: unknown })._continuo_managed;
      const command = (hook as { command?: unknown }).command;
      if (
        marker === true &&
        typeof command === 'string' &&
        command.includes('CONTINUO_HOOK_EVENTS_DIR')
      ) {
        return { installed: false, reason: 'already-installed' };
      }
    }
  }

  if (fileExists) {
    await copyFile(settingsPath, `${settingsPath}.continuo-bak.${Date.now()}`);
  } else {
    await mkdir(path.dirname(settingsPath), { recursive: true });
  }

  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'cc_${CONTINUO_WINDOW_ID:-unknown}_${CLAUDE_CODE_SESSION_ID:-unknown}_$(date +%s%N).jsonl"';

  stopArr.push({
    hooks: [{ type: 'command', command, _continuo_managed: true }],
  });
  const next = { ...existing, hooks: { ...hooks, Stop: stopArr } };
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { installed: true };
}

async function mergeCodexConfig(
  cwd: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const configPath = path.join(cwd, '.codex', 'config.toml');
  let text = '';
  let fileExists = false;
  try {
    text = await readFile(configPath, 'utf8');
    fileExists = true;
  } catch {
    // file missing, create new
  }

  if (/\[\[hooks\.Stop\]\][\s\S]*?command\s*=\s*'''/.test(text)) {
    return { installed: false, reason: 'unrecognized-existing-stop-hook' };
  }

  const managedStopPattern =
    /# continuo-managed[\s\S]*?command\s*=\s*"([^"]*)"/;
  const managedStop = managedStopPattern.exec(text);
  if (managedStop !== null) {
    if (text.includes(hookEventsDir)) {
      return { installed: false, reason: 'already-installed' };
    }
    return replaceManagedCodexStopHook(configPath, text, hookEventsDir);
  }

  if (fileExists) {
    await copyFile(configPath, `${configPath}.continuo-bak.${Date.now()}`);
  } else {
    await mkdir(path.dirname(configPath), { recursive: true });
  }

  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl"';
  const block =
    '\n# continuo-managed\n' +
    '[[hooks.Stop]]\n' +
    '[[hooks.Stop.hooks]]\n' +
    'type = "command"\n' +
    `command = ${JSON.stringify(command)}\n`;
  await writeFile(configPath, text + block, 'utf8');
  return { installed: true };
}

async function replaceManagedCodexStopHook(
  configPath: string,
  text: string,
  hookEventsDir: string,
): Promise<InstallStopHookResult> {
  const command =
    `mkdir -p "${hookEventsDir}" && ` +
    `cat > "\${CONTINUO_HOOK_EVENTS_DIR:-${hookEventsDir}}/` +
    'codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl"';
  const next = text.replace(
    /(# continuo-managed[\s\S]*?command\s*=\s*)"[^"]*"/,
    `$1${JSON.stringify(command)}`,
  );
  if (next === text) {
    return { installed: false, reason: 'unrecognized-existing-stop-hook' };
  }
  await copyFile(configPath, `${configPath}.continuo-bak.${Date.now()}`);
  await writeFile(configPath, next, 'utf8');
  return { installed: true };
}

interface AwaitStopHookToolDeps {
  readonly broker: HookFileBroker;
  readonly getSessionMeta: (
    sessionId: string,
    ctx: McpCallCtx,
  ) => TerminalSessionMetaLike | null;
}

export function createAwaitStopHookTool(
  deps: AwaitStopHookToolDeps,
): McpToolDef<AwaitStopHookInput, AwaitStopHookOutput> {
  return {
    name: MCP_TOOL_AWAIT_STOP_HOOK,
    description:
      'Block until next Stop hook fires for the given Continuo terminal session, or until timeout. ' +
      'v0.1 limitation: rejects with AWAIT_STOP_HOOK_ALREADY_PENDING if another await_stop_hook is in flight for the same (window, runner, cwd) — call sequentially for now.',
    jsonSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 600 },
        include_raw: { type: 'boolean' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    inputSchema:
      awaitStopHookInputSchema as unknown as McpToolDef<
        AwaitStopHookInput,
        AwaitStopHookOutput
      >['inputSchema'],
    run: async (input, ctx) => {
      const meta = deps.getSessionMeta(input.session_id, ctx);
      if (meta === null) {
        throw Object.assign(
          new Error(`terminal session not found: ${input.session_id}`),
          { code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND },
        );
      }

      const runner = inferRunner(meta);
      if (runner === 'unknown') {
        throw Object.assign(
          new Error(
            `unknown runner for session ${input.session_id}; cannot await stop hook`,
          ),
          { code: ERROR_CODES.TERMINAL_SESSION_NOT_FOUND },
        );
      }

      const startedAt = Date.now();
      const result = await deps.broker.awaitNext({
        windowId: ctx.ownerWindowId,
        runner,
        cwd: meta.cwd,
        timeoutMs: (input.timeout_sec ?? 60) * 1000,
      });

      if (!('payload' in result)) {
        return {
          status: 'timeout',
          session_id: input.session_id,
          cli_session_id: null,
          turn_id: null,
          cwd: null,
          transcript_path: null,
          last_assistant_message: null,
          elapsed_ms: result.elapsedMs,
        };
      }

      return {
        status: 'stop',
        session_id: input.session_id,
        cli_session_id: result.payload.cliSessionId,
        turn_id: result.payload.turnId,
        cwd: result.payload.cwd,
        transcript_path: result.payload.transcriptPath,
        last_assistant_message: result.payload.lastAssistantMessage,
        elapsed_ms: Date.now() - startedAt,
        ...(input.include_raw === true ? { raw: result.payload.raw } : {}),
      };
    },
  };
}
