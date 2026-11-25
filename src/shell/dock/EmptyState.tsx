import { useEffect, useState } from 'react';
import { BackgroundBeams } from '@/shell/decor/BackgroundBeams';
import { Button } from '@/design';
import { useT } from '@/i18n';

const EMPTY_DOCK_ICON = (
  <svg
    width="36"
    height="36"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="text-fg-dim"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
    <line x1="3" y1="10" x2="21" y2="10" strokeDasharray="2 2" />
  </svg>
);

/**
 * `elsewhere`:主窗没有面板,但面板都还开在 popout 子窗里 —— 不能说「都关掉了」,也不提供「恢复默认布局」
 * (会在主窗再建一套单例面板,与子窗里的同一面板冲突);关掉子窗即收回主窗。
 */
export function EmptyState({ onRestore, elsewhere = false }: { onRestore: () => void; elsewhere?: boolean }) {
  const t = useT();
  // 不可见或窗口失焦时不挂载 SVG,节电(R3 缓解)。
  // 主进程 backgroundThrottling:false(issue #34)使 Electron 在最小化 / 遮挡 / 隐藏时
  // 仍报 visibilityState='visible'(Electron 文档「Page visibility」),只靠它挡不住
  // 后台每帧补间 ~200 个 SVG 属性;故再加窗口焦点闸门。焦点信号在 macOS Dock 还原时
  // 可能迟到(要点击才 focus),误判只让装饰暂停/晚恢复,无功能影响。
  const [visible, setVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  const [focused, setFocused] = useState(
    () => document.hasFocus(),
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    // 初值在渲染时读、监听在绘制后才挂:其间的焦点/可见性变化(启动恢复多窗口时后建窗口抢焦点)会漏掉,
    // 挂上监听后立即重新同步一次。
    onChange();
    setFocused(document.hasFocus());
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div
      data-testid="empty-state"
      // 主窗无面板时 F6 / ⇧F6 的 dock 区域落点(src/shell/focus-parts.ts):只经脚本聚焦,不进 Tab 顺序。
      data-dock-empty=""
      tabIndex={-1}
      // [container:empty/size]:宽高都可做容器查询(dock 在最小窗口下只有约 145px 宽、200px 高)。
      className="absolute inset-0 z-10 flex h-full w-full overflow-hidden bg-canvas outline-none [container:empty/size]"
    >
      {visible && focused && <BackgroundBeams />}
      <div className="relative z-10 m-auto flex max-w-full flex-col items-center gap-4">
        {/* Icon 容器(参考 stitch_desktop_design_reviewer):圆形面板 + 边框,
         *  让"无面板"状态自成一个视觉单元而非孤立文案。窄(< 16rem)/ 矮(< 220px)时隐藏,不被裁成半圆。 */}
        <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border border-line/50 bg-panel @max-3xs/empty:hidden [@container_empty_(height<220px)]:hidden">
          {EMPTY_DOCK_ICON}
        </div>
        {/* 最小窗口下 dock 仅约 72px 宽:居中、收窄内边距,超宽单词(韩文 keep-all)必要时词内断行,不越出右边。 */}
        <p className="px-4 text-center text-fg-muted wrap-break-word @max-3xs/empty:px-2">{t(elsewhere ? 'dock.empty.in_other_windows' : 'dock.empty.message')}</p>
        {!elsewhere && (
          <Button variant="ghost" size="md" onClick={onRestore}>
            {t('dock.empty.restore')}
          </Button>
        )}
      </div>
    </div>
  );
}
