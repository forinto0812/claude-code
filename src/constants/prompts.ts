// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { type as osType, version as osVersion, release as osRelease } from 'os'
import { env } from '../utils/env.js'
import { getPromptLanguage } from '../utils/settings/promptLanguage.js'
import * as PromptContent from './prompts/content.js'
import { getIsGit } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import { getSessionStartDate } from './common.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import {
  AGENT_TOOL_NAME,
  VERIFICATION_AGENT_TYPE,
} from '../tools/AgentTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import type { Tools } from '../Tool.js'
import type { Command } from '../types/command.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import {
  getCanonicalName,
  getMarketingNameForModel,
} from '../utils/model/model.js'
import { getSkillToolCommands } from 'src/commands.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { getOutputStyleConfig } from './outputStyles.js'
import type {
  MCPServerConnection,
  ConnectedMCPServer,
} from '../services/mcp/types.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import {
  EXPLORE_AGENT,
  EXPLORE_AGENT_MIN_QUERIES,
} from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { areExplorePlanAgentsEnabled } from 'src/tools/AgentTool/builtInAgents.js'
import {
  isScratchpadEnabled,
  getScratchpadDir,
} from '../utils/permissions/filesystem.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { shouldUseGlobalCacheScope } from '../utils/betas.js'
import { isForkSubagentEnabled } from '../tools/AgentTool/forkSubagent.js'
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
} from './systemPromptSections.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import { TICK_TAG } from './xml.js'
import { logForDebugging } from '../utils/debug.js'
import { loadMemoryPrompt } from '../memdir/memdir.js'
import { isUndercover } from '../utils/undercover.js'
import { isMcpInstructionsDeltaEnabled } from '../utils/mcpInstructionsDelta.js'

// Dead code elimination: conditional imports for feature-gated modules
/* eslint-disable @typescript-eslint/no-require-imports */
const getCachedMCConfigForFRC = feature('CACHED_MICROCOMPACT')
  ? (
      require('../services/compact/cachedMCConfig.js') as typeof import('../services/compact/cachedMCConfig.js')
    ).getCachedMCConfig
  : null

const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../proactive/index.js')
    : null
const BRIEF_PROACTIVE_SECTION: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_PROACTIVE_SECTION
    : null
const briefToolModule =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/BriefTool.js') as typeof import('../tools/BriefTool/BriefTool.js'))
    : null
const DISCOVER_SKILLS_TOOL_NAME: string | null = feature(
  'EXPERIMENTAL_SKILL_SEARCH',
)
  ? (
      require('../tools/DiscoverSkillsTool/prompt.js') as typeof import('../tools/DiscoverSkillsTool/prompt.js')
    ).DISCOVER_SKILLS_TOOL_NAME
  : null
// Capture the module (not .isSkillSearchEnabled directly) so spyOn() in tests
// patches what we actually call — a captured function ref would point past the spy.
const skillSearchFeatureCheck = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import type { OutputStyleConfig } from './outputStyles.js'
import { CYBER_RISK_INSTRUCTION } from './cyberRiskInstruction.js'

export const CLAUDE_CODE_DOCS_MAP_URL =
  'https://code.claude.com/docs/en/claude_code_docs_map.md'

