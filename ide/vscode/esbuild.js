// esbuild 构建脚本 - 编译 VSCode 插件
const esbuild = require('esbuild')
const path = require('path')
const fs = require('fs')

// 是否生产模式
const isProduction = process.argv.includes('--production')
// 是否监听模式
const isWatch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  // 入口文件
  entryPoints: ['src/extension.ts'],
  // 输出目录
  outdir: 'dist',
  // 打包为单文件
  bundle: true,
  // VSCode 插件平台
  platform: 'node',
  // Node.js 目标版本
  target: 'node18',
  // 外部依赖（vscode 不打包）
  external: ['vscode'],
  // 输出格式
  format: 'cjs',
  // source map
  sourcemap: !isProduction,
  // 压缩（生产模式）
  minify: isProduction,
  // 定义常量
  define: {
    'process.env.NODE_ENV': isProduction ? '"production"' : '"development"',
  },
}

async function build() {
  // 复制 webview 静态文件到 dist/webview
  const webviewSrc = path.join(__dirname, 'src', 'webview')
  const webviewDist = path.join(__dirname, 'dist', 'webview')

  // 确保目录存在
  if (!fs.existsSync(webviewDist)) {
    fs.mkdirSync(webviewDist, { recursive: true })
  }

  // 复制 HTML 和 CSS
  for (const file of ['index.html', 'style.css']) {
    const src = path.join(webviewSrc, file)
    const dst = path.join(webviewDist, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
    }
  }

  // 编译 webview 脚本
  await esbuild.build({
    entryPoints: ['src/webview/main.ts'],
    outdir: 'dist/webview',
    bundle: true,
    platform: 'browser',
    target: 'es2020',
    format: 'iife',
    sourcemap: !isProduction,
    minify: isProduction,
  })

  if (isWatch) {
    // 监听模式
    const ctx = await esbuild.context(buildOptions)
    await ctx.watch()
    console.log('[claude-code] watching for changes...')
  } else {
    // 单次构建
    await esbuild.build(buildOptions)
    console.log('[claude-code] build complete')
  }
}

build().catch((err) => {
  console.error(err)
  process.exit(1)
})
