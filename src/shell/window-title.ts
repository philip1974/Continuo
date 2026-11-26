// 窗口原生标题(Dock / 窗口菜单 / 任务切换器里显示)的拼接:「文件 ● · 工作区」,都没有 → Continuo。主窗(TitleBar)与
// popout 子窗(popout-window-titles)共用。

export function formatWindowTitle(label: string | null, dirty: boolean, workspace: string | null): string {
  return [label && `${label}${dirty ? ' ●' : ''}`, workspace].filter(Boolean).join(' · ') || 'Continuo';
}