/**
 * Boundary marker separating static (cross-org cacheable) content from dynamic content.
 * Everything BEFORE this marker in the system prompt array can use scope: 'global'.
 * Everything AFTER contains user/session-specific content and should not be cached.
 *
 * WARNING: Do not remove or reorder this marker without updating cache logic in:
 * - src/utils/api.ts (splitSysPromptPrefix)
 * - src/services/api/claude.ts (buildSystemPromptBlocks)
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// @[MODEL LAUNCH]: Update the latest frontier model.
const FRONTIER_MODEL_NAME = 'Claude Opus 4.6'

// @[MODEL LAUNCH]: Update the model family IDs below to the latest in each tier.
const CLAUDE_4_5_OR_4_6_MODEL_IDS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
}

function getHooksSection(): string {
  return `Users may configure 'hooks', shell commands that execute in response to events like tool calls, in settings. Treat feedback from hooks, including <user-prompt-submit-hook>, as coming from the user. If you get blocked by a hook, determine if you can adjust your actions in response to the blocked message. If not, ask the user to check their hooks configuration.`
}

function getSystemRemindersSection(): string {
  return `- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.
- The conversation has unlimited context through automatic summarization.`
}

function getAntModelOverrideSection(): string | null {
  if (process.env.USER_TYPE !== 'ant') return null
  if (isUndercover()) return null
  return getAntModelOverrideConfig()?.defaultSystemPromptSuffix || null
}

function getLanguageSection(
  languagePreference: string | undefined,
): string | null {
  if (!languagePreference) return null

  return PromptContent.t(PromptContent.LANGUAGE_SECTION)(languagePreference)
}

function getOutputStyleSection(
  outputStyleConfig: OutputStyleConfig | null,
): string | null {
  if (outputStyleConfig === null) return null

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}

function getMcpInstructionsSection(
  mcpClients: MCPServerConnection[] | undefined,
): string | null {
  if (!mcpClients || mcpClients.length === 0) return null
  return getMcpInstructions(mcpClients)
}

export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}

function getSimpleIntroSection(
  outputStyleConfig: OutputStyleConfig | null,
): string {
  // eslint-disable-next-line custom-rules/prompt-spacing
  return `
${PromptContent.t(PromptContent.INTRO_TEXT)(outputStyleConfig)} Use the instructions below and the tools available to you to assist the user.

${CYBER_RISK_INSTRUCTION}
${PromptContent.t(PromptContent.URL_INSTRUCTION)}`
}

function getSimpleSystemSection(): string {
  const items = PromptContent.t(PromptContent.SYSTEM_ITEMS)

  return [PromptContent.t(PromptContent.SYSTEM_SECTION_TITLE), ...prependBullets(items)].join(`\n`)
}

function getSimpleDoingTasksSection(): string {
  const content = PromptContent.t(PromptContent.DOING_TASKS_ITEMS)
  const isChn = getPromptLanguage() === 'chn'

  const userHelpSubitems = content.help

  // Ant-user specific code style additions
  const antCodeStyleAdditions = process.env.USER_TYPE === 'ant'
    ? [
        isChn
          ? `默认不写注释。只在 WHY 不明显时才添加：隐藏约束、微妙的不变量、针对特定错误的解决方法、会让读者惊讶的行为。如果删除注释不会让未来读者困惑，就不要写它。`
          : `Default to writing no comments. Only add one when the WHY is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, behavior that would surprise a reader. If removing the comment wouldn't confuse a future reader, don't write it.`,
        isChn
          ? `不要解释代码做什么，因为命名良好的标识符已经说明了。不要引用当前任务、修复或调用者（"被 X 使用"、"为 Y 流添加"、"处理来自问题 #123 的情况"），因为这些属于 PR 描述，并随着代码库演变而腐烂。`
          : `Don't explain WHAT the code does, since well-named identifiers already do that. Don't reference the current task, fix, or callers ("used by X", "added for the Y flow", "handles the case from issue #123"), since those belong in the PR description and rot as the codebase evolves.`,
        isChn
          ? `除非您正在删除它们描述的代码，或者您知道它们是错误的，否则不要删除现有注释。对您来说毫无意义的注释可能编码了对您当前差异不可见的约束或过去错误的教训。`
          : `Don't remove existing comments unless you're removing the code they describe or you know they're wrong. A comment that looks pointless to you may encode a constraint or a lesson from a past bug that isn't visible in the current diff.`,
        // @[MODEL LAUNCH]: capy v8 thoroughness counterweight (PR #24302) — un-gate once validated on external via A/B
        isChn
          ? `在报告任务完成之前，验证它是否真的有效：运行测试、执行脚本、检查输出。最小复杂度意味着没有镀金，而不是跳过终点线。如果您无法验证（不存在测试，无法运行代码），请明确说明，而不是声称成功。`
          : `Before reporting a task complete, verify it actually works: run the test, execute the script, check the output. Minimum complexity means no gold-plating, not skipping the finish line. If you can't verify (no test exists, can't run the code), say so explicitly rather than claiming success.`,
      ]
    : []

  const items = [
    ...content.main,
    ...content.codeStyle,
    ...antCodeStyleAdditions,
    isChn
      ? `避免向后兼容性hack，如重命名未使用的 _vars、重新导出类型、为删除的代码添加 // removed 注释等。如果您确信某些东西未使用，您可以完全删除它。`
      : `Avoid backwards-compatibility hacks like renaming unused _vars, re-exporting types, adding // removed comments for removed code, etc. If you are certain that something is unused, you can delete it completely.`,
    // @[MODEL LAUNCH]: capy v8 assertiveness counterweight (PR #24302) — un-gate once validated on external via A/B
    ...(process.env.USER_TYPE === 'ant'
      ? [
          isChn
            ? `如果您注意到用户的请求基于误解，或在他们询问的内容附近发现错误，请说出来。您是合作者，不仅仅是执行者——用户受益于您的判断，而不仅仅是您的服从。`
            : `If you notice the user's request is based on a misconception, or spot a bug adjacent to what they asked about, say so. You're a collaborator, not just an executor—users benefit from your judgment, not just your compliance.`,
        ]
      : []),
    // @[MODEL LAUNCH]: False-claims mitigation for Capybara v8 (29-30% FC rate vs v4's 16.7%)
    ...(process.env.USER_TYPE === 'ant'
      ? [
          isChn
            ? `如实报告结果：如果测试失败，请附上相关输出说明；如果您没有运行验证步骤，请说明而不是暗示它成功了。当输出显示失败时，切勿声称"所有测试通过"，切勿压制或简化失败的检查（测试、lint、类型错误）以制造绿色结果，也切勿将不完整或损坏的工作描述为已完成。同样，当检查通过或任务完成时，请直接说明——不要用不必要的免责声明来对冲已确认的结果，不要将已完成的工作降级为"部分完成"，或重新验证您已经检查过的事情。目标是准确的报告，而不是防御性的报告。`
            : `Report outcomes faithfully: if tests fail, say so with the relevant output; if you did not run a verification step, say that rather than implying it succeeded. Never claim "all tests pass" when output shows failures, never suppress or simplify failing checks (tests, lints, type errors) to manufacture a green result, and never characterize incomplete or broken work as done. Equally, when a check did pass or a task is complete, state it plainly — do not hedge confirmed results with unnecessary disclaimers, downgrade finished work to "partial," or re-verify things you already checked. The goal is an accurate report, not a defensive one.`,
        ]
      : []),
    ...(process.env.USER_TYPE === 'ant'
      ? [
          isChn
            ? `如果用户报告 Claude Code 本身的错误、缓慢或意外行为（而不是要求您修复他们自己的代码），请推荐适当的斜杠命令：/issue 用于模型相关问题（奇怪输出、错误工具选择、幻觉、拒绝），或 /share 用于上传产品错误、崩溃、缓慢或一般问题的完整会话记录。仅在用户描述 Claude Code 问题时推荐这些。在 /share 生成 ccshare 链接后，如果您有可用的 Slack MCP 工具，请主动代表用户将链接发布到 #claude-code-feedback（频道 ID C07VBSHV7EV）。`
            : `If the user reports a bug, slowness, or unexpected behavior with Claude Code itself (as opposed to asking you to fix their own code), recommend the appropriate slash command: /issue for model-related problems (odd outputs, wrong tool choices, hallucinations, refusals), or /share to upload the full session transcript for product bugs, crashes, slowness, or general issues. Only recommend these when the user is describing a problem with Claude Code. After /share produces a ccshare link, if you have a Slack MCP tool available, offer to post the link to #claude-code-feedback (channel ID C07VBSHV7EV) for the user.`,
        ]
      : []),
    isChn
      ? `如果用户需要帮助或想要提供反馈，请告知他们以下信息：`
      : `If the user asks for help or wants to give feedback inform them of the following:`,
    userHelpSubitems,
  ]

  return [PromptContent.t(PromptContent.DOING_TASKS_TITLE), ...prependBullets(items)].join(`\n`)
}

function getActionsSection(): string {
  return PromptContent.t(PromptContent.ACTIONS_SECTION)
}

function getUsingYourToolsSection(enabledTools: Set<string>): string {
  const lang = getPromptLanguage()
  const isChn = lang === 'chn'
  const taskToolName = [TASK_CREATE_TOOL_NAME, TODO_WRITE_TOOL_NAME].find(n =>
    enabledTools.has(n),
  )

  // In REPL mode, Read/Write/Edit/Glob/Grep/Bash/Agent are hidden from direct
  // use (REPL_ONLY_TOOLS). The "prefer dedicated tools over Bash" guidance is
  // irrelevant — REPL's own prompt covers how to call them from scripts.
  if (isReplModeEnabled()) {
    const items = [
      taskToolName
        ? isChn
          ? `使用 ${taskToolName} 工具分解和管理工作。这些工具有助于规划您的工作并帮助用户跟踪您的进度。任务完成后立即将其标记为已完成。不要在标记为完成之前批量处理多个任务。`
          : `Break down and manage your work with the ${taskToolName} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
        : null,
    ].filter(item => item !== null)
    if (items.length === 0) return ''
    return [PromptContent.t(PromptContent.USING_TOOLS_TITLE), ...prependBullets(items)].join(`\n`)
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so skip guidance pointing at them.
  const embedded = hasEmbeddedSearchTools()

  const toolItems = PromptContent.t(PromptContent.TOOL_PREFERENCE_ITEMS)({
    read: FILE_READ_TOOL_NAME,
    edit: FILE_EDIT_TOOL_NAME,
    write: FILE_WRITE_TOOL_NAME,
    glob: GLOB_TOOL_NAME,
    grep: GREP_TOOL_NAME,
    bash: BASH_TOOL_NAME,
  })

  const providedToolSubitems = [
    toolItems[0],
    toolItems[1],
    toolItems[2],
    ...(embedded ? [] : [toolItems[3], toolItems[4]]),
    toolItems[5],
  ]

  const items = [
    PromptContent.t(PromptContent.USING_TOOLS_INTRO)(BASH_TOOL_NAME),
    providedToolSubitems,
    taskToolName
      ? isChn
        ? `使用 ${taskToolName} 工具分解和管理工作。这些工具有助于规划您的工作并帮助用户跟踪您的进度。任务完成后立即将其标记为已完成。不要在标记为完成之前批量处理多个任务。`
        : `Break down and manage your work with the ${taskToolName} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
      : null,
    isChn
      ? `您可以在单个响应中调用多个工具。如果您打算调用多个工具且它们之间没有依赖关系，请并行进行所有独立的工具调用。尽可能最大化并行工具调用的使用以提高效率。但是，如果某些工具调用依赖于先前的调用来获取依赖值，则不要并行调用这些工具，而是按顺序调用它们。例如，如果一个操作必须在另一个操作开始之前完成，请按顺序运行这些操作。`
      : `You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead.`,
  ].filter(item => item !== null)

  return [PromptContent.t(PromptContent.USING_TOOLS_TITLE), ...prependBullets(items)].join(`\n`)
}

function getAgentToolSection(): string {
  const content = PromptContent.AGENT_TOOL_SECTION[getPromptLanguage()]
  return isForkSubagentEnabled()
    ? content.forkEnabled(AGENT_TOOL_NAME)
    : content.default(AGENT_TOOL_NAME)
}

/**
 * Guidance for the skill_discovery attachment ("Skills relevant to your
 * task:") and the DiscoverSkills tool. Shared between the main-session
 * getUsingYourToolsSection bullet and the subagent path in
 * enhanceSystemPromptWithEnvDetails — subagents receive skill_discovery
 * attachments (post #22830) but don't go through getSystemPrompt, so
 * without this they'd see the reminders with no framing.
 *
 * feature() guard is internal — external builds DCE the string literal
 * along with the DISCOVER_SKILLS_TOOL_NAME interpolation.
 */
