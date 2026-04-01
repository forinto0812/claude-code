# Claude Code 中文 Prompt 支持 - 进度文档

## 已完成 ✅

### Phase 1: 基础设施
- `src/utils/settings/types.ts` - 添加 `promptLanguage` 字段
- `src/utils/settings/promptLanguage.ts` - 语言检测工具

### Phase 2: 核心 Prompts
- `src/constants/prompts/content.ts` - 双语内容映射表
- `src/constants/prompts.ts` - 核心 prompts 全部函数

### Phase 4: 其他 Prompts
- `src/constants/cyberRiskInstruction.ts`
- `src/context.ts` (Git 状态)
- `src/utils/swarm/teammatePromptAddendum.ts`
- `src/utils/claudeInChrome/prompt.ts`
- `src/services/SessionMemory/prompts.ts`

## 跳过
- Tool prompts (`src/tools/*/prompt.ts`) - 内容复杂，保持英文
- memdir 文件 - 系统内部使用，XML 格式

## 使用方式

`~/.claude/settings.json`:
```json
{
  "promptLanguage": "chn"
}
```

## 注意事项
- Tool 名称保持英文 (Bash, Read, Edit)
- 技术术语保持原样 (API, JSON, CLI)
- 代码示例保持原样
