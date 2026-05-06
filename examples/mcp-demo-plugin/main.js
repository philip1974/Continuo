// Continuo MCP Demo Plugin —— 注册 1 个 MCP tool 让 Agent 调用。
//
// 安装:把整个目录 cp 到 ${userData}/plugins/com.continuo.mcp-demo/
// 启用:Settings → 插件 → MCP Demo → 启用 → 授 mcp-tools 权限
// 验证:MCP client 调 tools/list 应见 demo.echo

const { Plugin, PermissionError, z } = globalThis.co;

export default class McpDemoPlugin extends Plugin {
  async onload() {
    try {
      await this.registerMcpTool({
        name: 'demo.echo',
        description:
          'Echo input.text back with plugin id and timestamp. Demonstrates plugin → MCP tool bridge.',
        jsonSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'text to echo' },
          },
          required: ['text'],
          additionalProperties: false,
        },
        inputSchema: z.object({ text: z.string() }).strict(),
        run: ({ text }) => ({
          echoed: text,
          from: this.manifest.id,
          ts: Date.now(),
        }),
      });
      console.log('[mcp-demo] demo.echo 注册成功');
    } catch (err) {
      if (err instanceof PermissionError) {
        console.warn('[mcp-demo] mcp-tools 权限未授,demo.echo 未注册');
      } else {
        console.warn('[mcp-demo] demo.echo 注册失败', err);
      }
    }
  }
}
