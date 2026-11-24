# plugin-fs-scope-shown-timeout(文件夹授权弹窗的无应答超时从开始显示起算)

## 背景

插件 `requestScope` 的授权弹窗在 renderer 是 FIFO 队列,一次只显示一个,renderer 自身不计时;main 的
`ScopeRequestCorrelator` 此前在**创建**请求时就定死 5 分钟过期。两个插件几乎同时请求,用户在 A 的弹窗停
4 分 50 秒后应答 → B 只显示约 10 秒就自动消失、插件收到 `request expired`;停超过 5 分钟 A、B 都过期。另外
过期按 `Date.now` 比较(含系统睡眠),弹窗开着合盖超过 5 分钟,唤醒后一分钟内就被清掉。

兄弟入口 agent-auth(`agent-auth.service` 的 `markDisplayed`)已改为从开始显示起算、排队另设 10 分钟兜底;
这里沿用同一模式。

## 行为

- renderer 的 fs-scope 弹窗开始显示某个请求(队首,且没有 manifest 权限弹窗占屏)时,经
  `plugin-fs:scope-request-shown` 回报 main 一次;main 从此刻起计 5 分钟无应答超时。
- **排队中的请求不计无应答超时**:前一个弹窗停留多久,都不会让排在后面的请求提前过期;轮到显示后仍有完整的 5 分钟。
- **排队兜底**:请求 10 分钟(与 agent-auth 排队上限同值)仍没被回报显示 → 同样按超时收口(插件收到
  `request expired`,renderer 收到撤弹窗通知),请求不会无限挂起。
- 回报只认**发给本窗口**的请求(别的 webContents 发来的标记无效),只生效一次(重复回报不能续期);
  不受信 frame 发来的回报被 frame-trust 门拒绝;畸形 requestId 按 BAD_INPUT 拒绝。
- 计时用 `setTimeout`(libuv 单调时钟,不计系统睡眠),与 agent-auth 一致。
- 超时收口后才到的决定被拒收(`unknown requestId`),不授予。

## 规范

- `scope-shown-timeout.spec.ts`:main 侧(request-scope / scope-request-shown handler + correlator)
- `bridge-reports-shown.spec.ts`:renderer 桥在弹窗开始显示时回报
