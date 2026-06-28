// @vitest-environment node

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DapStreamDecoder,
  encodeDapMessage,
  type DapMessage,
  type DapResponseMessage,
} from '../services/dap-client';

const root = process.cwd();
const adapterPath = path.join(
  root,
  'scripts/debug-spike/.adapter/js-debug/src/dapDebugServer.js',
);
const adapterExists = existsSync(adapterPath);

async function prepareCommonJsAdapter() {
  const dir = await mkdtemp(path.join(tmpdir(), 'continuo-debug-adapter-smoke-'));
  await cp(path.dirname(adapterPath), dir, { recursive: true });
  const runnablePath = path.join(dir, 'dapDebugServer.js');
  await copyFile(adapterPath, runnablePath);
  await writeFile(path.join(dir, 'package.json'), '{"type":"commonjs"}\n');
  return { dir, adapterPath: runnablePath };
}

function endpointForTest(): string {
  if (process.platform === 'win32') {
    return String(20_000 + Math.floor(Math.random() * 30_000));
  }
  return path.join(tmpdir(), `continuo-dap-smoke-${process.pid}-${Date.now()}.sock`);
}

function connectEndpoint(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = /^\d+$/.test(endpoint)
      ? net.connect({ port: Number(endpoint), host: '127.0.0.1' })
      : net.connect(endpoint);
    socket.once('connect', () => resolve(socket));
    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

async function waitForReady(endpoint: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await connectEndpoint(endpoint);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  throw new Error(
    `DAP adapter readiness timed out after ${timeoutMs}ms; last error: ${
      lastError?.message ?? 'none'
    }`,
  );
}

function waitForInitializeResponse(
  socket: Socket,
  requestSeq: number,
  timeoutMs: number,
): Promise<DapResponseMessage> {
  const decoder = new DapStreamDecoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`initialize response timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('DAP socket closed before initialize response'));
    };
    const onData = (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (isInitializeResponse(message, requestSeq)) {
          cleanup();
          resolve(message);
        }
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function isInitializeResponse(
  message: DapMessage,
  requestSeq: number,
): message is DapResponseMessage {
  return (
    message.type === 'response' &&
    message.command === 'initialize' &&
    message.request_seq === requestSeq
  );
}

async function killAdapter(pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGTERM');
    else process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
}

describe.skipIf(!adapterExists)('Debug adapter smoke', () => {
  it('starts dapDebugServer in node mode, answers initialize, and exits on kill', async () => {
    const adapterCopy = await prepareCommonJsAdapter();
    const endpoint = endpointForTest();
    let stderr = '';
    const server = spawn(process.execPath, [adapterCopy.adapterPath, endpoint], {
      // In packaged Electron this same adapter path is launched with ELECTRON_RUN_AS_NODE=1.
      // The dev smoke uses plain Node with the env present because process.execPath is Node in Vitest.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    });

    server.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    try {
      const socket = await waitForReady(endpoint, 15_000);
      try {
        const requestSeq = 1;
        const responsePromise = waitForInitializeResponse(socket, requestSeq, 20_000);
        socket.write(
          encodeDapMessage({
            seq: requestSeq,
            type: 'request',
            command: 'initialize',
            arguments: {
              adapterID: 'pwa-node',
              clientID: 'continuo-debug-adapter-smoke',
              clientName: 'Continuo debug adapter smoke',
              columnsStartAt1: true,
              linesStartAt1: true,
              pathFormat: 'path',
            },
          }),
        );

        await expect(responsePromise).resolves.toMatchObject({
          type: 'response',
          command: 'initialize',
          request_seq: requestSeq,
          success: true,
        });
      } finally {
        socket.destroy();
      }

      await killAdapter(server.pid);
      await Promise.race([
        once(server, 'exit'),
        new Promise((resolve) => {
          setTimeout(resolve, 3_000);
        }),
      ]);
      expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${message}\nresolved adapter path: ${adapterPath}\nruntime adapter path: ${adapterCopy.adapterPath}\nstderr:\n${stderr}`,
      );
    } finally {
      await killAdapter(server.pid);
      await rm(endpoint, { force: true }).catch(() => undefined);
      await rm(adapterCopy.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
