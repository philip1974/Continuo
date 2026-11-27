// @vitest-environment jsdom
// BDD: 自动保存因「已删除」停止时有可见提示(不刷屏)。文件被删 / 所在卷卸载后 tab 标「(已删除)」,自动保存不写回;
// 此前继续输入磁盘不更新且无任何提示。现在:自动保存开启的 tab 处于「已删除 + 有未保存修改」→ 提示一次(带文件名与保存键);
// 继续输入不再提示;标记清除(文件回来 / 手动保存)后复位,再次被删才再提示。自动保存未开启(非 Markdown)→ 不提示。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useAutoSave } from '@/panels/Editor/useAutoSave';
import { resetOrphanedAutoSaveNotices } from '@/panels/Editor/autosave-orphan-notice';
import { useEditorStore } from '@/stores/editor.store';
import { notify } from '@/notifications/notify';

function Probe({ enabled = true }: { enabled?: boolean }) {
  useAutoSave(() => Promise.resolve({ ok: true }), { enabled, delayMs: 50 });
  return null;
}

const tab = (patch: Record<string, unknown> = {}) => ({
  id: '/v/README.md',
  filePath: '/v/README.md',
  content: 'disk',
  originalContent: 'disk',
  dirty: false,
  ...patch,
});
const setTab = (patch: Record<string, unknown>) =>
  act(() => {
    useEditorStore.setState({ tabs: [tab(patch)], activeTabId: '/v/README.md' });
  });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetOrphanedAutoSaveNotices();
  warn = vi.spyOn(notify, 'warn').mockImplementation(() => '');
  useEditorStore.setState({ tabs: [tab()], activeTabId: '/v/README.md' });
});
afterEach(() => {
  cleanup();
  warn.mockRestore();
});

const pausedNotices = () => warn.mock.calls.filter((c) => String(c[0]).includes('README.md'));

describe('自动保存因已删除暂停的提示', () => {
  it('已删除 + 有未保存修改 → 提示一次(含文件名);继续输入不再提示', () => {
    render(<Probe />);
    setTab({ orphaned: true });
    expect(pausedNotices()).toHaveLength(0); // 没有未保存修改:自动保存本来就无事可做
    setTab({ orphaned: true, dirty: true, content: 'a' });
    expect(pausedNotices()).toHaveLength(1);
    setTab({ orphaned: true, dirty: true, content: 'ab' });
    setTab({ orphaned: true, dirty: true, content: 'abc' });
    expect(pausedNotices()).toHaveLength(1);
  });

  it('标记清除后复位:再次被删且有修改 → 再提示一次', () => {
    render(<Probe />);
    setTab({ orphaned: true, dirty: true, content: 'a' });
    setTab({ orphaned: false, dirty: true, content: 'a' });
    setTab({ orphaned: true, dirty: true, content: 'a' });
    expect(pausedNotices()).toHaveLength(2);
  });

  it('自动保存未开启 → 不提示', () => {
    render(<Probe enabled={false} />);
    setTab({ orphaned: true, dirty: true, content: 'a' });
    expect(pausedNotices()).toHaveLength(0);
  });
});
