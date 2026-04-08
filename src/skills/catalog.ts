import { readdir } from 'fs/promises'
import { join } from 'path'

/**
 * Lightweight skill catalog that maps skill names to their directory paths
 * for lazy loading. Scans the `.claude/skills/everything-claude-code/`
 * directory structure once and caches the result.
 *
 * Usage:
 *   const catalog = await getSkillCatalog()
 *   const path = catalog.get('tdd-workflow')
 *   // => '/absolute/path/to/.claude/skills/everything-claude-code/tdd-workflow'
 */

const SKILLS_SUBDIR = '.claude/skills/everything-claude-code'

/** Cached catalog instance. Null means not yet loaded. */
let cachedCatalog: Map<string, string> | null = null

/** The promise for an in-flight scan, used to coalesce concurrent callers. */
let scanPromise: Promise<Map<string, string>> | null = null

/**
 * Resolve the base directory for the ECC skill collection.
 * Accepts an optional project root; defaults to `process.cwd()`.
 */
export function getEccSkillsDir(projectRoot?: string): string {
  return join(projectRoot ?? process.cwd(), SKILLS_SUBDIR)
}

/**
 * Scan the skills directory and build a name -> absolute-path map.
 * Only directories that contain a `SKILL.md` file are included.
 */
async function scanSkillsDir(
  baseDir: string,
): Promise<Map<string, string>> {
  const catalog = new Map<string, string>()

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(baseDir, { withFileTypes: true })
  } catch {
    // Directory doesn't exist or is inaccessible — return empty catalog
    return catalog
  }

  // Check each subdirectory for a SKILL.md file.
  // We use readdir on the subdirectory to avoid a separate stat call.
  const checks = entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const dirPath = join(baseDir, entry.name)
      try {
        const children = await readdir(dirPath)
        if (children.includes('SKILL.md')) {
          catalog.set(entry.name, dirPath)
        }
      } catch {
        // Inaccessible subdirectory — skip
      }
    })

  await Promise.all(checks)
  return catalog
}

/**
 * Get the skill catalog (name -> directory path).
 *
 * The catalog is scanned once on first call and cached for the lifetime
 * of the process. Concurrent callers share the same scan promise.
 *
 * @param projectRoot - Optional project root directory. Defaults to cwd.
 * @returns A `Map<string, string>` where keys are skill names (directory
 *          basenames) and values are absolute directory paths.
 */
export async function getSkillCatalog(
  projectRoot?: string,
): Promise<ReadonlyMap<string, string>> {
  if (cachedCatalog !== null) {
    return cachedCatalog
  }

  if (scanPromise === null) {
    const baseDir = getEccSkillsDir(projectRoot)
    scanPromise = scanSkillsDir(baseDir).then((result) => {
      cachedCatalog = result
      scanPromise = null
      return result
    })
  }

  return scanPromise
}

/**
 * Look up a single skill's directory path by name.
 * Returns `undefined` if the skill is not found in the catalog.
 */
export async function getSkillPath(
  skillName: string,
  projectRoot?: string,
): Promise<string | undefined> {
  const catalog = await getSkillCatalog(projectRoot)
  return catalog.get(skillName)
}

/**
 * Get all skill names available in the catalog.
 */
export async function getSkillNames(
  projectRoot?: string,
): Promise<string[]> {
  const catalog = await getSkillCatalog(projectRoot)
  return [...catalog.keys()].sort()
}

/**
 * Get the total number of cataloged skills.
 */
export async function getSkillCount(
  projectRoot?: string,
): Promise<number> {
  const catalog = await getSkillCatalog(projectRoot)
  return catalog.size
}

/**
 * Force a re-scan on the next call to `getSkillCatalog()`.
 * Useful after skills have been added or removed at runtime.
 */
export function invalidateSkillCatalog(): void {
  cachedCatalog = null
  scanPromise = null
}