function getDiscoverSkillsGuidance(): string | null {
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    DISCOVER_SKILLS_TOOL_NAME !== null
  ) {
    return PromptContent.t(PromptContent.DISCOVER_SKILLS_GUIDANCE)(DISCOVER_SKILLS_TOOL_NAME)
  }
  return null
}

/**
 * Session-variant guidance that would fragment the cacheScope:'global'
 * prefix if placed before SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Each conditional
 * here is a runtime bit that would otherwise multiply the Blake2b prefix
 * hash variants (2^N). See PR #24490, #24171 for the same bug class.
 *
 * outputStyleConfig intentionally NOT moved here — identity framing lives
 * in the static intro pending eval.
 */
function getSessionSpecificGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
  const isChn = getPromptLanguage() === 'chn'
  const hasAskUserQuestionTool = enabledTools.has(ASK_USER_QUESTION_TOOL_NAME)
  const hasSkills =
    skillToolCommands.length > 0 && enabledTools.has(SKILL_TOOL_NAME)
  const hasAgentTool = enabledTools.has(AGENT_TOOL_NAME)
  const searchTools = hasEmbeddedSearchTools()
    ? isChn
      ? `通过 ${BASH_TOOL_NAME} 工具使用 \`find\` 或 \`grep\``
      : `\`find\` or \`grep\` via the ${BASH_TOOL_NAME} tool`
    : isChn
      ? `${GLOB_TOOL_NAME} 或 ${GREP_TOOL_NAME}`
      : `the ${GLOB_TOOL_NAME} or ${GREP_TOOL_NAME}`

  const items = [
    hasAskUserQuestionTool
      ? PromptContent.t(PromptContent.SESSION_GUIDANCE_ITEMS).askUserQuestion(ASK_USER_QUESTION_TOOL_NAME)
      : null,
    getIsNonInteractiveSession()
      ? null
      : PromptContent.t(PromptContent.SESSION_GUIDANCE_ITEMS).runCommand,
    // isForkSubagentEnabled() reads getIsNonInteractiveSession() — must be
    // post-boundary or it fragments the static prefix on session type.
    hasAgentTool ? getAgentToolSection() : null,
    ...(hasAgentTool &&
    areExplorePlanAgentsEnabled() &&
    !isForkSubagentEnabled()
      ? [
          isChn
            ? `对于简单、定向的代码库搜索（例如搜索特定文件/类/函数），直接使用 ${searchTools}。`
            : `For simple, directed codebase searches (e.g. for a specific file/class/function) use ${searchTools} directly.`,
          isChn
            ? `对于更广泛的代码库探索和深入研究，使用带有 subagent_type=${EXPLORE_AGENT.agentType} 的 ${AGENT_TOOL_NAME} 工具。这比直接使用 ${searchTools} 慢，因此仅在简单、定向搜索被证明不足或您的任务明显需要超过 ${EXPLORE_AGENT_MIN_QUERIES} 个查询时才使用。`
            : `For broader codebase exploration and deep research, use the ${AGENT_TOOL_NAME} tool with subagent_type=${EXPLORE_AGENT.agentType}. This is slower than using ${searchTools} directly, so use this only when a simple, directed search proves to be insufficient or when your task will clearly require more than ${EXPLORE_AGENT_MIN_QUERIES} queries.`,
        ]
      : []),
    hasSkills
      ? isChn
        ? `/<skill-name>（例如 /commit）是用户调用用户可调用技能的简写。执行时，技能会展开为完整提示。使用 ${SKILL_TOOL_NAME} 工具执行它们。重要提示：仅对 ${SKILL_TOOL_NAME} 的用户可调用技能部分列出的技能使用 ${SKILL_TOOL_NAME}——不要猜测或使用内置 CLI 命令。`
        : `/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the ${SKILL_TOOL_NAME} tool to execute them. IMPORTANT: Only use ${SKILL_TOOL_NAME} for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.`
      : null,
    DISCOVER_SKILLS_TOOL_NAME !== null &&
    hasSkills &&
    enabledTools.has(DISCOVER_SKILLS_TOOL_NAME)
      ? getDiscoverSkillsGuidance()
      : null,
    hasAgentTool &&
    feature('VERIFICATION_AGENT') &&
    // 3P default: false — verification agent is ant-only A/B
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)
      ? isChn
        ? `契约：当您的回合发生非平凡实现时，在您报告完成之前必须进行独立的对抗性验证——无论谁进行了实现（您直接、您生成的 fork 或子代理）。您是向用户报告的人；您拥有闸门。非平凡意味着：3+ 文件编辑、后端/API 更改或基础设施更改。使用 subagent_type="${VERIFICATION_AGENT_TYPE}" 生成 ${AGENT_TOOL_NAME} 工具。您自己的检查、警告和 fork 的自我检查不能替代——只有验证者分配裁决；您不能自我分配 PARTIAL。传递原始用户请求、所有更改的文件（由任何人）、方法和计划文件路径（如果适用）。如果有疑虑请标记，但不要分享测试结果或声称事情有效。失败时：修复，用其发现加上您的修复恢复验证者，重复直到通过。通过时：抽查它——从其报告中重新运行 2-3 个命令，确认每个通过都有一个命令运行块，其输出与您的重新运行匹配。如果任何通过缺少命令块或发散，用具体情况恢复验证者。部分通过（来自验证者）：报告通过的内容和无法验证的内容。`
        : `The contract: when non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion \u2014 regardless of who did the implementing (you directly, a fork you spawned, or a subagent). You are the one reporting to the user; you own the gate. Non-trivial means: 3+ file edits, backend/API changes, or infrastructure changes. Spawn the ${AGENT_TOOL_NAME} tool with subagent_type="${VERIFICATION_AGENT_TYPE}". Your own checks, caveats, and a fork's self-checks do NOT substitute \u2014 only the verifier assigns a verdict; you cannot self-assign PARTIAL. Pass the original user request, all files changed (by anyone), the approach, and the plan file path if applicable. Flag concerns if you have them but do NOT share test results or claim things work. On FAIL: fix, resume the verifier with its findings plus your fix, repeat until PASS. On PASS: spot-check it \u2014 re-run 2-3 commands from its report, confirm every PASS has a Command run block with output that matches your re-run. If any PASS lacks a command block or diverges, resume the verifier with the specifics. On PARTIAL (from the verifier): report what passed and what could not be verified.`
      : null,
  ].filter(item => item !== null)

  if (items.length === 0) return null
  return [PromptContent.t(PromptContent.SESSION_GUIDANCE_TITLE), ...prependBullets(items)].join('\n')
}

