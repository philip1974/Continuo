# Explorer 行内重命名:输入时校验,错误行内提示、输入保留

行为契约(对齐 VSCode Explorer 重命名的 `validateFileName`):**重命名输入框边输入边校验;名字为空、与同目录
其它项重名、含非法字符时,输入框标红(`aria-invalid`)并在其下方显示原因,Enter 不提交、输入保留可继续修改;
Esc 放弃;失焦时若输入无效则放弃(不提交)。** 此前重命名到已存在名字是 Enter 后输入框直接关闭、输入丢失,只弹
toast,而新建同样的错误却是行内红框保留输入 —— 两者不一致。

## 行为

| 输入 | 提示(en) | Enter | 失焦 |
|---|---|---|---|
| 空 / 全空白 | A file or folder name must be provided. | 不提交,输入框保留 | 放弃 |
| 与同目录其它项同名 | A file or folder “x” already exists at this location. Please choose a different name. | 不提交 | 放弃 |
| 非法名(`/`、`:`、`~`、`..`、控制字符、Windows 保留名、尾随点 / 空格等,与 main 端同一规则) | The name “x” is not valid as a file or folder name. Please choose a different name. | 不提交 | 放弃 |
| 未改名 / 合法新名 | 无 | 提交 | 提交 |

- 错误提示紧贴输入框下方(覆盖在下一行之上,不挤动列表),`role="alert"` 即时播报;输入框 `aria-describedby` 指向它。
- 改正输入后提示立即消失,可提交。
- **大小写仅变化**(`a.ts → A.ts`)不算重名:比较时排除正在重命名的项自身。重名比较的大小写策略同 VSCode:
  macOS / Windows(默认大小写不敏感文件系统)忽略大小写(`Bravo.ts` 与已有 `bravo.ts` 冲突);Linux 区分大小写。
- 提交后 main 端仍失败(权限、外部进程刚建了同名文件、未显示的隐藏文件同名等)→ 照 VSCode:退出重命名,toast
  提示原因(同名时带目标名)。

## 不在范围

- 新建(CreateInput)的校验时机不变:提交后 main 端失败时行内显示原因、保留输入。
