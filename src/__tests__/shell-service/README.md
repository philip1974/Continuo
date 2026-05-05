# shell-service(plugin app.shell.exec 后端)

行为契约:**execShell(input) 用 child_process.spawn 跑一次性命令,buffered
收 stdout/stderr,超时 SIGTERM,输出超 maxOutputBytes 截断标 truncated。
返回 ExecResult 含 exitCode / signal / timedOut / truncated。**

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/shell.service.ts` | execShell 实现 |
| `electron/shared/shell-channels.ts` | IpcShellExecInput / Result 类型 |

## 关键行为

### 正常退出

- exitCode = 进程实际退出码
- signal = null
- timedOut = false
- stdout / stderr 是完整缓冲

### 超时

- 默认 30s,opts.timeoutMs 覆盖
- 触发 SIGTERM,500ms grace 后 SIGKILL(防 hang)
- timedOut = true,signal 反映实际收到的(SIGTERM/SIGKILL)

### 输出截断

- stdout / stderr 各自独立 cap maxOutputBytes(默认 10MB)
- 超额停接,标 truncated = true,进程仍跑到结束

### spawn 失败

- 同步抛(cmd 不可执行)→ 返 exitCode=null + stderr 含错信息
- 异步 'error' 事件 → 同上,stderr 追加

### stdin

- input 字符串非 undefined → write + end