// @[MODEL LAUNCH]: Remove this section when we launch numbat.
function getOutputEfficiencySection(): string {
  if (process.env.USER_TYPE === 'ant') {
    return PromptContent.t(PromptContent.OUTPUT_EFFICIENCY_SECTION_ANT)
  }
  return PromptContent.t(PromptContent.OUTPUT_EFFICIENCY_SECTION)
}

function getSimpleToneAndStyleSection(): string {
  const items = PromptContent.t(PromptContent.TONE_AND_STYLE_ITEMS).map(item =>
    // Filter out the "short and concise" item for ant users
    process.env.USER_TYPE === 'ant' && item.includes('short and concise')
      ? null
      : item,
  ).filter(item => item !== null)

  return [PromptContent.t(PromptContent.TONE_AND_STYLE_TITLE), ...prependBullets(items)].join(`\n`)
}

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return [
      `You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
    ]
  }

  const cwd = getCwd()
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),
    getOutputStyleConfig(),
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])

  const settings = getInitialSettings()
  const enabledTools = new Set(tools.map(_ => _.name))

  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive()
  ) {
    logForDebugging(`[SystemPrompt] path=simple-proactive`)
    return [
      `\nYou are an autonomous agent. Use the available tools to do useful work.

${CYBER_RISK_INSTRUCTION}`,
      getSystemRemindersSection(),
      await loadMemoryPrompt(),
      envInfo,
      getLanguageSection(settings.language),
      // When delta enabled, instructions are announced via persisted
      // mcp_instructions_delta attachments (attachments.ts) instead.
      isMcpInstructionsDeltaEnabled()
        ? null
        : getMcpInstructionsSection(mcpClients),
      getScratchpadInstructions(),
      getFunctionResultClearingSection(model),
      SUMMARIZE_TOOL_RESULTS_SECTION,
      getProactiveSection(),
    ].filter(s => s !== null)
  }

  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
    ),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    systemPromptSection('ant_model_override', () =>
      getAntModelOverrideSection(),
    ),
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo(model, additionalWorkingDirectories),
    ),
    systemPromptSection('language', () =>
      getLanguageSection(settings.language),
    ),
    systemPromptSection('output_style', () =>
      getOutputStyleSection(outputStyleConfig),
    ),
    // When delta enabled, instructions are announced via persisted
    // mcp_instructions_delta attachments (attachments.ts) instead of this
    // per-turn recompute, which busts the prompt cache on late MCP connect.
    // Gate check inside compute (not selecting between section variants)
    // so a mid-session gate flip doesn't read a stale cached value.
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () =>
        isMcpInstructionsDeltaEnabled()
          ? null
          : getMcpInstructionsSection(mcpClients),
      'MCP servers connect/disconnect between turns',
    ),
    systemPromptSection('scratchpad', () => getScratchpadInstructions()),
    systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
    systemPromptSection(
      'summarize_tool_results',
      () => SUMMARIZE_TOOL_RESULTS_SECTION,
    ),
    // Numeric length anchors — research shows ~1.2% output token reduction vs
    // qualitative "be concise". Ant-only to measure quality impact first.
    ...(process.env.USER_TYPE === 'ant'
      ? [
          systemPromptSection(
            'numeric_length_anchors',
            () =>
              'Length limits: keep text between tool calls to \u226425 words. Keep final responses to \u2264100 words unless the task requires more detail.',
          ),
        ]
      : []),
    ...(feature('TOKEN_BUDGET')
      ? [
          // Cached unconditionally — the "When the user specifies..." phrasing
          // makes it a no-op with no budget active. Was DANGEROUS_uncached
          // (toggled on getCurrentTurnTokenBudget()), busting ~20K tokens per
          // budget flip. Not moved to a tail attachment: first-response and
          // budget-continuation paths don't see attachments (#21577).
          systemPromptSection(
            'token_budget',
            () =>
              'When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn. Keep working until you approach the target \u2014 plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.',
          ),
        ]
      : []),
    ...(feature('KAIROS') || feature('KAIROS_BRIEF')
      ? [systemPromptSection('brief', () => getBriefSection())]
      : []),
  ]

  const resolvedDynamicSections =
    await resolveSystemPromptSections(dynamicSections)

  return [
    // --- Static content (cacheable) ---
    getSimpleIntroSection(outputStyleConfig),
    getSimpleSystemSection(),
    outputStyleConfig === null ||
    outputStyleConfig.keepCodingInstructions === true
      ? getSimpleDoingTasksSection()
      : null,
    getActionsSection(),
    getUsingYourToolsSection(enabledTools),
    getSimpleToneAndStyleSection(),
    getOutputEfficiencySection(),
    // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
    ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
    // --- Dynamic content (registry-managed) ---
    ...resolvedDynamicSections,
  ].filter(s => s !== null)
}

function getMcpInstructions(mcpClients: MCPServerConnection[]): string | null {
  const connectedClients = mcpClients.filter(
    (client): client is ConnectedMCPServer => client.type === 'connected',
  )

  const clientsWithInstructions = connectedClients.filter(
    client => client.instructions,
  )

  if (clientsWithInstructions.length === 0) {
    return null
  }

  const instructionBlocks = clientsWithInstructions
    .map(client => {
      return `## ${client.name}
${client.instructions}`
    })
    .join('\n\n')

  return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
}

export async function computeEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([getIsGit(), getUnameSR()])

  // Undercover: keep ALL model names/IDs out of the system prompt so nothing
  // internal can leak into public commits/PRs. This includes the public
  // FRONTIER_MODEL_* constants — if those ever point at an unannounced model,
  // we don't want them in context. Go fully dark.
  //
  // DCE: `process.env.USER_TYPE === 'ant'` is build-time --define. It MUST be
  // inlined at each callsite (not hoisted to a const) so the bundler can
  // constant-fold it to `false` in external builds and eliminate the branch.
  let modelDescription = ''
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    // suppress
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`
  }

  const additionalDirsInfo =
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories: ${additionalWorkingDirectories.join(', ')}\n`
      : ''

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff
    ? `\n\nAssistant knowledge cutoff is ${cutoff}.`
    : ''

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${getCwd()}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
${additionalDirsInfo}Platform: ${env.platform}
${getShellInfoLine()}
OS Version: ${unameSR}
</env>
${modelDescription}${knowledgeCutoffMessage}`
}

