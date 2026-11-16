import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { defaultDocsDir } from '../config';
import { DOC_RESOURCES } from './doc-files';
import { publicDoc, publicTextProblems } from './public-docs';

describe('publicDoc', () => {
  it('drops block and inline omit spans and keeps the sentences around them', () => {
    const out = publicDoc(
      [
        '# Title',
        '',
        '<!--public:omit-->',
        '- gone',
        '<!--/public:omit-->',
        '',
        'Keep this<!--public:omit--> but not this<!--/public:omit-->.',
        'Across lines<!--public:omit--> first',
        'second<!--/public:omit--> works.',
        '- kept',
        '',
      ].join('\r\n'),
    );
    expect(out).toBe('# Title\n\nKeep this.\nAcross lines works.\n- kept\n');
  });

  it('refuses unbalanced or crossed markers', () => {
    expect(() => publicDoc('a <!--public:omit--> b')).toThrow(/1 <!--public:omit--> vs 0/);
    expect(() => publicDoc('a <!--/public:omit--> b <!--public:omit--> c')).toThrow(/nested or crossed/);
  });

  it('names what must not ship', () => {
    expect(publicTextProblems('ok\na live account\nbilling-service refuses\nsee libs/x')).toEqual([
      '2: the word "live": a live account',
      '3: service name: billing-service refuses',
      '4: source path: see libs/x',
    ]);
    expect(publicTextProblems('delivered, alive, olive oil, a deliverable')).toEqual([]);
  });
});

describe.each(DOC_RESOURCES.map((doc) => [doc.file]))('the public text of %s', (file) => {
  const dir = defaultDocsDir(path.resolve(__dirname, '..'));
  const out = publicDoc(readFileSync(path.join(dir, file), 'utf8'), file);

  it('carries nothing internal', () => {
    expect(publicTextProblems(out)).toEqual([]);
  });

  it('keeps the reference itself', () => {
    expect(out.startsWith('# ')).toBe(true);
    expect(out.length).toBeGreaterThan(30_000);
  });
});
