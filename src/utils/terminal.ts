import chalk from 'chalk'
import { ctrlOToExpand } from '../components/CtrlOToExpand.js'
import { stringWidth } from '@anthropic/ink'
import sliceAnsi from './sliceAnsi.js'

const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
const NON_SGR_CSI_SEQUENCE = /\u001B\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/g

export function sanitizeCapturedTerminalOutput(content: string): string {
  const withoutOsc = content.replace(OSC_SEQUENCE, '')
  const withoutCursorControl = withoutOsc.replace(NON_SGR_CSI_SEQUENCE, '')
  const normalizedNewlines = withoutCursorControl.replace(/\r\n/g, '\n')

  return normalizedNewlines
    .split('\n')
    .map(line => {
      const carriageReturnSegments = line.split('\r')
      return carriageReturnSegments[carriageReturnSegments.length - 1] ?? ''
    })
    .join('\n')
}

// Text rendering utilities for terminal display
const MAX_LINES_TO_SHOW = 3
// Account for MessageResponse prefix ("  ⎿ " = 5 chars) + parent width
// reduction (columns - 5 in tool result rendering)
const PADDING_TO_PREVENT_OVERFLOW = 10
const DEFAULT_TERMINAL_WIDTH = 80

/**
 * Inserts newlines in a string to wrap it at the specified width.
 * Uses ANSI-aware slicing to avoid splitting escape sequences.
 * @param text The text to wrap.
 * @param wrapWidth The width at which to wrap lines (in visible characters).
 * @returns The wrapped text.
 */
type WrappedText = {
  aboveTheFold: string
  remainingLines: number
  wrappedLineCount: number
}

type PreparedTruncation = {
  trimmedContent: string
  wrapWidth: number
  preTruncated: boolean
  wrapped: WrappedText
}

function getTerminalWrapWidth(terminalWidth: number): number {
  return Math.max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW, 10)
}

export function getTruncationTerminalWidth(terminalWidth?: number): number {
  return terminalWidth ?? process.stdout.columns ?? DEFAULT_TERMINAL_WIDTH
}

function wrapText(
  text: string,
  wrapWidth: number,
): WrappedText {
  const lines = text.split('\n')
  const wrappedLines: string[] = []

  for (const line of lines) {
    const visibleWidth = stringWidth(line)
    if (visibleWidth <= wrapWidth) {
      wrappedLines.push(line.trimEnd())
    } else {
      // Break long lines into chunks of wrapWidth visible characters
      // using ANSI-aware slicing to preserve escape sequences
      let position = 0
      while (position < visibleWidth) {
        const chunk = sliceAnsi(line, position, position + wrapWidth)
        wrappedLines.push(chunk.trimEnd())
        position += wrapWidth
      }
    }
  }

  const remainingLines = wrappedLines.length - MAX_LINES_TO_SHOW

  // If there's only 1 line after the fold, show it directly
  // instead of showing "... +1 line (ctrl+o to expand)"
  if (remainingLines === 1) {
    return {
      aboveTheFold: wrappedLines
        .slice(0, MAX_LINES_TO_SHOW + 1)
        .join('\n')
        .trimEnd(),
      remainingLines: 0, // All lines are shown, nothing remaining
      wrappedLineCount: wrappedLines.length,
    }
  }

  // Otherwise show the standard MAX_LINES_TO_SHOW
  return {
    aboveTheFold: wrappedLines.slice(0, MAX_LINES_TO_SHOW).join('\n').trimEnd(),
    remainingLines: Math.max(0, remainingLines),
    wrappedLineCount: wrappedLines.length,
  }
}

function prepareTruncatedContent(
  content: string,
  terminalWidth: number,
): PreparedTruncation | null {
  const trimmedContent = sanitizeCapturedTerminalOutput(content).trimEnd()
  if (!trimmedContent) {
    return null
  }

  const wrapWidth = getTerminalWrapWidth(terminalWidth)

  // Only process enough content for the visible lines. Avoids O(n) wrapping
  // on huge outputs (e.g. 64MB binary dumps that cause 382K-row screens).
  const maxChars = MAX_LINES_TO_SHOW * wrapWidth * 4
  const preTruncated = trimmedContent.length > maxChars
  const contentForWrapping = preTruncated
    ? trimmedContent.slice(0, maxChars)
    : trimmedContent

  return {
    trimmedContent,
    wrapWidth,
    preTruncated,
    wrapped: wrapText(contentForWrapping, wrapWidth),
  }
}

/**
 * Renders the content with line-based truncation for terminal display.
 * If the content exceeds the maximum number of lines, it truncates the content
 * and adds a message indicating the number of additional lines.
 * @param content The content to render.
 * @param terminalWidth Terminal width for wrapping lines.
 * @returns The rendered content with truncation if needed.
 */
export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint = false,
): string {
  const prepared = prepareTruncatedContent(content, terminalWidth)
  if (!prepared) {
    return ''
  }

  const { trimmedContent, wrapWidth, preTruncated, wrapped } = prepared
  const { aboveTheFold, remainingLines } = wrapped

  const estimatedRemaining = preTruncated
    ? Math.max(
        remainingLines,
        Math.ceil(trimmedContent.length / wrapWidth) - MAX_LINES_TO_SHOW,
      )
    : remainingLines

  return [
    aboveTheFold,
    estimatedRemaining > 0
      ? chalk.dim(
          `… +${estimatedRemaining} lines${suppressExpandHint ? '' : ` ${ctrlOToExpand()}`}`,
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Fast check: would OutputLine truncate this content for the given width?
 *  Mirrors renderTruncatedContent's sanitize + wrap behavior so truncation
 *  detection matches what the user actually sees. */
export function isOutputLineTruncated(
  content: string,
  terminalWidth: number,
): boolean {
  const prepared = prepareTruncatedContent(content, terminalWidth)
  if (!prepared) {
    return false
  }

  const {
    preTruncated,
    wrapped: { remainingLines, wrappedLineCount },
  } = prepared

  return preTruncated || remainingLines > 0 || wrappedLineCount > MAX_LINES_TO_SHOW + 1
}