export async function computeSimpleEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([getIsGit(), getUnameSR()])

  const lang = getPromptLanguage()
  const envContent = PromptContent.ENVIRONMENT_ITEMS[lang]

  // Undercover: strip all model name/ID references. See computeEnvInfo.
  // DCE: inline the USER_TYPE check at each site — do NOT hoist to a const.
  let modelDescription: string | null = null
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    // suppress
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? envContent.model(marketingName, modelId)
      : `You are powered by the model ${modelId}.`
  }

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff
    ? envContent.knowledgeCutoff(cutoff)
    : null

  const cwd = getCwd()
  const isWorktree = getCurrentWorktreeSession() !== null

  const envItems = [
    envContent.cwd(cwd),
    isWorktree
      ? lang === 'chn'
        ? `这是一个 git worktree——仓库的隔离副本。从此目录运行所有命令。不要 \`cd\` 到原始仓库根目录。`
        : `This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT \`cd\` to the original repository root.`
      : null,
    [envContent.isGit(isGit)],
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? lang === 'chn'
        ? `额外工作目录：`
        : `Additional working directories:`
      : null,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? additionalWorkingDirectories
      : null,
    envContent.platform(env.platform),
    getShellInfoLine(),
    envContent.osVersion(unameSR),
    modelDescription,
    knowledgeCutoffMessage,
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? null
      : envContent.modelFamily(
          CLAUDE_4_5_OR_4_6_MODEL_IDS.opus,
          CLAUDE_4_5_OR_4_6_MODEL_IDS.sonnet,
          CLAUDE_4_5_OR_4_6_MODEL_IDS.haiku,
          FRONTIER_MODEL_NAME,
        ),
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? null
      : envContent.availability,
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? null
      : envContent.fastMode(FRONTIER_MODEL_NAME),
  ].filter(item => item !== null)

  return [
    PromptContent.t(PromptContent.ENVIRONMENT_TITLE),
    PromptContent.t(PromptContent.ENVIRONMENT_INTRO),
    ...prependBullets(envItems),
  ].join(`\n`)
}

