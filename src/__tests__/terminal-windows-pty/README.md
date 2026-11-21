# terminal-windows-pty

行为契约:**Windows 上 xterm 获知 PTY 后端与系统 build 号**(同 VS Code `windowsPty`)。

xterm 6 未设 `windowsPty.buildNumber` 时 Windows 上仍开 reflow:ConPTY(build < 21376)自行重绘,
xterm 每次列数变化再对 20000 行 scrollback 做 O(N) `_reflow`,既白做又与 ConPTY 重绘冲突。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/continuo-meta-args.ts` | 仅 win32:`os.release()` 第三段 → `--continuo-windows-build=<n>`(经 `additionalArguments`,同 hostname 通道) |
| `electron/preload/continuo-meta-parse.ts` | 解析该参数(缺失 / 非法 → `null`),preload 暴露为 `coApi.system.windowsBuild` |
| `src/panels/Terminal/useTerminal.ts` | `terminalWindowsPtyOptions`:Windows 且有 build 号 → `new Terminal({ windowsPty })` |

## 关键行为

- Windows + build 号 → `windowsPty: { backend, buildNumber }`;后端与 node-pty 默认一致
  (sibling `server-node` spawn 不传 `useConpty` → node-pty 1.1 在 build ≥ 18309 用 ConPTY,更低回落 winpty)。
- 非 Windows → 不带 `windowsPty`(即便误注入了 build 号)。
- Windows 但拿不到 build 号 → 不猜,不带 `windowsPty`(维持旧行为)。
- xterm 据此在 `backend === 'conpty' && buildNumber >= 21376` 时才 reflow。
