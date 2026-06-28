#!/usr/bin/env node
import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  DapClient,
  EXPECTED_JS_DEBUG_SHA256,
  defaultAdapterPath,
} from './dap-client.mjs';
import { runClosedLoop } from './dap-driver.mjs';

const execFile = promisify(execFileCb);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const program = path.join(scriptDir, '.out', 'fixture.js');
const breakpointFile = path.join(scriptDir, 'fixture.ts');
const breakpointLine = 14;
const teardownMode = process.argv.includes('--teardown');

function printTranscript(transcript) {
  for (const entry of transcript) {
    console.log(`[dap:${entry.direction}] ${JSON.stringify(entry.message ?? entry.text)}`);
  }
}

async function prepareCommonJsAdapter() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuo-js-debug-cjs-'));
  await fs.cp(path.dirname(defaultAdapterPath), dir, { recursive: true });
  const cjsPath = path.join(dir, 'dapDebugServer.cjs');
  await fs.copyFile(defaultAdapterPath, cjsPath);
  return { dir, adapterPath: cjsPath };
}

async function processInfo(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    const { stdout } = await execFile('ps', ['-o', 'pid=,ppid=,pgid=,command=', '-p', String(pid)]);
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(stdout.trim());
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4],
    };
  } catch {
    return null;
  }
}

async function pidsInProcessGroup(pgid) {
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
          ? { pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }
          : null;
      })
      .filter((entry) => entry && entry.pgid === pgid);
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDead(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = pids.filter(pidAlive);
    if (alive.length === 0) return [];
    await sleep(100);
  }
  return pids.filter(pidAlive);
}

function printClosedLoopSummary(result) {
  console.log(`[debug-spike] stopped(reason=${result.stopped.body?.reason})`);
  console.log(`[debug-spike] frame source=${result.frame.source?.path}:${result.frame.line}`);
  console.log(`[debug-spike] variables nested.answer=${result.variables.nested?.children.answer?.value}`);
  console.log(`[debug-spike] variables nested.inner.k=${result.variables.nested?.children.inner?.children.k?.value}`);
  console.log(`[debug-spike] variables arr[0..2]=${JSON.stringify(result.variables.arr?.items)}`);
  console.log(`[debug-spike] variables sum=${result.variables.sum}`);
  console.log(`[debug-spike] evaluate nested.answer=${result.evaluate.nestedAnswer}`);
  console.log(`[debug-spike] evaluate nested.inner.k=${result.evaluate.innerK}`);
  console.log(`[debug-spike] evaluate arr.length=${result.evaluate.arrayLength}`);
  console.log(`[debug-spike] evaluate sum=${result.evaluate.sum}`);
  if ('staleReferenceRejected' in result) {
    console.log(`[debug-spike] stale variablesReference rejected=${result.staleReferenceRejected}`);
  }
}

async function runTeardown(client, result) {
  if (process.platform === 'win32') {
    throw new Error('teardown spike is POSIX-only; Windows deferred to Phase 1');
  }

  const adapterPid = client.server?.pid;
  const adapter = await processInfo(adapterPid);
  const pgid = adapter?.pgid ?? adapterPid;
  const debuggeePids = result.processEvents
    .map((event) => event.systemProcessId)
    .filter((pid) => Number.isInteger(pid));
  const groupBefore = await pidsInProcessGroup(pgid);
  const pidsToWatch = Array.from(new Set([
    adapterPid,
    ...debuggeePids,
    ...groupBefore.map((entry) => entry.pid),
  ].filter(Boolean)));

  console.log('[debug-spike] teardown POSIX-only; Windows deferred Phase 1');
  console.log(`[debug-spike] adapter pid=${adapter?.pid ?? adapterPid} ppid=${adapter?.ppid ?? 'unknown'} pgid=${pgid}`);
  console.log(`[debug-spike] adapter command=${adapter?.command ?? 'unknown'}`);
  console.log(`[debug-spike] debuggee pids=${debuggeePids.length ? debuggeePids.join(',') : 'none-from-dap-process-event'}`);
  console.log(`[debug-spike] process-group before=${groupBefore.map((entry) => `${entry.pid}:${entry.command}`).join(' | ')}`);

  console.log(`[debug-spike] teardown SIGTERM at ${new Date().toISOString()}`);
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch (err) {
    console.log(`[debug-spike] teardown SIGTERM failed: ${err.message}`);
  }

  let alive = await waitForDead(pidsToWatch, 1_500);
  if (alive.length > 0) {
    console.log(`[debug-spike] teardown SIGKILL at ${new Date().toISOString()} alive=${alive.join(',')}`);
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (err) {
      console.log(`[debug-spike] teardown SIGKILL failed: ${err.message}`);
    }
    alive = await waitForDead(alive, 3_000);
  } else {
    console.log('[debug-spike] teardown SIGKILL not needed');
  }

  const groupAfter = await pidsInProcessGroup(pgid);
  console.log(`[debug-spike] teardown final alive pid=${alive.length ? alive.join(',') : 'none'}`);
  console.log(`[debug-spike] teardown process-group after=${groupAfter.map((entry) => entry.pid).join(',') || 'none'}`);
  if (alive.length > 0 || groupAfter.length > 0) {
    throw new Error(`teardown left alive pids: ${Array.from(new Set([...alive, ...groupAfter.map((entry) => entry.pid)])).join(',')}`);
  }
  console.log('[debug-spike] teardown result=PASS');
}

async function main() {
  const transcript = [];
  const adapterCopy = await prepareCommonJsAdapter();
  const client = new DapClient({
    transcript,
    adapterPath: adapterCopy.adapterPath,
  });

  console.log('[debug-spike] adapter:', defaultAdapterPath);
  console.log('[debug-spike] adapter runtime copy:', adapterCopy.adapterPath);
  console.log('[debug-spike] js-debug version: 1.117.0');
  console.log('[debug-spike] expected sha256:', EXPECTED_JS_DEBUG_SHA256);
  console.log('[debug-spike] node:', process.version);
  console.log('[debug-spike] platform:', `${process.platform}/${process.arch}`);

  try {
    await client.spawnServer();
    const result = await runClosedLoop(client, {
      program,
      breakpointFile,
      breakpointLine,
      cwd: scriptDir,
      stopForTeardown: teardownMode,
    });
    printClosedLoopSummary(result);
    if (teardownMode) {
      await runTeardown(client, result);
    }
    printTranscript(transcript);
    console.log('[debug-spike] result:', JSON.stringify({
      stoppedReason: result.stopped.body?.reason,
      hitLine: result.frame.line,
      sourcePath: result.frame.source?.path,
      evaluate: result.evaluate,
    }, null, 2));
  } catch (err) {
    printTranscript(transcript);
    console.error('[debug-spike] FAIL:', err.message);
    if (client.server?.pid) {
      console.error('[debug-spike] adapter pid:', client.server.pid);
    }
    process.exitCode = 1;
  } finally {
    await client.dispose().catch(() => undefined);
    await fs.rm(adapterCopy.dir, { recursive: true, force: true });
  }
}

await main();
