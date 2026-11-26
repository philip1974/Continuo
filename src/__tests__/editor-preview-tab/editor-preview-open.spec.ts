// @vitest-environment jsdom
// BDD:预览编辑器的打开方式 —— openFileByPath 的 preview 选项、设置 workbench.editor.enablePreview、保留编辑器命令、
// 搜索结果 / ⌘P 的打开选项。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { groupPreviewTabIdOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';
import { openFileByPath, type EditorFileDeps } from '../../panels/Editor/editor-file-actions';
import {
  KEEP_EDITOR_COMMAND_ID,
  installEditorPreviewSettingSync,
  isEditorPreviewEnabled,
  keepActiveEditor,
} from '../../panels/Editor/editor-preview';
import { editorCommandSpecs } from '../../panels/Editor/editor-commands';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { EDITOR_ENABLE_PREVIEW } from '../../plugins/settings/core-setting-specs';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const DICTS: readonly Record<string, string>[] = [en, zh, ko];

const A = '/w/a.ts';
const B = '/w/b.md';
const C = '/w/c.png';

function deps(read?: (p: string) => Promise<{ ok: true; data: string }>): EditorFileDeps {
  return {
    fs: {
      readFile: vi.fn(read ?? (async (p: string) => ({ ok: true as const, data: `content of ${p}` }))),
      writeFile: vi.fn(async () => ({ ok: true as const, data: { mtimeMs: 1.5, size: 1, ino: 1 } })),
    },
  } as unknown as EditorFileDeps;
}

const st = () => useEditorStore.getState();
const ids = () => groupTabsOf(st(), 'editor').map((t) => t.id);
const preview = () => groupPreviewTabIdOf(st(), 'editor');
const setPreviewSetting = (on: boolean | undefined) =>
  useSettingsValuesStore.setState({ values: on === undefined ? {} : { [EDITOR_ENABLE_PREVIEW.id]: on } });

beforeEach(() => {
  setPreviewSetting(undefined);
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
    viewRefs: new Map(),
  });
});

describe('设置 workbench.editor.enablePreview', () => {
  it('默认开;编辑器设置页「标签页」组', () => {
    expect(isEditorPreviewEnabled()).toBe(true);
    expect(EDITOR_ENABLE_PREVIEW).toMatchObject({ id: 'workbench.editor.enablePreview', category: 'editor', default: true });
    for (const dict of DICTS) {
      for (const key of [EDITOR_ENABLE_PREVIEW.titleKey!, EDITOR_ENABLE_PREVIEW.descriptionKey!, EDITOR_ENABLE_PREVIEW.groupKey!]) {
        expect(dict[key]).toBeTruthy();
      }
    }
  });
});

