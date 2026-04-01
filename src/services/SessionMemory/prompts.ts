import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  t,
  SESSION_MEMORY_TEMPLATE,
  SESSION_MEMORY_UPDATE_PROMPT,
  SESSION_MEMORY_SECTION_REMINDERS,
  SESSION_MEMORY_TRUNCATED_SECTION,
} from '../../constants/prompts/content.js'
import { roughTokenCountEstimation } from '../../services/tokenEstimation.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode, toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'

const MAX_SECTION_LENGTH = 2000
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12000

export const DEFAULT_SESSION_MEMORY_TEMPLATE = t(SESSION_MEMORY_TEMPLATE)

function getDefaultUpdatePrompt(): string {
  return t(SESSION_MEMORY_UPDATE_PROMPT)(MAX_SECTION_LENGTH, MAX_TOTAL_SESSION_MEMORY_TOKENS)
}

/**
 * Load custom session memory template from file if it exists
 */
export async function loadSessionMemoryTemplate(): Promise<string> {
  const templatePath = join(
    getClaudeConfigHomeDir(),
    'session-memory',
    'config',
    'template.md',
  )

  try {
    return await readFile(templatePath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return DEFAULT_SESSION_MEMORY_TEMPLATE
    }
    logError(toError(e))
    return DEFAULT_SESSION_MEMORY_TEMPLATE
  }
}

/**
 * Load custom session memory prompt from file if it exists
 * Custom prompts can be placed at ~/.claude/session-memory/prompt.md
 * Use {{variableName}} syntax for variable substitution (e.g., {{currentNotes}}, {{notesPath}})
 */
export async function loadSessionMemoryPrompt(): Promise<string> {
  const promptPath = join(
    getClaudeConfigHomeDir(),
    'session-memory',
    'config',
    'prompt.md',
  )

  try {
    return await readFile(promptPath, { encoding: 'utf-8' })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return getDefaultUpdatePrompt()
    }
    logError(toError(e))
    return getDefaultUpdatePrompt()
  }
}

/**
 * Parse the session memory file and analyze section sizes
 */
function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {}
  const lines = content.split('\n')
  let currentSection = ''
  let currentContent: string[] = []

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (currentSection && currentContent.length > 0) {
        const sectionContent = currentContent.join('\n').trim()
        sections[currentSection] = roughTokenCountEstimation(sectionContent)
      }
      currentSection = line
      currentContent = []
    } else {
      currentContent.push(line)
    }
  }

  if (currentSection && currentContent.length > 0) {
    const sectionContent = currentContent.join('\n').trim()
    sections[currentSection] = roughTokenCountEstimation(sectionContent)
  }

  return sections
}

/**
 * Generate reminders for sections that are too long
 */
function generateSectionReminders(
  sectionSizes: Record<string, number>,
  totalTokens: number,
): string {
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS
  const oversizedSections = Object.entries(sectionSizes)
    .filter(([_, tokens]) => tokens > MAX_SECTION_LENGTH)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([section, tokens]) =>
        `- "${section}" is ~${tokens} tokens (limit: ${MAX_SECTION_LENGTH})`,
    )

  const remindersContent = t(SESSION_MEMORY_SECTION_REMINDERS)
  return remindersContent(totalTokens, MAX_TOTAL_SESSION_MEMORY_TOKENS, oversizedSections)
}

/**
 * Substitute variables in the prompt template using {{variable}} syntax
 */
function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  // Single-pass replacement avoids two bugs: (1) $ backreference corruption
  // (replacer fn treats $ literally), and (2) double-substitution when user
  // content happens to contain {{varName}} matching a later variable.
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key]!
      : match,
  )
}

/**
 * Check if the session memory content is essentially empty (matches the template).
 * This is used to detect if no actual content has been extracted yet,
 * which means we should fall back to legacy compact behavior.
 */
export async function isSessionMemoryEmpty(content: string): Promise<boolean> {
  const template = await loadSessionMemoryTemplate()
  // Compare trimmed content to detect if it's just the template
  return content.trim() === template.trim()
}

export async function buildSessionMemoryUpdatePrompt(
  currentNotes: string,
  notesPath: string,
): Promise<string> {
  const promptTemplate = await loadSessionMemoryPrompt()

  // Analyze section sizes and generate reminders if needed
  const sectionSizes = analyzeSectionSizes(currentNotes)
  const totalTokens = roughTokenCountEstimation(currentNotes)
  const sectionReminders = generateSectionReminders(sectionSizes, totalTokens)

  // Substitute variables in the prompt
  const variables = {
    currentNotes,
    notesPath,
  }

  const basePrompt = substituteVariables(promptTemplate, variables)

  // Add section size reminders and/or total budget warnings
  return basePrompt + sectionReminders
}

/**
 * Truncate session memory sections that exceed the per-section token limit.
 * Used when inserting session memory into compact messages to prevent
 * oversized session memory from consuming the entire post-compact token budget.
 *
 * Returns the truncated content and whether any truncation occurred.
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string
  wasTruncated: boolean
} {
  const lines = content.split('\n')
  const maxCharsPerSection = MAX_SECTION_LENGTH * 4 // roughTokenCountEstimation uses length/4
  const outputLines: string[] = []
  let currentSectionLines: string[] = []
  let currentSectionHeader = ''
  let wasTruncated = false

  for (const line of lines) {
    if (line.startsWith('# ')) {
      const result = flushSessionSection(
        currentSectionHeader,
        currentSectionLines,
        maxCharsPerSection,
      )
      outputLines.push(...result.lines)
      wasTruncated = wasTruncated || result.wasTruncated
      currentSectionHeader = line
      currentSectionLines = []
    } else {
      currentSectionLines.push(line)
    }
  }

  // Flush the last section
  const result = flushSessionSection(
    currentSectionHeader,
    currentSectionLines,
    maxCharsPerSection,
  )
  outputLines.push(...result.lines)
  wasTruncated = wasTruncated || result.wasTruncated

  return {
    truncatedContent: outputLines.join('\n'),
    wasTruncated,
  }
}

function flushSessionSection(
  sectionHeader: string,
  sectionLines: string[],
  maxCharsPerSection: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!sectionHeader) {
    return { lines: sectionLines, wasTruncated: false }
  }

  const sectionContent = sectionLines.join('\n')
  if (sectionContent.length <= maxCharsPerSection) {
    return { lines: [sectionHeader, ...sectionLines], wasTruncated: false }
  }

  // Truncate at a line boundary near the limit
  let charCount = 0
  const keptLines: string[] = [sectionHeader]
  for (const line of sectionLines) {
    if (charCount + line.length + 1 > maxCharsPerSection) {
      break
    }
    keptLines.push(line)
    charCount += line.length + 1
  }
  keptLines.push(t(SESSION_MEMORY_TRUNCATED_SECTION))
  return { lines: keptLines, wasTruncated: true }
}
