/**
 * 焦点在 container 内,或已丢失(落在 body / 无焦点 / 焦点元素已脱离文档)。关闭弹窗 / 面板 / tab 后据此判断
 * 「是否该由我们把焦点交出去」:焦点已被用户或命令移到别处时不抢。
 */
export function focusWithinOrLost(doc: Document, container: Element | null | undefined): boolean {
  const active = doc.activeElement;
  return (
    active == null ||
    active === doc.body ||
    !active.isConnected ||
    (container?.contains(active) ?? false)
  );
}
