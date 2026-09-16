/**
 * Load the demo in a real browser and check that it works.
 *
 * Serves the project and opens the saved copy, so the check never depends on
 * the USGS feeds being reachable. Beyond "it drew something", it asserts the
 * four things this demo exists to show:
 *
 *   - narrowing to the notable earthquakes moves the tiles and the charts;
 *   - a revised magnitude lands on the row it belongs to rather than adding
 *     a second one;
 *   - the rolling window drops an event older than seven days while keeping
 *     a fresh one that arrived in the same push;
 *   - every headline figure agrees with the saved feed data, recomputed here
 *     rather than read back off the page.
 *
 * It then opens a fresh copy and checks the Statistics tab, which is what this
 * edition exists for: that the five analyses draw, and that EVERY figure in
 * every verdict agrees with the same figure computed a second, independent way
 * in Node, from the raw rows the table is holding (`tools/crosscheck.mjs`, which
 * imports nothing the page uses). It then narrows to the notable earthquakes and
 * does the whole cross-check again, because a verdict that did not move when the
 * table did would be a verdict about nothing.
 *
 * It then blocks the feeds in the browser and opens the live page, to prove
 * a visitor gets the saved copy, and is told so, when USGS cannot be reached.
 *
 * `--all` also opens the live feeds and the single file preview from disk,
 * which need the internet, so they are not part of the deployment gate.
 *
 * Exits non-zero when any of that fails, so it can gate a deployment.
 *
 * Usage: node tools/verify.mjs [--all] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import * as check2 from './crosscheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const shotIndex = args.indexOf('--shots');
const shotDir = shotIndex >= 0 ? resolve(args[shotIndex + 1]) : null;
const all = args.includes('--all');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOTABLE_MAG = 4.5;
/* The grid's retention is a bound, not a guillotine: a row lives up to about
   a tenth of the span past it, plus one tick of the eviction timer. Counts
   near the boundary are checked against that range rather than a point. */
const SLACK_MS = WINDOW_MS * 0.1 + 1000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

/** The first browser on this machine that actually exists. */
async function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  throw new Error(`No browser found. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet CHROME_PATH to point at one.`);
}

/**
 * This check talks to the browser over a WebSocket, which Node only provides
 * as a global from version 22. Say so plainly rather than failing later with
 * an unexplained missing name.
 */
function requireModernNode() {
  if (typeof WebSocket === 'undefined') {
    throw new Error(
      `This check needs Node 22 or newer. You are running ${process.version}, which has no built in WebSocket.`,
    );
  }
}

