/**
 * Build `preview.html`: the whole dashboard in one file that can be opened
 * straight from disk, with the saved earthquakes written into the page and
 * the grid loaded from a public CDN.
 *
 * Before it writes anything it checks each CDN file: that it answers 200, and
 * that its bytes are identical to the copy installed in `node_modules`. A
 * preview that silently loaded a different build of the library would be
 * showing something other than what was tested.
 *
 * Run it with `npm run preview`. It is a development tool.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkgDir = join(root, 'node_modules', '@toclocoinc', 'lattice-grid');

const installed = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));
const VERSION = installed.version;
const CDN = `https://cdn.jsdelivr.net/npm/@toclocoinc/lattice-grid@${VERSION}`;

/** The library files the preview loads, as paths inside the package. */
const CDN_FILES = [
  'lattice-grid.min.js',
  'modules/charts.min.js',
  'modules/kpi.min.js',
  'modules/tabs.min.js',
  'modules/data-router.min.js',
];

/** Fields worked out again on the way in rather than being stored. */
const DERIVED = new Set(['day', 'count']);

/**
 * Check every CDN file answers 200 and matches the installed bytes.
 *
 * @returns {Promise<object[]>} one report per file
 */
async function checkCdn() {
  const reports = [];
  for (const file of CDN_FILES) {
    const local = await readFile(join(pkgDir, file));
    const localHash = createHash('sha256').update(local).digest('hex');
    const url = `${CDN}/${file}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}. The preview would not load.`);
    }
    const remote = Buffer.from(await response.arrayBuffer());
    const remoteHash = createHash('sha256').update(remote).digest('hex');
    if (remoteHash !== localHash) {
      throw new Error(
        `${url} does not match the installed copy.\n  installed sha256 ${localHash}\n  CDN       sha256 ${remoteHash}`,
      );
    }
    reports.push({ file, status: response.status, bytes: remote.length, sha256: remoteHash });
  }
  return reports;
}

/**
 * Pack rows column by column.
 *
 * Written out row by row the same few hundred place names, networks and
 * magnitude scales repeat thousands of times. Listing each column's distinct
 * values once and referring to them by position is what keeps the file small.
 * A column whose values are nearly all different is written as it stands,
 * because a dictionary would save nothing.
 *
 * @param {object[]} rows the rows to pack
 * @returns {object} the packed form
 */
function pack(rows) {
  const fields = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!DERIVED.has(key)) fields.add(key);
  }

  const columns = {};
  for (const field of fields) {
    const values = rows.map((row) => (row[field] === undefined ? null : row[field]));
    /* Keyed on the value itself, so `null`, `1` and `'1'` stay three
       different things rather than collapsing into one. */
    const distinct = new Set(values);

    if (distinct.size <= Math.max(64, values.length / 8)) {
      const dictionary = [];
      const index = new Map();
      const codes = new Array(values.length);
      for (let i = 0; i < values.length; i += 1) {
        let code = index.get(values[i]);
        if (code === undefined) {
          code = dictionary.length;
          dictionary.push(values[i]);
          index.set(values[i], code);
        }
        codes[i] = code;
      }
      columns[field] = { d: dictionary, v: codes };
    } else {
      columns[field] = { r: values };
    }
  }
  return { n: rows.length, columns };
}

/**
 * Strip the module syntax so a file can be dropped into a classic script.
 * Everything it declares becomes an ordinary global, which is what lets one
 * copy of the dashboard serve both the served page and this file.
 *
 * @param {string} source the module source
 * @returns {string} the flattened source
 */
function flatten(source) {
  const flat = source
    .replace(/^import\s[^;]*;$/gm, '')
    .replace(/^export\s+default\s+[^;]*;$/gm, '')
    .replace(/^export\s*\{[^}]*\};$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?(?:function|const|class|let|var)\b)/gm, '');

  const leftover = flat.match(/^\s*(export|import)\s.*$/gm);
  if (leftover) {
    throw new Error(`module syntax survived flattening:\n${leftover.join('\n')}`);
  }
  return flat;
}

/**
 * Make a JSON string safe to sit inside a script element: a literal `<` would
 * let a value close the element early, and the two Unicode line separators
 * are not valid inside a JavaScript string. They are matched by character
 * code so this file never has to contain one.
 *
 * @param {unknown} value anything JSON can hold
 * @returns {string} the escaped JSON
 */
function safeJSON(value) {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .split('<')
    .join('\\u003c')
    .split(lineSeparator)
    .join('\\u2028')
    .split(paragraphSeparator)
    .join('\\u2029');
}

console.log(`Checking ${CDN_FILES.length} files on the CDN for version ${VERSION}...`);
const cdnReport = await checkCdn();
for (const report of cdnReport) {
  console.log(`  ${report.status} ${report.file} (${report.bytes} bytes) sha256 ${report.sha256.slice(0, 16)}...`);
}

