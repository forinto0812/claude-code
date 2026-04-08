/**
 * Runtime feature flag system for the reimagined Claude Code.
 *
 * Replaces the build-time `feature()` from `bun:bundle` with a runtime-configurable
 * system. Flags can be enabled via:
 *   - CLAUDE_FEATURE_FLAGS env var (comma-separated list)
 *   - Default-enabled flags for user-facing tools that have complete implementations
 */

// Flags that are enabled by default because they have complete, user-facing implementations.
// Currently empty — feature-gated tools only have stub implementations.
// As tools are restored to full functionality, add their flag names here.
const DEFAULT_ENABLED_FLAGS = new Set<string>([
  // 'WORKFLOW_SCRIPTS',  // Enable when WorkflowTool has a real implementation
  // 'HISTORY_SNIP',      // Enable when SnipTool has a real implementation
  // 'WEB_BROWSER_TOOL',  // Enable when WebBrowserTool has a real implementation
  // 'TERMINAL_PANEL',    // Enable when TerminalCaptureTool has a real implementation
])

// Parse user-configured flags from environment
const _userFlags = new Set(
  (process.env.CLAUDE_FEATURE_FLAGS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

// Parse explicitly disabled flags (prefixed with -)
const _disabledFlags = new Set(
  [..._userFlags]
    .filter((f) => f.startsWith('-'))
    .map((f) => f.slice(1)),
)

/**
 * Check if a feature flag is enabled at runtime.
 * Priority: explicit disable (-FLAG) > explicit enable > default
 */
export function isFeatureEnabled(name: string): boolean {
  if (_disabledFlags.has(name)) return false
  if (_userFlags.has(name)) return true
  return DEFAULT_ENABLED_FLAGS.has(name)
}

/**
 * Get all currently enabled feature flags (for diagnostics/logging)
 */
export function getEnabledFeatures(): string[] {
  const all = new Set([...DEFAULT_ENABLED_FLAGS, ..._userFlags])
  for (const d of _disabledFlags) all.delete(d)
  return [...all].filter((f) => !f.startsWith('-'))
}
