# Claude Code 中文 Prompt 支持 - 进度断点文档

## 已完成的工作

### Phase 1: 基础设施 ✅

1. **添加 `promptLanguage` 设置字段** (`src/utils/settings/types.ts`)
   - 在 SettingsSchema 中添加了 `promptLanguage` 字段
   - 类型: `z.enum(['eng', 'chn']).optional()`
   - 默认值为 'eng'

2. **创建 `promptLanguage.ts` 工具函数** (`src/utils/settings/promptLanguage.ts`)
   - `getPromptLanguage()`: 获取当前配置的 prompt 语言
   - `isChinesePrompt()`: 检查是否启用中文 prompt

### Phase 2: 核心 Prompts 国际化 (已完成 ✅)

1. **创建双语内容映射表** (`src/constants/prompts/content.ts`)
   - 实现了 `t()` 辅助函数用于根据语言选择内容
   - 已添加以下双语内容映射:
     - `INTRO_TEXT`: 介绍文本
     - `URL_INSTRUCTION`: URL 指令
     - `SYSTEM_SECTION_TITLE`: 系统部分标题
     - `SYSTEM_ITEMS`: 系统说明项
     - `DOING_TASKS_TITLE`: 执行任务标题
     - `DOING_TASKS_ITEMS`: 执行任务说明项
     - `ACTIONS_SECTION`: 谨慎执行操作部分
     - `TONE_AND_STYLE_TITLE`: 语气和风格标题
     - `TONE_AND_STYLE_ITEMS`: 语气和风格项
     - `OUTPUT_EFFICIENCY_SECTION`: 输出效率部分
     - `OUTPUT_EFFICIENCY_SECTION_ANT`: Ant用户输出效率部分
     - `USING_TOOLS_TITLE`: 使用工具标题
     - `USING_TOOLS_INTRO`: 使用工具介绍
     - `TOOL_PREFERENCE_ITEMS`: 工具偏好项
     - `DEFAULT_AGENT_PROMPT`: 默认代理 prompt
     - `SESSION_GUIDANCE_TITLE`: 会话指南标题
     - `SESSION_GUIDANCE_ITEMS`: 会话指南项
     - `LANGUAGE_SECTION`: 语言部分
     - `ENVIRONMENT_TITLE`: 环境标题
     - `ENVIRONMENT_INTRO`: 环境介绍
     - `ENVIRONMENT_ITEMS`: 环境项
     - `AGENT_TOOL_SECTION`: Agent 工具部分
     - `DISCOVER_SKILLS_GUIDANCE`: 技能发现指南
     - `SUMMARIZE_TOOL_RESULTS_SECTION`: 工具结果摘要部分
     - `FUNCTION_RESULT_CLEARING_SECTION`: 函数结果清除部分
     - `SCRATCHPAD_SECTION`: Scratchpad 部分
     - `MCP_INSTRUCTIONS_TITLE`: MCP 指令标题
     - `MCP_INSTRUCTIONS_INTRO`: MCP 指令介绍
     - `AGENT_NOTES`: Agent 增强注释

2. **修改 `prompts.ts` 使用双语内容** (已完成 ✅)
   - ✅ 添加了 `getPromptLanguage` 和 `PromptContent` 导入
   - ✅ 修改了 `getSimpleIntroSection()` 函数
   - ✅ 修改了 `getSimpleSystemSection()` 函数
   - ✅ 修改了 `getSimpleDoingTasksSection()` 函数 - 使用双语标题
   - ✅ 修改了 `getActionsSection()` 函数
   - ✅ 修改了 `getUsingYourToolsSection()` 函数
   - ✅ 修改了 `getSimpleToneAndStyleSection()` 函数
   - ✅ 修改了 `getOutputEfficiencySection()` 函数
   - ✅ 修改了 `getSessionSpecificGuidanceSection()` 函数 - 使用双语标题
   - ✅ 修改了 `computeSimpleEnvInfo()` 函数
   - ✅ 修改了 `getLanguageSection()` 函数
   - ✅ 修改了 `getScratchpadInstructions()` 函数
   - ✅ 修改了 `getFunctionResultClearingSection()` 函数
   - ✅ 修改了 `SUMMARIZE_TOOL_RESULTS_SECTION` 常量
   - ✅ 修改了 `enhanceSystemPromptWithEnvDetails()` 函数 - notes 部分
   - ✅ 修改了 `getAgentToolSection()` 函数
   - ✅ 修改了 `getDiscoverSkillsGuidance()` 函数

## 当前状态

**Phase 2 已完成！** 核心 `prompts.ts` 文件的所有函数都已更新为支持双语。语法错误已修复。

## 下一步计划

### Phase 3: Tool Prompts (进行中)

需要处理各个工具的 prompt 文件。已查看 `src/tools/BashTool/prompt.ts`，内容较长且复杂，包含：
- Git 提交和 PR 指令
- Sandbox 沙箱配置
- 简单 prompt 模板

**待处理的 Tool Prompts:**
- `src/tools/BashTool/prompt.ts` - 核心 Bash 工具，内容复杂（已查看）
- `src/tools/FileReadTool/prompt.ts`
- `src/tools/FileEditTool/prompt.ts`
- `src/tools/FileWriteTool/prompt.ts`
- `src/tools/GlobTool/prompt.ts`
- `src/tools/GrepTool/prompt.ts`
- `src/tools/AgentTool/prompt.ts`
- `src/tools/TodoWriteTool/prompt.ts`
- 其他 tools...

### Phase 4: 其他 Prompts

4. **处理其他零散 prompts**
   - `src/constants/cyberRiskInstruction.ts`
   - `src/utils/claudeInChrome/prompt.ts`
   - `src/utils/swarm/teammatePromptAddendum.ts`
   - `src/services/SessionMemory/prompts.ts`

### Phase 5: 测试与验证

5. **验证工作**
   - 修复所有 TypeScript 错误
   - 确保 bun run dev 能正常启动
   - 测试语言切换功能

## 配置使用方式

用户在 `~/.claude/settings.json` 或 `.claude/settings.json` 中添加:

```json
{
  "promptLanguage": "chn"
}
```

## 相关文件清单

### 已创建/修改的文件
- `src/utils/settings/types.ts` - 添加 promptLanguage 字段
- `src/utils/settings/promptLanguage.ts` - 语言检测工具 (新建)
- `src/constants/prompts/content.ts` - 双语内容映射 (新建)
- `src/constants/prompts.ts` - 核心 prompts 文件，所有函数已更新为双语支持

### 待处理的文件
- 所有 `src/tools/*/prompt.ts` 文件
- `src/constants/cyberRiskInstruction.ts`
- `src/utils/claudeInChrome/prompt.ts`
- `src/utils/swarm/teammatePromptAddendum.ts`
- `src/services/SessionMemory/prompts.ts`

## 注意事项

1. **保持 Tool Name 英文**: Tool 名称（如 Bash, Read, Edit）是标识符，保持英文不变
2. **向后兼容**: 默认语言为英文，不影响现有用户
3. **技术术语**: 如 bash, shell, API, JSON 等保持原样
4. **代码示例**: 代码块、命令示例保持原样

---

**断点位置**: Phase 3 准备开始，`src/tools/BashTool/prompt.ts` 已查看，内容较长需要仔细处理
**下次开始**: 开始处理 Tool Prompts，从 `BashTool/prompt.ts` 开始
