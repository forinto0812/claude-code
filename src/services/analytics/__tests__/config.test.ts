import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let provider: 'firstParty' | 'openai' = 'firstParty'
let telemetryDisabled = false

mock.module('../../../utils/model/providers.js', () => ({
  getAPIProvider: () => provider,
}))

mock.module('../../../utils/privacyLevel.js', () => ({
  isTelemetryDisabled: () => telemetryDisabled,
}))

const { isAnalyticsDisabled } = await import('../config.js')

describe('isAnalyticsDisabled', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    provider = 'firstParty'
    telemetryDisabled = false
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv
    } else {
      delete process.env.NODE_ENV
    }
  })

  test('disables analytics for OpenAI-compatible providers', () => {
    provider = 'openai'
    expect(isAnalyticsDisabled()).toBe(true)
  })

  test('keeps analytics enabled for first-party provider when privacy allows it', () => {
    provider = 'firstParty'
    expect(isAnalyticsDisabled()).toBe(false)
  })

  test('disables analytics when telemetry privacy is enabled', () => {
    telemetryDisabled = true
    expect(isAnalyticsDisabled()).toBe(true)
  })
})
