import { mkdtemp, rm, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLUGIN_FS_CHANNELS } from '../../../../electron/shared/plugin-fs-channels';
import { IdentityRegistry } from '../../../../electron/main/services/identity-registry.service';
import { PathScopeRegistry } from '../../../../electron/main/services/path-scope-registry.service';
import { ScopeRequestCorrelator } from '../../../../electron/main/services/scope-request-correlator';
import { registerPluginFsHandlers } from '../../../../electron/main/services/plugin-fs.service';
import { ScopeError, type PathScope } from '../../../plugins/types';
import {
  StubIpcMain,
  makeFakeEvent,
  type StubIpcEvent,
} from './make-stub-ipc';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) =>
      name === 'home' ? '/tmp/sdk-contract-home' : '',
    ),
  },
}));

interface FsHarness {
  ipc: StubIpcMain;
  event: StubIpcEvent;
  identity: IdentityRegistry;
  scopes: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
  token: string;
}

let tmpRoot: string;
let tmpCanonical: string;
let siblingRoot: string;
let harness: FsHarness;

interface PersistenceDeps {
  loadPersistedScopes?: (pluginId: string) => Promise<readonly PathScope[]>;
  persistScopes?: (
    pluginId: string,
    scopes: readonly PathScope[],
  ) => Promise<void>;
}

async function makeHarness(persistence?: PersistenceDeps): Promise<FsHarness> {
  const ipc = new StubIpcMain();
  const identity = new IdentityRegistry();
  const scopes = new PathScopeRegistry(identity);
  const correlator = new ScopeRequestCorrelator({
    ttlMs: 60_000,
    gcIntervalMs: 60_000,
  });
  registerPluginFsHandlers(ipc as never, {
    identityRegistry: identity,
    pathScopeRegistry: scopes,
    correlator,
    webContentsForSender: () => null,
    ...persistence,
  });
  const event = makeFakeEvent({ id: 1 });
  const token = (
    await ipc.invokeWithEvent(
      event,
      PLUGIN_FS_CHANNELS.REGISTER_PLUGIN,
      'plugin.fs',
    )
  ) as { token: string; generation: number };
  return { ipc, event, identity, scopes, correlator, token: token.token };
}

/**
 * 等待 request-scope handler 发出 scope-request 并返回 requestId。
 * handler 在发 send 前有 canonicalize / hydrate 等 await,故不能同步读 mock。
 */
async function nextRequestId(h: FsHarness): Promise<string> {
  const call = await vi.waitFor(() => {
    const c = h.event.sender.send.mock.calls.at(-1);
    if (!c) throw new Error('scope-request 尚未发出');
    return c;
  });
  return (call[1] as { requestId: string }).requestId;
}

/** 驱动一次完整的弹窗授权(发请求 → renderer 决策),返回 request-scope 的最终决议。 */
async function grantViaPrompt(
  h: FsHarness,
  requestScopes: readonly PathScope[],
): Promise<unknown> {
  const pending = h.ipc.invokeWithEvent(
    h.event,
    PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
    h.token,
    requestScopes,
  );
  const requestId = await nextRequestId(h);
  await h.ipc.invokeWithEvent(
    h.event,
    PLUGIN_FS_CHANNELS.SCOPE_DECISION,
    requestId,
    'grant',
  );
  return pending;
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), `sdk-contract-fs-${randomUUID()}-`));
  tmpCanonical = await realpath(tmpRoot);
  siblingRoot = await mkdtemp(join(tmpdir(), `sdk-contract-fs-sibling-${randomUUID()}-`));
  harness = await makeHarness();
});

afterEach(async () => {
  harness.correlator.dispose();
  await rm(tmpRoot, { recursive: true, force: true });
  await rm(siblingRoot, { recursive: true, force: true });
});

