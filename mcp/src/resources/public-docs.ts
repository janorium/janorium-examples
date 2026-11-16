/**
 * The public text of a `docs://*` reference. The references are also contracts inside Janorium's own repository, so the
 * passages that only make sense there (source paths, the platform's internals) are wrapped in `<!--public:omit-->` …
 * `<!--/public:omit-->`, and this cuts them out before the text ships: in the npm package (tsup copies the references
 * into `dist/docs` through it) and in the public source export. A span whose markers stand on lines of their own goes
 * with its lines; an inline one leaves the sentence around it intact. The website's copy of the strategy config
 * reference follows the same rules.
 *
 * No imports on purpose: `tsup.config.ts` and the export script run it outside the TypeScript build.
 */

const OPEN = '<!--public:omit-->';
const CLOSE = '<!--/public:omit-->';

/** A span whose markers stand on lines of their own — removed together with those lines. */
const BLOCK_SPAN = /^<!--public:omit-->\n[\s\S]*?^<!--\/public:omit-->\n/gm;
/** Any other span — removed in place. */
const INLINE_SPAN = /<!--public:omit-->[\s\S]*?<!--\/public:omit-->/g;

/**
 * What must never reach the public text, checked on the result: the word the brand never uses (Janorium only
 * backtests), and anything shaped like the name of one of the platform's own services or source folders.
 */
export const PUBLIC_TEXT_FORBIDDEN: readonly { name: string; pattern: RegExp }[] = [
  { name: 'omit marker', pattern: /<!--\/?public:omit-->/ },
  { name: 'the word "live"', pattern: /\bliv(?:e|es|ed|ing)\b/i },
  { name: 'deployment / onboarding', pattern: /\bdeployments?\b|\bonboarding\b/i },
  { name: 'service name', pattern: /\b[a-z]+(?:-[a-z]+)*-service\b/i },
  { name: 'source path', pattern: /\b(?:services|libs|apps|infra)\/|\.java\b|\bdb\/migration\b/ },
];

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Strips the omit spans; throws on unbalanced, nested or crossed markers. */
export function publicDoc(markdown: string, name = 'reference'): string {
  const text = markdown.replace(/\r\n/g, '\n');
  const opens = count(text, OPEN);
  const closes = count(text, CLOSE);
  if (opens !== closes) {
    throw new Error(`${name}: ${opens} ${OPEN} vs ${closes} ${CLOSE}`);
  }
  const body = text.replace(BLOCK_SPAN, '').replace(INLINE_SPAN, '');
  if (body.includes(OPEN) || body.includes(CLOSE)) {
    throw new Error(`${name}: nested or crossed public:omit markers`);
  }
  return body.replace(/\n{3,}/g, '\n\n');
}

/** Every line of a public text that matches {@link PUBLIC_TEXT_FORBIDDEN}, as `line: rule: text`. */
export function publicTextProblems(text: string): string[] {
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const rule of PUBLIC_TEXT_FORBIDDEN) {
      if (rule.pattern.test(line)) {
        problems.push(`${i + 1}: ${rule.name}: ${line.trim().slice(0, 120)}`);
      }
    }
  });
  return problems;
}
