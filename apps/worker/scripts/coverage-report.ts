/**
 * Print what `extractRecipeFromHtml()` actually gets out of every committed
 * fixture. This is the data behind `test/fixtures/COVERAGE.md`; re-run it
 * after a re-capture to check whether a source has changed underneath us.
 *
 * `corepack pnpm --filter @recipes/worker coverage`
 *
 * Reads only local files — no network.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRecipeFromHtml, TRACKED_FIELDS } from '../src/scanner/jsonld';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

interface Manifest {
  name: string;
  discoveredVia?: string;
  feedUrl: string | null;
  sitemapUrl?: string | null;
  pages: { file: string; url: string; error?: string }[];
}

async function main(): Promise<void> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const sites = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

  for (const site of sites) {
    const manifestPath = join(fixturesDir, site, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    process.stdout.write(`\n## ${manifest.name} (${site}) via ${manifest.discoveredVia ?? '?'}\n`);

    for (const page of manifest.pages) {
      if (page.error !== undefined) {
        process.stdout.write(`  ${page.file}: NOT CAPTURED — ${page.error}\n`);
        continue;
      }
      const html = await readFile(join(fixturesDir, site, page.file), 'utf8');
      const result = extractRecipeFromHtml(html, page.url);
      const stats = result.stats;
      if (!result.found || result.recipe === null) {
        process.stdout.write(
          `  ${page.file}: NO RECIPE JSON-LD (blocks=${stats.blocks} malformed=${stats.malformed} nodes=${stats.nodes}) ${page.url}\n`,
        );
        continue;
      }
      const r = result.recipe;
      const present = TRACKED_FIELDS.filter((field) => !r.missing.includes(field));
      process.stdout.write(
        [
          `  ${page.file}: ${JSON.stringify(r.title)}`,
          `    blocks=${stats.blocks} malformed=${stats.malformed} nodes=${stats.nodes} recipeNodes=${stats.recipeNodes}`,
          `    ingredients=${r.ingredients.length} steps=${r.instructions.length}` +
            ` sections=${new Set(r.instructions.map((s) => s.name)).size}` +
            ` total=${r.totalMinutes} prep=${r.prepMinutes} cook=${r.cookMinutes}` +
            ` servings=${r.servings} yield=${JSON.stringify(r.yieldText)}`,
          `    rating=${r.rating?.value ?? 'null'}/${r.rating?.count ?? 'null'} author=${JSON.stringify(r.author)}` +
            ` published=${r.publishedAt?.toISOString().slice(0, 10) ?? 'null'} image=${r.imageUrl !== null}`,
          `    present=[${present.join(',')}]`,
          `    missing=[${r.missing.join(',')}]`,
          `    rawKeys=${Object.keys(r.raw).length} instrShape=${instructionShape(r.raw['recipeInstructions'])}`,
        ].join('\n') + '\n',
      );
    }
  }
}

function instructionShape(value: unknown): string {
  if (typeof value === 'string') return 'string';
  if (!Array.isArray(value)) return typeof value;
  const types = new Set(
    value.map((item) =>
      typeof item === 'object' && item !== null
        ? String((item as Record<string, unknown>)['@type'] ?? 'object')
        : typeof item,
    ),
  );
  return `array<${[...types].join('|')}>`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
