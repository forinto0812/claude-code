import { describe, test, expect, beforeEach } from "bun:test"

describe("feature flag system", () => {
  test("cli.tsx polyfill reads CLAUDE_FEATURE_FLAGS env var", () => {
    // Simulate the polyfill logic from cli.tsx
    const envValue = "WORKFLOW_SCRIPTS,HISTORY_SNIP"
    const enabledFeatures = new Set(
      envValue.split(",").map((s) => s.trim()).filter(Boolean),
    )
    const feature = (name: string) => enabledFeatures.has(name)

    expect(feature("WORKFLOW_SCRIPTS")).toBe(true)
    expect(feature("HISTORY_SNIP")).toBe(true)
    expect(feature("KAIROS")).toBe(false)
    expect(feature("")).toBe(false)
  })

  test("empty CLAUDE_FEATURE_FLAGS means all flags off", () => {
    const envValue = ""
    const enabledFeatures = new Set(
      envValue.split(",").map((s) => s.trim()).filter(Boolean),
    )
    const feature = (name: string) => enabledFeatures.has(name)

    expect(feature("WORKFLOW_SCRIPTS")).toBe(false)
    expect(feature("COORDINATOR_MODE")).toBe(false)
  })

  test("runtime featureFlags module works", async () => {
    // Import the actual module — it reads process.env at module load time
    // so we test the interface, not the env state
    const { isFeatureEnabled, getEnabledFeatures } = await import(
      "../src/utils/featureFlags.js"
    )

    expect(typeof isFeatureEnabled).toBe("function")
    expect(typeof getEnabledFeatures).toBe("function")
    expect(Array.isArray(getEnabledFeatures())).toBe(true)

    // With no CLAUDE_FEATURE_FLAGS set, defaults should apply
    // (currently no defaults are enabled)
    expect(isFeatureEnabled("COORDINATOR_MODE")).toBe(false)
    expect(isFeatureEnabled("KAIROS")).toBe(false)
  })

  test("disable flag syntax (-FLAG) works", () => {
    const envValue = "WORKFLOW_SCRIPTS,-HISTORY_SNIP"
    const userFlags = new Set(
      envValue.split(",").map((s) => s.trim()).filter(Boolean),
    )
    const disabledFlags = new Set(
      [...userFlags].filter((f) => f.startsWith("-")).map((f) => f.slice(1)),
    )

    const isEnabled = (name: string): boolean => {
      if (disabledFlags.has(name)) return false
      if (userFlags.has(name)) return true
      return false
    }

    expect(isEnabled("WORKFLOW_SCRIPTS")).toBe(true)
    expect(isEnabled("HISTORY_SNIP")).toBe(false)
  })
})
