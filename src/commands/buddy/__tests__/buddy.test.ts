import { describe, expect, test, beforeEach } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { getCompanion } from '../../../buddy/companion.js'

// Upstream buddy.ts uses LocalCommandCall: call(args, context) → LocalCommandResult
const { call } = await import('../buddy.js')

// Reset config before each test (NODE_ENV=test uses in-memory object)
function resetConfig() {
  saveGlobalConfig(() => ({
    ...getGlobalConfig(),
    companion: undefined as any,
    companionMuted: undefined as any,
  }))
}

describe('/buddy command', () => {
  beforeEach(() => {
    resetConfig()
  })

  test('/buddy with no companion shows hint to hatch', async () => {
    expect(getCompanion()).toBeUndefined()
    const result = await call('', {} as any)
    expect(result.type).toBe('text')
    expect(result.value).toContain('hatch')
  })

  test('/buddy hatch creates a new companion', async () => {
    expect(getCompanion()).toBeUndefined()
    const result = await call('hatch', {} as any)

    expect(result.type).toBe('text')
    expect(result.value).toContain('companion appeared')

    const config = getGlobalConfig()
    expect(config.companion).toBeDefined()
    expect(config.companion!.name).toBeTruthy()
    expect(config.companion!.personality).toBeTruthy()
    expect(config.companion!.hatchedAt).toBeGreaterThan(0)
  })

  test('/buddy shows existing companion card', async () => {
    // Hatch first
    await call('hatch', {} as any)
    const name = getGlobalConfig().companion!.name

    // Show card
    const result = await call('', {} as any)
    expect(result.type).toBe('text')
    expect(result.value).toContain(name)
    expect(result.value).toContain('Stats')
  })

  test('/buddy hatch again hints about existing companion', async () => {
    await call('hatch', {} as any)
    const result = await call('hatch', {} as any)
    expect(result.type).toBe('text')
    expect(result.value).toContain('already have a companion')
  })

  test('/buddy rehatch replaces existing companion', async () => {
    await call('hatch', {} as any)
    const first = getGlobalConfig().companion!

    const result = await call('rehatch', {} as any)
    expect(result.type).toBe('text')
    expect(result.value).toContain('new companion appeared')

    const second = getGlobalConfig().companion!
    expect(second.hatchedAt).toBeGreaterThanOrEqual(first.hatchedAt)
  })

  test('/buddy off sets companionMuted to true', async () => {
    const result = await call('off', {} as any)
    expect(getGlobalConfig().companionMuted).toBe(true)
    expect(result.value).toContain('muted')
  })

  test('/buddy on sets companionMuted to false', async () => {
    saveGlobalConfig(c => ({ ...c, companionMuted: true }))
    const result = await call('on', {} as any)
    expect(getGlobalConfig().companionMuted).toBe(false)
    expect(result.value).toContain('unmuted')
  })

  test('/buddy mute and /buddy unmute also work', async () => {
    const r1 = await call('mute', {} as any)
    expect(getGlobalConfig().companionMuted).toBe(true)
    expect(r1.value).toContain('muted')

    const r2 = await call('unmute', {} as any)
    expect(getGlobalConfig().companionMuted).toBe(false)
    expect(r2.value).toContain('unmuted')
  })

  test('/buddy pet with no companion shows hint', async () => {
    const result = await call('pet', {} as any)
    expect(result.value).toContain('hatch')
  })

  test('/buddy pet with companion shows hearts', async () => {
    await call('hatch', {} as any)
    const name = getGlobalConfig().companion!.name
    const result = await call('pet', {} as any)
    expect(result.value).toContain(name)
    expect(result.value).toContain('♥')
  })

  test('invalid subcommand shows usage', async () => {
    const result = await call('dance', {} as any)
    expect(result.value).toContain('Unknown command')
    expect(result.value).toContain('/buddy')
  })
})
