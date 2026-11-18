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
- 未提供 input → 立即 end stdin(一次性非交互 API;cat / python - 读到 EOF 正常退出,不等到超时)

### 不可信仓库中的 git 兜底(安全,覆盖范围有限)

- 宿主给所有插件子进程注入 git 命令行作用域 `core.fsmonitor=false`(`lib/child-spawn-hardening`),
  恶意 `.git/config` 的 fsmonitor 不能借插件的 `git status` 执行命令(`git-fsmonitor-hardening.test.ts`)。
- **宿主兜底只覆盖 fsmonitor。** 同一威胁下的 `filter.<x>.clean/smudge/process` + `.gitattributes`、
  `diff.<x>.textconv` / `diff.external`、`core.sshCommand`、`core.pager`、`credential.helper` 等,驱动名由仓库
  自定、无通配禁用语法,强行置空又会破坏用户合法配置 —— **需插件自行加固**(`--no-textconv` / `--no-ext-diff`、
  按需 `-c <key>=<安全值>` 显式覆盖、只用不触发过滤器的子命令,或受信判断后再调用)。

### env 合并(Windows)

- `input.env` 覆盖宿主 env;Windows 上键大小写不敏感合并(插件 `PATH` 覆盖宿主 `Path`,只留一个键),
  命令解析与子进程实际 env 一致(`spawn-env-path-case.test.ts`)。
