// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, waitFor } from '@testing-library/react';
import { PermissionEditorModal } from '../../plugins/permissions/PermissionEditorModal';
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

describe('PermissionEditorModal — 渲染条件', () => {
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

  it('open=false → Modal 不可见(visible 透传给 design Modal)', () => {
    render(
      <PermissionEditorModal
        open={false}
        pluginId="p1"
        declared={['fs']}
        store={makeStore()}
        onClose={vi.fn()}
      />,
    );
    // design Modal 在 visible=false 时不挂载
    expect(document.querySelector('.wm-modal-content')).toBeNull();
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