/** A free TCP port, asked of the operating system. */
function freePort() {
  return new Promise((ok, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

const failures = [];
const notes = [];

/** Record a check and its outcome. */
function check(ok, description, detail) {
  if (ok) {
    notes.push(`  ok   ${description}${detail ? ` (${detail})` : ''}`);
  } else {
    failures.push(`${description}${detail ? ` (${detail})` : ''}`);
    notes.push(`  FAIL ${description}${detail ? ` (${detail})` : ''}`);
  }
}

let browser;
let browserPid = null;
let profile;
let server;

try {
  requireModernNode();
  const chromePath = await findChrome();
  const started = await startServer(0);
  server = started.server;
  const origin = `http://127.0.0.1:${started.port}`;
  console.log(`Browser: ${chromePath}`);
  console.log(`Serving: ${origin}`);

  profile = await mkdtemp(join(tmpdir(), 'quake-demo-verify-'));
  /* A port of the operating system's choosing, so two checks running side by
     side on one machine cannot land on the same debugging socket. */
  const port = await freePort();
  /* Its own process group, so the whole browser tree can be taken down
     together rather than leaving orphaned renderers behind. */
  browser = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  browserPid = browser.pid;
  browser.stderr.on('data', () => {});

  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) wsUrl = (await response.json()).webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(200);
  }
  if (!wsUrl) throw new Error('the browser never opened its debugging port');

  const socket = new WebSocket(wsUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = () => fail(new Error('could not attach to the browser'));
  });

  let nextId = 0;
  const pending = new Map();
  let consoleErrors = [];
  let pageErrors = [];

  /* A browser that goes away mid-run, killed from outside or crashed, would
     otherwise leave every call waiting for an answer that never comes. Fail
     the run instead of hanging it. */
  socket.onclose = () => {
    for (const { reject } of pending.values()) reject(new Error('the browser went away before it answered'));
    pending.clear();
  };

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id != null && pending.has(message.id)) {
      const { resolve: ok, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else ok(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
  };

  const send = (method, params = {}, sessionId) =>
    new Promise((ok, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: ok, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + (result.exceptionDetails.exception?.description || ''));
    }
    return result.result.value;
  };

  const waitFor = async (expression, timeout, what) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      let value;
      try {
        value = await evaluate(expression);
      } catch {}
      if (value) return value;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** Open a URL with a clean error log and wait for the dashboard to report in. */
  const open = async (url, label) => {
    consoleErrors = [];
    pageErrors = [];
    console.log(`\n--- ${label} ---\n${url}`);
    await call('Page.navigate', { url });
    await waitFor('!!(window.__quakeDemo)', 120000, `${label} to load`);
    const state = await evaluate('({ ready: window.__quakeDemo.ready, error: window.__quakeDemo.error || null })');
    if (!state.ready) throw new Error(`${label} reported a failure: ${state.error}`);
    await waitFor('window.__quakeDemo.allGrid && window.__quakeDemo.allGrid.rows.count() > 0', 60000, `${label} rows`);
  };

  /** Save a screenshot, when a directory was asked for. */
  const shoot = async (name) => {
    if (!shotDir) return;
    await mkdir(shotDir, { recursive: true });
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`  shot ${file}`);
  };

  /** Complain about anything the page logged. */
  const noErrors = (label) => {
    check(consoleErrors.length === 0, `${label}: no console errors`, consoleErrors.slice(0, 3).join(' | '));
    check(pageErrors.length === 0, `${label}: no page errors`, pageErrors.slice(0, 3).join(' | '));
  };

  /* =================================================================== */
  /* 1. The saved copy: the deterministic run, where the figures are      */
  /*    cross-checked against the saved feed data.                        */
  /* =================================================================== */

  await open(`${origin}/index.html?source=snapshot`, 'saved copy');

  const snap = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      total: d.allGrid.rows.totalCount(),
      columns: d.allGrid.columns.visible().length,
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      shiftMs: d.meta.shiftMs || 0,
      charts: d.charts.length,
      watermark: d.allGrid.licence.watermark(),
      licenceState: d.allGrid.licence.state(),
      tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      named: document.querySelector('.kpi-named-value').textContent,
    };
  })()`);
  console.log(`  ${snap.rows} rows, ${snap.columns} columns, ${snap.painted} painted, ${snap.charts} charts`);
  console.log(`  tiles: ${JSON.stringify(snap.tiles)}`);

  check(snap.rows > 0, 'saved copy: the table holds rows', `${snap.rows}`);
  check(snap.painted > 0, 'saved copy: the table painted rows', `${snap.painted}`);
  check(snap.charts === 4, 'saved copy: all four charts were built', `${snap.charts}`);

  /* Built is not drawn. A chart whose points all carry a null measure puts an
     empty pair of axes on the page and reports no error, so each one is asked
     what it actually plotted. */
  const drawn = await evaluate(`(() => window.__quakeDemo.charts.map((c, i) => {
    const data = c.data();
    const series = (data && data.series) || [];
    const points = series.reduce((n, s) => n + ((s.points || []).length), 0);
    const withValue = series.reduce((n, s) => n + (s.points || []).filter((p) => p.y != null && p.y !== 0).length, 0);
    const svg = c.element;
    const marks = svg ? svg.querySelectorAll('rect, circle').length : 0;
    return { i, points, withValue, marks };
  }))()`);
  for (const c of drawn) {
    console.log(`  chart ${c.i}: ${c.points} points, ${c.withValue} with a value, ${c.marks} marks`);
    check(c.withValue > 0, `saved copy: chart ${c.i} plotted values rather than empty axes`, `${c.withValue} of ${c.points} points carry a measure`);
    check(c.marks > 2, `saved copy: chart ${c.i} drew marks`, `${c.marks} marks`);
  }
  check(snap.watermark === false, 'saved copy: no watermark on localhost', `state ${snap.licenceState}`);
  noErrors('saved copy');
  await shoot('01-grid-saved');

  /* The independent recomputation: the saved rows, shifted the same way the
     page shifted them, reduced here in Node. */
  const savedRows = JSON.parse(await readFile(join(root, 'data', 'snapshot', 'quakes.json'), 'utf8'));
  const shifted = savedRows.map((row) => ({ ...row, time: row.time + snap.shiftMs }));
  const now = Date.now();
  const strict = shifted.filter((row) => now - row.time <= WINDOW_MS);
  const slack = shifted.filter((row) => now - row.time <= WINDOW_MS + SLACK_MS);

  const maxMag = (list) => list.reduce((m, r) => (typeof r.mag === 'number' && r.mag > m ? r.mag : m), -Infinity);
  const expectedNotable24 = shifted.filter(
    (row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG && row.time >= now - DAY_MS,
  ).length;

  check(
    snap.tiles.events >= strict.length && snap.tiles.events <= slack.length,
    'saved copy: the event count matches the saved feed',
    `tile ${snap.tiles.events}, expected between ${strict.length} and ${slack.length}`,
  );
  check(
    snap.tiles.largest >= maxMag(strict) - 1e-9 && snap.tiles.largest <= maxMag(slack) + 1e-9,
    'saved copy: the largest magnitude matches the saved feed',
    `tile ${snap.tiles.largest}, expected between ${maxMag(strict)} and ${maxMag(slack)}`,
  );
  check(
    snap.tiles.notable24 === expectedNotable24,
    `saved copy: the M${NOTABLE_MAG}+ in 24 hours count matches the saved feed`,
    `tile ${snap.tiles.notable24}, expected ${expectedNotable24}`,
  );

  const newest = shifted.reduce((m, r) => (r.time > m ? r.time : m), 0);
  const expectedSince = Math.round((now - newest) / 60000);
  check(
    Math.abs(snap.tiles.sinceLatest - expectedSince) <= 2,
    'saved copy: minutes since the latest event matches the saved feed',
    `tile ${snap.tiles.sinceLatest}, expected about ${expectedSince}`,
  );
  check(
    /^M\d/.test(snap.named),
    'saved copy: the largest earthquake is named',
    snap.named,
  );

  /* ---- narrowing to the notable earthquakes moves the tiles and charts ---- */

  const before = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      events: d.kpi.value('events'),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
    };
  })()`);

  await evaluate('window.__quakeDemo.notableButton.click()');
  await sleep(700);

  const after = await evaluate(`(() => {
    const d = window.__quakeDemo;
    return {
      rows: d.allGrid.rows.count(),
      events: d.kpi.value('events'),
      pressed: d.notableButton.getAttribute('aria-pressed'),
      chartRows: d.charts.map((c) => { const data = c.data(); return data ? JSON.stringify(data).length : 0; }),
      minMag: (() => { let m = Infinity; d.allGrid.rows.forEach((r) => { if (r && r.data && typeof r.data.mag === 'number' && r.data.mag < m) m = r.data.mag; }); return m; })(),
    };
  })()`);

  const expectedNotable = strict.filter((row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG).length;
  const expectedNotableSlack = slack.filter((row) => typeof row.mag === 'number' && row.mag >= NOTABLE_MAG).length;

  console.log(`  narrowed: ${before.rows} rows -> ${after.rows} rows, tile ${before.events} -> ${after.events}`);
  check(after.pressed === 'true', 'the notable filter reports itself pressed');
  check(after.rows < before.rows, 'the notable filter narrows the table', `${before.rows} -> ${after.rows}`);
  check(after.events < before.events, 'the notable filter moves the event tile', `${before.events} -> ${after.events}`);
  check(
    after.events >= expectedNotable && after.events <= expectedNotableSlack,
    `the narrowed tile matches the saved feed's M${NOTABLE_MAG}+ count`,
    `tile ${after.events}, expected between ${expectedNotable} and ${expectedNotableSlack}`,
  );
  check(after.minMag >= NOTABLE_MAG, 'every remaining row is above the threshold', `smallest ${after.minMag}`);
  const chartsMoved = after.chartRows.filter((size, i) => size !== before.chartRows[i]).length;
  check(chartsMoved > 0, 'the charts rebound to the narrowed data', `${chartsMoved} of ${after.chartRows.length} changed`);
  await shoot('02-charts-filtered');

  await evaluate('window.__quakeDemo.notableButton.click()');
  await sleep(500);
  const restored = await evaluate('window.__quakeDemo.allGrid.rows.count()');
  check(restored === before.rows, 'removing the filter restores the table', `${restored} of ${before.rows}`);

  /* ---- a revision lands on the row it belongs to ---- */

  const revision = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    let target = null;
    d.allGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.mag === 'number') target = r.data; });
    const before = { count: d.allGrid.rows.count(), id: target.id, mag: target.mag };
    d.ingest([{ ...target, mag: Number((target.mag + 1.7).toFixed(1)), updated: target.updated + 1000 }]);
    await new Promise((r) => setTimeout(r, 400));
    let found = null;
    d.allGrid.rows.forEach((r) => { if (r && r.data && r.data.id === before.id) found = r.data; });
    return { before, after: { count: d.allGrid.rows.count(), mag: found ? found.mag : null }, expected: Number((before.mag + 1.7).toFixed(1)) };
  })()`);
  console.log(`  revision: ${revision.before.id} M${revision.before.mag} -> M${revision.after.mag}, rows ${revision.before.count} -> ${revision.after.count}`);
  check(
    revision.after.count === revision.before.count,
    'a revision updates the row rather than adding one',
    `${revision.before.count} -> ${revision.after.count}`,
  );
  check(
    revision.after.mag === revision.expected,
    'the revised magnitude is on the row',
    `expected ${revision.expected}, found ${revision.after.mag}`,
  );

  /* ---- a stale revision is dropped, a newer one is kept ---- */

  const ordering = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    let target = null;
    d.allGrid.rows.forEach((r) => { if (!target && r && r.data && typeof r.data.mag === 'number') target = r.data; });
    const held = { id: target.id, mag: target.mag, updated: target.updated };
    const droppedBefore = d.router.dropped || 0;
    /* An older copy of the same event: its revision stamp is behind the one
       already applied, so it must not undo the correction. */
    d.router.apply([{ op: 'upsert', row: { ...target, mag: 0.1, updated: held.updated - 60000 } }]);
    await new Promise((r) => setTimeout(r, 300));
    let found = null;
    d.allGrid.rows.forEach((r) => { if (r && r.data && r.data.id === held.id) found = r.data; });
    return { held, mag: found ? found.mag : null, dropped: (d.router.dropped || 0) - droppedBefore };
  })()`);
  check(
    ordering.mag === ordering.held.mag,
    'an out of order revision does not undo a correction',
    `magnitude stayed ${ordering.mag}`,
  );
  check(ordering.dropped >= 1, 'the router counted the stale revision it dropped', `${ordering.dropped}`);

  /* ---- the rolling window drops what is too old, and keeps what is not ---- */

  /*
   * Both rows go in inside the window, so both must be admitted. One of them
   * is three seconds from the far edge of it. Waiting for it to cross and
   * rolling the window forward has to take that one out and leave the other,
   * which is the window ageing a row out rather than a push being refused.
   */
  const window7 = await evaluate(`(async () => {
    const d = window.__quakeDemo;
    const now = Date.now();
    const WINDOW = 7 * 24 * 60 * 60 * 1000;
    const base = { updated: now, magType: 'ml', place: 'Window check', depth: 10, lat: 0, lng: 0,
      alert: 'none', tsunami: false, felt: null, cdi: null, mmi: null, sig: 1, net: 'zz',
      status: 'automatic', kind: 'earthquake', url: null, significant: false, count: 1 };
    const present = () => {
      const seen = { fresh: false, expiring: false };
      d.allGrid.rows.forEach((r) => {
        if (!r || !r.data) return;
        if (r.data.id === 'window-check-fresh') seen.fresh = true;
        if (r.data.id === 'window-check-expiring') seen.expiring = true;
      });
      return seen;
    };
    const held = (id) => !!d.allGrid.rows.byKey(id);
    d.ingest([
      { ...base, id: 'window-check-fresh', mag: 3.1, time: now - 60000, day: '' },
      { ...base, id: 'window-check-expiring', mag: 3.2, time: now - WINDOW + 3000, day: '' },
    ]);
    await new Promise((r) => setTimeout(r, 200));
    const admitted = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring') };
    const totalBefore = d.allGrid.rows.totalCount();

    await new Promise((r) => setTimeout(r, 4000));
    const dropped = d.pruneWindow();
    await new Promise((r) => setTimeout(r, 300));
    const settled = { fresh: held('window-check-fresh'), expiring: held('window-check-expiring') };
    const totalAfter = d.allGrid.rows.totalCount();

    /* The walk is read separately. A removed row stays in rows.forEach until
       the next row change arrives, so it is checked after one. */
    const walkedBeforeNextChange = present();
    d.ingest([{ ...base, id: 'window-check-nudge', mag: 1.0, time: Date.now() - 1000, day: '' }]);
    await new Promise((r) => setTimeout(r, 400));
    return { admitted, settled, dropped, totalBefore, totalAfter, walkedBeforeNextChange, walkedAfterNextChange: present() };
  })()`);
  console.log(`  window: admitted ${JSON.stringify(window7.admitted)}, after crossing ${JSON.stringify(window7.settled)}, dropped ${window7.dropped}, total ${window7.totalBefore} -> ${window7.totalAfter}`);
  console.log(`  window: walk before the next change ${JSON.stringify(window7.walkedBeforeNextChange)}, after it ${JSON.stringify(window7.walkedAfterNextChange)}`);
  check(
    window7.admitted.fresh === true && window7.admitted.expiring === true,
    'the window admits both rows while both are inside it',
    JSON.stringify(window7.admitted),
  );
  check(
    window7.settled.expiring === false && window7.dropped >= 1,
    'the rolling window drops an event once it passes seven days',
    `${window7.dropped} dropped, the table no longer holds it`,
  );
  check(
    window7.totalAfter < window7.totalBefore,
    'the dropped event leaves the table',
    `${window7.totalBefore} -> ${window7.totalAfter}`,
  );
  check(
    window7.settled.fresh === true,
    'the rolling window keeps the event that is still inside it',
    'the control row is still in the table',
  );
  check(
    window7.walkedAfterNextChange.expiring === false,
    'the dropped event is gone from the rows the table walks',
    'checked after the next change, because a removal leaves the walk stale until then',
  );

  /* ---- grouping, and the significant tab ---- */

  await evaluate("window.__quakeDemo.allGrid.columns.group(['alert'])");
  await sleep(600);
  const grouped = await evaluate(`(() => {
    const d = window.__quakeDemo;
    let groups = 0;
    d.allGrid.rows.forEach((r) => { if (r && r.group) groups += 1; });
    return { groups, rows: d.allGrid.rows.count() };
  })()`);
  check(grouped.groups > 0, 'grouping by PAGER alert produces group rows', `${grouped.groups} groups`);
  await shoot('03-grouped-by-alert');
  await evaluate('window.__quakeDemo.allGrid.columns.group([])');
  await sleep(400);

  await evaluate("window.__quakeDemo.tabs.activate('significant')");
  await waitFor('window.__quakeDemo.significantGrid && window.__quakeDemo.significantGrid.rows.count() > 0', 30000, 'the significant table');
  const significant = await evaluate(`(() => {
    const d = window.__quakeDemo;
    let allSignificant = true;
    d.significantGrid.rows.forEach((r) => { if (r && r.data && r.data.significant !== true) allSignificant = false; });
    return { rows: d.significantGrid.rows.count(), allSignificant };
  })()`);
  const expectedSignificant = savedRows.filter((row) => row.significant).length;
  console.log(`  significant table: ${significant.rows} rows, saved feed holds ${expectedSignificant}`);
  check(significant.rows > 0, 'the significant table holds rows', `${significant.rows}`);
  check(significant.allSignificant, 'the significant table holds only significant earthquakes');
  check(
    significant.rows === expectedSignificant,
    'the significant table matches the saved significant feed',
    `${significant.rows} against ${expectedSignificant}`,
  );
  await shoot('04-significant-tab');
  noErrors('saved copy, after the checks');


  /* =================================================================== */
  /* 2. The Statistics tab: five analyses, and every verdict figure       */
  /*    computed a second way here and compared.                          */
  /* =================================================================== */

  /*
   * A fresh page. The checks above deliberately push rows in and take rows out
   * to exercise the window and the revision path, and one of those rows carries
   * no calendar day at all; cross-checking the statistics against a table that
   * has been prodded like that would be checking the prodding. So this section
   * starts again on an untouched copy.
   */
  await open(`${origin}/index.html?source=snapshot`, 'saved copy, for the statistics tab');

  /** Open the statistics tab and wait for a pass to land. */
  const openStatistics = async () => {
    await evaluate("window.__quakeDemo.tabs.activate('statistics')");
    await waitFor(
      'window.__quakeDemo.statistics && window.__quakeDemo.statistics.state.passes > 0',
      30000,
      'the statistics tab',
    );
    await sleep(400);
  };

  /** The rows the table is holding, raw: the input both sides work from. */
  const tableRows = () => evaluate(`(() => {
    const out = [];
    window.__quakeDemo.allGrid.rows.forEach((r) => {
      if (!r || r.group || !r.data) return;
      const d = r.data;
      out.push({ id: d.id, time: d.time, mag: d.mag, depth: d.depth, net: d.net,
        place: d.place, lat: d.lat, lng: d.lng });
    });
    return out;
  })()`);

  /** What the panel says, and what it drew. */
  const panelState = () => evaluate(`(() => {
    const p = window.__quakeDemo.statistics;
    const plots = [...document.querySelectorAll('.stats-plot')];
    return {
      rows: p.state.rows,
      passes: p.state.passes,
      error: p.state.error,
      groupBy: p.state.groupBy,
      analyses: p.state.analyses,
      verdicts: p.state.verdicts.map((v) => v.text),
      sources: p.state.verdicts.map((v) => v.source),
      cards: [...document.querySelectorAll('.stats-card')].map((n) => n.dataset.analysis),
      plots: plots.length,
      marks: plots.map((box) => {
        const svg = box.querySelector('svg');
        return svg ? svg.querySelectorAll('rect, circle, path, line, polygon, polyline').length : 0;
      }),
      fitLines: plots.map((box) => {
        const svg = box.querySelector('svg');
        return svg ? svg.querySelectorAll('path').length : 0;
      }),
      chartErrors: [...document.querySelectorAll('.chart-error')].map((n) => n.textContent),
      figures: [...document.querySelectorAll('.stats-figures dd')].length,
    };
  })()`);

  await openStatistics();

  /**
   * Compare a figure the page shows with the same figure computed here.
   *
   * The tolerance is relative, so a b-value and a control limit can be held to
   * the same standard without one of them being checked to the wrong precision.
   */
  const agrees = (label, shown, computed, tolerance = 1e-6, unit = '') => {
    if (shown == null || computed == null) {
      check(false, `cross-check: ${label}`, `page ${shown}, computed ${computed}`);
      return;
    }
    const scale = Math.max(Math.abs(computed), 1e-9);
    const off = Math.abs(shown - computed) / scale;
    check(
      off <= tolerance,
      `cross-check: ${label}`,
      `page ${Number(shown).toPrecision(8)}${unit}, computed ${Number(computed).toPrecision(8)}${unit}, off by ${(off * 100).toPrecision(2)}%`,
    );
  };

  /**
   * Every figure in every verdict, worked out again from the raw rows and
   * compared with what the page put on screen.
   *
   * @param {string} tag which run this is, for the check names
   * @returns {Promise<object>} the panel state, for the comparisons between runs
   */
  const crossCheckStatistics = async (tag) => {
    const rows = await tableRows();
    const state = await panelState();

    check(state.error === null, `${tag}: the statistics tab computed without error`, String(state.error));
    check(state.rows === rows.length, `${tag}: the panel read every row the table holds`, `${state.rows} of ${rows.length}`);
    check(
      state.cards.length === 5,
      `${tag}: all five analyses are on the page`,
      state.cards.join(', '),
    );
    check(state.chartErrors.length === 0, `${tag}: no analysis failed to draw`, state.chartErrors.slice(0, 2).join(' | '));
    check(state.plots > 0, `${tag}: the analyses put charts on the page`, `${state.plots} plots`);
    for (let i = 0; i < state.marks.length; i += 1) {
      check(state.marks[i] > 2, `${tag}: plot ${i} drew marks`, `${state.marks[i]} marks`);
    }
    check(state.figures > 0, `${tag}: the figures are stated with their source`, `${state.figures} figures`);

    const a = state.analyses;

    /* ---- 1. the b-value ---- */

    if (a.magnitudeFrequency && a.magnitudeFrequency.ok) {
      const modal = check2.modalBand(rows);
      const shownMcCount = modal.counts.get(a.magnitudeFrequency.completeness);
      check(
        shownMcCount === modal.count,
        `${tag}: the completeness magnitude is a modal band`,
        `M${a.magnitudeFrequency.completeness} holds ${shownMcCount}, the fullest band holds ${modal.count}`,
      );
      const mine = check2.bValue(rows, a.magnitudeFrequency.completeness);
      check(
        mine.bands === a.magnitudeFrequency.bands,
        `${tag}: the same magnitude bands were fitted`,
        `page ${a.magnitudeFrequency.bands}, computed ${mine.bands}`,
      );
      /* The per-band counts the page charted, against the counts here. */
      let countsAgree = true;
      for (const [band, n] of a.magnitudeFrequency.points) {
        if (modal.counts.get(band) !== n) countsAgree = false;
      }
      check(countsAgree, `${tag}: every band's count matches`, `${a.magnitudeFrequency.points.length} bands`);
      agrees(`${tag}: the b-value`, a.magnitudeFrequency.b, mine.b, 1e-9);
      agrees(`${tag}: the b-value's lower bound`, a.magnitudeFrequency.bLower, mine.bLower, 1e-6);
      agrees(`${tag}: the b-value's upper bound`, a.magnitudeFrequency.bUpper, mine.bUpper, 1e-6);
      agrees(`${tag}: the b-value fit's R²`, a.magnitudeFrequency.r2, mine.r2, 1e-9);
    } else {
      check(false, `${tag}: the b-value was computed`, String(a.magnitudeFrequency && a.magnitudeFrequency.reason));
    }

    /* ---- 2. the gaps ---- */

    if (a.interArrival && a.interArrival.ok) {
      const mine = check2.gaps(rows);
      check(
        mine.length === a.interArrival.n,
        `${tag}: the same number of gaps were measured`,
        `page ${a.interArrival.n}, computed ${mine.length}`,
      );
      const interval = check2.meanInterval(mine, 0.95);
      agrees(`${tag}: the mean gap`, a.interArrival.mean, interval.mean, 1e-9, ' min');
      agrees(`${tag}: the mean gap's lower bound`, a.interArrival.lower, interval.lower, 1e-6, ' min');
      agrees(`${tag}: the mean gap's upper bound`, a.interArrival.upper, interval.upper, 1e-6, ' min');
      agrees(`${tag}: the median gap`, a.interArrival.median, check2.quantile(mine, 0.5), 1e-9, ' min');
      agrees(`${tag}: the 95th percentile gap`, a.interArrival.p95, check2.quantile(mine, 0.95), 1e-9, ' min');
      agrees(`${tag}: Jarque-Bera on the gaps`, a.interArrival.jarqueBera, check2.jarqueBera(mine), 1e-6);
      agrees(`${tag}: the gaps' skewness`, a.interArrival.skewness, check2.skewness(mine), 1e-6);
      check(
        a.interArrival.notNormal === check2.jarqueBera(mine) > 5.99,
        `${tag}: the normality verdict follows the statistic`,
        `page says ${a.interArrival.notNormal ? 'not normal' : 'normal'} at ${a.interArrival.jarqueBera.toFixed(1)}`,
      );
      /* The exponential the verdict compares against is stated as a model, and
         its median and p95 follow from the mean the grid reported. */
      agrees(`${tag}: the model's median`, a.interArrival.modelMedian, a.interArrival.mean * Math.LN2, 1e-12, ' min');
      agrees(`${tag}: the model's 95th percentile`, a.interArrival.modelP95, a.interArrival.mean * Math.log(20), 1e-12, ' min');
    } else {
      check(false, `${tag}: the gaps were measured`, String(a.interArrival && a.interArrival.reason));
    }

    /* ---- 3. the aftershock decay ---- */

    const mineOmori = check2.omori(rows);
    if (a.aftershockDecay && a.aftershockDecay.ok) {
      check(mineOmori.ok, `${tag}: a sequence was found on both sides`);
      check(
        mineOmori.ok && mineOmori.mainshock.id === a.aftershockDecay.mainshock.id,
        `${tag}: the same mainshock was chosen`,
        `page ${a.aftershockDecay.mainshock.id}, computed ${mineOmori.ok ? mineOmori.mainshock.id : 'none'}`,
      );
      check(
        mineOmori.aftershocks === a.aftershockDecay.aftershocks,
        `${tag}: the same aftershocks were counted`,
        `page ${a.aftershockDecay.aftershocks}, computed ${mineOmori.aftershocks}`,
      );
      agrees(`${tag}: the decay exponent`, a.aftershockDecay.p, mineOmori.p, 1e-9);
      agrees(`${tag}: the decay exponent's lower bound`, a.aftershockDecay.pLower, mineOmori.pLower, 1e-6);
      agrees(`${tag}: the decay exponent's upper bound`, a.aftershockDecay.pUpper, mineOmori.pUpper, 1e-6);
      agrees(`${tag}: the decay fit's R²`, a.aftershockDecay.r2, mineOmori.r2, 1e-9);
      check(
        state.fitLines[0] >= 2 && state.fitLines[4] >= 2,
        `${tag}: both regression charts drew a fitted line and a band`,
        `magnitude fit ${state.fitLines[0]} paths, decay fit ${state.fitLines[4]} paths`,
      );
    } else {
      check(
        !mineOmori.ok,
        `${tag}: no sequence is quoted, and none was found here either`,
        `page ${a.aftershockDecay && a.aftershockDecay.reason}, computed ${mineOmori.ok ? 'found one' : 'found none'}`,
      );
    }

    /* ---- 4. depth by group ---- */

    if (a.depthByGroup && a.depthByGroup.ok) {
      const depths = rows.map((r) => r.depth);
      agrees(`${tag}: the mean depth`, a.depthByGroup.rawMean, check2.mean(depths), 1e-9, ' km');
      agrees(`${tag}: the trimmed mean depth`, a.depthByGroup.trimmedMean, check2.trimmedMean(depths), 1e-9, ' km');
      const flagged = check2.modifiedZOutliers(depths);
      check(
        a.depthByGroup.flagged === flagged.flagged,
        `${tag}: the same depths are flagged as outliers`,
        `page ${a.depthByGroup.flagged}, computed ${flagged.flagged} (median ${flagged.median.toFixed(3)}, MAD ${flagged.mad.toFixed(3)})`,
      );
      check(
        a.depthByGroup.scanned === depths.filter((d) => typeof d === 'number').length,
        `${tag}: the outlier scan covered every depth`,
        `page ${a.depthByGroup.scanned}`,
      );
      const key = a.depthByGroup.groupBy === 'region'
        ? (row) => check2.regionOf(row.place)
        : (row) => row.net;
      for (const group of a.depthByGroup.groups) {
        const values = rows.filter((row) => key(row) === group.key).map((row) => row.depth);
        check(
          values.length === group.n,
          `${tag}: ${group.key} holds the same earthquakes`,
          `page ${group.n}, computed ${values.length}`,
        );
        agrees(`${tag}: ${group.key} median depth`, group.median, check2.quantile(values, 0.5), 1e-9, ' km');
        agrees(`${tag}: ${group.key} mean depth`, group.raw, check2.mean(values), 1e-9, ' km');
        agrees(`${tag}: ${group.key} trimmed mean depth`, group.trimmed, check2.trimmedMean(values), 1e-9, ' km');
      }
    } else {
      check(false, `${tag}: depth was compared by group`, String(a.depthByGroup && a.depthByGroup.reason));
    }

    /* ---- 5. the daily control chart ---- */

    if (a.dailyControl && a.dailyControl.ok) {
      const all = check2.perDay(rows);
      const whole = all.slice(1, -1);
      check(
        whole.length === a.dailyControl.days.length,
        `${tag}: the same whole days were charted`,
        `page ${a.dailyControl.days.length}, computed ${whole.length}`,
      );
      let daysAgree = true;
      for (let i = 0; i < whole.length; i += 1) {
        const shown = a.dailyControl.days[i];
        if (!shown || shown[0] !== whole[i][0] || shown[1] !== whole[i][1]) daysAgree = false;
      }
      check(
        daysAgree,
        `${tag}: every day's count matches`,
        `${whole.map(([d, n]) => `${d}:${n}`).join(' ')}`,
      );
      const limits = check2.controlLimits(whole.map(([, n]) => n));
      agrees(`${tag}: the control chart's centre line`, a.dailyControl.centre, limits.centre, 1e-9);
      agrees(`${tag}: the control chart's sigma`, a.dailyControl.sigma, limits.sigma, 1e-9);
      agrees(`${tag}: the upper control limit`, a.dailyControl.upper, limits.upper, 1e-9);
      agrees(`${tag}: the lower control limit`, a.dailyControl.lower, limits.lower, 1e-9);
      const beyond = limits.breaches.map((b) => whole[b.index][0]);
      const named = a.dailyControl.breaches
        .filter((b) => b.rules.some((r) => /three sigma/.test(r)))
        .map((b) => b.day);
      check(
        beyond.length === named.length && beyond.every((day) => named.includes(day)),
        `${tag}: the days beyond three sigma are the same days`,
        `page [${named.join(', ')}], computed [${beyond.join(', ')}]`,
      );
    } else {
      check(false, `${tag}: the daily control chart was computed`, String(a.dailyControl && a.dailyControl.reason));
    }

    /* ---- the verdicts are words, and they carry their source ---- */

    check(state.verdicts.length >= 5, `${tag}: the verdict panel is written out`, `${state.verdicts.length} sentences`);
    check(
      state.verdicts.every((text) => /[.]$/.test(text.trim()) && text.length > 60),
      `${tag}: every verdict is a sentence rather than a number`,
    );
    check(
      state.sources.every((source) => source && source.length > 3),
      `${tag}: every verdict names where its figures came from`,
    );

    return state;
  };

  const wide = await crossCheckStatistics('statistics, everything in view');
  noErrors('statistics tab');
  await shoot('05-statistics');

  /* ---- grouping the depth comparison by region rather than network ---- */

  await evaluate("window.__quakeDemo.statistics.setGroupBy('region')");
  await sleep(900);
  const byRegion = await crossCheckStatistics('statistics, depth by region');
  check(
    byRegion.analyses.depthByGroup.groupBy === 'region',
    'the depth comparison regrouped by region',
    byRegion.analyses.depthByGroup.groups.map((g) => g.key).join(', '),
  );
  check(
    byRegion.analyses.depthByGroup.groups.map((g) => g.key).join(',') !==
      wide.analyses.depthByGroup.groups.map((g) => g.key).join(','),
    'regrouping produced different groups',
  );
  await evaluate("window.__quakeDemo.statistics.setGroupBy('net')");
  await sleep(700);

  /* ---- narrowing to the notable earthquakes moves every verdict ---- */

  await evaluate('window.__quakeDemo.toggleNotable()');
  await sleep(1200);
  const narrow = await crossCheckStatistics('statistics, only the notable');

  check(
    narrow.rows < wide.rows,
    'narrowing moves the rows the statistics are computed over',
    `${wide.rows} -> ${narrow.rows}`,
  );
  check(
    narrow.analyses.magnitudeFrequency.completeness > wide.analyses.magnitudeFrequency.completeness,
    'narrowing raises the completeness magnitude',
    `M${wide.analyses.magnitudeFrequency.completeness} -> M${narrow.analyses.magnitudeFrequency.completeness}`,
  );
  check(
    narrow.analyses.magnitudeFrequency.b !== wide.analyses.magnitudeFrequency.b,
    'narrowing moves the b-value',
    `${wide.analyses.magnitudeFrequency.b.toFixed(3)} -> ${narrow.analyses.magnitudeFrequency.b.toFixed(3)}`,
  );
  /*
   * About thirty times fewer earthquakes must mean about thirty times longer
   * between them. The check is on the direction and the order of magnitude, not
   * on a ratio: the notable earthquakes are not a random sample of the rest.
   */
  const ratioRows = wide.rows / narrow.rows;
  const ratioGap = narrow.analyses.interArrival.mean / wide.analyses.interArrival.mean;
  check(
    ratioGap > ratioRows / 3 && ratioGap < ratioRows * 3,
    'narrowing lengthens the mean gap in proportion to the rows it removed',
    `rows fell ${ratioRows.toFixed(1)}x, the mean gap rose ${ratioGap.toFixed(1)}x`,
  );
  check(
    narrow.analyses.depthByGroup.rawMean > wide.analyses.depthByGroup.rawMean,
    'narrowing to the notable earthquakes deepens the mean depth',
    `${wide.analyses.depthByGroup.rawMean.toFixed(1)} km -> ${narrow.analyses.depthByGroup.rawMean.toFixed(1)} km`,
  );
  check(
    narrow.analyses.dailyControl.centre < wide.analyses.dailyControl.centre,
    'narrowing lowers the daily control chart centre line',
    `${wide.analyses.dailyControl.centre.toFixed(0)} -> ${narrow.analyses.dailyControl.centre.toFixed(0)} a day`,
  );
  const changed = narrow.verdicts.filter((text, i) => text !== wide.verdicts[i]).length;
  check(
    changed >= 5,
    'narrowing rewrites the verdicts rather than leaving them stale',
    `${changed} of ${wide.verdicts.length} sentences changed`,
  );
  noErrors('statistics tab, narrowed');
  await shoot('06-statistics-narrowed');

  await evaluate('window.__quakeDemo.toggleNotable()');
  await sleep(1000);
  const restoredStats = await crossCheckStatistics('statistics, the filter removed');
  check(
    restoredStats.rows === wide.rows,
    'removing the filter restores the statistics to what they were',
    `${restoredStats.rows} of ${wide.rows}`,
  );
  agrees('the b-value returns to what it was', restoredStats.analyses.magnitudeFrequency.b, wide.analyses.magnitudeFrequency.b, 1e-12);

  const watermarked = await evaluate('window.__quakeDemo.allGrid.licence.watermark()');
  check(watermarked === false, 'statistics tab: no watermark on localhost');

  /* =================================================================== */
  /* 3. What a visitor gets when the USGS feeds cannot be reached.       */
  /* =================================================================== */

  /*
   * The feeds are blocked in the browser rather than asked politely to fail,
   * so this exercises the same path a real outage takes and the demo carries
   * no test only code. A failed request does log to the console, so the check
   * here is that nothing was thrown and the saved copy is on screen saying so.
   */
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['*earthquake.usgs.gov*'] });
  await open(`${origin}/index.html`, 'live page, with the feeds unreachable');
  const fallback = await evaluate(`(() => {
    const d = window.__quakeDemo;
    const notice = document.querySelector('.notice');
    const pill = document.querySelector('.head-note .pill');
    const freshness = document.querySelector('.freshness');
    return {
      rows: d.allGrid.rows.totalCount(),
      painted: document.querySelectorAll('.lattice [role="row"]').length,
      fellBack: !!(d.timings && d.timings.fellBack),
      mode: d.timings && d.timings.mode,
      badge: pill ? pill.textContent.trim() : null,
      notice: notice ? notice.textContent.trim() : null,
      savedOnShown: freshness ? /saved on/i.test(freshness.textContent) : false,
      polling: !!d.poller,
    };
  })()`);
  console.log(`  rows ${fallback.rows}, badge "${fallback.badge}", fell back: ${fallback.fellBack}`);
  console.log(`  notice: ${fallback.notice}`);
  check(fallback.rows > 0, 'fallback: the saved copy is on screen', `${fallback.rows} rows`);
  check(fallback.painted > 0, 'fallback: the table painted rows', `${fallback.painted}`);
  check(fallback.fellBack, 'fallback: the page recorded that it fell back to the saved copy');
  check(fallback.mode === 'live', 'fallback: the page ran in the live default, not snapshot mode', `mode ${fallback.mode}`);
  check(fallback.badge === 'Saved copy', 'fallback: the badge reads "Saved copy"', `"${fallback.badge}"`);
  check(
    !!fallback.notice && /could not be reached/i.test(fallback.notice),
    'fallback: the page says the feeds were unreachable',
    fallback.notice,
  );
  check(fallback.savedOnShown, "fallback: the saved copy's date is shown");
  check(!fallback.polling, 'fallback: no poll is started against feeds that could not be reached');
  check(pageErrors.length === 0, 'fallback: no page errors', pageErrors.slice(0, 3).join(' | '));
  await shoot('05-fallback');
  await call('Network.setBlockedURLs', { urls: [] });

  if (all) {
    /* ================================================================= */
    /* 4. Live.                                                          */
    /* ================================================================= */

    await open(`${origin}/index.html`, 'live');
    const live = await evaluate(`(() => {
      const d = window.__quakeDemo;
      return {
        rows: d.allGrid.rows.count(),
        charts: d.charts.length,
        fellBack: !!(d.timings && d.timings.fellBack),
        watermark: d.allGrid.licence.watermark(),
        freshness: document.querySelector('.freshness').textContent,
        tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      };
    })()`);
    console.log(`  ${live.rows} rows from the live feeds; ${live.freshness}`);
    check(live.fellBack === false, 'live: the rows came from the feeds, not the saved copy');
    check(live.rows > 0, 'live: the table holds rows from the feed', `${live.rows}`);
    check(live.charts === 4, 'live: all four charts were built', `${live.charts}`);
    check(live.watermark === false, 'live: no watermark on localhost');
    check(typeof live.tiles.events === 'number' && live.tiles.events > 0, 'live: the tiles read the feed', `${live.tiles.events} events`);
    noErrors('live');
    await shoot('06-live');

    /* A poll that fails must leave the table alone and say so. */
    const failed = await evaluate(`(() => {
      const d = window.__quakeDemo;
      const before = d.allGrid.rows.count();
      d.onPollError(new Error('a deliberate failure, for the check'));
      return { before, after: d.allGrid.rows.count(), text: document.querySelector('.freshness').textContent, className: document.querySelector('.freshness').className };
    })()`);
    check(failed.after === failed.before, 'live: a failed poll does not lose the table', `${failed.before} -> ${failed.after}`);
    check(/could not reach/i.test(failed.text), 'live: a failed poll is said out loud', failed.text);
    check(/failed/.test(failed.className), 'live: a failed poll is marked visually', failed.className);

    /* ================================================================= */
    /* 5. The single file preview, opened from disk.                     */
    /* ================================================================= */

    await open(`file://${join(root, 'preview.html')}`, 'preview from disk');
    const preview = await evaluate(`(() => {
      const d = window.__quakeDemo;
      return {
        rows: d.allGrid.rows.count(),
        charts: d.charts.length,
        watermark: d.allGrid.licence.watermark(),
        licenceState: d.allGrid.licence.state(),
        tiles: Object.fromEntries(d.kpi.tiles().map((t) => [t.id, t.value])),
      };
    })()`);
    console.log(`  ${preview.rows} rows, ${preview.charts} charts, licence ${preview.licenceState}`);
    check(preview.rows > 0, 'preview: the table holds rows', `${preview.rows}`);
    check(preview.charts === 4, 'preview: all four charts were built', `${preview.charts}`);
    check(preview.watermark === false, 'preview: no watermark on file://', `state ${preview.licenceState}`);

    /*
     * The statistics tab, in the flattened single file. Every module becomes one
     * script there, so a helper that was fine as an import can be undefined at
     * the moment it is called; opening the tab is the only thing that proves the
     * flattening kept the order right.
     */
    await openStatistics();
    const previewStats = await panelState();
    console.log(`  preview statistics: ${previewStats.rows} rows, ${previewStats.plots} plots, ${previewStats.verdicts.length} verdicts`);
    check(previewStats.error === null, 'preview: the statistics tab computed without error', String(previewStats.error));
    check(previewStats.cards.length === 5, 'preview: all five analyses are on the page', previewStats.cards.join(', '));
    check(previewStats.chartErrors.length === 0, 'preview: no analysis failed to draw', previewStats.chartErrors.slice(0, 2).join(' | '));
    check(previewStats.marks.every((n) => n > 2), 'preview: every analysis drew marks', previewStats.marks.join(', '));
    check(previewStats.verdicts.length >= 5, 'preview: the verdicts are written out', `${previewStats.verdicts.length}`);
    noErrors('preview');
    await shoot('07-preview-file');
  }

  socket.close();
} catch (error) {
  failures.push(String((error && error.stack) || error));
} finally {
  /* Take the whole browser tree down, not just the process that was spawned:
     a surviving renderer is an orphan nobody will reap. */
  if (browserPid) {
    try { process.kill(-browserPid, 'SIGKILL'); } catch {}
    try { process.kill(browserPid, 'SIGKILL'); } catch {}
  }
  if (server) server.close();
  await sleep(400);
  if (profile) await rm(profile, { recursive: true, force: true });
}

console.log('\nChecks:');
for (const note of notes) console.log(note);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nAll ${notes.length} checks passed.`);
process.exit(0);