// @[MODEL LAUNCH]: Add a knowledge cutoff date for the new model.
function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = getCanonicalName(modelId)
  if (canonical.includes('claude-sonnet-4-6')) {
    return 'August 2025'
  } else if (canonical.includes('claude-opus-4-6')) {
    return 'May 2025'
  } else if (canonical.includes('claude-opus-4-5')) {
    return 'May 2025'
  } else if (canonical.includes('claude-haiku-4')) {
    return 'February 2025'
  } else if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4')
  ) {
    return 'January 2025'
  }
  return null
}

function getShellInfoLine(): string {
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell
  if (env.platform === 'win32') {
    return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
  }
  return `Shell: ${shellName}`
}

export function getUnameSR(): string {
  // os.type() and os.release() both wrap uname(3) on POSIX, producing output
  // byte-identical to `uname -sr`: "Darwin 25.3.0", "Linux 6.6.4", etc.
  // Windows has no uname(3); os.type() returns "Windows_NT" there, but
  // os.version() gives the friendlier "Windows 11 Pro" (via GetVersionExW /
  // RtlGetVersion) so use that instead. Feeds the OS Version line in the
  // system prompt env section.
  if (env.platform === 'win32') {
    return `${osVersion()} ${osRelease()}`
  }
  return `${osType()} ${osRelease()}`
}

