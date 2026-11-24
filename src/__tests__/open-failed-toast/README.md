# open-failed-toast(打开文件失败的统一提示)

行为契约:**用户主动打开文件失败时,弹一条 `「打开失败」 <文件名>: <原因>` 的 error toast,原因按错误码本地化,toast 附带错误码。**

Explorer 点击文件(`FolderTree`)、Quick Open 选中文件(`QuickOpenModal`)与 Markdown 内链打开本地文件(`EditorPanel`)共用 `notifyOpenFailed`
(此前各写一份并已分叉:Quick Open 不附 code、抛错时不本地化;Explorer 抛出非 Error 时原因显示成 `undefined`)。

## 行为

- `ok:false` 结果 → 原因 = `localizeErrorByCode(code, message ?? code)`,toast 带 `{ code }`。
- 抛错 → code 取 `errorCodeOf(err)`(无则 `EXCEPTION`),原因按同一规则本地化;抛出值没有 message 时回退 code,
  不显示 `undefined`。
- 调用方已自行 console 记录时可传 `{ mirror: false }`。

## 接线守卫

三个调用方源码都调用 `notifyOpenFailed(`,且不再内联 `t('quick_open.open_failed')`。
