export function Terminal() {
  return (
    <div className="h-full w-full overflow-auto bg-black/30 p-3 font-mono text-xs text-emerald-300">
      <div>$ pnpm dev</div>
      <div className="text-neutral-400">vite ready in 312 ms</div>
      <div>$ _</div>
    </div>
  );
}
