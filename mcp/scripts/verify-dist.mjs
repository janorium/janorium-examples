#!/usr/bin/env node
/**
 * `prepack` gate for the npm package (runs on `npm pack` and `npm publish`, after the build). Refuses to pack when:
 * - dist/index.js lacks the shebang the `bin` entry needs;
 * - a `docs://*` reference is missing from dist/docs (tsup writes them only when it finds the references' docs/), or one
 *   still carries an omit marker or the word "live";
 * - the bundle carries an absolute path from this machine (a user's home directory, a drive letter);
 * - package.json, server.json and `SERVER_VERSION` disagree on the version, or `mcpName` differs from server.json `name`
 *   (the MCP Registry checks both).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const problems = [];

const bundle = existsSync(path.join(root, 'dist/index.js')) ? read('dist/index.js') : '';
if (!bundle) {
  problems.push('dist/index.js is missing — run the build first');
} else {
  if (!bundle.startsWith('#!/usr/bin/env node\n')) {
    problems.push('dist/index.js does not start with "#!/usr/bin/env node"');
  }
  // C:\Users\… in a comment, C:\\Users\\… in a string literal, C:/Users/…, /home/<user>/…, /Users/<user>/…
  const leak = bundle.match(/[A-Za-z]:(?:\\{1,2}|\/)(?:Users|home)(?:\\{1,2}|\/)[^\s'"`]+|\/(?:Users|home)\/[^\s'"`/]+\/[^\s'"`]+/);
  if (leak) {
    problems.push(`dist/index.js carries a local absolute path: ${leak[0].slice(0, 80)}`);
  }
}

const docFiles = [...read('src/resources/doc-files.ts').matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
if (docFiles.length === 0) {
  problems.push('no doc files found in src/resources/doc-files.ts');
}
for (const file of docFiles) {
  const doc = path.join(root, 'dist/docs', file);
  if (!existsSync(doc)) {
    problems.push(`dist/docs/${file} is missing — build from a checkout that has the references (docs/)`);
  } else if (/<!--\/?public:omit-->|\bliv(?:e|es|ed|ing)\b/i.test(readFileSync(doc, 'utf8'))) {
    // tsup writes the public text only (src/resources/public-docs.ts); this is the last look before it ships.
    problems.push(`dist/docs/${file} still carries an omit marker or the word "live" — rebuild`);
  }
}

const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));
const serverVersion = read('src/server.ts').match(/SERVER_VERSION = '([^']+)'/)?.[1];
const npmEntry = (server.packages ?? []).find((p) => p.registryType === 'npm');
const versions = {
  'package.json': pkg.version,
  'server.json version': server.version,
  'server.json npm package': npmEntry?.version,
  SERVER_VERSION: serverVersion,
};
if (new Set(Object.values(versions)).size !== 1) {
  problems.push(`versions disagree: ${JSON.stringify(versions)}`);
}
if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName (${pkg.mcpName}) differs from server.json name (${server.name})`);
}
if (npmEntry?.identifier !== pkg.name) {
  problems.push(`server.json npm identifier (${npmEntry?.identifier}) differs from package.json name (${pkg.name})`);
}
if (!existsSync(path.join(root, 'LICENSE'))) {
  problems.push('LICENSE is missing');
}

if (problems.length > 0) {
  console.error(`verify-dist: refusing to pack ${pkg.name}@${pkg.version}:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`verify-dist: ${pkg.name}@${pkg.version} ok (${docFiles.length} references, mcpName ${pkg.mcpName})`);