describe('sdk-contract integration: plugin-fs.service', () => {
  it('T1 request-scope grants scopes after renderer decision', async () => {
    const pending = harness.ipc.invokeWithEvent(
      harness.event,
      PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
      harness.token,
      [{ path: tmpCanonical, mode: 'rw' }],
    );
    const requestId = await nextRequestId(harness);

    await harness.ipc.invokeWithEvent(
      harness.event,
      PLUGIN_FS_CHANNELS.SCOPE_DECISION,
      requestId,
      'grant',
    );

    await expect(pending).resolves.toBe('grant');
    expect(harness.scopes._peek('plugin.fs')).toEqual([
      { path: tmpCanonical, mode: 'rw' },
    ]);
  });

  it('T2 writeFile succeeds inside a granted rw scope', async () => {
    harness.scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
    const target = join(tmpRoot, 'note.txt');

    await harness.ipc.invokeWithEvent(
      harness.event,
      PLUGIN_FS_CHANNELS.WRITE_FILE,
      harness.token,
      target,
      'hello',
    );

    await expect(readFile(target, 'utf-8')).resolves.toBe('hello');
  });

  it('T3 writeFile rejects outside granted scopes', async () => {
    harness.scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
    const target = join(siblingRoot, 'outside.txt');

    await expect(
      harness.ipc.invokeWithEvent(
        harness.event,
        PLUGIN_FS_CHANNELS.WRITE_FILE,
        harness.token,
        target,
        'nope',
      ),
    ).rejects.toBeInstanceOf(ScopeError);
  });

  it('T4 atomicReplaceWithinScope replaces final from staging in same parent', async () => {
    harness.scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
    const staging = join(tmpRoot, 'file.tmp');
    const final = join(tmpRoot, 'file.txt');
    await writeFile(staging, 'next', 'utf-8');
    await writeFile(final, 'old', 'utf-8');

    await harness.ipc.invokeWithEvent(
      harness.event,
      PLUGIN_FS_CHANNELS.ATOMIC_REPLACE,
      harness.token,
      staging,
      final,
      { overwrite: true },
    );

    await expect(readFile(final, 'utf-8')).resolves.toBe('next');
    await expect(readFile(staging, 'utf-8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('T5 atomicReplaceWithinScope enforces same parent', async () => {
    harness.scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
    const child = join(tmpRoot, 'child');
    await mkdir(child);
    const staging = join(tmpRoot, 'file.tmp');
    const final = join(child, 'file.txt');
    await writeFile(staging, 'next', 'utf-8');

    await expect(
      harness.ipc.invokeWithEvent(
        harness.event,
        PLUGIN_FS_CHANNELS.ATOMIC_REPLACE,
        harness.token,
        staging,
        final,
        { overwrite: true },
      ),
    ).rejects.toThrow(/share parent/);
  });

  it('T6 mkdir recursive documents topic-05 bootstrap parent chain precheck', async () => {
    harness.scopes.grant('plugin.fs', [{ path: tmpCanonical, mode: 'rw' }]);
    const target = join(tmpRoot, 'a', 'b');

    await expect(
      harness.ipc.invokeWithEvent(
        harness.event,
        PLUGIN_FS_CHANNELS.MKDIR,
        harness.token,
        target,
        { recursive: true },
      ),
    ).rejects.toMatchObject({
      details: { reason: 'ENOENT' },
    });
  });

  it('T8 同会话已授 scope 再次请求时静默授予,不再弹窗', async () => {
    const persistScopes = vi.fn(async () => {});
    const h = await makeHarness({ persistScopes });

    // 第一次:走弹窗授权
    await expect(grantViaPrompt(h, [{ path: tmpCanonical, mode: 'rw' }])).resolves.toBe(
      'grant',
    );
    const sendCallsAfterFirst = h.event.sender.send.mock.calls.length;
    expect(sendCallsAfterFirst).toBeGreaterThan(0);

    // 第二次:同一(子树)scope —— 应静默 grant,不再发 scope-request
    await expect(
      h.ipc.invokeWithEvent(
        h.event,
        PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
        h.token,
        [{ path: join(tmpCanonical, 'sub'), mode: 'rw' }],
      ),
    ).resolves.toBe('grant');
    expect(h.event.sender.send.mock.calls.length).toBe(sendCallsAfterFirst);
  });

  it('T9 重启后从持久化水合,同 scope 直接静默授予', async () => {
    // 模拟「上次会话」已持久化的 scope;本次为全新 registry(冷启动)。
    const loadPersistedScopes = vi.fn(async () => [
      { path: tmpCanonical, mode: 'rw' } as PathScope,
    ]);
    const h = await makeHarness({ loadPersistedScopes });

    await expect(
      h.ipc.invokeWithEvent(
        h.event,
        PLUGIN_FS_CHANNELS.REQUEST_SCOPE,
        h.token,
        [{ path: tmpCanonical, mode: 'rw' }],
      ),
    ).resolves.toBe('grant');

    expect(loadPersistedScopes).toHaveBeenCalledWith('plugin.fs');
    // 未弹窗
    expect(h.event.sender.send).not.toHaveBeenCalled();
    // 水合进了内存 registry
    expect(h.scopes._peek('plugin.fs')).toEqual([
      { path: tmpCanonical, mode: 'rw' },
    ]);
  });

  it('T10 未覆盖的新 scope 仍弹窗,授权后持久化合并全集', async () => {
    const persistScopes = vi.fn(async () => {});
    const loadPersistedScopes = vi.fn(async () => []);
    const h = await makeHarness({ loadPersistedScopes, persistScopes });

    await expect(grantViaPrompt(h, [{ path: tmpCanonical, mode: 'rw' }])).resolves.toBe(
      'grant',
    );

    // 弹过窗
    expect(h.event.sender.send).toHaveBeenCalled();
    // 持久化收到合并后的全集(canonical)
    expect(persistScopes).toHaveBeenCalledWith('plugin.fs', [
      { path: tmpCanonical, mode: 'rw' },
    ]);
  });

  it('T7 rejects atomic replace across different parents even when both are rw scoped', async () => {
    const siblingCanonical = await realpath(siblingRoot);
    harness.scopes.grant('plugin.fs', [
      { path: tmpCanonical, mode: 'rw' },
      { path: siblingCanonical, mode: 'rw' },
    ]);
    const staging = join(tmpRoot, 'file.tmp');
    const final = join(siblingRoot, 'file.txt');
    await writeFile(staging, 'next', 'utf-8');

    await expect(
      harness.ipc.invokeWithEvent(
        harness.event,
        PLUGIN_FS_CHANNELS.ATOMIC_REPLACE,
        harness.token,
        staging,
        final,
        { overwrite: true },
      ),
    ).rejects.toThrow(/share parent/);
  });
});
