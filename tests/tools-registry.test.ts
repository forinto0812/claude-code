import { describe, test, expect, beforeAll } from "bun:test"

// Polyfill the bun:bundle feature function and global macros that cli.tsx
// normally sets up, since we are importing tools.ts directly.
;(globalThis as any).feature = (_name: string) => false
if (typeof (globalThis as any).MACRO === "undefined") {
  ;(globalThis as any).MACRO = {
    VERSION: "0.0.0-test",
    BUILD_TIME: new Date().toISOString(),
    FEEDBACK_CHANNEL: "",
    ISSUES_EXPLAINER: "",
    NATIVE_PACKAGE_URL: "",
    PACKAGE_URL: "",
    VERSION_CHANGELOG: "",
  }
}
;(globalThis as any).BUILD_TARGET = "external"
;(globalThis as any).BUILD_ENV = "production"
;(globalThis as any).INTERFACE_TYPE = "stdio"

// Now import the tools registry
import { getAllBaseTools } from "../src/tools.js"

describe("tools registry", () => {
  let tools: ReturnType<typeof getAllBaseTools>

  beforeAll(() => {
    tools = getAllBaseTools()
  })

  test("getAllBaseTools returns a non-empty array", () => {
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBeGreaterThan(0)
  })

  test("every tool has a non-empty name string", () => {
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string")
      expect(tool.name.length).toBeGreaterThan(0)
    }
  })

  test("tool names are unique", () => {
    const names = tools.map((t) => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  test("known core tools are present", () => {
    const names = new Set(tools.map((t) => t.name))
    // These tools should always be in the base list
    for (const expected of ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch"]) {
      expect(names.has(expected)).toBe(true)
    }
  })
})
