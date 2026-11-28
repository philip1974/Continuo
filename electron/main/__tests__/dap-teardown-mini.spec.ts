// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEBUG_SPIKE_FIXTURE_TIMEOUT_MS,
  ensureDebugSpikeFixture,
  prepareCommonJsAdapter,
  processInfo,
  pidsInProcessGroup,
  waitForDead,
} from './_helpers/debug-adapter';
import { sleep } from '../../shared/wait-at-most';

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

describeWithAdapter('Phase 0b DAP teardown in electron/main context', () => {
  // fixture 是 gitignore 的编译产物:新 worktree 只复制了 .adapter 时补编一次。
  beforeAll(() => ensureDebugSpikeFixture(spikeDir), DEBUG_SPIKE_FIXTURE_TIMEOUT_MS);

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
      const adapterCopy = await prepareCommonJsAdapter(adapterPath, 'continuo-main-dap-cjs-');
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
