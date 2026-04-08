# Tool Implementation Status

Audit of `src/tools/*/` — which tools have real implementations vs stubs.

## Fully Implemented (38 tools)

| Tool | Feature Gate | Notes |
|------|-------------|-------|
| AgentTool | - | Core tool |
| AskUserQuestionTool | - | Core tool |
| BashTool | - | Core tool |
| BriefTool | - | Core tool |
| ConfigTool | USER_TYPE=ant | Anthropic-internal |
| EnterPlanModeTool | - | Core tool |
| EnterWorktreeTool | worktree mode | Requires env |
| ExitPlanModeTool | - | Core tool |
| ExitWorktreeTool | worktree mode | Requires env |
| FileEditTool | - | Core tool |
| FileReadTool | - | Core tool |
| FileWriteTool | - | Core tool |
| GlobTool | - | Core tool |
| GrepTool | - | Core tool |
| LSPTool | ENABLE_LSP_TOOL | Ready to enable |
| ListMcpResourcesTool | - | MCP integration |
| MCPTool | - | MCP integration |
| McpAuthTool | - | MCP auth |
| NotebookEditTool | - | Core tool |
| PowerShellTool | platform check | Windows only |
| REPLTool | USER_TYPE=ant | Anthropic-internal |
| ReadMcpResourceTool | - | MCP integration |
| RemoteTriggerTool | AGENT_TRIGGERS_REMOTE | Feature-gated |
| ScheduleCronTool | AGENT_TRIGGERS | Feature-gated |
| SendMessageTool | - | Agent comms |
| SkillTool | - | Core tool |
| SleepTool | PROACTIVE/KAIROS | Feature-gated |
| SyntheticOutputTool | - | Internal |
| TaskCreateTool | TODO_V2 | Task system |
| TaskGetTool | TODO_V2 | Task system |
| TaskListTool | TODO_V2 | Task system |
| TaskOutputTool | - | Task system |
| TaskStopTool | - | Task system |
| TaskUpdateTool | TODO_V2 | Task system |
| TeamCreateTool | agent swarms | Swarm feature |
| TeamDeleteTool | agent swarms | Swarm feature |
| TodoWriteTool | - | Core tool |
| ToolSearchTool | tool search | Core tool |
| WebFetchTool | - | Core tool |
| WebSearchTool | - | Core tool |

## Stub Only (11 tools)

These have placeholder files but no real implementation.

| Tool | Feature Gate | Has |
|------|-------------|-----|
| DiscoverSkillsTool | - | Stub export only |
| MonitorTool | MONITOR_TOOL | Stub export only |
| OverflowTestTool | OVERFLOW_TEST_TOOL | Stub export only |
| ReviewArtifactTool | - | Stub export only |
| SendUserFileTool | KAIROS | Stub export only |
| SnipTool | HISTORY_SNIP | prompt.ts only |
| TerminalCaptureTool | TERMINAL_PANEL | prompt.ts only |
| TungstenTool | - | Stub (ant-internal) |
| VerifyPlanExecutionTool | CLAUDE_CODE_VERIFY_PLAN | Stub export only |
| WebBrowserTool | WEB_BROWSER_TOOL | Panel stub only |
| WorkflowTool | WORKFLOW_SCRIPTS | Stub + constants |

## Empty Directories

| Directory | Notes |
|-----------|-------|
| SuggestBackgroundPRTool | No files (ant-only) |

## Feature Flag Configuration

Use `CLAUDE_FEATURE_FLAGS` env var (comma-separated) to enable runtime flags.
Use `-FLAG` prefix to explicitly disable a default flag.

```bash
# Enable LSP tool
ENABLE_LSP_TOOL=1 bun run dev

# Enable worktree mode
CLAUDE_WORKTREE_MODE=1 bun run dev
```
