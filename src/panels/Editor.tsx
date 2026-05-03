export function Editor() {
  return (
    <div className="h-full w-full overflow-auto p-4 font-mono text-sm text-neutral-200">
      <div className="text-neutral-500">// editor placeholder</div>
      <div>export function hello() {'{'}</div>
      <div className="pl-4">return 'world';</div>
      <div>{'}'}</div>
    </div>
  );
}
