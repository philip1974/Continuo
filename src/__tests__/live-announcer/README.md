# live-announcer — 全局读屏播报

`src/lib/announce.ts` 的 `announce(text, { politeness, doc })`:应用内所有「不随某个元素出现、只需读屏念一句」的播报
(toast 创建 / 合并、Debug 停下 / 继续运行)共用的一处实现。参考 VSCode `aria.alert` / `aria.status`(全局常驻播报节点)
与 react-aria `LiveAnnouncer`(每条播报一个新节点、数秒后清理、新建区域后稍等再插入)。

- A1 每个文档(主窗、每个 popout 子窗)一对常驻、视觉隐藏(`SR_ONLY_STYLE`)的 `[data-live-announcer]` 区域:
  `aria-live="polite"` 与 `aria-live="assertive"`,均 `aria-atomic="false"`、`aria-relevant="additions"` —— 只读新增的节点。
  `prepareAnnouncer(doc)` 预先建好(幂等;`ToastViewport` 对主窗与每个 popout 子窗调用)。
- A2 每次播报在对应区域追加一个新节点:同一 tick 的多次播报全部保留(React 合批也不会只剩最后一条),polite / assertive
  互不清空;同样的文本再播是新节点,读屏会再读。A2b 每区只留最近 `ANNOUNCE_MAX_NODES` 条,每条 `ANNOUNCE_CLEAR_MS` 后移除。
  A2c 区域尚不存在时先建区域,`ANNOUNCE_PRIME_MS` 后再插入(live region 须先于内容存在)。
- A3 模态感知:该文档有打开的 design `Modal` 时(`aria-modal="true"`,Chromium / VoiceOver 不读对话框外的节点),播报写进
  顶层模态内容(`getTopModalContent(doc)`)里的一对区域;没有模态时回到 `body` 下的那一对。
- A4 `doc` 选项指定写进哪个文档(默认主窗);每次播报只写一个文档,读屏不重复。选哪个窗口由调用方决定
  (`getAnnouncingDocument()`:有焦点的 popout 子窗,否则主窗)。
- A5 区域被移出文档后再播报会重建。

调用方:`unified-toast-notification` T25-T30、`51-debug-breakpoint-ui` 停点播报。
