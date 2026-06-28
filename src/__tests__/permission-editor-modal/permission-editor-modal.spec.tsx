// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, waitFor } from '@testing-library/react';
import {
  PermissionEditorModal,
  splitPermissionDecisionsForSave,
} from '../../plugins/permissions/PermissionEditorModal';
import type {
  PermissionDecision,
  PermissionKey,
  PermissionStore,
} from '../../plugins/permissions';

function makeStore(prior: PermissionDecision[] = []): PermissionStore & {
  grant: ReturnType<typeof vi.fn>;
  deny: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(async () => prior),
    grant: vi.fn(async () => {}),
    deny: vi.fn(async () => {}),
    clearDenied: vi.fn(async () => {}),
  } as never;
}

afterEach(() => cleanup());

describe('PermissionEditorModal — save helpers', () => {
  it('splitPermissionDecisionsForSave 预分配 grant/deny 数组,不通过 push 扩容', () => {
    const decisions = new Map<PermissionKey, boolean | null>([
      ['fs', true],
      ['network', false],
      ['shell', null],
      ['clipboard', true],
    ]);

    const result = splitPermissionDecisionsForSave(decisions);

    expect(result.toGrant).toEqual(['fs', 'clipboard']);
    expect(result.toDeny).toEqual(['network']);
    expect(splitPermissionDecisionsForSave.toString()).not.toContain('toGrant.push(');
    expect(splitPermissionDecisionsForSave.toString()).not.toContain('toDeny.push(');
  });

  it('splitPermissionDecisionsForSave 空 decisions 复用稳定空 grant/deny', () => {
    const a = splitPermissionDecisionsForSave(new Map());
    const b = splitPermissionDecisionsForSave(new Map());

    expect(a.toGrant).toEqual([]);
    expect(a.toDeny).toEqual([]);
    expect(a).toBe(b);
    expect(a.toGrant).toBe(b.toGrant);
    expect(a.toDeny).toBe(b.toDeny);
  });
});

describe('PermissionEditorModal — 渲染条件', () => {
  it('open=false / pluginId=null shell 直接返回,不初始化 body 状态或 i18n', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/permissions/PermissionEditorModal.tsx'),
      'utf8',
    );
    const shellStart = src.indexOf('export function PermissionEditorModal(');
    const bodyStart = src.indexOf('function PermissionEditorModalBody');
    const shellSrc = src.slice(shellStart, bodyStart);

    expect(shellStart).toBeGreaterThanOrEqual(0);
    expect(bodyStart).toBeGreaterThan(shellStart);
    expect(shellSrc).toContain('if (!open || !pluginId) return null;');
    expect(shellSrc).not.toContain('useT(');
    expect(shellSrc).not.toContain('useState(');
    expect(src.indexOf('const t = useT();')).toBeGreaterThan(bodyStart);
  });

  it('decisions state 使用 lazy initializer,避免每次 render eager new Map', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/permissions/PermissionEditorModal.tsx'),
      'utf8',
    );

    expect(src).toContain('useState<Map<PermissionKey, boolean | null>>(');
    expect(src).toContain('() => new Map()');
    expect(src).not.toContain(
      'useState<Map<PermissionKey, boolean | null>>(\n    new Map(),',
    );
  });

  it('pluginId=null → 不渲染', () => {
    const { container } = render(
      <PermissionEditorModal
        open={true}
        pluginId={null}
        declared={['fs']}
        store={makeStore()}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('open=false → 不挂载 body,不触发权限加载', () => {
    const store = makeStore();
    render(
      <PermissionEditorModal
        open={false}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={vi.fn()}
      />,
    );
    expect(document.querySelector('.wm-modal-content')).toBeNull();
    expect(store.get).not.toHaveBeenCalled();
  });
});

describe('PermissionEditorModal — 初始勾选', () => {
  it('prior granted=true → checked,prior granted=false → 不勾,无 prior → 不勾', async () => {
    const store = makeStore([
      { permission: 'fs', granted: true, decidedAt: 1 },
      { permission: 'network', granted: false, decidedAt: 2 },
    ]);
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs', 'network', 'shell']}
        store={store}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      const cbs =
        document.querySelectorAll<HTMLInputElement>(
          '.wm-modal-content input[type=checkbox]',
        );
      expect(cbs.length).toBe(3);
      expect(cbs[0]!.checked).toBe(true); // fs
      expect(cbs[1]!.checked).toBe(false); // network denied
      expect(cbs[2]!.checked).toBe(false); // shell 无 prior
    });
  });
});