describe('openFileByPath 的打开方式', () => {
  it('preview:true 连续打开 → 只有一个 tab,依次替换(代码 / Markdown / 图片都适用)', async () => {
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    await openFileByPath(B, d, { preview: true });
    expect(ids()).toEqual([B]);
    await openFileByPath(C, d, { preview: true });
    expect(ids()).toEqual([C]);
    expect(preview()).toBe(C);
  });

  it('preview:false 打开已是预览的文件 → 转常驻(资源管理器双击 / Enter、⌘P)', async () => {
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    await openFileByPath(A, d, { preview: false });
    expect(preview()).toBeUndefined();
    await openFileByPath(B, d, { preview: true });
    expect(ids()).toEqual([A, B]);
  });

  it('缺省(后退 / 前进、链接、插件等)→ 新开的常驻,已是预览的不变', async () => {
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    await openFileByPath(A, d);
    expect(preview()).toBe(A);
    await openFileByPath(B, d);
    expect(ids()).toEqual([A, B]);
  });

  it('双击:第一下(预览)读盘晚于第二下(常驻)完成 → 最终常驻且只有一个 tab', async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    const d = deps(async (p) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((r) => (releaseFirst = r));
      return { ok: true as const, data: `content of ${p}` };
    });
    const first = openFileByPath(A, d, { preview: true });
    const second = openFileByPath(A, d, { preview: false });
    await second;
    releaseFirst();
    await first;
    expect(ids()).toEqual([A]);
    expect(preview()).toBeUndefined();
  });

  it('双击:两下都在读盘,第一下先完成 → 它已被第二下超越而放弃,第二下完成后常驻且只有一个 tab', async () => {
    let releaseSecond!: () => void;
    let calls = 0;
    const d = deps(async (p) => {
      calls += 1;
      if (calls === 2) await new Promise<void>((r) => (releaseSecond = r));
      return { ok: true as const, data: `content of ${p}` };
    });
    const first = openFileByPath(A, d, { preview: true });
    const second = openFileByPath(A, d, { preview: false });
    await first;
    expect(ids()).toEqual([]);
    releaseSecond();
    await second;
    expect(ids()).toEqual([A]);
    expect(preview()).toBeUndefined();
  });

  it('双击:第一下读完已显示为预览 → 第二下把它转常驻', async () => {
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    expect(preview()).toBe(A);
    await openFileByPath(A, d, { preview: false });
    expect(ids()).toEqual([A]);
    expect(preview()).toBeUndefined();
  });

  it('连点两个文件:前一个(预览)读盘晚于后一个完成 → 放弃前一个,只剩后一个预览 tab(VSCode 同)', async () => {
    let releaseFirst!: () => void;
    const d = deps(async (p) => {
      if (p === A) await new Promise<void>((r) => (releaseFirst = r));
      return { ok: true as const, data: `content of ${p}` };
    });
    const first = openFileByPath(A, d, { preview: true });
    await openFileByPath(B, d, { preview: true });
    releaseFirst();
    expect(await first).toEqual({ ok: true, data: undefined });
    expect(ids()).toEqual([B]);
    expect(preview()).toBe(B);
    expect(st().activeTabId).toBe(B);
  });

  it('预览打开读盘期间用户切到别的 tab → 放弃这次预览打开', async () => {
    const d = deps();
    await openFileByPath(B, d, { preview: false });
    await openFileByPath(C, d, { preview: false });
    let release!: () => void;
    const slow = deps(async (p) => {
      await new Promise<void>((r) => (release = r));
      return { ok: true as const, data: `content of ${p}` };
    });
    const pending = openFileByPath(A, slow, { preview: true });
    st().switchTab(B);
    release();
    await pending;
    expect(ids()).toEqual([B, C]);
    expect(st().activeTabId).toBe(B);
  });

  it('常驻打开读盘晚于后一个打开完成 → 仍在后台以常驻加入(不放弃)', async () => {
    let releaseFirst!: () => void;
    const d = deps(async (p) => {
      if (p === A) await new Promise<void>((r) => (releaseFirst = r));
      return { ok: true as const, data: `content of ${p}` };
    });
    const first = openFileByPath(A, d, { preview: false });
    await openFileByPath(B, d, { preview: true });
    releaseFirst();
    await first;
    expect(ids()).toEqual([B, A]);
    expect(preview()).toBe(B);
    expect(st().activeTabId).toBe(B);
  });

  it('设置关闭 → preview:true 也按常驻打开(与此前一致)', async () => {
    setPreviewSetting(false);
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    await openFileByPath(B, d, { preview: true });
    expect(ids()).toEqual([A, B]);
    expect(preview()).toBeUndefined();
  });

  it('设置关闭时已有的预览 tab 立即全部转常驻', async () => {
    const off = installEditorPreviewSettingSync();
    try {
      await openFileByPath(A, deps(), { preview: true });
      expect(preview()).toBe(A);
      useSettingsValuesStore.getState().setValue(EDITOR_ENABLE_PREVIEW.id, false);
      expect(preview()).toBeUndefined();
    } finally {
      off();
    }
  });
});

describe('保留编辑器(workbench.action.keepEditor)', () => {
  it('活动的预览 tab 转常驻;命令无默认键,三语标题', async () => {
    await openFileByPath(A, deps(), { preview: true });
    keepActiveEditor();
    expect(preview()).toBeUndefined();
    const spec = editorCommandSpecs('mac').find((c) => c.id === KEEP_EDITOR_COMMAND_ID);
    expect(spec).toBeDefined();
    expect(spec!.hotkey).toBeUndefined();
    for (const dict of DICTS) expect(dict[spec!.titleKey!]).toBeTruthy();
  });
});

describe('保存即常驻', () => {
  it('⌘S 保存干净的预览 tab → 转常驻', async () => {
    const d = deps();
    await openFileByPath(A, d, { preview: true });
    const { saveFile } = await import('../../panels/Editor/editor-file-actions');
    const r = await saveFile(A, d, { force: true });
    expect(r.ok).toBe(true);
    expect(preview()).toBeUndefined();
  });
});
