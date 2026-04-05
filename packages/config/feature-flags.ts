/**
 * FeatureFlagProvider — Unified feature flag interface
 *
 * Provides higher-level feature flag access beyond the basic `feature()`
 * builtin. For boolean compile-time feature flags, continue using
 * `import { feature } from 'bun:bundle'` directly — `feature()` requires
 * string literal arguments and cannot be wrapped dynamically.
 *
 * This module provides:
 * - Typed feature value access (non-boolean, GrowthBook-backed)
 * - Refresh lifecycle (subscribe, trigger)
 * - Env override inspection
 */

import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  onGrowthBookRefresh,
  refreshGrowthBookFeatures,
  hasGrowthBookEnvOverride,
  getAllGrowthBookFeatures,
  getGrowthBookConfigOverrides,
  setGrowthBookConfigOverride,
  clearGrowthBookConfigOverrides,
} from '../../src/services/analytics/growthbook.js'

/** Unsubscribe function returned by onRefresh() */
type Unsubscribe = () => void

/**
 * FeatureFlagProvider — access GrowthBook feature values and lifecycle.
 *
 * For boolean feature flags, use `feature('FLAG_NAME')` from `bun:bundle`.
 * For typed values (numbers, strings, objects) and refresh management, use this.
 *
 * Usage:
 *   import { FeatureFlagProvider } from '@anthropic/config/feature-flags'
 *
 *   const val = FeatureFlagProvider.getValue<number>('MY_CONFIG')
 *   const unsub = FeatureFlagProvider.onRefresh(() => { ... })
 */
export const FeatureFlagProvider = {
  /**
   * Get a typed feature value from GrowthBook.
   * Returns `undefined` if the feature is not set or not yet loaded.
   *
   * WARNING: This value may be stale if GrowthBook hasn't refreshed yet.
   */
  getValue<T>(name: string): T | undefined {
    return getFeatureValue_CACHED_MAY_BE_STALE<T>(name)
  },

  /**
   * Check if a feature has an environment variable override.
   */
  hasEnvOverride(name: string): boolean {
    return hasGrowthBookEnvOverride(name)
  },

  /**
   * Get all known GrowthBook features and their resolved values.
   */
  getAll(): Record<string, unknown> {
    return getAllGrowthBookFeatures()
  },

  /**
   * Get local config overrides (ant-only).
   */
  getConfigOverrides(): Record<string, unknown> {
    return getGrowthBookConfigOverrides()
  },

  /**
   * Set a local config override (ant-only).
   */
  setConfigOverride(name: string, value: unknown): void {
    setGrowthBookConfigOverride(name, value)
  },

  /**
   * Clear all local config overrides (ant-only).
   */
  clearConfigOverrides(): void {
    clearGrowthBookConfigOverrides()
  },

  /**
   * Subscribe to GrowthBook refresh events.
   * Called after each successful refresh.
   * Returns an unsubscribe function.
   */
  onRefresh(callback: () => void): Unsubscribe {
    return onGrowthBookRefresh(callback)
  },

  /**
   * Manually trigger a GrowthBook feature refresh.
   * Usually not needed — periodic refresh is handled by the analytics service.
   */
  async refresh(): Promise<void> {
    return refreshGrowthBookFeatures()
  },
} as const
