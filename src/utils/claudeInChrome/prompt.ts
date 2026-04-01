import {
  t,
  CLAUDE_IN_CHROME_PROMPT,
  CHROME_TOOL_SEARCH_INSTRUCTIONS as CHROME_TOOL_SEARCH_INSTRUCTIONS_CONTENT,
  CLAUDE_IN_CHROME_SKILL_HINT as SKILL_HINT,
  CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER as SKILL_HINT_WITH_WEBBROWSER,
} from '../../constants/prompts/content.js'

export const BASE_CHROME_PROMPT = t(CLAUDE_IN_CHROME_PROMPT)

/**
 * Additional instructions for chrome tools when tool search is enabled.
 * These instruct the model to load chrome tools via ToolSearch before using them.
 * Only injected when tool search is actually enabled (not just optimistically possible).
 */
export const CHROME_TOOL_SEARCH_INSTRUCTIONS = t(CHROME_TOOL_SEARCH_INSTRUCTIONS_CONTENT)

/**
 * Get the base chrome system prompt (without tool search instructions).
 * Tool search instructions are injected separately at request time in claude.ts
 * based on the actual tool search enabled state.
 */
export function getChromeSystemPrompt(): string {
  return BASE_CHROME_PROMPT
}

/**
 * Minimal hint about Claude in Chrome skill availability. This is injected at startup when the extension is installed
 * to guide the model to invoke the skill before using the MCP tools.
 */
export const CLAUDE_IN_CHROME_SKILL_HINT = t(SKILL_HINT)

/**
 * Variant when the built-in WebBrowser tool is also available — steer
 * dev-loop tasks to WebBrowser and reserve the extension for the user's
 * authenticated Chrome (logged-in sites, OAuth, computer-use).
 */
export const CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER = t(SKILL_HINT_WITH_WEBBROWSER)
