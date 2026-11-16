/**
 * The English, LLM-facing references served as `docs://*`.
 *
 * No imports on purpose: `tsup.config.ts` and `scripts/verify-dist.mjs` read this list too — tsup copies the files into
 * `dist/docs` so the npm package carries them, and the check refuses to pack without them.
 */
export const DOC_RESOURCES = [
  { name: 'strategy-config-reference', file: '18-strategy-config-reference.md', title: 'Strategy config reference' },
  { name: 'optimizer-run-reference', file: '19-optimizer-run-reference.md', title: 'Optimizer run reference' },
  { name: 'research-scan-reference', file: '20-research-scan-reference.md', title: 'Research scan reference' },
  { name: 'analog-query-reference', file: '22-analog-query-reference.md', title: 'Analog query reference' },
] as const;
