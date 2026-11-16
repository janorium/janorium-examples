import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { SERVER_VERSION } from '../src/server';

interface PackageJson {
  name: string;
  version: string;
  private?: boolean;
  repository: { type: string; url: string; directory: string };
  mcpName: string;
  files: string[];
  bin: Record<string, string>;
}

interface EnvVar {
  name: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
}

interface ServerJson {
  name: string;
  version: string;
  description: string;
  repository: { url: string; source: string; subfolder: string };
  packages: { registryType: string; identifier: string; version: string; environmentVariables: EnvVar[] }[];
}

/** What the npm package and the MCP Registry entry promise each other. */
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageJson;
const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8')) as ServerJson;
const npmEntry = server.packages.find((p) => p.registryType === 'npm')!;

describe('npm package ↔ server.json', () => {
  it('agree on the version everywhere the registry and the client see it', () => {
    expect(server.version).toBe(pkg.version);
    expect(npmEntry.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('agree on the names the registry checks', () => {
    expect(pkg.mcpName).toBe(server.name);
    expect(npmEntry.identifier).toBe(pkg.name);
    expect(server.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('point at the same public source', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/janorium/janorium-examples.git', directory: 'mcp' });
    expect(server.repository).toEqual({ url: 'https://github.com/janorium/janorium-examples', source: 'github', subfolder: pkg.repository.directory });
  });

  it('ship only the bundle, the references, README and LICENSE', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(['dist/index.js', 'dist/docs/*.md']);
    expect(Object.values(pkg.bin)).toEqual(['dist/index.js']);
  });

  it('declare the key as a required secret and the base URL as optional', () => {
    const env = Object.fromEntries(npmEntry.environmentVariables.map((v) => [v.name, v]));
    expect(env.CB_API_KEY).toMatchObject({ isRequired: true, isSecret: true });
    expect(env.CB_BASE_URL).toMatchObject({ isRequired: false, default: 'https://janorium.com/api/v1' });
  });
});
