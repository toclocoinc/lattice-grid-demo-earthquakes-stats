/**
 * Save a real run of the USGS earthquake feeds to `data/snapshot/`, so the
 * dashboard can also be opened with no network at all.
 *
 * Run it with `npm run snapshot`. It is a development tool: nothing the page
 * loads imports it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchInitial } from '../src/usgs-feed.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'data', 'snapshot');

const started = Date.now();
console.log('Reading a week of earthquakes and a month of the significant ones...');

const { rows, significantIds, feeds } = await fetchInitial({
  onProgress: (message) => console.log(`  ${message}`),
});

const seconds = Number(((Date.now() - started) / 1000).toFixed(1));

/* Sorted newest first so the file reads sensibly and the replay has an
   obvious tail to work from. */
rows.sort((a, b) => b.time - a.time);

const meta = {
  fetchedAt: new Date().toISOString(),
  fetchedAtMs: Date.now(),
  seconds,
  rows: rows.length,
  significant: significantIds.size,
  source: 'United States Geological Survey earthquake feeds',
  sourceUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php',
  licence: 'USGS data are in the public domain.',
  feeds: feeds.map((feed) => ({
    name: feed.name,
    title: feed.title,
    generated: feed.generated,
    generatedAt: new Date(feed.generated).toISOString(),
    count: feed.count,
  })),
  oldest: rows.length ? new Date(rows[rows.length - 1].time).toISOString() : null,
  newest: rows.length ? new Date(rows[0].time).toISOString() : null,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'quakes.json'), JSON.stringify(rows));
await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`\nSaved ${rows.length} earthquakes in ${seconds}s.`);
for (const feed of meta.feeds) {
  console.log(`  ${feed.name}: ${feed.count} events, generated ${feed.generatedAt}`);
}
console.log(`Oldest ${meta.oldest}, newest ${meta.newest}.`);
