/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    '复制 Claude 的上一条响应到剪贴板（或 /copy N 获取倒数第 N 条）',
  load: () => import('./copy.js'),
} satisfies Command

export default copy
