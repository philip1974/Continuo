// M-Editor Step E3:Milkdown/Crepe 包装。
// 从 MindAutonAgent MilkdownEditor.tsx 移植,Crepe features 配置一致:
//   开:CodeMirror / ListItem / LinkTooltip / Cursor / BlockEdit / Toolbar / Placeholder / Table
//   关:ImageBlock / Latex(MVP 不做图片插入与数学公式)
// ```mermaid 代码块经 CodeMirror 特性的 renderPreview 渲染成图(见 mermaid-preview.ts)。
//
// 注意:Crepe 主题 CSS 自成体系,不与 Tailwind 冲突;直接 import frame-dark。

import { useCallback, useEffect, useRef } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
// 必须在 Crepe theme 之后,才能 override 它的 px 字号(详见文件注释)
import '@/styles/milkdown-font-override.css';
import { useSettingValue } from '@/plugins/settings/values-store';
import { t, useLocale } from '@/i18n';
import { useTheme } from '@/theme';
import {
  redrawMermaidPreviews,
  registerMermaidRoot,
  renderMermaidPreview,
} from './mermaid-preview';

interface MilkdownEditorProps {
  defaultValue: string;
  readonly?: boolean;
  onChange?: (markdown: string) => void;
  /**
   * Cmd/Ctrl+click on `<a>` 时触发,把 anchor 的 href 上抛给上层路由。
   * 上层(EditorPanel)用 resolveLink 决定打开内部文件还是外链。见 issue #25。
   */
  onLinkClick?: (href: string) => void;
}

function CrepeEditor({ defaultValue, readonly = false, onChange }: MilkdownEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 注:useEditor 的 callback 在 mount 时执行,defaultValue 只在挂载时生效。
  // 切 tab 时通过 EditorPanel 上的 key={activeTabId} 强制 remount,
  // 让 Crepe 拿到新 tab 的初始 markdown(Mind 同模式)。
  const editorCallback = useCallback((root: HTMLElement) => {
    const crepe = new Crepe({
      root,
      defaultValue,
      features: {
        [CrepeFeature.CodeMirror]: true,
        [CrepeFeature.ListItem]: true,
        [CrepeFeature.LinkTooltip]: true,
        [CrepeFeature.Cursor]: true,
        [CrepeFeature.ImageBlock]: false, // MVP 不接图片
        [CrepeFeature.BlockEdit]: true,
        [CrepeFeature.Toolbar]: true,
        [CrepeFeature.Placeholder]: true,
        [CrepeFeature.Table]: true,
        [CrepeFeature.Latex]: false, // MVP 不接 KaTeX
      },
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: t('panels.editor.placeholder.start_writing'),
        },
        [CrepeFeature.CodeMirror]: {
          renderPreview: renderMermaidPreview,
          copyText: t('panels.editor.codeBlock.copy'),
          searchPlaceholder: t('panels.editor.codeBlock.searchLanguage'),
          noResultText: t('panels.editor.codeBlock.noResult'),
          previewLabel: t('panels.editor.codeBlock.previewLabel'),
          previewLoading: t('panels.editor.codeBlock.previewLoading'),
          previewToggleText: (previewOnlyMode) =>
            previewOnlyMode
              ? t('panels.editor.codeBlock.previewEdit')
              : t('panels.editor.codeBlock.previewHide'),
        },
      },
    });

    if (readonly) crepe.setReadonly(true);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
        if (readonly) return;
        // 挂载期 Milkdown 会给以代码块 / 表格结尾的文档补一个尾随空段落,序列化结果只多出
        // 尾部空白 —— 不是用户编辑,不上抛(否则打开即变脏、自动保存改写文件,issue #44)。
        // 不能用「吞掉第一次 emit」判断:以段落结尾的文档挂载期没有这次 emit,会吞掉用户的
        // 第一次真实编辑。
        if (markdown.trimEnd() === prevMarkdown.trimEnd()) return;
        onChangeRef.current?.(markdown);
      });
    });

    return crepe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEditor(editorCallback);

  return <Milkdown />;
}

