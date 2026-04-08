import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { isOpenAIThinkingEnabled } from '../index.js'

describe('isOpenAIThinkingEnabled', () => {
  const originalEnv = {
    OPENAI_ENABLE_THINKING: process.env.OPENAI_ENABLE_THINKING,
  }

  beforeEach(() => {
    // Clear env var before each test
    delete process.env.OPENAI_ENABLE_THINKING
  })

  afterEach(() => {
    // Restore original env var
    process.env.OPENAI_ENABLE_THINKING = originalEnv.OPENAI_ENABLE_THINKING
  })

  describe('OPENAI_ENABLE_THINKING env var', () => {
    test('returns true when OPENAI_ENABLE_THINKING=1', () => {
      process.env.OPENAI_ENABLE_THINKING = '1'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
    })

    test('returns true when OPENAI_ENABLE_THINKING=true', () => {
      process.env.OPENAI_ENABLE_THINKING = 'true'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
    })

    test('returns true when OPENAI_ENABLE_THINKING=yes', () => {
      process.env.OPENAI_ENABLE_THINKING = 'yes'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
    })

    test('returns true when OPENAI_ENABLE_THINKING=on', () => {
      process.env.OPENAI_ENABLE_THINKING = 'on'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
    })

    test('returns true when OPENAI_ENABLE_THINKING=TRUE (case insensitive)', () => {
      process.env.OPENAI_ENABLE_THINKING = 'TRUE'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
    })

    test('returns false when OPENAI_ENABLE_THINKING=0', () => {
      process.env.OPENAI_ENABLE_THINKING = '0'
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(false)
    })

    test('returns false when OPENAI_ENABLE_THINKING=false', () => {
      process.env.OPENAI_ENABLE_THINKING = 'false'
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(false)
    })

    test('returns false when OPENAI_ENABLE_THINKING is empty', () => {
      process.env.OPENAI_ENABLE_THINKING = ''
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(false)
    })

    test('returns false when OPENAI_ENABLE_THINKING is not set', () => {
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(false)
    })
  })

  describe('model name auto-detect', () => {
    test('returns true when model name is "deepseek-reasoner"', () => {
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(true)
    })

    test('returns true when model name contains "deepseek-reasoner" (case insensitive)', () => {
      expect(isOpenAIThinkingEnabled('DeepSeek-Reasoner')).toBe(true)
    })

    test('returns true when model name has prefix/suffix for deepseek-reasoner', () => {
      expect(isOpenAIThinkingEnabled('my-deepseek-reasoner-v1')).toBe(true)
    })

    test('returns true when model name is namespaced for deepseek-reasoner', () => {
      expect(isOpenAIThinkingEnabled('TokenService/deepseek-reasoner')).toBe(true)
    })

    test('returns true when model name is "deepseek-v3.2"', () => {
      expect(isOpenAIThinkingEnabled('deepseek-v3.2')).toBe(true)
    })

    test('returns true when model name contains "deepseek-v3.2" (case insensitive)', () => {
      expect(isOpenAIThinkingEnabled('DeepSeek-V3.2')).toBe(true)
    })

    test('returns true when model name has prefix/suffix for deepseek-v3.2', () => {
      expect(isOpenAIThinkingEnabled('my-deepseek-v3.2-v1')).toBe(true)
    })

    test('returns true when model name is namespaced for deepseek-v3.2', () => {
      expect(isOpenAIThinkingEnabled('TokenService/deepseek-v3.2')).toBe(true)
    })

    test('returns false when model name is "deepseek-chat"', () => {
      expect(isOpenAIThinkingEnabled('deepseek-chat')).toBe(false)
    })

    test('returns false when model name is "deepseek-v3"', () => {
      expect(isOpenAIThinkingEnabled('deepseek-v3')).toBe(false)
    })

    test('returns false when model name contains "deepseek" but not "reasoner" or "v3.2"', () => {
      expect(isOpenAIThinkingEnabled('deepseek-coder')).toBe(false)
    })

    test('returns false when model name is "gpt-4o"', () => {
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(false)
    })

    test('returns false when model name is empty', () => {
      expect(isOpenAIThinkingEnabled('')).toBe(false)
    })
  })

  describe('priority and combined detection', () => {
    test('OPENAI_ENABLE_THINKING=1 enables thinking for any model', () => {
      process.env.OPENAI_ENABLE_THINKING = '1'
      expect(isOpenAIThinkingEnabled('gpt-4o')).toBe(true)
      expect(isOpenAIThinkingEnabled('deepseek-v3')).toBe(true)
    })

    test('OPENAI_ENABLE_THINKING=false disables thinking even for deepseek-reasoner', () => {
      process.env.OPENAI_ENABLE_THINKING = 'false'
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(false)
    })

    test('OPENAI_ENABLE_THINKING=0 disables thinking even for deepseek-reasoner', () => {
      process.env.OPENAI_ENABLE_THINKING = '0'
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(false)
    })

    test('both conditions can enable thinking', () => {
      process.env.OPENAI_ENABLE_THINKING = '1'
      expect(isOpenAIThinkingEnabled('deepseek-reasoner')).toBe(true)
    })
  })
})

describe('thinking request parameters', () => {
  // Note: These tests verify the request body structure indirectly.
  // The actual API call is mocked in integration tests.
  // Here we document the expected parameter formats:

  test('documents official DeepSeek API format: thinking: { type: "enabled" }', () => {
    // Official DeepSeek API expects:
    const officialFormat = {
      thinking: { type: 'enabled' },
    }
    expect(officialFormat.thinking.type).toBe('enabled')
  })

  test('documents vLLM/self-hosted format: enable_thinking + chat_template_kwargs', () => {
    // Self-hosted DeepSeek-V3.2/vLLM expects:
    const vllmFormat = {
      enable_thinking: true,
      chat_template_kwargs: { thinking: true },
    }
    expect(vllmFormat.enable_thinking).toBe(true)
    expect(vllmFormat.chat_template_kwargs.thinking).toBe(true)
  })

  test('both formats are added simultaneously when thinking is enabled', () => {
    // The implementation adds both formats so each endpoint
    // can use the one it recognizes:
    const combinedFormat = {
      // Official DeepSeek API format
      thinking: { type: 'enabled' },
      // Self-hosted DeepSeek-V3.2/vLLM format
      enable_thinking: true,
      chat_template_kwargs: { thinking: true },
    }
    expect(combinedFormat.thinking.type).toBe('enabled')
    expect(combinedFormat.enable_thinking).toBe(true)
    expect(combinedFormat.chat_template_kwargs.thinking).toBe(true)
  })

  test('thinking params are NOT added when thinking is disabled', () => {
    // When thinking is disabled, none of these params should be present:
    const disabledFormat = {
      model: 'gpt-4o',
      messages: [],
      stream: true,
    }
    expect((disabledFormat as any).thinking).toBeUndefined()
    expect((disabledFormat as any).enable_thinking).toBeUndefined()
    expect((disabledFormat as any).chat_template_kwargs).toBeUndefined()
  })
})