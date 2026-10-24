import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/entry.ts'],
  outfile: 'test/bundle/extension-under-test.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  alias: { vscode: './test/vscode-shim.mjs' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'error',
});
