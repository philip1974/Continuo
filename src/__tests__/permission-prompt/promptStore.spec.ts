import { describe, it, expect, beforeEach } from 'vitest';
import { usePermissionPromptStore } from '../../plugins/permissions/promptStore';

beforeEach(() => {
  usePermissionPromptStore.setState({
    pending: null,
    resolve: null,
  });
});

describe('usePermissionPromptStore', () => {
  it('request 设 pending,grant 后 Promise resolve 收授权列表', async () => {
    const promise = usePermissionPromptStore
      .getState()
      .request('p', ['fs', 'network']);
    expect(usePermissionPromptStore.getState().pending).toEqual({
      pluginId: 'p',
      perms: ['fs', 'network'],
    });
    usePermissionPromptStore.getState().grant(['fs']);
    expect(await promise).toEqual(['fs']);
    expect(usePermissionPromptStore.getState().pending).toBeNull();
  });

  it('denyAll → Promise resolve []', async () => {
    const promise = usePermissionPromptStore
      .getState()
      .request('p', ['fs']);
    usePermissionPromptStore.getState().denyAll();
    expect(await promise).toEqual([]);
  });

  it('同时只能一个 pending,二次 request → 立即 resolve([])', async () => {
    const first = usePermissionPromptStore
      .getState()
      .request('p1', ['fs']);
    const second = usePermissionPromptStore
      .getState()
      .request('p2', ['shell']);
    expect(await second).toEqual([]); // 立刻拒
    // 第一个还在 pending(不被覆盖)
    expect(usePermissionPromptStore.getState().pending?.pluginId).toBe('p1');
    usePermissionPromptStore.getState().grant(['fs']);
    expect(await first).toEqual(['fs']);
  });
});
