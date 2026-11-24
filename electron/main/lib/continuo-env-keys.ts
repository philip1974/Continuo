// 宿主注入给终端会话的 env 名(单一来源)。注入处(continuo-terminal-host-adapter / terminal.service)、
// 机密剥离名单(child-spawn-hardening.INTERNAL_SECRET_ENV_KEYS)与 managed hook 命令(mcp-tools-hook-bridge)
// 必须用同一个名字:只改注入一侧,剥离会静默失效、token 漏进插件 shell / 调试适配器。

/** MCP HTTP 调用凭据(机密,不得进入非宿主子进程)。 */
export const CONTINUO_MCP_TOKEN_ENV = 'CONTINUO_MCP_TOKEN';
/** managed Stop hook 写事件文件的目录(broker / hook 安装 / PTY env 必须一致)。 */
export const CONTINUO_HOOK_EVENTS_DIR_ENV = 'CONTINUO_HOOK_EVENTS_DIR';