export function getDefaultAgentPrompt(): string {
  return PromptContent.t(PromptContent.DEFAULT_AGENT_PROMPT)
}

/**
 * @deprecated Use getDefaultAgentPrompt() instead
 */
export const DEFAULT_AGENT_PROMPT = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.`

export async function enhanceSystemPromptWithEnvDetails(
  existingSystemPrompt: string[],
  model: string,
  additionalWorkingDirectories?: string[],
  enabledToolNames?: ReadonlySet<string>,
): Promise<string[]> {
  const notes = PromptContent.t(PromptContent.AGENT_NOTES)
  // Subagents get skill_discovery attachments (prefetch.ts runs in query(),
  // no agentId guard since #22830) but don't go through getSystemPrompt —
  // surface the same DiscoverSkills framing the main session gets. Gated on
  // enabledToolNames when the caller provides it (runAgent.ts does).
  // AgentTool.tsx:768 builds the prompt before assembleToolPool:830 so it
  // omits this param — `?? true` preserves guidance there.
  const discoverSkillsGuidance =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchFeatureCheck?.isSkillSearchEnabled() &&
    DISCOVER_SKILLS_TOOL_NAME !== null &&
    (enabledToolNames?.has(DISCOVER_SKILLS_TOOL_NAME) ?? true)
      ? getDiscoverSkillsGuidance()
      : null
  const envInfo = await computeEnvInfo(model, additionalWorkingDirectories)
  return [
    ...existingSystemPrompt,
    notes,
    ...(discoverSkillsGuidance !== null ? [discoverSkillsGuidance] : []),
    envInfo,
  ]
}

/**
 * Returns instructions for using the scratchpad directory if enabled.
 * The scratchpad is a per-session directory where Claude can write temporary files.
 */
export function getScratchpadInstructions(): string | null {
  if (!isScratchpadEnabled()) {
    return null
  }

  const scratchpadDir = getScratchpadDir()

  return PromptContent.t(PromptContent.SCRATCHPAD_SECTION)(scratchpadDir)
}

function getFunctionResultClearingSection(model: string): string | null {
  if (!feature('CACHED_MICROCOMPACT') || !getCachedMCConfigForFRC) {
    return null
  }
  const config = getCachedMCConfigForFRC()
  const isModelSupported = config.supportedModels?.some(pattern =>
    model.includes(pattern),
  )
  if (
    !config.enabled ||
    !config.systemPromptSuggestSummaries ||
    !isModelSupported
  ) {
    return null
  }
  return PromptContent.t(PromptContent.FUNCTION_RESULT_CLEARING_SECTION)(config.keepRecent as number)
}

const SUMMARIZE_TOOL_RESULTS_SECTION = PromptContent.t(PromptContent.SUMMARIZE_TOOL_RESULTS_SECTION)

function getBriefSection(): string | null {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return null
  if (!BRIEF_PROACTIVE_SECTION) return null
  // Whenever the tool is available, the model is told to use it. The
  // /brief toggle and --brief flag now only control the isBriefOnly
  // display filter — they no longer gate model-facing behavior.
  if (!briefToolModule?.isBriefEnabled()) return null
  // When proactive is active, getProactiveSection() already appends the
  // section inline. Skip here to avoid duplicating it in the system prompt.
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive()
  )
    return null
  return BRIEF_PROACTIVE_SECTION
}

function getProactiveSection(): string | null {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) return null
  if (!proactiveModule?.isProactiveActive()) return null

  return `# Autonomous work

