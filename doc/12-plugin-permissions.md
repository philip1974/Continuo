# Plugin 作者文档:权限系统(v5)

LM 插件如果要访问文件系统、网络、剪贴板或 shell,必须**先在 manifest
声明 + 用户授权 + runtime 访问 app.* 命名空间**。本文给 plugin 作者
讲清楚怎么用、什么会被拦、怎么优雅降级。

> 系统设计见 [11-v5-权限-runtime-sandbox.md](./11-v5-权限-runtime-sandbox.md)。
> 端用户视角的权限 UX 见 LM Settings → 插件 tab。

## 1. 声明权限(manifest.json)

```json
{
  "id": "com.example.foo",
  "name": "Foo",
  "version": "1.0.0",
  "main": "main.js",
  "permissions": ["fs", "network", "clipboard"]
}
```

支持的权限枚举(`PermissionKey`):

| Key | 含义 | runtime 访问入口 |
|---|---|---|
| `fs` | 读写本地文件 | `this.app.fs.{readFile,writeFile,listDir}` |
| `network` | 发起 HTTP 请求 | `this.app.network.fetch` |
| `clipboard` | 读写系统剪贴板 | `this.app.clipboard.{readText,writeText}` |
| `shell` | 执行 shell 命令(Phase 4+ 实装) | `this.app.shell.*`(占位) |

不在此枚举内的值会被 manifest schema 拒绝(`SCHEMA_ERROR`)。
未在 manifest 声明的权限,plugin runtime 调用对应 API 必抛
`PermissionError`,即使用户在 LM 内部 Modal 上看不见这一项。

## 2. 首次启用 → 用户决策

用户在 Settings → 插件 → [启用] 你的插件时,LM 弹"权限请求"Modal
列出 manifest.permissions 里的项,默认全勾。用户可以:

- **[授权选中]**:勾选项 grant,未勾视为 deny
- **[全部拒绝]**:全部 deny → plugin 不激活,状态 FAILED
- **ESC / 点遮罩**:等同全部拒绝

## 3. partial grant:plugin 仍激活 + warning

v5 Phase 2 起**支持部分授权**。例:

- manifest 声明 `["fs", "network"]`
- 用户只勾 `fs`
- plugin 激活成功,Settings 行下显黄字 ⚠ `部分授权:已授 fs;未授 network`
- plugin 调 `app.fs.*` 正常,调 `app.network.fetch` 抛 `PermissionError`

**plugin 必须 try/catch `PermissionError`**,优雅降级。例:

```js
const { Plugin, PermissionError } = globalThis.lm;

export default class Foo extends Plugin {
  async onload() {
    this.addCommand({
      id: 'foo.sync',
      title: 'Sync from cloud',
      fn: async () => {
        try {
          const r = await this.app.network.fetch('https://api.example.com/sync');
          const data = await r.json();
          // ... 用 data
        } catch (err) {
          if (err instanceof PermissionError) {
            // 友好提示,引导用户开权限
            alert('需要 network 权限,请在 Settings → 插件 → [权限] 编辑');
          } else {
            // 其它错(网络断、API 5xx)
            console.error('sync failed', err);
          }
        }
      },
    });
  }
}
```

或主动检查避免抛:

```js
if (await this.app.permission.check('network')) {
  await this.app.network.fetch(url);
} else {
  // 走 offline path
}
```

`this.app.permission.granted()` 返回当前 plugin 实际拿到的权限列表。

## 4. 用户事后改主意

用户可在 Settings → 插件 → 你的插件行点 **[权限]** 按钮编辑,
改完点 **[保存]**。改动**不会**自动重启 plugin 实例 — plugin 需要
作出选择:

- **写入 store 后等下次启用生效**(默认):用户手动 [禁用] → [启用] 时
  权限重新生效
- **plugin 自己监听并刷新**:自家命令的 fn 每次都用 `app.permission.check`
  即时判,自动反映最新决策

LM 不强制选哪种,但**推荐 plugin 自己每次调 API 时 try/catch**,这样
即时反映最新 store 状态。

## 5. FAILED 状态 + 用户重试

- 用户 [全部拒绝] → plugin 状态 FAILED + 红字 `PERMISSION_DENIED: ...`
- Settings 行仍显 [启用] 按钮(v4.7),用户改主意点 [启用] →
  LM 自动 `clearDenied(pluginId)` 清旧 deny → re-prompt → 用户重选
- 全部拒就还是 FAILED;授任一就 enabled(可能 partial)

## 6. 当前 sandbox 已知限制

v5 Phase 4 的入境清洗只覆盖 `globalThis.fetch` + `navigator.clipboard`,
且**只在 PROD 模式生效**(dev 保留供 Vite HMR 使用)。

**还能绕开的路**:

- `window.api.fs.*` 直接调 — LM UI 自身大量用 `window.api.*`,refactor
  到内部 helper 工程量大,本次未做。**不要写**这种代码,marketplace
  review 会拒
- 把代码丢到 `<iframe>` / `Worker` / `eval` 里再调 — 同 realm 同享
  globals(本计划见 11.§3 选项 C 留给 v6+)

PROD 模式下 plugin 写 `globalThis.fetch(...)` 会得到 `TypeError: fetch
is not a function`,plugin 作者一旦在 PROD 测试就会发现并改用
`this.app.network.fetch`。

## 7. 完整示例

参考 `examples/sample-plugin/`(v0.2.0):

- `manifest.json` 声明 `["fs", "network"]`
- `main.js` 中 `sample.read-tmp` 命令演示 `app.fs.listDir` + `try/catch PermissionError`
- `sample.fetch-time` 命令演示 `app.network.fetch` + `try/catch PermissionError`

## 8. 测试 plugin 的权限路径

dev 模式:plugin 调 raw API 不会被拦(为兼容 Vite HMR)。要验证
"未授时的 PermissionError 路径",有两种方式:

1. **临时调 app.\* 强制走 gating**(推荐):写代码就用 `this.app.fs.*`,
   gating 永远生效
2. **打 PROD .app 测**:`pnpm build:app` 后跑 `LayoutMotion.app`,
   raw fetch 会被 sandbox sweep 删掉

## 9. 反馈 / 路线

完整 sandbox(进程隔离 / Worker)见 #14 / `doc/11`。
有具体 plugin 场景被现限制堵到 → 提 issue,会优先级提前。
