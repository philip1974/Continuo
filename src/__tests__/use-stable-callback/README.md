# useStableCallback(引用恒定的最新回调)

行为契约:**返回的函数引用在组件生命周期内不变,调用时总是执行最近一次渲染传入的 fn。**

传给 design `Modal` 的 `onClose` 须引用稳定(其焦点 / 键盘栈 effect 依赖 onClose):ConfirmDialog、
PermissionEditorModal、KeybindingCaptureModal 共用本 hook(此前前两处各手写 ref + useCallback,第三处漏了,
父组件重渲即把弹窗内焦点拉回)。

## 接线守卫

三个弹窗组件都经 `useStableCallback(` 包装传给 Modal 的 onClose。
