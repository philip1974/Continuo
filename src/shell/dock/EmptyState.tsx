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

export function EmptyState({ onRestore }: { onRestore: () => void }) {
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
      className="absolute inset-0 z-10 flex h-full w-full overflow-hidden bg-canvas outline-none"
    >
      {visible && focused && <BackgroundBeams />}
      <div className="relative z-10 m-auto flex flex-col items-center gap-4">
        {/* Icon 容器(参考 stitch_desktop_design_reviewer):圆形面板 + 边框,
         *  让"无面板"状态自成一个视觉单元而非孤立文案。 */}
        <div className="flex h-20 w-20 items-center justify-center rounded-full border border-line/50 bg-panel">
          {EMPTY_DOCK_ICON}
        </div>
        <p className="text-fg-muted">{t('dock.empty.message')}</p>
        <Button variant="ghost" size="md" onClick={onRestore}>
          {t('dock.empty.restore')}
        </Button>
      </div>
    </div>
  );
}
