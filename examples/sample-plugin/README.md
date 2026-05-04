# Sample Plugin(LM 示例插件)

演示 LM 插件系统 9 个贡献点 + 持久化 + 权限请求(本插件无需权限)。

## 文件清单

| 文件 | 用途 |
|---|---|
| `manifest.json` | 插件元数据(id / name / version / main / minLMVersion) |
| `main.js` | ESM 入口,export default class extends Plugin |
| `README.md` | 本文档 |
| `styles.css` | 可选,LM 自动注入到 head(本示例未用)|

## 安装

把整个目录拷到 LM 的 userData:

```bash
# macOS
cp -r examples/sample-plugin "$HOME/Library/Application Support/LayoutMotion/plugins/com.example.sample"

# Linux
cp -r examples/sample-plugin "$XDG_CONFIG_HOME/LayoutMotion/plugins/com.example.sample"

# Windows
xcopy examples\sample-plugin "%APPDATA%\LayoutMotion\plugins\com.example.sample" /E /I
```

启动 LM → Settings(右下 ⚙) → 插件 → 在"第三方插件"段看到 'Sample Plugin' →
点 [启用]。

## 演示的 API

| 贡献点 | 演示 |
|---|---|
| `addCommand` | `sample.hello` 命令(⌘⇧H 弹 alert),进命令面板 ⌘P |
| `addStatusBarItem` | 右下 🕐 时钟,1 秒刷新 |
| `addRibbonAction` | IconSidebar 中段 🧩 图标,点击触发 hello 命令 |
| `registerEvent` | 订阅自定义 `sample.tick` 事件 |
| `addSettingTab` | Settings 多一个 "Sample" tab |
| `registerExplorerDecorator` | 文件树 .md 文件右侧 'MD' badge(主色)|
| `registerEditorAction` | EditorHeader 加 [大写] 按钮(仅 markdown 文件显示)|
| `loadData / saveData` | 启动时读、写 `lastLoadedAt`(纯演示,无 UI 反馈)|
| 权限 | 本插件 manifest 无 `permissions`,启用时不弹授权框 |

## 实操验证 LM 插件链路

启用本插件后,LM 应该立刻出现:

- 右下状态栏 🕐 时钟在跳
- 左侧活动栏多一个 🧩 图标(在内置 Explorer/Search 下面)
- ⌘P 命令面板能搜到 'Sample: Hello World'
- ⌘⇧H 弹出 alert
- Settings → Sample tab 显示插件信息
- 打开 explorer,.md 文件右侧出现 'MD' badge
- 打开任意 .md 文件,EditorHeader 右侧出现 [大写] 按钮

[禁用] 后这些立刻全部消失(LIFO 自动清理验证)。

## 已知简化(待 LM SDK 完善)

1. **未 extends Plugin**:本示例直接定义 onload/onunload,因 LM 暂未通过
   `import 'lm'` 暴露 Plugin 基类。SDK 完成后可改为
   `import { Plugin } from 'lm'; export default class extends Plugin { ... }`。
2. **React 通过 globalThis.React**:plugin 内 JSX 编译成 React.createElement,
   依赖 LM 把 React 挂全局。SDK 完成后可改为 `import { createElement } from 'react'`。
3. **disposables 手动管理**:基于以上 #1,onunload 自己跑 LIFO。继承 Plugin
   父类后 disposables 自动收集 + 清理。

## 修改 + 重载

改完 main.js 不需要重启 LM:Settings → 插件 → 该行 [重载] 按钮即可加载最新代码。

## 调试

打开 DevTools(View → Toggle Developer Tools)看 console:
- 插件加载失败信息(`[plugin-manager] ...`)
- 你自己 console.debug / console.log 的输出
