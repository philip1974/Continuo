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
  // visibilityState === 'hidden' 时不挂载 SVG,节电(R3 缓解)。
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return (
    <div
      data-testid="empty-state"
      className="absolute inset-0 z-10 flex h-full w-full overflow-hidden bg-canvas"
    >
      {visible && <BackgroundBeams />}
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
