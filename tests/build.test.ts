import { describe, test, expect } from "bun:test"
import { existsSync, rmSync } from "fs"
import { join } from "path"

const ROOT = join(import.meta.dir, "..")

describe("build", () => {
  test("bun build succeeds and produces dist/cli.js", async () => {
    const outdir = join(ROOT, "dist")

    // Clean previous build artefact so the check is meaningful
    const outFile = join(outdir, "cli.js")
    if (existsSync(outFile)) {
      rmSync(outFile)
    }

    const proc = Bun.spawn(
      ["bun", "build", "src/entrypoints/cli.tsx", "--outdir", "dist", "--target", "bun"],
      {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(0)
    // The output bundle must exist
    expect(existsSync(outFile)).toBe(true)
  }, 60_000) // allow up to 60s for the build
})
