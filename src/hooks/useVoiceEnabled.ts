import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasAvailableVoiceProvider,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with provider availability + GB
 * kill-switch. Only the provider half is memoized on authVersion — it's the
 * expensive one (cold getClaudeAIOAuthTokens memoize → sync `security` spawn,
 * ~60ms/call, ~180ms total in profile v5 when token refresh cleared the cache
 * mid-session). GB is a cheap cached-map lookup and stays outside the memo so a
 * mid-session kill-switch flip still takes effect on the next render.
 *
 * authVersion bumps on /login only. Background token refresh leaves it alone
 * (the same provider availability still applies), so the memo stays correct
 * without re-eval.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const providerAvailable = useMemo(hasAvailableVoiceProvider, [authVersion])
  return userIntent && providerAvailable && isVoiceGrowthBookEnabled()
}
