import { getInitialSettings } from './settings.js'

export type PromptLanguage = 'eng' | 'chn'

/**
 * Get the configured prompt language.
 * Defaults to 'eng' if not set.
 */
export function getPromptLanguage(): PromptLanguage {
  return getInitialSettings().promptLanguage ?? 'eng'
}

/**
 * Check if Chinese prompts are enabled.
 */
export function isChinesePrompt(): boolean {
  return getPromptLanguage() === 'chn'
}
