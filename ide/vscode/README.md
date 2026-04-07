# Claude Code VSCode 插件

基于 [csc 项目](../../) 的 VSCode 编辑器插件，将 Claude Code CLI 的能力直接集成到 VS Code 中。

## 功能

- **侧边栏聊天面板** - 在 VS Code 侧边栏与 Claude 对话
- **多轮对话** - 完整的上下文会话支持
- **会话历史** - 持久化会话，随时切换历史对话
- **代码操作** - 右键菜单发送选中代码：解释、重构、修复
- **工具权限审批** - 在 WebView 内嵌审批 Bash/文件操作等工具调用
- **多 Provider 支持** - Anthropic / OpenAI 兼容 / Gemini / Bedrock / Vertex / Grok
- **状态栏显示** - 实时显示运行状态和 Token 用量
- **流式输出** - 实时显示 Claude 回复

## 快速开始

### 前置条件

1. 先构建 csc 项目：
   ```bash
   cd ../../
   bun run build
   ```
   这会生成 `dist/cli.js`，插件会自动检测到它。

2. 安装 Node.js 依赖：
   ```bash
   cd ide/vscode
   npm install
   ```

### 开发模式

```bash
# 编译插件（监听模式）
npm run dev

# 在 VS Code 中按 F5 启动调试（Extension Development Host）
```

### 打包发布

```bash
npm run build
npm run package  # 生成 .vsix 文件
```

## 配置项

在 VS Code 设置（`Ctrl+,`）中搜索 `claudeCode`：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `claudeCode.cliPath` | CLI 路径（留空自动检测） | `""` |
| `claudeCode.runtime` | 运行时：auto/node/bun | `"auto"` |
| `claudeCode.provider` | AI 提供商 | `"anthropic"` |
| `claudeCode.model` | 模型名称 | `""` |
| `claudeCode.apiKey` | API 密钥 | `""` |
| `claudeCode.openaiBaseUrl` | OpenAI 兼容端点 | `""` |
| `claudeCode.permissionMode` | 权限模式 | `"default"` |
| `claudeCode.autoApproveTools` | 自动批准的工具 | `["Read","Glob","Grep"]` |
| `claudeCode.maxTurns` | 最大对话轮次 | `20` |
| `claudeCode.showThinking` | 显示思考过程 | `false` |
| `claudeCode.systemPrompt` | 附加系统提示 | `""` |

## 命令

| 命令 | 快捷键 | 说明 |
|------|--------|------|
| 新建对话 | `Ctrl+Shift+N` | 创建新的聊天会话 |
| 发送选中代码 | `Ctrl+Shift+A` | 发送编辑器选中内容 |
| 停止生成 | - | 停止当前 AI 生成 |
| 查看历史 | - | 浏览历史对话 |
| 打开设置 | - | 打开插件配置 |

## 架构

```
ide/vscode/
├── src/
│   ├── extension.ts          # 插件入口（激活/注销）
│   ├── types/index.ts        # 类型定义（消息/会话/权限/Provider）
│   ├── config/settings.ts    # VSCode 设置读写
│   ├── services/
│   │   ├── ClaudeCodeProcess.ts  # CLI 进程管理（stream-json 协议）
│   │   ├── SessionManager.ts     # 会话持久化
│   │   └── PermissionManager.ts  # 工具权限审批
│   ├── providers/
│   │   ├── ChatViewProvider.ts   # 侧边栏 WebView（核心）
│   │   └── StatusBarProvider.ts  # 状态栏
│   ├── commands/index.ts         # 命令注册
│   └── webview/
│       ├── main.ts               # WebView 脚本（聊天 UI）
│       └── style.css             # WebView 样式（VSCode 主题适配）
└── esbuild.js                # 构建脚本
```

### 通信协议

插件通过 `--input-format stream-json --output-format stream-json` 与 csc CLI 进行双向 JSON 通信：

```
Extension → CLI stdin:  {"type":"user","message":"你好"}
CLI stdout → Extension: {"type":"assistant","message":{...}}
CLI stdout → Extension: {"type":"result","subtype":"success",...}
```

### Provider 配置示例

**Anthropic（默认）**
```json
{
  "claudeCode.provider": "anthropic",
  "claudeCode.apiKey": "sk-ant-..."
}
```

**Ollama（OpenAI 兼容）**
```json
{
  "claudeCode.provider": "openai",
  "claudeCode.openaiBaseUrl": "http://localhost:11434/v1",
  "claudeCode.model": "qwen2.5-coder:14b"
}
```

**Google Gemini**
```json
{
  "claudeCode.provider": "gemini",
  "claudeCode.apiKey": "AIza...",
  "claudeCode.model": "gemini-2.5-flash"
}
```
