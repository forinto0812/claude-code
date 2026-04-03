/**
 * @ant/computer-use-swift — cross-platform display, apps, and screenshot API
 *
 * Platform backends:
 *   - darwin: AppleScript/JXA + screencapture
 *   - win32:  PowerShell + System.Drawing + Win32 P/Invoke
 *
 * Add new platforms by creating backends/<platform>.ts implementing SwiftBackend.
 */

// Re-export all types
export type {
  DisplayGeometry,
  PrepareDisplayResult,
  AppInfo,
  InstalledApp,
  RunningApp,
  ScreenshotResult,
  ResolvePrepareCaptureResult,
  WindowDisplayInfo,
  DisplayAPI,
  AppsAPI,
  ScreenshotAPI,
  SwiftBackend,
} from './types.js'

import type { ResolvePrepareCaptureResult, SwiftBackend } from './types.js'

// ---------------------------------------------------------------------------
// Platform dispatch
// ---------------------------------------------------------------------------

function loadBackend(): SwiftBackend | null {
  try {
    switch (process.platform) {
      case 'darwin':
        return require('./backends/darwin.js') as SwiftBackend
      case 'win32':
        return require('./backends/win32.js') as SwiftBackend
      default:
        return null
    }
  } catch {
    return null
  }
}

const backend = loadBackend()

// ---------------------------------------------------------------------------
// ComputerUseAPI — Main export (preserves original class interface)
// ---------------------------------------------------------------------------

export class ComputerUseAPI {
  apps = backend?.apps ?? {
    async prepareDisplay() { return { activated: '', hidden: [] } },
    async previewHideSet() { return [] },
    async findWindowDisplays(ids: string[]) { return ids.map(b => ({ bundleId: b, displayIds: [] as number[] })) },
    async appUnderPoint() { return null },
    async listInstalled() { return [] },
    iconDataUrl() { return null },
    listRunning() { return [] },
    async open() {},
    async unhide() {},
  }

  display = backend?.display ?? {
    getSize() { return { width: 1920, height: 1080, scaleFactor: 1, displayId: 0 } },
    listAll() { return [{ width: 1920, height: 1080, scaleFactor: 1, displayId: 0 }] },
  }

  screenshot = backend?.screenshot ?? {
    async captureExcluding() { return { base64: '', width: 0, height: 0 } },
    async captureRegion() { return { base64: '', width: 0, height: 0 } },
  }

  async resolvePrepareCapture(
    allowedBundleIds: string[],
    _surrogateHost: string,
    quality: number,
    targetW: number,
    targetH: number,
    displayId?: number,
    _autoResolve?: boolean,
    _doHide?: boolean,
  ): Promise<ResolvePrepareCaptureResult> {
    return this.screenshot.captureExcluding(allowedBundleIds, quality, targetW, targetH, displayId)
  }
}
