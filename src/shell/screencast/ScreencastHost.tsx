// 屏幕录制模式打开时才加载并挂载浮层(关闭时零开销,浮层 chunk 不进首屏包)。MainApp 挂载。BDD: src/__tests__/screencast-mode/
import { lazy, Suspense } from 'react';
import { useScreencastStore } from './screencast-store';

const ScreencastOverlay = lazy(() => import('./ScreencastOverlay'));

export function ScreencastHost() {
  const enabled = useScreencastStore((s) => s.enabled);
  if (!enabled) return null;
  return (
    <Suspense fallback={null}>
      <ScreencastOverlay />
    </Suspense>
  );
}
