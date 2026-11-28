// 无标题文本文件(VSCode workbench.action.files.newUntitledFile,⌘N / Ctrl+N):不落盘的文本编辑器,标识 `untitled:Untitled-N`
//(见 electron/shared/untitled)。语言模式 = 纯文本(标识无扩展名);首次保存走另存为;自动保存跳过;不进会话快照 / 最近关闭
//(Continuo 不做热退出,关闭 / 关窗时有内容即按脏文件确认)。tab 名按界面语言(「Untitled-1」/「无标题-1」)。
// BDD: src/__tests__/editor-save-as/
import { revealInvisibleChars } from '@/lib/untrusted-text';
import { t } from '@/i18n';
import { basenameForChrome } from '@/lib/path-label';
import { createTab, groupTabsOf, useEditorStore, type EditorTab } from '@/stores/editor.store';
import { requestEditorFocus } from './editor-focus-registry';
import { editorGroupForOpen } from './editor-open-group';
import { untitledNumberOf, untitledPath } from '../../../electron/shared/untitled';

export { isUntitledPath } from '../../../electron/shared/untitled';

/** 下一个无标题编号:当前未被打开的无标题 tab 占用的最小正整数(VSCode 同:关掉 Untitled-1 后再新建仍是 1)。 */
export function nextUntitledNumber(tabs: readonly Pick<EditorTab, 'filePath'>[]): number {
  const used = new Set<number>();
  for (const tab of tabs) {
    const n = untitledNumberOf(tab.filePath);
    if (n !== null) used.add(n);
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/**
 * 新建无标题文本文件并激活(落在编辑器组 requestedGroupId,缺省触发窗口的编辑器组;常驻,不是预览)并聚焦它的编辑器(VSCode ⌘N 后可直接打字;
 * 从终端 / 资源管理器 / 命令面板 / 菜单触发同样 —— 聚焦在下一帧兑现,晚于命令面板关闭时的焦点还原)。返回新 tab id。
 */
export function newUntitledFile(requestedGroupId?: string): string {
  // 没指定组 → 在触发窗口打开(活动编辑器组在别的窗口、主窗没有编辑器组时在主窗新建一个;见 editor-open-group)
  const groupId = requestedGroupId ?? editorGroupForOpen();
  const store = useEditorStore.getState();
  const id = untitledPath(nextUntitledNumber(store.tabs));
  store.openTab(createTab(id, ''), groupId === undefined ? { preview: false } : { preview: false, groupId });
  // openTab 可能拒开(tab 数上限)→ 不聚焦
  const after = useEditorStore.getState();
  const gid = groupId ?? after.activeGroupId;
  if (groupTabsOf(after, gid).some((t) => t.id === id)) requestEditorFocus(id, gid);
  return id;
}

/** tab / 标题栏 / 确认框里显示的文件名:无标题 → 按界面语言的「Untitled-N」;其余同 basenameForChrome。 */
export function editorTabTitle(filePath: string): string {
  const n = untitledNumberOf(filePath);
  // 文件名里的双向控制 / 零宽字符可见化(tab、标题栏、状态栏、确认框与提示都经这里取名)
  return n === null ? revealInvisibleChars(basenameForChrome(filePath)) : t('editor.untitled_name', { n });
}

/** 首行推断名字的最大长度(VSCode UntitledTextEditorModel.FIRST_LINE_NAME_MAX_LENGTH)。 */
const FIRST_LINE_NAME_MAX = 40;
/** 文件名里不允许的字符(Windows 最严的集合 + 控制字符,各平台统一去掉,另存为后跨平台可用)。 */
const ILLEGAL_NAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
const isLegalNameChar = (ch: string): boolean => !ILLEGAL_NAME_CHARS.has(ch) && ch.charCodeAt(0) >= 0x20;

/**
 * 另存为对话框的建议文件名(VSCode:无标题文件从首行推断名字 + 语言的扩展名):首行去首尾空白、连续空白并成一个、去掉 U+202E,
 * 截到 40 个字符;不含任何文字 / 数字 → 用「Untitled-N」(VSCode 的资源名,不随语言)。没有扩展名 → 加 `.txt`(纯文本)。
 */
export function suggestedUntitledFileName(filePath: string, content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  let name = firstLine.replace(/\u202e/g, '').trim().replace(/\s+/g, ' ');
  name = Array.from(name).slice(0, FIRST_LINE_NAME_MAX).filter(isLegalNameChar).join('').trim();
  // 结尾的点 / 空格在 Windows 上会被吞掉
  name = name.replace(/[. ]+$/, '');
  if (!/[\p{L}\p{N}]/u.test(name)) name = `Untitled-${String(untitledNumberOf(filePath) ?? 1)}`;
  return /\.[\p{L}\p{N}]{1,10}$/u.test(name) ? name : `${name}.txt`;
}
