import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { defaultDocsDir, isLoopbackHost, loadConfig, ConfigError } from './config';
import { mask, stderrLogger } from './log';
import { DOC_RESOURCES } from './resources/doc-files';

describe('mask', () => {
  it('never lets a whole key through', () => {
    const key = 'cbk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz';
    const lines: string[] = [];
    stderrLogger((line) => lines.push(line)).error(`introspection failed for ${key} (401)`);
    expect(lines[0]).not.toContain(key);
    expect(lines[0]).toContain('cbk_AbCd…');
    expect(mask(`a ${key} b ${key}`)).toBe('a cbk_AbCd… b cbk_AbCd…');
  });
});

describe('loadConfig', () => {
  it('requires a cbk_ key', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ CB_API_KEY: 'eyJhbGciOi.jwt.token' })).toThrow(/starts with cbk_/);
  });

  it('derives the socket origin from the REST base', () => {
    const config = loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'https://api.example.com/api/v1/' });
    expect(config.baseUrl).toBe('https://api.example.com/api/v1');
    expect(config.wsUrl).toBe('https://api.example.com');
    expect(config.exchange).toBe('binance');
    expect(config.insecureTransport).toBe(false);
  });

  it('accepts cleartext only to this machine', () => {
    for (const base of ['http://localhost:8080/api/v1', 'http://127.0.0.1:8080/api/v1', 'http://127.1.2.3/api/v1', 'http://[::1]:8080/api/v1']) {
      expect(loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: base }).insecureTransport).toBe(false);
    }
  });

  it('defaults to the public platform over https, socket included', () => {
    const config = loadConfig({ CB_API_KEY: 'cbk_x' });
    expect(config).toMatchObject({ baseUrl: 'https://janorium.com/api/v1', wsUrl: 'https://janorium.com', insecureTransport: false });
  });

  it('runs in free mode unless MCP_REQUIRE_CAMPAIGN asks for campaigns', () => {
    expect(loadConfig({ CB_API_KEY: 'cbk_x' }).requireCampaign).toBe(false);
    expect(loadConfig({ CB_API_KEY: 'cbk_x', MCP_REQUIRE_CAMPAIGN: 'true' }).requireCampaign).toBe(true);
    expect(loadConfig({ CB_API_KEY: 'cbk_x', MCP_REQUIRE_CAMPAIGN: 'false' }).requireCampaign).toBe(false);
  });

  it('reads the references bundled next to the build, else the package docs/, else the repository docs/', () => {
    const pkg = mkdtempSync(path.join(tmpdir(), 'mcp-pkg-'));
    const dist = path.join(pkg, 'dist');
    mkdirSync(dist);
    const writeDocs = (dir: string) => {
      mkdirSync(dir);
      for (const doc of DOC_RESOURCES) {
        writeFileSync(path.join(dir, doc.file), '# reference\n');
      }
    };
    expect(defaultDocsDir(dist)).toBe(path.resolve(dist, '..', '..', '..', 'docs'));
    writeDocs(path.join(pkg, 'docs'));
    expect(defaultDocsDir(dist)).toBe(path.join(pkg, 'docs'));
    writeDocs(path.join(dist, 'docs'));
    expect(defaultDocsDir(dist)).toBe(path.join(dist, 'docs'));
    expect(loadConfig({ CB_API_KEY: 'cbk_x', CB_DOCS_DIR: '/elsewhere' }).docsDir).toBe('/elsewhere');
  });

  it('refuses http:// or ws:// to another host unless CB_ALLOW_INSECURE_HTTP=true', () => {
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'http://gateway.lan:8080/api/v1' })).toThrow(
      /CB_BASE_URL=http:\/\/gateway.lan:8080.*CB_ALLOW_INSECURE_HTTP/,
    );
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'https://api.example.com/api/v1', CB_WS_URL: 'ws://api.example.com' })).toThrow(/CB_WS_URL/);
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'http://10.0.0.5/api/v1', CB_ALLOW_INSECURE_HTTP: 'ture' })).toThrow(ConfigError);
    const config = loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'http://gateway.lan:8080/api/v1', CB_ALLOW_INSECURE_HTTP: 'true' });
    expect(config).toMatchObject({ wsUrl: 'http://gateway.lan:8080', insecureTransport: true });
  });

  it('refuses credentials in a URL and protocols other than http(s)/ws(s)', () => {
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'https://user:pw@api.example.com/api/v1' })).toThrow(/credentials/);
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'file:///etc/passwd' })).toThrow(/must use/);
    expect(() => loadConfig({ CB_API_KEY: 'cbk_x', CB_BASE_URL: 'not a url' })).toThrow(/not a valid URL/);
  });
});

describe('isLoopbackHost', () => {
  it('knows localhost, 127/8 and ::1, nothing else', () => {
    expect(['localhost', '127.0.0.1', '127.255.0.9', '[::1]', '::1'].every(isLoopbackHost)).toBe(true);
    expect(['localhost.example.com', '128.0.0.1', '10.0.0.1', 'gateway.lan', '[::2]'].some(isLoopbackHost)).toBe(false);
  });
});

describe('mask on tokens', () => {
  it('hides a JWT echoed in text', () => {
    expect(mask('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI0MiJ9.sig-nature_x')).toBe('Bearer eyJ…[jwt]');
  });
});
