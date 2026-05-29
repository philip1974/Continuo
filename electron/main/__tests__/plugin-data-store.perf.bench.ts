// T5: P95 < 100ms CI bench. CI-only — local skip via env gate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';

const SKIP_PERF = !process.env.CI && !process.env.RUN_PERF;
const ITER = 50;

describe.skipIf(SKIP_PERF)('T5 PluginDataStore perf bench', () => {
  let tmp: string;
  let handlers: Record<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'plugin-data-perf-'));
    handlers = {};
    const fakeIpc = {
      handle: (
        ch: string,
        h: (event: unknown, ...args: unknown[]) => Promise<unknown>,
      ) => {
        handlers[ch] = h;
      },
    } as unknown as Parameters<typeof registerPluginDataStoreHandlers>[0];
    registerPluginDataStoreHandlers(fakeIpc, { userDataPath: tmp });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('save P95 < 100ms after warmup', async () => {
    const pluginId = randomUUID();
    const fakeEvent = {};
    for (let i = 0; i < 3; i++) {
      await handlers['plugin-data:save']!(fakeEvent, pluginId, { i });
    }

    const times: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const start = process.hrtime.bigint();
      await handlers['plugin-data:save']!(fakeEvent, pluginId, {
        i,
        payload: 'x'.repeat(100),
      });
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1_000_000);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(
      `[T5] save P95: ${p95?.toFixed(2)}ms, ratio_vs_in_memory: ${
        p95 ? (p95 / 0.5).toFixed(0) : 'N/A'
      }x`,
    );
    expect(p95).toBeLessThan(100);
  });

  it('load P95 < 100ms after warmup', async () => {
    const pluginId = randomUUID();
    const fakeEvent = {};
    await handlers['plugin-data:save']!(fakeEvent, pluginId, {
      warmup: true,
    });
    for (let i = 0; i < 3; i++) {
      await handlers['plugin-data:load']!(fakeEvent, pluginId);
    }

    const times: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const start = process.hrtime.bigint();
      await handlers['plugin-data:load']!(fakeEvent, pluginId);
      const end = process.hrtime.bigint();
      times.push(Number(end - start) / 1_000_000);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`[T5] load P95: ${p95?.toFixed(2)}ms`);
    expect(p95).toBeLessThan(100);
  });
});
