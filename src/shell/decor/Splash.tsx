import { Spotlight } from './Spotlight';

export function Splash() {
  return (
    <div
      data-testid="splash"
      className="fixed inset-0 z-modal flex items-center justify-center overflow-hidden bg-canvas"
    >
      <Spotlight className="-top-40 left-0 md:-top-20 md:left-60" fill="white" />
      <h1 className="relative z-10 bg-gradient-to-b from-neutral-50 to-neutral-400 bg-clip-text text-5xl font-bold text-transparent">
        Continuo
      </h1>
    </div>
  );
}
