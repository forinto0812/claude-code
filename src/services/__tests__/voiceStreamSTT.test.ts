import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let mockedOpenAICalls: Array<Record<string, unknown>> = []

mock.module('openai', () => {
  class OpenAIStub {
    audio = {
      transcriptions: {
        create: async (params: Record<string, unknown>) => {
          mockedOpenAICalls.push(params)
          return { text: 'hello world' }
        },
      },
    }

    constructor(_opts: Record<string, unknown>) {}
  }

  return {
    default: OpenAIStub,
    toFile: async (data: Buffer, name: string, options?: Record<string, unknown>) => ({
      data,
      name,
      options,
    }),
  }
})

const {
  connectVoiceStream,
  getVoiceModeAvailability,
  getVoiceSttProvider,
  isVoiceStreamAvailable,
} = await import('../voiceStreamSTT.js')

describe('voiceStreamSTT', () => {
  const originalEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    OPENAI_TRANSCRIPTION_MODEL: process.env.OPENAI_TRANSCRIPTION_MODEL,
  }

  beforeEach(() => {
    mockedOpenAICalls = []
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_TRANSCRIPTION_MODEL
  })

  afterEach(() => {
    if (originalEnv.OPENAI_API_KEY !== undefined) {
      process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
    } else {
      delete process.env.OPENAI_API_KEY
    }
    if (originalEnv.OPENAI_BASE_URL !== undefined) {
      process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
    } else {
      delete process.env.OPENAI_BASE_URL
    }
    if (originalEnv.OPENAI_MODEL !== undefined) {
      process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
    } else {
      delete process.env.OPENAI_MODEL
    }
    if (originalEnv.OPENAI_TRANSCRIPTION_MODEL !== undefined) {
      process.env.OPENAI_TRANSCRIPTION_MODEL =
        originalEnv.OPENAI_TRANSCRIPTION_MODEL
    } else {
      delete process.env.OPENAI_TRANSCRIPTION_MODEL
    }
  })

  test('returns openai when OPENAI_API_KEY is configured', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-test'
    expect(getVoiceSttProvider()).toBe('openai')
    expect(isVoiceStreamAvailable()).toBe(true)
    expect(getVoiceModeAvailability()).toEqual({
      provider: 'openai',
      available: true,
    })
  })

  test('returns null when no supported provider is configured', () => {
    expect(getVoiceSttProvider()).toBeNull()
    expect(isVoiceStreamAvailable()).toBe(false)
    expect(getVoiceModeAvailability()).toEqual({
      provider: null,
      available: false,
    })
  })

  test('creates transcription from buffered audio for api key provider', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

    const transcripts: string[] = []
    let readyCalled = false
    const connection = await connectVoiceStream(
      {
        onTranscript: (text, isFinal) => {
          if (isFinal) transcripts.push(text)
        },
        onError: message => {
          throw new Error(message)
        },
        onClose: () => {},
        onReady: () => {
          readyCalled = true
        },
      },
      { language: 'en', keyterms: ['claude'] },
    )

    expect(connection).not.toBeNull()
    expect(readyCalled).toBe(true)

    connection!.send(Buffer.from('pcm-audio'))
    const source = await connection!.finalize()

    expect(source).toBe('post_closestream_endpoint')
    expect(transcripts).toEqual(['hello world'])
    expect(mockedOpenAICalls).toHaveLength(1)
    expect(mockedOpenAICalls[0]?.model).toBe('gpt-4o-mini-transcribe')
    expect(mockedOpenAICalls[0]?.language).toBe('en')
    expect(mockedOpenAICalls[0]?.prompt).toContain('claude')
    const uploadedFile = mockedOpenAICalls[0]?.file as {
      data: Buffer
      name: string
      options?: { type?: string }
    }
    expect(uploadedFile.name).toBe('voice-input.wav')
    expect(uploadedFile.options?.type).toBe('audio/wav')
    expect(uploadedFile.data.subarray(0, 4).toString()).toBe('RIFF')
    expect(uploadedFile.data.subarray(8, 12).toString()).toBe('WAVE')
  })
})
