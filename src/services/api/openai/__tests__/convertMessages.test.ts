import { describe, expect, test } from 'bun:test'
import { anthropicMessagesToOpenAI } from '../convertMessages.js'
import type { UserMessage, AssistantMessage } from '../../../../types/message.js'

// Helpers to create internal-format messages
function makeUserMsg(content: string | any[]): UserMessage {
  return {
    type: 'user',
    uuid: '00000000-0000-0000-0000-000000000000',
    message: { role: 'user', content },
  } as UserMessage
}

function makeAssistantMsg(content: string | any[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000001',
    message: { role: 'assistant', content },
  } as AssistantMessage
}

describe('anthropicMessagesToOpenAI', () => {
  test('converts system prompt to system message', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg('hello')],
      ['You are helpful.'] as any,
    )
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' })
  })

  test('joins multiple system prompt strings', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg('hi')],
      ['Part 1', 'Part 2'] as any,
    )
    expect(result[0]).toEqual({ role: 'system', content: 'Part 1\n\nPart 2' })
  })

  test('skips empty system prompt', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg('hi')],
      [] as any,
    )
    expect(result[0].role).toBe('user')
  })

  test('converts simple user text message', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg('hello world')],
      [] as any,
    )
    expect(result).toEqual([{ role: 'user', content: 'hello world' }])
  })

  test('converts user message with content array', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ])],
      [] as any,
    )
    expect(result).toEqual([{ role: 'user', content: 'line 1\nline 2' }])
  })

  test('converts assistant message with text', () => {
    const result = anthropicMessagesToOpenAI(
      [makeAssistantMsg('response text')],
      [] as any,
    )
    expect(result).toEqual([{ role: 'assistant', content: 'response text' }])
  })

  test('converts assistant message with tool_use', () => {
    const result = anthropicMessagesToOpenAI(
      [makeAssistantMsg([
        { type: 'text', text: 'Let me help.' },
        {
          type: 'tool_use' as const,
          id: 'toolu_123',
          name: 'bash',
          input: { command: 'ls' },
        },
      ])],
      [] as any,
    )
    expect(result).toEqual([{
      role: 'assistant',
      content: 'Let me help.',
      tool_calls: [{
        id: 'toolu_123',
        type: 'function',
        function: { name: 'bash', arguments: '{"command":"ls"}' },
      }],
    }])
  })

  test('converts tool_result to tool message', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        {
          type: 'tool_result' as const,
          tool_use_id: 'toolu_123',
          content: 'file1.txt\nfile2.txt',
        },
      ])],
      [] as any,
    )
    expect(result).toEqual([{
      role: 'tool',
      tool_call_id: 'toolu_123',
      content: 'file1.txt\nfile2.txt',
    }])
  })

  test('strips thinking blocks', () => {
    const result = anthropicMessagesToOpenAI(
      [makeAssistantMsg([
        { type: 'thinking' as const, thinking: 'internal thoughts...' },
        { type: 'text', text: 'visible response' },
      ])],
      [] as any,
    )
    expect(result).toEqual([{ role: 'assistant', content: 'visible response' }])
  })

  test('handles full conversation with tools', () => {
    const result = anthropicMessagesToOpenAI(
      [
        makeUserMsg('list files'),
        makeAssistantMsg([
          {
            type: 'tool_use' as const,
            id: 'toolu_abc',
            name: 'bash',
            input: { command: 'ls' },
          },
        ]),
        makeUserMsg([
          {
            type: 'tool_result' as const,
            tool_use_id: 'toolu_abc',
            content: 'file.txt',
          },
        ]),
      ],
      ['You are helpful.'] as any,
    )

    expect(result).toHaveLength(4)
    expect(result[0].role).toBe('system')
    expect(result[1].role).toBe('user')
    expect(result[2].role).toBe('assistant')
    expect((result[2] as any).tool_calls).toBeDefined()
    expect(result[3].role).toBe('tool')
  })

  // --- Regression: failure.json scenario ---
  // When a user turn contains BOTH injected text (e.g. skill context) AND a
  // tool_result, the tool message MUST come before the user text message.
  // OpenAI rejects any user message inserted between assistant(tool_calls)
  // and the corresponding tool result.
  test('emits tool messages before user text when user turn has mixed text+tool_result', () => {
    const result = anthropicMessagesToOpenAI(
      [
        makeAssistantMsg([
          {
            type: 'tool_use' as const,
            id: 'call_skill_001',
            name: 'Skill',
            input: { skill: 'experiment', args: 'list my experiment environments' },
          },
        ]),
        makeUserMsg([
          // injected skill context (text block)
          { type: 'text', text: 'Base directory for this skill: /home/experiment\n\n# Skill content...' },
          // tool result
          {
            type: 'tool_result' as const,
            tool_use_id: 'call_skill_001',
            content: 'Launching skill: experiment',
          },
        ]),
      ],
      [] as any,
    )

    // Expected order: assistant → tool → user
    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('assistant')
    expect((result[0] as any).tool_calls[0].id).toBe('call_skill_001')

    // tool MUST come before user text
    expect(result[1].role).toBe('tool')
    expect((result[1] as any).tool_call_id).toBe('call_skill_001')
    expect((result[1] as any).content).toBe('Launching skill: experiment')

    expect(result[2].role).toBe('user')
    expect((result[2] as any).content).toContain('Skill content')
  })

  test('emits tool messages before user text when multiple tool_results mixed with text', () => {
    const result = anthropicMessagesToOpenAI(
      [
        makeAssistantMsg([
          {
            type: 'tool_use' as const,
            id: 'call_001',
            name: 'bash',
            input: { command: 'echo hello' },
          },
          {
            type: 'tool_use' as const,
            id: 'call_002',
            name: 'read_file',
            input: { path: '/tmp/foo' },
          },
        ]),
        makeUserMsg([
          { type: 'text', text: 'context injected by system' },
          {
            type: 'tool_result' as const,
            tool_use_id: 'call_001',
            content: 'hello',
          },
          {
            type: 'tool_result' as const,
            tool_use_id: 'call_002',
            content: 'file content',
          },
        ]),
      ],
      [] as any,
    )

    // Expected: assistant → tool(call_001) → tool(call_002) → user(text)
    expect(result).toHaveLength(4)
    expect(result[0].role).toBe('assistant')
    expect(result[1].role).toBe('tool')
    expect((result[1] as any).tool_call_id).toBe('call_001')
    expect(result[2].role).toBe('tool')
    expect((result[2] as any).tool_call_id).toBe('call_002')
    expect(result[3].role).toBe('user')
    expect((result[3] as any).content).toBe('context injected by system')
  })

  test('user turn with only tool_result (no text) keeps correct order', () => {
    const result = anthropicMessagesToOpenAI(
      [
        makeAssistantMsg([
          {
            type: 'tool_use' as const,
            id: 'call_only_tool',
            name: 'bash',
            input: { command: 'pwd' },
          },
        ]),
        makeUserMsg([
          {
            type: 'tool_result' as const,
            tool_use_id: 'call_only_tool',
            content: '/home/user',
          },
        ]),
      ],
      [] as any,
    )

    // No text in user turn → no user message emitted, only tool
    expect(result).toHaveLength(2)
    expect(result[0].role).toBe('assistant')
    expect(result[1].role).toBe('tool')
    expect((result[1] as any).tool_call_id).toBe('call_only_tool')
  })

  test('converts base64 image to image_url', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        { type: 'text', text: 'what is this?' },
        {
          type: 'image' as const,
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ])],
      [] as any,
    )
    expect(result).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
        },
      ],
    }])
  })

  test('converts url image to image_url', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        {
          type: 'image' as const,
          source: {
            type: 'url',
            url: 'https://example.com/img.png',
          },
        },
      ])],
      [] as any,
    )
    expect(result).toEqual([{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'https://example.com/img.png' },
        },
      ],
    }])
  })

  test('converts image-only message without text', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        {
          type: 'image' as const,
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: '/9j/4AAQ',
          },
        },
      ])],
      [] as any,
    )
    expect(result).toEqual([{
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
        },
      ],
    }])
  })

  test('defaults to image/png when media_type is missing', () => {
    const result = anthropicMessagesToOpenAI(
      [makeUserMsg([
        {
          type: 'image' as const,
          source: {
            type: 'base64',
            data: 'ABC123',
          },
        },
      ])],
      [] as any,
    )
    expect((result[0].content as any[])[0].image_url.url).toBe(
      'data:image/png;base64,ABC123',
    )
  })
})
