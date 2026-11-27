// BDD: command-discoverability —— 菜单 / 右键 / 标题栏里的常用动作注册为命令(三语标题 + 分类,无默认键);
// 英文命令标题统一 Title Case。见同目录 README 第 2、3 条。
import { describe, expect, it } from 'vitest';
import { bootCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

type Key = keyof typeof en;

// 命令 id → 英文标题 / 分类(无分类 = null)
const NEW_COMMANDS: Record<string, readonly [string, string | null]> = {
  'workbench.action.quickOpen': ['Go to File…', null],
  'workbench.action.showCommands': ['Show All Commands', null],
  'workbench.action.closeWindow': ['Close Window', 'Window'],
  'workbench.action.reloadWindow': ['Reload Window', 'Window'],
  'workbench.action.zoomIn': ['Zoom In', 'View'],
  'workbench.action.zoomOut': ['Zoom Out', 'View'],
  'workbench.action.zoomReset': ['Reset Zoom', 'View'],
  'workbench.action.toggleFullScreen': ['Toggle Full Screen', 'View'],
  'workbench.action.closeOtherEditors': ['Close Other Editors in Group', 'View'],
  'workbench.action.closeEditorsToTheRight': ['Close Editors to the Right in Group', 'View'],
  'workbench.action.closeUnmodifiedEditors': ['Close Saved Editors in Group', 'View'],
  'workbench.action.closeEditorsInGroup': ['Close All Editors in Group', 'View'],
  copyFilePath: ['Copy Path of Active File', 'File'],
  copyRelativeFilePath: ['Copy Relative Path of Active File', 'File'],
  revealFileInOS: ['Reveal Active File in Finder', 'File'],
  'markdown.switchToEditMode': ['Switch to Edit Mode', 'Markdown'],
  'markdown.switchToSourceMode': ['Switch to Source Mode', 'Markdown'],
  'markdown.switchToPreviewMode': ['Switch to Preview Mode', 'Markdown'],
  'workbench.files.action.collapseExplorerFolders': ['Collapse Folders in Explorer', 'Explorer'],
  'workbench.files.action.refreshFilesExplorer': ['Refresh Explorer', 'Explorer'],
  'workbench.action.closeFolder': ['Close Folder', 'File'],
  'workbench.view.output': ['Show Output', 'View'],
  'workbench.view.debug': ['Show Debug', 'View'],
  'workbench.action.moveEditorGroupToNewWindow': ['Move Group into New Window', 'View'],
};

const ZOOM_COMMANDS = new Set(['workbench.action.zoomIn', 'workbench.action.zoomOut', 'workbench.action.zoomReset']);
// 显示输出 / 显示调试后来补上 VSCode 默认键 ⇧⌘U / ⇧⌘D(见 src/__tests__/workbench-vscode-default-keys/)
const KEYED_COMMANDS = new Set([...ZOOM_COMMANDS, 'workbench.view.output', 'workbench.view.debug']);

describe('常用动作注册为命令', () => {
  it('核心插件注册全部新命令:三语标题 + 分类,无默认键', () => {
    bootCorePlugins();
    for (const [id, [title, category]] of Object.entries(NEW_COMMANDS)) {
      const spec = coApp.commands.get(id);
      expect(spec, id).toBeDefined();
      // 缩放命令带 VSCode 默认键(见 src/__tests__/window-zoom/);显示输出 / 调试同(见 workbench-vscode-default-keys)
      if (!KEYED_COMMANDS.has(id)) expect(spec!.hotkey, id).toBeUndefined();
      const titleKey = spec!.titleKey as Key;
      expect(en[titleKey], id).toBe(title);
      expect(zh[titleKey], id).toBeTruthy();
      expect(ko[titleKey], id).toBeTruthy();
      expect(zh[titleKey], id).not.toBe(title);
      expect(ko[titleKey], id).not.toBe(title);
      if (category === null) {
        expect(spec!.category, id).toBeUndefined();
      } else {
        expect(en[spec!.categoryKey as Key], id).toBe(category);
        expect(zh[spec!.categoryKey as Key], id).toBeTruthy();
        expect(ko[spec!.categoryKey as Key], id).toBeTruthy();
      }
    }
  });
});

// VSCode 命令标题风格:Title Case,只有虚词小写(between:VSCode「Toggle between Light/Dark Themes」)。
// 'from':VSCode「Detect Indentation from Content」(editor.action.detectIndentation)照抄
const LOWERCASE_WORDS = new Set(['in', 'to', 'the', 'of', 'and', 'a', 'an', 'for', 'on', 'into', 'between', 'from']);

describe('英文命令标题大小写统一', () => {
  it('核心命令英文标题每个实词首字母大写(「Toggle Explorer Sidebar」)', () => {
    bootCorePlugins();
    const bad: string[] = [];
    for (const spec of coApp.commands.getAll()) {
      const title = spec.titleKey ? (en[spec.titleKey as Key] ?? spec.title) : spec.title;
      const words = title.replace(/…$/, '').split(' ');
      words.forEach((word, i) => {
        const first = word.charAt(0);
        if (first !== first.toLowerCase() || first === first.toUpperCase()) return;
        if (i > 0 && LOWERCASE_WORDS.has(word)) return;
        bad.push(`${spec.id}: ${title}`);
      });
    }
    expect(bad).toEqual([]);
    expect(en['settings.explorer.toggle_sidebar']).toBe('Toggle Explorer Sidebar');
  });
});
