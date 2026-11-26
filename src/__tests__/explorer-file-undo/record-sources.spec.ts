// BDD:入栈来源(README 规则 2)—— 批量漏斗回报复制成功项,外部拖入只在全是新文件时回报。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/notifications/notify', () => ({ notify: { error: vi.fn() } }));

import { dropForeignFilesInto, transferEntriesInto, type OverwriteChoice } from '../../panels/Explorer/batch-transfer';

const OK = { ok: true as const, data: undefined };

describe('transferEntriesInto · onCopied', () => {
  it('copy 每成功一项回报 (src, dest);失败项不回报', async () => {
    const onCopied = vi.fn();
    await transferEntriesInto('copy', ['/ws/a', '/ws/b'], '/ws/d', {
      fs: {
        move: vi.fn(async () => OK),
        copy: vi.fn(async (src: string) =>
          src === '/ws/b' ? { ok: false as const, code: 'FS_IO', message: 'x' } : OK,
        ),
      },
      makeUniqueDestPicker: async (dir) => (name) => `${dir}/${name}`,
      refreshDir: vi.fn(),
      onMoved: vi.fn(),
      onCopied,
      onItemFailed: vi.fn(),
      onException: vi.fn(),
    });
    expect(onCopied.mock.calls).toEqual([['/ws/a', '/ws/d/a']]);
  });
});

function itemsOf(names: string[]): DataTransferItemList {
  const arr = names.map((name) => ({
    kind: 'file',
    type: '',
    getAsFile: () => new File([new Uint8Array([1])], name),
    webkitGetAsEntry: () => ({ isDirectory: false, name }),
  }));
  return Object.assign(arr, { length: arr.length }) as unknown as DataTransferItemList;
}

function drop(existing: string[], names: string[], choice: OverwriteChoice) {
  const onCreated = vi.fn();
  const fs = {
    listDir: vi.fn(async () => ({
      ok: true as const,
      data: existing.map((name) => ({ path: `/ws/${name}`, name, isDirectory: false })),
    })),
    writeBinary: vi.fn(async () => OK),
  };
  return {
    onCreated,
    run: () => dropForeignFilesInto(itemsOf(names), '/ws', fs, vi.fn(), async () => choice, onCreated),
  };
}

describe('dropForeignFilesInto · onCreated', () => {
  it('无同名 → 回报写入的新文件(同名多次只一次)', async () => {
    const d = drop([], ['a.png', 'b.png', 'a.png'], 'cancel');
    await d.run();
    expect(d.onCreated).toHaveBeenCalledWith(['/ws/a.png', '/ws/b.png']);
  });

  it('选「跳过」→ 只回报写入的新文件', async () => {
    const d = drop(['a.png'], ['a.png', 'b.png'], 'skip');
    await d.run();
    expect(d.onCreated).toHaveBeenCalledWith(['/ws/b.png']);
  });

  it('选「替换」→ 不回报(被替换的原文件无法恢复,不可撤销)', async () => {
    const d = drop(['a.png'], ['a.png', 'b.png'], 'replace');
    await d.run();
    expect(d.onCreated).not.toHaveBeenCalled();
  });
});