describe('PermissionEditorModal — toggle / save', () => {
  it('toggle 切换 + save 调 grant / deny / onClose', async () => {
    const store = makeStore([
      { permission: 'fs', granted: false, decidedAt: 1 },
    ]);
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs', 'network']}
        store={store}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      const cbs = document.querySelectorAll<HTMLInputElement>(
        '.wm-modal-content input[type=checkbox]',
      );
      expect(cbs.length).toBe(2);
    });
    const checkboxes = document.querySelectorAll<HTMLInputElement>(
      '.wm-modal-content input[type=checkbox]',
    );
    // 初始: fs=false (denied), network=null (not checked)
    expect(checkboxes[0]!.checked).toBe(false);
    expect(checkboxes[1]!.checked).toBe(false);

    // 把 fs 勾上 (false → true)
    fireEvent.click(checkboxes[0]!);
    // 把 network 勾上 (null → true)
    fireEvent.click(checkboxes[1]!);
    // 再点 network 一次 (true → false)
    fireEvent.click(checkboxes[1]!);

    // 点保存
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存');
    expect(saveBtn).toBeDefined();
    fireEvent.click(saveBtn!);

    await waitFor(() => {
      expect(store.grant).toHaveBeenCalledWith(
        'p1',
        expect.arrayContaining<PermissionKey>(['fs']),
      );
      expect(store.deny).toHaveBeenCalledWith(
        'p1',
        expect.arrayContaining<PermissionKey>(['network']),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    // 同时 fs 进 grant 仅一项,network 进 deny 仅一项
    expect((store.grant.mock.calls[0]![1] as PermissionKey[]).sort()).toEqual([
      'fs',
    ]);
    expect((store.deny.mock.calls[0]![1] as PermissionKey[]).sort()).toEqual([
      'network',
    ]);
  });

  it('declared 全部维持 null(没改) + save → 不调 grant/deny,但仍 onClose', async () => {
    const store = makeStore([]);
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content input[type=checkbox]'),
      ).toBeTruthy();
    });
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(store.grant).not.toHaveBeenCalled();
    expect(store.deny).not.toHaveBeenCalled();
  });

  // race(R102):保存瞬间 pluginStillExists()=false(弹窗打开期间插件被卸载)→ 中止写入 + onClose,
  // 防把已卸载插件的 ghost 权限写回 _permissions.json。
  it('pluginStillExists()=false → save 中止写盘,仅 onClose', async () => {
    const store = makeStore([]);
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
        pluginStillExists={() => false}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content input[type=checkbox]'),
      ).toBeTruthy();
    });
    // 勾上 fs(本应写 grant)
    fireEvent.click(
      document.querySelector<HTMLInputElement>(
        '.wm-modal-content input[type=checkbox]',
      )!,
    );
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    fireEvent.click(saveBtn);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(store.grant).not.toHaveBeenCalled(); // ghost 写入被中止
    expect(store.deny).not.toHaveBeenCalled();
  });

  it('pluginStillExists()=true → save 正常写盘(不影响在册插件)', async () => {
    const store = makeStore([]);
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
        pluginStillExists={() => true}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content input[type=checkbox]'),
      ).toBeTruthy();
    });
    fireEvent.click(
      document.querySelector<HTMLInputElement>(
        '.wm-modal-content input[type=checkbox]',
      )!,
    );
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    fireEvent.click(saveBtn);
    await waitFor(() =>
      expect(store.grant).toHaveBeenCalledWith('p1', ['fs']),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('取消 → onClose,不写盘', async () => {
    const store = makeStore([]);
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content input[type=checkbox]'),
      ).toBeTruthy();
    });

    const cancelBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '取消')!;
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.grant).not.toHaveBeenCalled();
    expect(store.deny).not.toHaveBeenCalled();
  });
});

describe('PermissionEditorModal — a11y(A46) 保存失败反馈', () => {
  it('store.grant reject → role=alert 失败提示 + 不 onClose(Modal 保持打开)', async () => {
    const store = {
      get: vi.fn(async () => []),
      grant: vi.fn(async () => {
        throw new Error('disk full');
      }),
      deny: vi.fn(async () => {}),
      clearDenied: vi.fn(async () => {}),
    } as never as PermissionStore & { grant: ReturnType<typeof vi.fn> };
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
      />,
    );
    await waitFor(() => {
      expect(
        document.querySelector('.wm-modal-content input[type=checkbox]'),
      ).toBeTruthy();
    });
    // 勾上 fs(null → true)→ save 走 grant → reject
    fireEvent.click(
      document.querySelector(
        '.wm-modal-content input[type=checkbox]',
      ) as HTMLInputElement,
    );
    fireEvent.click(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
      ).find((b) => b.textContent === '保存')!,
    );
    // 失败 → role=alert 出现,Modal 不关闭(onClose 未调)
    await waitFor(() => {
      expect(document.querySelector('[role=alert]')).not.toBeNull();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.wm-modal-content')).not.toBeNull();
  });
});

