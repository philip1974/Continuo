// 命令按已本地化标题字母序排(命令面板与快捷键设置页共用;此前两处各写一份)。
export function byDisplayTitle(a: { readonly displayTitle: string }, b: { readonly displayTitle: string }): number {
  return a.displayTitle.localeCompare(b.displayTitle);
}
