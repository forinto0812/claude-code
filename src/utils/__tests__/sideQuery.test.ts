import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const getLastApiCompletionTimestamp = mock(() => null)
const setLastApiCompletionTimestamp = mock(() => {})
const logEvent = mock(() => {})
const anthropicMessagesToOpenAI = mock(() => [
  { role: 'system', content: 'converted-system' },
])
const anthropicToolsToOpenAI = mock(() => [
  {
    type: 'function',
    function: {
      name: 'explain_command',
      parameters: { type: 'object' },
    },
  },
])
const anthropicToolChoiceToOpenAI = mock(() => ({
  type: 'function',
  function: { name: 'explain_command' },
}))
const openAICreate = mock(async () => ({
  id: 'resp_123',
  model: 'gpt-5.4',
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: 'Structured explanation ready',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'explain_command',
              arguments:
                '{"riskLevel":"LOW","explanation":"safe","reasoning":"needed","risk":"none"}',
            },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
  },
}))
const getOpenAIClient = mock(() => ({
  chat: {
    completions: {
      create: openAICreate,
    },
  },
}))
const getAnthropicClient = mock(async () => {
  throw new Error('Anthropic client should not be used for OpenAI sideQuery')
})

mock.module('../../bootstrap/state.js', () => ({
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
}))

mock.module('../../services/analytics/index.js', () => ({
  logEvent,
}))

mock.module('../../constants/betas.js', () => ({
  STRUCTURED_OUTPUTS_BETA_HEADER: 'structured-outputs',
}))

mock.module('../../constants/system.js', () => ({
  getAttributionHeader: () => '',
  getCLISyspromptPrefix: () => '',
}))

mock.module('../../services/api/claude.js', () => ({
  getAPIMetadata: () => ({}),
}))

mock.module('../settings/settings.js', () => ({
  getInitialSettings: () => ({}),
}))

mock.module('../../services/api/client.js', () => ({
  getAnthropicClient,
}))

mock.module('../../services/api/openai/client.js', () => ({
  getOpenAIClient,
}))

mock.module('../../services/api/openai/modelMapping.js', () => ({
  resolveOpenAIModel: () => 'gpt-5.4',
}))

mock.module('../../services/api/openai/convertMessages.js', () => ({
  anthropicMessagesToOpenAI,
}))

mock.module('../../services/api/openai/convertTools.js', () => ({
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
}))

mock.module('../messages.js', () => ({
  createAssistantMessage: ({ content }: { content: unknown }) => ({
    type: 'assistant',
    message: { content },
  }),
  createUserMessage: ({ content }: { content: unknown }) => ({
    type: 'user',
    message: { content },
  }),
}))

mock.module('../../services/api/grok/client.js', () => ({
  getGrokClient: () => {
    throw new Error('Grok client should not be used in this test')
  },
}))

mock.module('../../services/api/grok/modelMapping.js', () => ({
  resolveGrokModel: () => 'grok-1',
}))

mock.module('../betas.js', () => ({
  getModelBetas: () => [],
  modelSupportsStructuredOutputs: () => true,
}))

mock.module('../fingerprint.js', () => ({
  computeFingerprint: () => 'fingerprint',
}))

mock.module('../json.js', () => ({
  safeParseJSON: (value: string) => JSON.parse(value),
}))

mock.module('../model/model.js', () => ({
  normalizeModelStringForAPI: (model: string) => model,
}))

const { sideQuery } = await import('../sideQuery.js')

describe('sideQuery', () => {
  const originalOpenAIFlag = process.env.CLAUDE_CODE_USE_OPENAI

  beforeEach(() => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    getLastApiCompletionTimestamp.mockClear()
    setLastApiCompletionTimestamp.mockClear()
    logEvent.mockClear()
    anthropicMessagesToOpenAI.mockClear()
    anthropicToolsToOpenAI.mockClear()
    anthropicToolChoiceToOpenAI.mockClear()
    openAICreate.mockClear()
    getOpenAIClient.mockClear()
    getAnthropicClient.mockClear()
  })

  afterEach(() => {
    if (originalOpenAIFlag !== undefined) {
      process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAIFlag
    } else {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    }
  })

  test('routes OpenAI side queries through the OpenAI-compatible client', async () => {
    const response = await sideQuery({
      model: 'claude-sonnet-4-5',
      system: 'Explain the command safely',
      messages: [{ role: 'user', content: 'Explain rm -rf build/' }],
      tools: [
        {
          name: 'explain_command',
          description: 'Explain a command',
          input_schema: { type: 'object' },
        },
      ] as any,
      tool_choice: { type: 'tool', name: 'explain_command' } as any,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            riskLevel: { type: 'string' },
          },
        },
      },
      max_tokens: 256,
      stop_sequences: ['</block>'],
      querySource: 'permission_explainer',
    })

    expect(getOpenAIClient).toHaveBeenCalledTimes(1)
    expect(getAnthropicClient).not.toHaveBeenCalled()

    expect(anthropicMessagesToOpenAI).toHaveBeenCalledTimes(1)
    const [, systemPrompt] = anthropicMessagesToOpenAI.mock.calls[0]!
    expect([...systemPrompt]).toEqual(['Explain the command safely'])

    expect(openAICreate).toHaveBeenCalledTimes(1)
    const [params] = openAICreate.mock.calls[0]!
    expect(params.model).toBe('gpt-5.4')
    expect(params.max_completion_tokens).toBe(256)
    expect(params.stop).toEqual(['</block>'])
    expect(params.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'side_query',
        schema: {
          type: 'object',
          properties: {
            riskLevel: { type: 'string' },
          },
        },
        strict: true,
      },
    })

    expect(response.id).toBe('resp_123')
    expect(response.model).toBe('gpt-5.4')
    expect(response.stop_reason).toBe('tool_use')
    expect(response.usage.input_tokens).toBe(11)
    expect(response.usage.output_tokens).toBe(7)
    expect(response.content).toEqual([
      { type: 'text', text: 'Structured explanation ready' },
      {
        type: 'tool_use',
        id: 'call_123',
        name: 'explain_command',
        input: {
          riskLevel: 'LOW',
          explanation: 'safe',
          reasoning: 'needed',
          risk: 'none',
        },
      },
    ])
  })
})
