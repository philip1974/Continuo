import { Spotlight } from './Spotlight';

export function Splash() {
  return (
    <div
      data-testid="splash"
      className="fixed inset-0 z-modal flex items-center justify-center overflow-hidden bg-canvas"
    >
      {/* 光束色跟随主题前景色(原写死 white,亮色画布上看不见)。 */}
      <Spotlight className="-top-40 left-0 text-fg md:-top-20 md:left-60" fill="currentColor" />
      <h1 className="relative z-10 bg-gradient-to-b from-fg to-fg-muted bg-clip-text text-5xl font-bold text-transparent">
        Continuo
      </h1>
    </div>
  );
}
