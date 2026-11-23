// MCP create_session 的 PTY 创建入口(makeAgentCreateSession):窗口查找、把会话归属到调用方、autorun 延时键入。
// 此前这段逻辑内联在 main/index.ts(createSessionForAgent),没有任何规范直接覆盖,只有别的规范手写「复刻」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { AUTORUN_DELAY_MS, makeAgentCreateSession } from '../../../electron/main/ipc/terminal.ipc';
import { ERROR_CODES } from '../../../electron/shared/error-codes';

const win = { id: 3, isDestroyed: () => false } as unknown as BrowserWindow;
const input = { originHint: 'agent' as const, agentLabel: 'codex' };

function setup(opts?: { window?: BrowserWindow | null }) {
  const createHandler = vi.fn(async () => ({ id: 'term-1' }));
  const service = { has: vi.fn(() => true), write: vi.fn(async () => true) };
  const create = makeAgentCreateSession({
    createHandler: createHandler as never,
    service,
    getWindow: () => (opts && 'window' in opts ? opts.window! : win),
  });
  return { create, createHandler, service };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('makeAgentCreateSession', () => {
  it('调用方窗口不存在 / 已销毁 → TERMINAL_NO_WINDOW,不创建', async () => {
    for (const window of [null, { id: 3, isDestroyed: () => true } as unknown as BrowserWindow]) {
      const { create, createHandler } = setup({ window });
      await expect(create(input, { ownerWindowId: 3 })).rejects.toMatchObject({
        code: ERROR_CODES.TERMINAL_NO_WINDOW,
      });
      expect(createHandler).not.toHaveBeenCalled();
    }
  });

  it('安全 S3:会话归属到发起创建的调用方(callerSubject → controllerToken);无 subject 不盖归属', async () => {
    const a = setup();
    await a.create(input, { ownerWindowId: 3, callerSubject: 'tok-a' });
    expect(a.createHandler).toHaveBeenCalledWith(input, win, { controllerToken: 'tok-a' });

    const b = setup();
    await b.create(input, { ownerWindowId: 3 });
    expect(b.createHandler).toHaveBeenCalledWith(input, win, undefined);
  });

  it('autorun:创建完成后延时键入「命令 + 换行」;无 autorun 不键入', async () => {
    const { create, service } = setup();
    await expect(create({ ...input, autorun: 'codex' }, { ownerWindowId: 3 })).resolves.toEqual({ id: 'term-1' });
    expect(service.write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTORUN_DELAY_MS);
    expect(service.write).toHaveBeenCalledWith('term-1', 'codex\n');

    const plain = setup();
    await plain.create(input, { ownerWindowId: 3 });
    vi.advanceTimersByTime(AUTORUN_DELAY_MS);
    expect(plain.service.write).not.toHaveBeenCalled();
  });

  it('创建期间调用方已断开 / 被撤销(signal aborted)→ 不排 autorun', async () => {
    const { create, service } = setup();
    const ac = new AbortController();
    ac.abort();
    await create({ ...input, autorun: 'codex' }, { ownerWindowId: 3, signal: ac.signal });
    vi.advanceTimersByTime(AUTORUN_DELAY_MS);
    expect(service.write).not.toHaveBeenCalled();
  });

  it('延时期间被撤销,或 PTY 已不在 → 不键入', async () => {
    const aborted = setup();
    const ac = new AbortController();
    await aborted.create({ ...input, autorun: 'codex' }, { ownerWindowId: 3, signal: ac.signal });
    ac.abort();
    vi.advanceTimersByTime(AUTORUN_DELAY_MS);
    expect(aborted.service.write).not.toHaveBeenCalled();

    const gone = setup();
    gone.service.has.mockReturnValue(false);
    await gone.create({ ...input, autorun: 'codex' }, { ownerWindowId: 3 });
    vi.advanceTimersByTime(AUTORUN_DELAY_MS);
    expect(gone.service.write).not.toHaveBeenCalled();
  });
});
