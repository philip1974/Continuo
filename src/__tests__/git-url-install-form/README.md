# 「从 Git URL 安装」输入行(GitUrlInstallForm)

行为契约:**输入框里按 Enter 等同点「安装」(IME 组合中的 Enter 不算);安装进行中输入框改 readOnly(不 disabled),
焦点不掉回 body;从按钮发起的安装结束后焦点回到输入框。**

对照 VSCode:扩展视图 / Quick Input 里输入后按 Enter 即提交;操作进行中输入框保持可聚焦(进度条提示),不丢焦点。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/GitUrlInstallForm.tsx` | UI(设置 → 插件、插件市场共用) |
| `src/design/ime.ts` | `isImeComposing`(组合中按键判定,仓库共用) |

## 规范文件

- `git-url-install-form.spec.tsx`

## 关键行为

- 输入非空 URL 按 Enter → install(trim 后的 URL)一次
- IME 组合中(isComposing / keyCode 229)的 Enter → 不安装
- 空 / 全空白输入按 Enter → 不安装
- 安装中:输入框 readOnly 且不 disabled,原先在输入框的焦点保持;再按 Enter 不重复安装(单飞)
- 点按钮发起的安装结束后(按钮 busy 时 disabled 会丢焦点)→ 焦点回到输入框
- 安装成功(install 返回 true)→ 清空输入
