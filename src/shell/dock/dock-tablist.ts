// dockview 生成的 tab 条容器(.dv-tabs-container)没有 role/名称:补 role=tablist + 本地化 aria-label(幂等,每次重写名称以随语言更新)。
// SharedTab(tab 级)与 HeaderActions(组级,空组也渲染 → 组内无 tab 时切语言也能更新)共用。BDD: src/__tests__/shared-tab/、popout-header-menu/
export function labelDockTablist(strip: Element | null | undefined, label: string): void {
  if (!strip) return;
  if (strip.getAttribute('role') !== 'tablist') strip.setAttribute('role', 'tablist');
  if (strip.getAttribute('aria-label') !== label) strip.setAttribute('aria-label', label);
}
