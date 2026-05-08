# design Modal — focus trap / overlay / escape / tab cycle

行为契约:**`<Modal visible onClose={fn}>` 在 visible=true 时挂载,聚焦内部第一个 focusable;
visible=false 不渲染;Esc 调 onClose;Tab 在最后一个 focusable 上循环到第一个,
Shift+Tab 在第一个上循环到最后一个;overlay click 调 onClose;关闭后焦点返还触发前元素。**

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

- 点击 overlay → onClose
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
