# Computer Use — 恢复 + Windows 支持计划

更新时间：2026-04-03
参考项目：`E:\源码\claude-code-source-main\claude-code-source-main`

## 1. 目标

让 Computer Use（屏幕操控）功能在 macOS 和 Windows 上都能工作。

## 2. 涉及的 3 个包

```
feature('CHICAGO_MCP')
    │
    ▼
@ant/computer-use-mcp        ← MCP server + 工具定义（当前 STUB）
    ├── @ant/computer-use-input  ← 键鼠模拟（当前仅 macOS AppleScript）
    └── @ant/computer-use-swift  ← 截图 + 应用管理（当前仅 macOS AppleScript）
```

| 包 | 当前状态 | 需要做什么 |
|---|---------|----------|
| `computer-use-mcp` | stub（返回空工具/null server） | 从参考项目复制完整实现（12 文件，6517 行） |
| `computer-use-input` | macOS AppleScript 实现（183 行） | 保留 macOS，新增 Windows PowerShell 后端 |
| `computer-use-swift` | macOS AppleScript 实现（388 行） | 保留 macOS，新增 Windows PowerShell 后端 |

## 3. 文件架构设计

### 3.1 `@ant/computer-use-input` — 键鼠模拟

**当前**：所有代码在 `src/index.ts` 一个文件里，macOS only。

**改为**：

```
packages/@ant/computer-use-input/src/
├── index.ts              ← dispatcher：按 platform 选后端，导出统一 API
├── backends/
│   ├── darwin.ts          ← 现有 AppleScript/JXA 实现（从 index.ts 拆出，不改逻辑）
│   └── win32.ts           ← 新增 PowerShell 实现
└── types.ts               ← 共享类型定义（从 index.ts 拆出）
```

**`index.ts`（dispatcher）**：
```typescript
import type { InputBackend } from './types.js'

function loadBackend(): InputBackend | null {
  switch (process.platform) {
    case 'darwin':
      return require('./backends/darwin.js')
    case 'win32':
      return require('./backends/win32.js')
    default:
      return null
  }
}

const backend = loadBackend()
export const isSupported = backend !== null

export const moveMouse = backend?.moveMouse ?? unsupported
export const key = backend?.key ?? unsupported
export const keys = backend?.keys ?? unsupported
// ... 其余导出
```

**`types.ts`**：
```typescript
export interface FrontmostAppInfo {
  bundleId: string    // macOS: bundle ID, Windows: exe path
  appName: string
}

export interface InputBackend {
  moveMouse(x: number, y: number, animated: boolean): Promise<void>
  key(key: string, action: 'press' | 'release'): Promise<void>
  keys(parts: string[]): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  mouseButton(button: 'left' | 'right' | 'middle', action: 'click' | 'press' | 'release', count?: number): Promise<void>
  mouseScroll(amount: number, direction: 'vertical' | 'horizontal'): Promise<void>
  typeText(text: string): Promise<void>
  getFrontmostAppInfo(): FrontmostAppInfo | null
}
```

**`backends/darwin.ts`**：现有 `index.ts` 中的 macOS 实现原样拆出，不改一行逻辑。

**`backends/win32.ts`**：PowerShell 实现，已验证可行的 API：

