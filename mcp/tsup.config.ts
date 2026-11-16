import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'tsup';
import { DOC_RESOURCES } from './src/resources/doc-files';
import { publicDoc, publicTextProblems } from './src/resources/public-docs';

/**
 * Where the `docs://*` references are read from: `docs/` next to this file in the public source
 * (github.com/janorium/janorium-examples, `mcp/`), else the `docs/` of the repository the package is developed in.
 */
const SOURCE_DOCS = [path.resolve(__dirname, 'docs'), path.resolve(__dirname, '..', '..', 'docs')].find((dir) =>
  DOC_RESOURCES.every((doc) => existsSync(path.join(dir, doc.file))),
);
const DIST_DOCS = path.resolve(__dirname, 'dist', 'docs');

/**
 * One CommonJS file. Bundling (rather than `tsc` emit) keeps `src/platform-types.ts` type-only: in the development
 * repository it re-exports the web app's DTO types by relative path, and those imports vanish here instead of dragging
 * the web app's source into the output tree. Runtime dependencies stay external: node_modules in a checkout, the
 * package's own dependencies once installed from npm.
 *
 * The source map stays for local stack traces but is not published (`files` in package.json lists `dist/index.js`).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // The npm package travels without a repository around it, so the `docs://*` references go inside it (config.ts reads
  // dist/docs first), each reduced to its public text. A Docker build that copies only this package and mounts the
  // references instead has no source here, so a missing source is a warning; `prepack` (scripts/verify-dist.mjs) is
  // what refuses to pack without them.
  onSuccess: async () => {
    if (!SOURCE_DOCS) {
      console.warn('[docs] no docs/ with the references found — dist/docs not written (fine for a Docker image, not for npm)');
      return;
    }
    mkdirSync(DIST_DOCS, { recursive: true });
    for (const doc of DOC_RESOURCES) {
      const text = publicDoc(readFileSync(path.join(SOURCE_DOCS, doc.file), 'utf8'), doc.file);
      const problems = publicTextProblems(text);
      if (problems.length > 0) {
        throw new Error(`[docs] ${doc.file} is not fit to publish:\n  ${problems.join('\n  ')}`);
      }
      writeFileSync(path.join(DIST_DOCS, doc.file), text);
    }
    console.log(`[docs] ${DOC_RESOURCES.length} references written to dist/docs`);
  },
});