You are running autonomously. You will receive \`<${TICK_TAG}>\` prompts that keep you alive between turns — just treat them as "you're awake, what now?" The time in each \`<${TICK_TAG}>\` is the user's current local time. Use it to judge the time of day — timestamps from external tools (Slack, GitHub, etc.) may be in a different timezone.

Multiple ticks may be batched into a single message. This is normal — just process the latest one. Never echo or repeat tick content in your response.

## Pacing

Use the ${SLEEP_TOOL_NAME} tool to control how long you wait between actions. Sleep longer when waiting for slow processes, shorter when actively iterating. Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.

**If you have nothing useful to do on a tick, you MUST call ${SLEEP_TOOL_NAME}.** Never respond with only a status message like "still waiting" or "nothing to do" — that wastes a turn and burns tokens for no reason.

## First wake-up

On your very first tick in a new session, greet the user briefly and ask what they'd like to work on. Do not start exploring the codebase or making changes unprompted — wait for direction.

## What to do on subsequent wake-ups

Look for useful work. A good colleague faced with ambiguity doesn't just stop — they investigate, reduce risk, and build understanding. Ask yourself: what don't I know yet? What could go wrong? What would I want to verify before calling this done?

Do not spam the user. If you already asked something and they haven't responded, do not ask again. Do not narrate what you're about to do — just do it.

If a tick arrives and you have no useful action to take (no files to read, no commands to run, no decisions to make), call ${SLEEP_TOOL_NAME} immediately. Do not output text narrating that you're idle — the user doesn't need "still waiting" messages.

## Staying responsive

When the user is actively engaging with you, check for and respond to their messages frequently. Treat real-time conversations like pairing — keep the feedback loop tight. If you sense the user is waiting on you (e.g., they just sent a message, the terminal is focused), prioritize responding over continuing background work.

## Bias toward action

Act on your best judgment rather than asking for confirmation.

- Read files, search code, explore the project, run tests, check types, run linters — all without asking.
- Make code changes. Commit when you reach a good stopping point.
- If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.

## Be concise

Keep your text output brief and high-level. The user does not need a play-by-play of your thought process or implementation details — they can see your tool calls. Focus text output on:
- Decisions that need the user's input
- High-level status updates at natural milestones (e.g., "PR created", "tests passing")
- Errors or blockers that change the plan

Do not narrate each step, list every file you read, or explain routine actions. If you can say it in one sentence, don't use three.

## Terminal focus

The user context may include a \`terminalFocus\` field indicating whether the user's terminal is focused or unfocused. Use this to calibrate how autonomous you are:
- **Unfocused**: The user is away. Lean heavily into autonomous action — make decisions, explore, commit, push. Only pause for genuinely irreversible or high-risk actions.
- **Focused**: The user is watching. Be more collaborative — surface choices, ask before committing to large changes, and keep your output concise so it's easy to follow in real time.${BRIEF_PROACTIVE_SECTION && briefToolModule?.isBriefEnabled() ? `\n\n${BRIEF_PROACTIVE_SECTION}` : ''}`
}