| 函数 | PowerShell 方案 | 已验证 |
|------|----------------|--------|
| `moveMouse` | `SetCursorPos` Win32 P/Invoke | ✅ 画圆测试通过 |
| `mouseButton` | `SendInput` MOUSEEVENTF_*DOWN/*UP | ✅ 类型加载成功 |
| `mouseScroll` | `SendInput` MOUSEEVENTF_WHEEL/HWHEEL | ✅ 滚轮测试通过 |
| `mouseLocation` | `GetCursorPos` Win32 P/Invoke | ✅ 坐标读取成功 |
| `key` | `keybd_event` P/Invoke | ✅ 类型加载成功 |
| `keys` | `keybd_event` 组合（modifier down → key → modifier up） | ✅ |
| `typeText` | `SendKeys.SendWait()` | ✅ API 可用 |
| `getFrontmostAppInfo` | `GetForegroundWindow` + `GetWindowThreadProcessId` | ✅ 返回进程名+路径 |

**Win32 实现要点**：
- 所有 P/Invoke 的 `Add-Type` 代码编译一次，缓存在模块级变量中，避免每次调用重复编译
- PowerShell 每次启动约 273ms；考虑用 `Bun.spawn` 启动一个长期驻留的 PowerShell 进程，通过 stdin/stdout 交互，摊平启动成本

### 3.2 `@ant/computer-use-swift` — 截图 + 应用管理

**当前**：所有代码在 `src/index.ts` 一个文件里，macOS only。

**改为**：

```
packages/@ant/computer-use-swift/src/
├── index.ts              ← dispatcher：按 platform 选后端，导出 ComputerUseAPI 类
├── backends/
│   ├── darwin.ts          ← 现有 AppleScript/screencapture 实现（拆出）
│   └── win32.ts           ← 新增 PowerShell 实现
└── types.ts               ← 共享类型（DisplayGeometry, AppInfo, ScreenshotResult 等）
```

**`backends/win32.ts`** 需要实现的函数：

| 函数 | PowerShell 方案 | 已验证 |
|------|----------------|--------|
| `captureExcluding()` | `Graphics.CopyFromScreen` 全屏 → PNG → base64 | ✅ 191KB 截图成功 |
| `captureRegion(x,y,w,h)` | `Graphics.CopyFromScreen` 指定区域 | ✅ 区域截图成功 |
| `prepareDisplay()` | `Screen.AllScreens` | ✅ 检测到双显示器 |
| `apps.listRunning()` | `Get-Process` 带 MainWindowTitle | ✅ 返回进程列表 |
| `apps.open(name)` | `Start-Process` | 标准 API |
| `getFrontmostAppInfo()` | `GetForegroundWindow` + `GetWindowThreadProcessId` | ✅ |
| `findWindowDisplays()` | `EnumWindows` + `MonitorFromWindow` | 需实现 |

### 3.3 `@ant/computer-use-mcp` — MCP Server

**纯 stub 替换**，与 chrome-mcp 同模式。从参考项目复制 12 个文件：

```
packages/@ant/computer-use-mcp/src/
├── index.ts          ← 覆盖 stub
├── types.ts          ← 覆盖（参考项目版本更完整）
├── sentinelApps.ts   ← 覆盖（参考项目版本更完整）
├── mcpServer.ts      ← 新增
├── executor.ts       ← 新增
├── toolCalls.ts      ← 新增（3649 行，最大文件）
├── tools.ts          ← 新增
├── deniedApps.ts     ← 新增
├── keyBlocklist.ts   ← 新增
├── imageResize.ts    ← 新增
├── pixelCompare.ts   ← 新增
└── subGates.ts       ← 新增
```

## 4. 执行步骤

### Phase 1：恢复 MCP server（标准 stub 替换，不涉及 Windows）

| 步骤 | 操作 | 文件 |
|------|------|------|
| 1.1 | 从参考项目复制 computer-use-mcp 完整实现 | `packages/@ant/computer-use-mcp/src/` 12 文件 |
| 1.2 | `DEFAULT_FEATURES` 加 `"CHICAGO_MCP"` | `scripts/dev.ts` + `build.ts` |
| 1.3 | 验证 build 成功 | `bun run build` |
| 1.4 | 验证 macOS 现有功能不受影响 | 非 macOS 可跳过 |

### Phase 2：拆分 input 包为平台后端架构

| 步骤 | 操作 | 文件 |
|------|------|------|
| 2.1 | 创建 `types.ts`，定义 `InputBackend` 接口 | 新增 |
| 2.2 | 现有 `index.ts` macOS 代码拆到 `backends/darwin.ts` | 拆分，不改逻辑 |
| 2.3 | `index.ts` 改为 dispatcher | 重写 |
| 2.4 | 验证 macOS 功能不变（如有 macOS 环境） | — |
| 2.5 | 编写 `backends/win32.ts` PowerShell 实现 | 新增 |
| 2.6 | Windows 上验证 8 个函数 | 逐个测试 |

### Phase 3：拆分 swift 包为平台后端架构

| 步骤 | 操作 | 文件 |
|------|------|------|
| 3.1 | 创建 `types.ts`，定义共享类型 | 新增 |
| 3.2 | 现有 `index.ts` macOS 代码拆到 `backends/darwin.ts` | 拆分，不改逻辑 |
| 3.3 | `index.ts` 改为 dispatcher | 重写 |
| 3.4 | 编写 `backends/win32.ts` PowerShell 实现 | 新增 |
| 3.5 | Windows 上验证截图、应用管理 | 逐个测试 |

### Phase 4：集成验证

| 步骤 | 操作 |
|------|------|
| 4.1 | `bun run build` 成功 |
| 4.2 | Windows: Computer Use 工具列表非空 |
| 4.3 | Windows: 截图、鼠标移动、键盘输入端到端测试 |
| 4.4 | DEV-LOG.md 追加章节 |
| 4.5 | 提交 PR |

## 5. 文件改动总览

### Phase 1（stub 替换）

| 操作 | 文件 | 说明 |
|------|------|------|
| 覆盖 | `packages/@ant/computer-use-mcp/src/index.ts` | stub → 完整导出 |
| 覆盖 | `packages/@ant/computer-use-mcp/src/types.ts` | 补全类型 |
| 覆盖 | `packages/@ant/computer-use-mcp/src/sentinelApps.ts` | 补全 |
| 新增 | `packages/@ant/computer-use-mcp/src/` 其余 9 文件 | 参考项目复制 |
| 修改 | `scripts/dev.ts` + `build.ts` | 加 `"CHICAGO_MCP"` |

### Phase 2（input 平台架构）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `packages/@ant/computer-use-input/src/types.ts` | InputBackend 接口 |
| 拆分 | `packages/@ant/computer-use-input/src/backends/darwin.ts` | 从 index.ts 拆出 |
| 重写 | `packages/@ant/computer-use-input/src/index.ts` | dispatcher |
| 新增 | `packages/@ant/computer-use-input/src/backends/win32.ts` | PowerShell 键鼠 |

### Phase 3（swift 平台架构）

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `packages/@ant/computer-use-swift/src/types.ts` | 共享类型 |
| 拆分 | `packages/@ant/computer-use-swift/src/backends/darwin.ts` | 从 index.ts 拆出 |
| 重写 | `packages/@ant/computer-use-swift/src/index.ts` | dispatcher |
| 新增 | `packages/@ant/computer-use-swift/src/backends/win32.ts` | PowerShell 截图+应用 |

## 6. 性能预期

| 操作 | macOS (AppleScript) | Windows (PowerShell) | 原生 .node |
|------|--------------------|--------------------|-----------|
| 鼠标移动 | ~50ms | ~273ms（首次），可优化到 ~30ms（驻留进程） | ~1ms |
| 键盘输入 | ~50ms | ~273ms，同上 | ~1ms |
| 截图 | ~200ms | ~273ms | ~50ms |
| 前台窗口 | ~100ms | ~273ms，同上 | ~1ms |

**优化方向**：启动一个长驻 PowerShell 进程，通过 stdin 发送命令、stdout 读取结果。可将每次调用延迟从 273ms 降到 ~30ms。此优化可在基础功能验证后的 Phase 5 中实施。

## 7. 不改动的文件

- `src/utils/computerUse/` 下所有文件 — 已与参考项目一致
- `src/services/mcp/client.ts` — 已包含 CHICAGO_MCP 门控逻辑
- `src/commands.ts` — 无需改动

## 8. 运行时前置条件

| 条件 | macOS | Windows |
|------|-------|---------|
| feature flag | `CHICAGO_MCP` | 同 |
| GrowthBook | `tengu_malort_pedway` enabled | 同（需绕过或设默认 true） |
| 系统权限 | Accessibility 权限 | 无特殊权限 |
| 外部依赖 | 无（osascript 内置） | 无（PowerShell 内置） |
