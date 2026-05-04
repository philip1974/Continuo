import { useCallback, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { DockShell } from './dock/DockShell';
import { Splash } from './decor/Splash';
import { IconSidebar } from './IconSidebar';
import { PopoutHost } from './PopoutHost';
import { isPopoutWindow } from '@/lib/popout-mode';

const SPLASH_MIN_MS = 600;

function MainApp() {
  const [layoutReady, setLayoutReady] = useState(false);
  const [splashElapsed, setSplashElapsed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSplashElapsed(true), SPLASH_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  const onLayoutReady = useCallback(() => setLayoutReady(true), []);
  const showSplash = !(layoutReady && splashElapsed);

  return (
    <>
      <div className="flex h-dvh w-dvw flex-col bg-[#020617] text-neutral-100">
        <header className="flex h-9 shrink-0 items-center justify-center border-b border-white/5 text-xs text-neutral-500 select-none [-webkit-app-region:drag]">
          LayoutMotion
        </header>
        <main className="flex min-h-0 flex-1">
          <IconSidebar />
          <div className="min-w-0 flex-1">
            <DockShell onLayoutReady={onLayoutReady} />
          </div>
        </main>
      </div>
      {showSplash && <Splash />}
    </>
  );
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      {isPopoutWindow() ? <PopoutHost /> : <MainApp />}
    </MotionConfig>
  );
}
