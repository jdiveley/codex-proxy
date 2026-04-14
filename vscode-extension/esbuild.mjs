import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // VS Code extensions must be CommonJS — the extension host doesn't support ESM.
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // 'vscode' is injected by the extension host at runtime — never bundle it.
  external: ['vscode'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // Suppress the dynamic-require warning from esbuild — Node built-ins are fine.
  banner: {
    js: '/* codex-proxy VS Code extension */',
  },
});

if (watch) {
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