describe('PermissionEditorModal — a11y(A59) 加载失败反馈', () => {
  it('store.get reject → role=alert 加载失败提示 + 保存按钮 disabled', async () => {
    const store = {
      get: vi.fn(async () => {
        throw new Error('EACCES');
      }),
      grant: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
      clearDenied: vi.fn(async () => {}),
    } as never as PermissionStore;
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={vi.fn()}
      />,
    );
    // 加载失败 → role=alert 出现
    await waitFor(() => {
      expect(document.querySelector('[role=alert]')).not.toBeNull();
    });
    // 保存按钮 disabled(避免用空/默认态覆盖已存权限)
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    expect(saveBtn.disabled).toBe(true);
  });
});

// race(R23):初始 decisions 加载完成前禁用 checkbox/保存,防异步 load 结果覆盖用户提前的勾选。
describe('PermissionEditorModal — R23 加载期门控防覆盖', () => {
  it('load 在途 → checkbox/保存 disabled;加载完成后启用并反映已存决策', async () => {
    let resolveGet!: (v: PermissionDecision[]) => void;
    const store = {
      get: vi.fn(
        () =>
          new Promise<PermissionDecision[]>((res) => {
            resolveGet = res;
          }),
      ),
      grant: vi.fn(async () => {}),
      deny: vi.fn(async () => {}),
      clearDenied: vi.fn(async () => {}),
    } as never as PermissionStore;

    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs'] as PermissionKey[]}
        store={store}
        onClose={vi.fn()}
      />,
    );

    // load 未 resolve → checkbox 与保存均 disabled(用户无法提前勾选被覆盖)
    const box = document.querySelector<HTMLInputElement>(
      '.wm-modal-content input[type=checkbox]',
    )!;
    expect(box.disabled).toBe(true);
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    expect(saveBtn.disabled).toBe(true);

    // 加载完成(fs 已 granted)→ 启用 + 勾选反映已存
    resolveGet([{ permission: 'fs', granted: true, decidedAt: 1 }]);
    await waitFor(() => {
      const b = document.querySelector<HTMLInputElement>(
        '.wm-modal-content input[type=checkbox]',
      )!;
      expect(b.disabled).toBe(false);
      expect(b.checked).toBe(true);
    });
  });
});

describe('race(R35) — 保存写盘期间门控', () => {
  function checkboxes() {
    return Array.from(
      document.querySelectorAll<HTMLInputElement>(
        '.wm-modal-content input[type=checkbox]',
      ),
    );
  }
  function saveButton() {
    return Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
  }

  it('保存进行中 → checkbox + Save 禁用;完成后 onClose(防迟到 onClose 丢弃保存后改动)', async () => {
    let resolveGrant: () => void = () => {};
    const store = {
      get: vi.fn(async () => [{ permission: 'fs', granted: false, decidedAt: 1 }]),
      grant: vi.fn(() => new Promise<void>((res) => { resolveGrant = res; })),
      deny: vi.fn(async () => {}),
      clearDenied: vi.fn(async () => {}),
    } as never as PermissionStore & { grant: ReturnType<typeof vi.fn> };
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(checkboxes().length).toBe(1));

    // 勾上 fs(false→true)→ 点保存(grant 阻塞)
    fireEvent.click(checkboxes()[0]!);
    fireEvent.click(saveButton());

    // 写盘进行中:checkbox + Save 禁用,不允许继续编辑同一份 decisions。
    await waitFor(() => {
      expect(checkboxes()[0]!.disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
    });
    expect(onClose).not.toHaveBeenCalled();

    // 写盘完成 → onClose
    resolveGrant();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('双击 Save → grant 仅排队一次(重入守卫)', async () => {
    let resolveGrant: () => void = () => {};
    const grant = vi.fn(() => new Promise<void>((res) => { resolveGrant = res; }));
    const store = {
      get: vi.fn(async () => [{ permission: 'fs', granted: false, decidedAt: 1 }]),
      grant,
      deny: vi.fn(async () => {}),
      clearDenied: vi.fn(async () => {}),
    } as never as PermissionStore;
    const onClose = vi.fn();
    render(
      <PermissionEditorModal
        open={true}
        pluginId="p1"
        declared={['fs']}
        store={store}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(checkboxes().length).toBe(1));
    fireEvent.click(checkboxes()[0]!); // false→true

    const btn = saveButton();
    fireEvent.click(btn); // 首次保存(grant 阻塞 + 按钮随即禁用)
    fireEvent.click(btn); // 双击:disabled + saving 守卫双重拦截
    await Promise.resolve();

    expect(grant).toHaveBeenCalledTimes(1);
    resolveGrant();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
