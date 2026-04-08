# Hooks

Hooks are event-driven automations that fire before or after Claude Code tool executions. They enforce code quality, catch mistakes early, and automate repetitive checks.

## How Hooks Work

```
User request -> Claude picks a tool -> PreToolUse hook runs -> Tool executes -> PostToolUse hook runs
```

- **PreToolUse** hooks run before the tool executes. They can **block** (exit code 2) or **warn** (stderr without blocking).
- **PostToolUse** hooks run after the tool completes. They can analyze output but cannot block.
- **Stop** hooks run after each Claude response.
- **SessionStart/SessionEnd** hooks run at session lifecycle boundaries.
- **PreCompact** hooks run before context compaction, useful for saving state.

## Hook Status in This Repo

The hooks in `hooks.json` reference scripts via `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/`. This variable resolves to the ECC (Everything Claude Code) plugin installation directory, which is **external to this repository**. The `scripts/hooks/` directory does not exist in this repo.

### Functional Hooks (self-contained -- no external scripts needed)

| ID | Event | Description | Notes |
|---|---|---|---|
| `pre:bash:block-no-verify` | PreToolUse (Bash) | Block git hook-bypass flags | Uses `npx block-no-verify@1.1.2` -- works if npm/npx is available |

### Hooks Requiring ECC Plugin (scripts not in this repo)

These hooks reference scripts under `${CLAUDE_PLUGIN_ROOT}/scripts/hooks/` which must be provided by the ECC plugin installation. They will **silently skip** or **fail** if the ECC plugin is not installed.

#### PreToolUse

| ID | Script Referenced | Description |
|---|---|---|
| `pre:bash:auto-tmux-dev` | `auto-tmux-dev.js` | Auto-start dev servers in tmux |
| `pre:bash:tmux-reminder` | `pre-bash-tmux-reminder.js` | Remind to use tmux for long-running commands |
| `pre:bash:git-push-reminder` | `pre-bash-git-push-reminder.js` | Review reminder before git push |
| `pre:bash:commit-quality` | `pre-bash-commit-quality.js` | Pre-commit quality checks (lint, secrets, format) |
| `pre:write:doc-file-warning` | `doc-file-warning.js` | Warn about non-standard documentation files |
| `pre:edit-write:suggest-compact` | `suggest-compact.js` | Suggest manual compaction at logical intervals |
| `pre:observe:continuous-learning` | `skills/continuous-learning-v2/hooks/observe.sh`* | Capture tool use observations (async) |
| `pre:governance-capture` | `governance-capture.js` | Capture governance events (requires `ECC_GOVERNANCE_CAPTURE=1`) |
| `pre:config-protection` | `config-protection.js` | Block modifications to linter/formatter configs |
| `pre:mcp-health-check` | `mcp-health-check.js` | Check MCP server health before tool execution |

\* The `observe.sh` script for continuous-learning-v2 exists at `.claude/skills/everything-claude-code/continuous-learning-v2/hooks/observe.sh` in this repo, but the `run-with-flags-shell.sh` wrapper that invokes it requires the ECC plugin root.

#### PreCompact

| ID | Script Referenced | Description |
|---|---|---|
| `pre:compact` | `pre-compact.js` | Save state before context compaction |

#### SessionStart

| ID | Script Referenced | Description |
|---|---|---|
| `session:start` | `session-start-bootstrap.js` | Load previous context and detect package manager |

#### PostToolUse

| ID | Script Referenced | Description |
|---|---|---|
| `post:bash:command-log-audit` | `post-bash-command-log.js` (audit) | Audit log all bash commands |
| `post:bash:command-log-cost` | `post-bash-command-log.js` (cost) | Cost tracker for bash tool usage |
| `post:bash:pr-created` | `post-bash-pr-created.js` | Log PR URL after PR creation |
| `post:bash:build-complete` | `post-bash-build-complete.js` | Async build analysis (background) |
| `post:quality-gate` | `quality-gate.js` | Quality gate checks after file edits |
| `post:edit:design-quality-check` | `design-quality-check.js` | Warn when UI edits drift toward generic templates |
| `post:edit:accumulator` | `post-edit-accumulator.js` | Record edited file paths for batch processing at Stop |
| `post:edit:console-warn` | `post-edit-console-warn.js` | Warn about console.log statements |
| `post:governance-capture` | `governance-capture.js` | Capture governance events from outputs |
| `post:observe:continuous-learning` | `skills/continuous-learning-v2/hooks/observe.sh` | Capture tool results for learning (async) |

#### PostToolUseFailure