const [quakes, meta, gridCss, pageCss, feedSrc, analysisSrc, statsSrc, dashSrc] = await Promise.all([
  readFile(join(root, 'data', 'snapshot', 'quakes.json'), 'utf8').then(JSON.parse),
  readFile(join(root, 'data', 'snapshot', 'meta.json'), 'utf8').then(JSON.parse),
  readFile(join(pkgDir, 'lattice-grid.min.css'), 'utf8'),
  readFile(join(root, 'styles.css'), 'utf8'),
  readFile(join(root, 'src', 'usgs-feed.js'), 'utf8'),
  /* Before the dashboard, because flattening turns every module into one
     script and a `const` is not hoisted: the file that declares a helper has to
     come before the file that calls it. */
  readFile(join(root, 'src', 'analysis.js'), 'utf8'),
  readFile(join(root, 'src', 'statistics.js'), 'utf8'),
  readFile(join(root, 'src', 'dashboard.js'), 'utf8'),
]);

const packed = { quakes: pack(quakes), meta: { ...meta, live: false } };

const bootstrap = `
/** Put the packed columns back together as ordinary rows. */
function unpack(packedRows) {
  var rows = new Array(packedRows.n);
  var entries = Object.entries(packedRows.columns);
  for (var i = 0; i < packedRows.n; i += 1) {
    var row = {};
    for (var e = 0; e < entries.length; e += 1) {
      var field = entries[e][0];
      var column = entries[e][1];
      row[field] = column.d ? column.d[column.v[i]] : column.r[i];
    }
    row.day = dayKey(row.time);
    row.count = 1;
    rows[i] = row;
  }
  return rows;
}

/** Say what went wrong, where a reader will see it. */
function showFailure(host, error) {
  host.textContent = '';
  var panel = document.createElement('div');
  panel.className = 'loading';
  var title = document.createElement('h1');
  title.textContent = 'The dashboard could not be shown';
  var message = document.createElement('p');
  message.className = 'loading-message';
  message.textContent = String((error && error.message) || error);
  panel.appendChild(title);
  panel.appendChild(message);
  host.appendChild(panel);
}

(function start() {
  var host = document.querySelector('#app');
  try {
    if (!window.LatticeGrid || !window.LatticeGrid.createGrid) {
      throw new Error('The grid could not be loaded. This page needs to be able to reach cdn.jsdelivr.net.');
    }
    var packedData = JSON.parse(document.getElementById('quake-data').textContent);
    var began = performance.now();
    var saved = unpack(packedData.quakes);
    /* The same shift the served page applies: the saved run is shown as
       though its newest event had just arrived, so the seven day window is
       never empty however long ago the file was built. */
    var shifted = shiftToNow(saved);
    var meta = Object.assign({}, packedData.meta, { shiftMs: shifted.shiftMs });
    var built = buildDashboard({
      root: host,
      createGrid: window.LatticeGrid.createGrid,
      createChart: window.LatticeGrid.createChart,
      createKPI: window.LatticeGridKPI.createKPI,
      createTabs: window.LatticeGridTabs.createTabs,
      createDataRouter: window.LatticeGridDataRouter.createDataRouter,
      createHeadlessGrid: window.LatticeGrid.createHeadlessGrid,
      rows: shifted.rows,
      meta: meta
    });
    built.meta = meta;
    built.timings = { mode: 'preview', rows: built.allGrid ? built.allGrid.rows.count() : 0, buildMs: Math.round(performance.now() - began) };
    built.ready = true;
    window.__quakeDemo = built;
    console.log('[earthquake demo] ready', built.timings);
  } catch (error) {
    window.__quakeDemo = { ready: false, error: String((error && error.message) || error) };
    showFailure(host, error);
  }
})();
`;

const html = `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Earthquakes around the world, and what the numbers say</title>
    <link rel="icon" href="data:," />
    <style>
${gridCss}
    </style>
    <style>
${pageCss}
    </style>
  </head>
  <body>
    <main id="app">
      <div class="loading">
        <h1>Earthquakes around the world, and what the numbers say</h1>
        <p class="loading-message">Starting...</p>
      </div>
    </main>

    <script id="quake-data" type="application/json">${safeJSON(packed)}</script>

${CDN_FILES.map((file) => `    <script src="${CDN}/${file}"></script>`).join('\n')}

    <script>
${flatten(feedSrc)}
${flatten(analysisSrc)}
${flatten(statsSrc)}
${flatten(dashSrc)}
${bootstrap}
    </script>
  </body>
</html>
`;

const out = join(root, 'preview.html');
await writeFile(out, html);
const { size } = await stat(out);
const mb = size / 1024 / 1024;
console.log(`\nWrote ${out}`);
console.log(`${mb.toFixed(2)} MB, ${quakes.length} earthquakes, library from ${CDN}`);
if (size > 16 * 1024 * 1024) {
  console.log('WARNING: over 16 MB.');
  process.exitCode = 1;
}
