import type { Tools } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'

/**
 * Type for the getSystemPrompt function
 */
export type GetSystemPromptFn = (
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
) => Promise<string[]>

/**
 * Type for language-specific prompt sections
 */
export type PromptSection = {
  eng: string
  chn: string
}

/**
 * Helper type for functions that return prompt strings
 */
export type PromptFn<T extends any[] = []> = (...args: T) => string | null
