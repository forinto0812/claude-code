import { describe, test, expect } from 'bun:test'
import { formatCountdown } from '../BuiltinStatusLine.js'

describe('formatCountdown', () => {
  const now = Date.now() / 1000

  test('returns "now" for past time', () => {
    expect(formatCountdown(now - 60)).toBe('now')
  })

  test('returns "now" for exactly zero diff', () => {
    expect(formatCountdown(now)).toBe('now')
  })

  test('returns minutes for less than 1 hour', () => {
    expect(formatCountdown(now + 45 * 60)).toBe('45m')
  })

  test('returns hours and minutes for less than 1 day', () => {
    expect(formatCountdown(now + 3 * 3600 + 12 * 60)).toBe('3h12m')
  })

  test('returns hours with 0 minutes', () => {
    expect(formatCountdown(now + 1 * 3600)).toBe('1h0m')
  })

  test('returns days and hours for 1+ days', () => {
    expect(formatCountdown(now + 5 * 86400 + 20 * 3600)).toBe('5d20h')
  })
})
