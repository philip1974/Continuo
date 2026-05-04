import { useEffect, useState } from 'react';
import { BackgroundBeams } from '@/shell/decor/BackgroundBeams';
import { Button } from '@/design';

export function EmptyState({ onRestore }: { onRestore: () => void }) {
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
      className="absolute inset-0 z-10 flex h-full w-full overflow-hidden bg-[#020617]"
    >
      {visible && <BackgroundBeams />}
      <div className="relative z-10 m-auto flex flex-col items-center gap-4">
        <p className="text-fg-muted">所有面板都关掉了。</p>
        <Button variant="ghost" size="md" onClick={onRestore}>
          恢复默认布局
        </Button>
      </div>
    </div>
  );
}
