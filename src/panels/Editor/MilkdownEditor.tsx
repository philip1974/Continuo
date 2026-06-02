// M-Editor Step E3:Milkdown/Crepe 包装。
// 从 MindAutonAgent MilkdownEditor.tsx 移植,Crepe features 配置一致:
//   开:CodeMirror / ListItem / LinkTooltip / Cursor / BlockEdit / Toolbar / Placeholder / Table
//   关:ImageBlock / Latex(MVP 不做图片插入与数学公式)
//
// 注意:Crepe 主题 CSS 自成体系,不与 Tailwind 冲突;直接 import frame-dark。

import { useCallback, useRef } from 'react';
import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame-dark.css';
// 必须在 Crepe theme 之后,才能 override 它的 px 字号(详见文件注释)
import '@/styles/milkdown-font-override.css';
import { useSettingValue } from '@/plugins/settings/values-store';
import { t } from '@/i18n';

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
  const firstEmitRef = useRef(true);

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
      },
    });

    if (readonly) crepe.setReadonly(true);

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        if (firstEmitRef.current) {
          firstEmitRef.current = false;
          return;
        }
        if (readonly) return;
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
  // src/styles/editor-font.css 里 override(后续若需扩展)
  const fontSize = useSettingValue<number>('editor.fontSize', 13);

  // ref 跟踪最新 onLinkClick:外层 click handler 不重建,内部读最新值。
  const onLinkClickRef = useRef(props.onLinkClick);
  onLinkClickRef.current = props.onLinkClick;

  // Cmd/Ctrl+click on <a>:Crepe 渲染 markdown link 为真实 anchor,
  // 我们冒泡到外层捕获。仅修饰键 click 拦截,普通 click 让 ProseMirror
  // 走光标定位(IDE 通用约定:Cmd+click 跳转,普通 click 编辑)。见 issue #25。
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    const a = target?.closest('a');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    onLinkClickRef.current?.(href);
  }, []);

  return (
    <MilkdownProvider>
      <div
        className="h-full w-full overflow-auto"
        style={{ fontSize: `${fontSize}px` }}
        onClick={handleClick}
      >
        <CrepeEditor {...props} />
      </div>
    </MilkdownProvider>
  );
}
