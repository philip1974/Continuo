# design Modal — focus trap / overlay / escape / tab cycle

行为契约:**`<Modal visible onClose={fn}>` 在 visible=true 时挂载,聚焦内部第一个 focusable;
visible=false 不渲染;Esc 调 onClose;Tab 在最后一个 focusable 上循环到第一个,
Shift+Tab 在第一个上循环到最后一个;overlay click 调 onClose;关闭后焦点返还触发前元素。**

键盘(Esc / Tab)与焦点(触发前元素、陷阱内当前焦点)都按 **Modal 内容所在文档**处理,面板弹出到 popout 子窗时
同样生效(见 `popout-panel-keyboard`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/Modal.tsx` | UI |

## 关键行为

### 渲染

- visible=false → 返 null
- visible=true → wm-modal-overlay > wm-modal-content
- size prop → data-size='sm/md/lg'
- className 与默认合并

### onClose

- 点击 overlay → onClose:仅当 **mousedown 与 click 的 target 都是 overlay 本身**;在内容区按下、拖到遮罩上松开
  (click 落在公共祖先 overlay)不关闭(避免拖选文字误关命令面板 / Quick Open、误拒授权弹窗)
- 点击 content → e.stopPropagation,**不**调 onClose
- Esc → preventDefault + onClose
- onClose 缺省 → overlay 不带 onClick(无 hover handler)

### 焦点

- 挂载时:把当前 activeElement 存 prevFocus,raf 后聚焦第一个 focusable;
- 没有 focusable → root.focus
- 卸载时:把焦点还给 prevFocus

### Tab 循环

- 没 focusable + Tab → preventDefault
- Tab 在 last 上 → preventDefault + first.focus()
- Shift+Tab 在 first 上 → preventDefault + last.focus()
- 中间位置 Tab → 浏览器默认(我们不动)

### 打开状态订阅

- `hasOpenModal()`:当前是否有 visible 的 Modal(主窗与 popout 子窗文档合计)
- `subscribeOpenModals(listener)`:仅在「有 / 无打开的 Modal」切换时调用 listener(叠加第二个不通知);返回退订函数
- 通用 API,不含业务;toast 用它在模态遮罩期间暂停自动消失(`unified-toast-notification` T24)
- `getTopModalContent(doc)`:该文档最后打开、仍可见的 Modal 内容节点(`.wm-modal-content`),无模态时为 `null`。
  `aria-modal` 让读屏忽略对话框外的节点,全局播报据此把 live region 放进顶层模态(`live-announcer` A3)