| ID | Script Referenced | Description |
|---|---|---|
| `post:mcp-health-check` | `mcp-health-check.js` | Track failed MCP calls, attempt reconnect |

#### Stop

These hooks use inline `node -e "..."` scripts with embedded ECC plugin root discovery logic. They will attempt to auto-discover the plugin root from several candidate paths and fall back gracefully with a warning if not found.

| ID | Inner Script Referenced | Description |
|---|---|---|
| `stop:format-typecheck` | `stop-format-typecheck.js` | Batch format + typecheck all edited JS/TS files (timeout: 300s) |
| `stop:check-console-log` | `check-console-log.js` | Check modified files for console.log |
| `stop:session-end` | `session-end.js` | Persist session state (async) |
| `stop:evaluate-session` | `evaluate-session.js` | Extract patterns from session (async) |
| `stop:cost-tracker` | `cost-tracker.js` | Track token and cost metrics (async) |
| `stop:desktop-notify` | `desktop-notify.js` | Send desktop notification with task summary (async) |

#### SessionEnd

| ID | Inner Script Referenced | Description |
|---|---|---|
| `session:end:marker` | `session-end-marker.js` | Session end lifecycle marker (async) |

## Installing the ECC Plugin

To make all hooks functional, install the Everything Claude Code plugin. The hooks expect the plugin to be available at one of these paths:

- `$CLAUDE_PLUGIN_ROOT` (environment variable, if set)
- `~/.claude/` (if it contains `scripts/hooks/run-with-flags.js`)
- `~/.claude/plugins/ecc/`
- `~/.claude/plugins/everything-claude-code/`
- `~/.claude/plugins/marketplace/ecc/`
- `~/.claude/plugins/marketplace/everything-claude-code/`
- `~/.claude/plugins/cache/ecc/<org>/<version>/`
- `~/.claude/plugins/cache/everything-claude-code/<org>/<version>/`

## Customizing Hooks

### Disabling a Hook

Remove or comment out the hook entry in `hooks.json`. If installed as a plugin, override in your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [],
        "description": "Override: allow all .md file creation"
      }
    ]
  }
}
```

### Runtime Hook Controls (Recommended)

Use environment variables to control hook behavior without editing `hooks.json`:

```bash
# minimal | standard | strict (default: standard)
export ECC_HOOK_PROFILE=standard

# Disable specific hook IDs (comma-separated)
export ECC_DISABLED_HOOKS="pre:bash:tmux-reminder,post:edit:typecheck"
```

Profiles:
- `minimal` -- keep essential lifecycle and safety hooks only.
- `standard` -- default; balanced quality + safety checks.
- `strict` -- enables additional reminders and stricter guardrails.

### Writing Your Own Hook

Hooks are shell commands that receive tool input as JSON on stdin and must output JSON on stdout.

**Basic structure:**

```javascript
// my-hook.js
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(data);

  // Access tool info
  const toolName = input.tool_name;        // "Edit", "Bash", "Write", etc.
  const toolInput = input.tool_input;      // Tool-specific parameters
  const toolOutput = input.tool_output;    // Only available in PostToolUse

  // Warn (non-blocking): write to stderr
  console.error('[Hook] Warning message shown to Claude');

  // Block (PreToolUse only): exit with code 2
  // process.exit(2);

  // Always output the original data to stdout
  console.log(data);
});
```

**Exit codes:**
- `0` -- Success (continue execution)
- `2` -- Block the tool call (PreToolUse only)
- Other non-zero -- Error (logged but does not block)

### Hook Input Schema

```typescript
interface HookInput {
  tool_name: string;          // "Bash", "Edit", "Write", "Read", etc.
  tool_input: {
    command?: string;         // Bash: the command being run
    file_path?: string;       // Edit/Write/Read: target file
    old_string?: string;      // Edit: text being replaced
    new_string?: string;      // Edit: replacement text
    content?: string;         // Write: file content
  };
  tool_output?: {             // PostToolUse only
    output?: string;          // Command/tool output
  };
}
```

### Async Hooks

For hooks that should not block the main flow (e.g., background analysis):

```json
{
  "type": "command",
  "command": "node my-slow-hook.js",
  "async": true,
  "timeout": 30
}
```

Async hooks run in the background. They cannot block tool execution.

## Cross-Platform Notes

Hook logic is implemented in Node.js scripts for cross-platform behavior on Windows, macOS, and Linux. A small number of shell wrappers are retained for continuous-learning observer hooks; those wrappers are profile-gated and have Windows-safe fallback behavior.
