// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const root = process.cwd();
const spikeDir = path.join(root, 'scripts/debug-spike');
const adapterPath = path.join(
  spikeDir,
  '.adapter/js-debug/src/dapDebugServer.js',
);
const program = path.join(spikeDir, '.out/fixture.js');
const breakpointFile = path.join(spikeDir, 'fixture.ts');
const breakpointLine = 14;
const adapterExists = existsSync(adapterPath);
const describeWithAdapter = adapterExists ? describe : describe.skip;

type ProcessInfo = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
};

type ProcessGroupEntry = {
  pid: number;
  pgid: number;
  command: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function prepareCommonJsAdapter() {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-main-dap-cjs-'));
  await cp(path.dirname(adapterPath), dir, { recursive: true });
  const cjsPath = path.join(dir, 'dapDebugServer.cjs');
  await copyFile(adapterPath, cjsPath);
  return { dir, adapterPath: cjsPath };
}

async function processInfo(pid: number | undefined): Promise<ProcessInfo | null> {
  if (!pid || process.platform === 'win32') return null;
  try {
    const { stdout } = await execFile('ps', [
      '-o',
      'pid=,ppid=,pgid=,command=',
      '-p',
      String(pid),
    ]);
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    };
  } catch {
    return null;
  }
}

async function pidsInProcessGroup(pgid: number): Promise<ProcessGroupEntry[]> {
  if (!pgid || process.platform === 'win32') return [];
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,pgid=,command=']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match
          ? {
              pid: Number(match[1]),
              pgid: Number(match[2]),
              command: match[3] ?? '',
            }
          : null;
      })
      .filter((entry): entry is ProcessGroupEntry => entry !== null)
      .filter((entry) => entry.pgid === pgid);
  } catch {
    return [];
  }
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDead(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return [];
    await sleep(100);
  }
  return pids.filter(pidAlive);
}

describeWithAdapter('Phase 0b DAP teardown in electron/main context', () => {
  it(
    'spawns dapDebugServer from main-context child_process and reaps its POSIX process group',
    async () => {
      if (process.platform === 'win32') {
        throw new Error('Phase 0b teardown mini spec is POSIX-only; Windows deferred Phase 1');
      }

      // Phase 0b 强信号:此处只验证 main 进程上下文的 child_process spawn + teardown。
      // 它不是 main 托管等价验证,不覆盖 Electron 打包/asar、BrowserWindow close 或 renderer IPC。
      // @ts-expect-error spike helper is an ESM .mjs file without a declaration file.
      const { DapClient } = await import('../../../scripts/debug-spike/dap-client.mjs');
      // @ts-expect-error spike helper is an ESM .mjs file without a declaration file.
      const { runClosedLoop } = await import('../../../scripts/debug-spike/dap-driver.mjs');
      const adapterCopy = await prepareCommonJsAdapter();
      const transcript: unknown[] = [];
      const client = new DapClient({
        adapterPath: adapterCopy.adapterPath,
        transcript,
      });

      try {
        const endpoint = client.socketPath ?? String(client.tcpPort);
        if (client.socketPath) {
          await rm(client.socketPath, { force: true });
        }
        client.server = spawn(process.execPath, [adapterCopy.adapterPath, endpoint], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });
        client.server.stderr?.on('data', (chunk: Buffer) => {
          client.serverStderr += chunk.toString('utf8');
        });
        client.server.stdout?.on('data', (chunk: Buffer) => {
          transcript.push({
            direction: 'server-stdout',
            text: chunk.toString('utf8'),
          });
        });
        client.server.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          client.rejectAllPending(
            new Error(`DAP server exited code=${code} signal=${signal}`),
          );
        });

        client.socket = await client.waitForReady();
        client.attachSocket(client.socket);

        const result = await runClosedLoop(client, {
          program,
          breakpointFile,
          breakpointLine,
          cwd: spikeDir,
          stopForTeardown: true,
        });
        expect(result.stopped.body?.reason).toBe('breakpoint');
        expect(result.frame.source?.path).toBe(breakpointFile);
        expect(result.frame.line).toBe(breakpointLine);

        const adapter = await processInfo(client.server.pid);
        const pgid = adapter?.pgid ?? client.server.pid;
        const groupBefore = await pidsInProcessGroup(pgid);
        const debuggeePids = result.processEvents
          .map((event: { systemProcessId?: unknown }) => event.systemProcessId)
          .filter((pid: unknown): pid is number => Number.isInteger(pid));
        const pidsToWatch = Array.from(
          new Set(
            [
              client.server.pid,
              ...debuggeePids,
              ...groupBefore.map((entry) => entry.pid),
            ].filter((pid): pid is number => Boolean(pid)),
          ),
        );

        expect(pidsToWatch).toContain(client.server.pid);

        process.kill(-pgid, 'SIGTERM');
        let alive = await waitForDead(pidsToWatch, 1_500);
        if (alive.length > 0) {
          process.kill(-pgid, 'SIGKILL');
          alive = await waitForDead(alive, 3_000);
        }
        await Promise.race([
          once(client.server, 'exit'),
          sleep(1_000),
        ]);

        const groupAfter = await pidsInProcessGroup(pgid);
        expect({
          adapter,
          debuggeePids,
          groupBefore,
          alive,
          groupAfter,
        }).toMatchObject({
          alive: [],
          groupAfter: [],
        });
      } finally {
        await client.dispose().catch(() => undefined);
        await rm(adapterCopy.dir, { recursive: true, force: true });
      }
    },
    130_000,
  );
});
