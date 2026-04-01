/**
 * Teammate-specific system prompt addendum.
 *
 * This is appended to the full main agent system prompt for teammates.
 * It explains visibility constraints and communication requirements.
 */

import { t, TEAMMATE_SYSTEM_PROMPT_ADDENDUM as TEAMMATE_CONTENT } from '../../constants/prompts/content.js'

export const TEAMMATE_SYSTEM_PROMPT_ADDENDUM = t(TEAMMATE_CONTENT)
