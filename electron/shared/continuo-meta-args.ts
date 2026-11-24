// main 经 webPreferences.additionalArguments 注入、sandbox preload 从 process.argv 解析的元信息参数前缀。
// 两侧共用此一份(main 拼接 electron/main/continuo-meta-args.ts,preload 解析 electron/preload/continuo-meta-parse.ts)。
// 本文件被 sandbox preload 引用,不得 import node:*。

/** 本机 hostname(OSC7 acceptedHosts 用)。 */
export const CONTINUO_HOSTNAME_ARG_PREFIX = '--continuo-hostname=';
/** Windows 系统 build 号(仅 win32 注入;终端 xterm windowsPty 用)。 */
export const CONTINUO_WINDOWS_BUILD_ARG_PREFIX = '--continuo-windows-build=';