export function MilkdownEditor(props: MilkdownEditorProps) {
  // Crepe theme 内部很多元素是相对单位(em/rem),容器 font-size 变,
  // ProseMirror 文本会跟着变。如果某些元素用 px 绝对值,可在
  // src/styles/milkdown-font-override.css(本文件顶部已导入)里 override
  const fontSize = useSettingValue<number>('editor.fontSize', 13);
  // 主题变化(含跟随系统的自动切换,可能发生在输入途中):mermaid 图的配色在渲染时定死,
  // 就地重画即可,不重挂载编辑器(会丢光标 / 滚动 / 尚未落 store 的输入)。
  const { resolved: theme } = useTheme();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const drawnThemeRef = useRef(theme);
  useEffect(() => {
    if (drawnThemeRef.current === theme) return;
    drawnThemeRef.current = theme;
    if (wrapperRef.current) redrawMermaidPreviews(wrapperRef.current);
  }, [theme]);
  // 语言变化:代码块工具条 / placeholder 文案在 Crepe 创建时定死 → 用当前内容重挂载。语言只能在
  // 设置面板里切,不会与输入同时发生。key 必须放在 MilkdownProvider 上:只 key 内层的话 Provider
  // 里还留着旧 editorFactory,会先用旧挂载时的内容建一个临时编辑器(listener 仍连着 store)再建新的。
  const locale = useLocale();
  // 让 mermaid 预览能按内容反查到本编辑器里的代码块(连续输入时只渲染最后一版)。
  // 容器随 Provider 的 key 重建,故依赖 locale。
  useEffect(
    () => (wrapperRef.current ? registerMermaidRoot(wrapperRef.current) : undefined),
    [locale],
  );

  // ref 跟踪最新 onLinkClick:外层 click handler 不重建,内部读最新值。
  const onLinkClickRef = useRef(props.onLinkClick);
  onLinkClickRef.current = props.onLinkClick;

  // 点击 <a>(Crepe 渲染的 markdown link、mermaid 图 `click` 产出的 SVG 链接):
  //   - 永远吞掉默认行为 —— 只读视图 / 预览面板里的 <a> 默认会把整个应用窗口导航到 href;
  //   - Edit:仅修饰键 click 跳转,普通 click 留给 ProseMirror 定位光标(IDE 通用约定,issue #25);
  //   - Preview(只读)与链接气泡里的地址:普通 click 即跳转。
  // 鼠标与键盘(Cmd/Ctrl+Enter)两条路径定位到 <a> 后的共同收尾:取 href、吞掉默认行为、
  // 交给 onLinkClick。
  const activateLink = useCallback(
    (a: Element | null, e: React.SyntheticEvent): void => {
      // SVG <a> 的地址在 xlink:href 上
      const href = a?.getAttribute('href') ?? a?.getAttribute('xlink:href');
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      onLinkClickRef.current?.(href);
    },
    [],
  );

  const readonly = props.readonly ?? false;
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element | null)?.closest('a') ?? null;
    if (!a) return;
    e.preventDefault();
    if (readonly || e.metaKey || e.ctrlKey || a.classList.contains('link-display')) {
      activateLink(a, e);
    }
  }, [activateLink, readonly]);

  // a11y(A152):Cmd/Ctrl+click 跳转的键盘等价 —— Cmd/Ctrl+Enter。键盘用户无法用鼠标修饰键
  // 点击链接;用修饰键(非裸 Enter)避免与可编辑 ProseMirror 的换行冲突。链接定位优先 event
  // target(链接获焦时),退回当前选区 anchorNode 所在的 <a>(caret 落在链接文本里时)。
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    const fromTarget = (e.target as HTMLElement | null)?.closest?.('a') ?? null;
    let a: HTMLAnchorElement | null = fromTarget as HTMLAnchorElement | null;
    if (!a) {
      const sel = (e.currentTarget.ownerDocument ?? document).getSelection();
      const node = sel?.anchorNode ?? null;
      const el =
        node instanceof HTMLElement ? node : (node?.parentElement ?? null);
      a = el?.closest('a') ?? null;
    }
    activateLink(a, e);
  }, [activateLink]);

  return (
    <MilkdownProvider key={locale}>
      <div
        ref={wrapperRef}
        className="h-full w-full overflow-auto"
        style={{ fontSize: `${fontSize}px` }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <CrepeEditor {...props} />
      </div>
    </MilkdownProvider>
  );
}
