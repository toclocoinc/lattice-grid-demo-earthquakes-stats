/**
 * The USGS earthquake feeds: fetching them, turning a GeoJSON feature into a
 * flat row, and polling for changes.
 *
 * Nothing here knows about the grid. It produces plain objects and hands them
 * to whoever asked, so the same code feeds the live page, the saved copy and
 * the single file preview.
 *
 * The feeds are public and need no key. Each one is regenerated every minute.
 */

const BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

/** The feeds this demo reads, by the name used throughout the code. */
export const FEEDS = {
  hour: `${BASE}/all_hour.geojson`,
  day: `${BASE}/all_day.geojson`,
  week: `${BASE}/all_week.geojson`,
  significant: `${BASE}/significant_month.geojson`,
};

/** How long an event stays in the rolling window: seven days, in milliseconds. */
export const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the page asks the feed for changes. USGS regenerates every minute. */
export const POLL_MS = 60 * 1000;

/**
 * The magnitude at which an earthquake starts being widely felt, and the
 * threshold behind the demo's quick filter.
 */
export const NOTABLE_MAG = 4.5;

/** The PAGER alert levels, least to most severe, as USGS spells them. */
export const ALERT_LEVELS = ['green', 'yellow', 'orange', 'red'];

/** A readable label for each alert level, plus the unassessed case. */
export const ALERT_LABELS = {
  none: 'Not assessed',
  green: 'Green',
  yellow: 'Yellow',
  orange: 'Orange',
  red: 'Red',
};

/**
 * Turn one GeoJSON feature into a flat row.
 *
 * The geometry's three coordinates are longitude, latitude and depth in
 * kilometres, in that order, which is the GeoJSON convention and the reverse
 * of how people say it. Several properties are frequently absent, so they are
 * read defensively rather than assumed: `alert`, `felt`, `cdi` and `mmi` are
 * only present once an event has been assessed or reported on, and `tz` is
 * always empty in the current feeds despite still being documented.
 *
 * @param {object} feature one member of a feed's `features` array
 * @returns {object|null} the row, or null when the feature has no usable identity
 */
export function toRow(feature) {
  if (!feature || !feature.id || !feature.properties) return null;
  const p = feature.properties;
  const coordinates = (feature.geometry && feature.geometry.coordinates) || [];
  const time = Number(p.time);
  if (!Number.isFinite(time)) return null;

  return {
    id: feature.id,
    time,
    /* The local calendar day, carried on the row so the grid can group by it
       and a chart can count per day without re-deriving it on every pass. */
    day: dayKey(time),
    updated: Number.isFinite(Number(p.updated)) ? Number(p.updated) : time,
    mag: typeof p.mag === 'number' ? p.mag : null,
    magType: p.magType || null,
    place: p.place || p.title || 'Location not given',
    depth: typeof coordinates[2] === 'number' ? coordinates[2] : null,
    lat: typeof coordinates[1] === 'number' ? coordinates[1] : null,
    lng: typeof coordinates[0] === 'number' ? coordinates[0] : null,
    alert: p.alert || 'none',
    tsunami: p.tsunami === 1,
    felt: typeof p.felt === 'number' ? p.felt : null,
    cdi: typeof p.cdi === 'number' ? p.cdi : null,
    mmi: typeof p.mmi === 'number' ? p.mmi : null,
    sig: typeof p.sig === 'number' ? p.sig : null,
    net: p.net || null,
    status: p.status || null,
    kind: p.type || null,
    url: p.url || null,
    /* Set by the caller once it knows which feeds carried this event. */
    significant: false,
    /* Always 1. It is what the charts and the group subtotals add up. */
    count: 1,
  };
}

/**
 * The local calendar day an instant falls in, as `2026-09-15`.
 *
 * Built from the local date parts rather than from an ISO string, because an
 * ISO string is in UTC and would file an evening event under the next day for
 * anyone east of Greenwich.
 *
 * @param {number} ms epoch milliseconds
 * @returns {string} the day key
 */
export function dayKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Fetch one feed and return its rows along with the feed's own timestamps.
 *
 * `metadata.generated` is when USGS built the file, which is up to a minute
 * behind the moment it is read; both are reported so the page can say which
 * it means.
 *
 * @param {string} name a key of {@link FEEDS}
 * @param {{signal?: AbortSignal}} [opts] an abort signal for the request
 * @returns {Promise<{name: string, rows: object[], generated: number, fetchedAt: number, title: string, count: number}>}
 */
export async function fetchFeed(name, opts = {}) {
  const url = FEEDS[name];
  if (!url) throw new Error(`There is no feed called ${name}.`);
  const response = await fetch(url, { signal: opts.signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`The ${name} feed answered ${response.status}.`);
  }
  const body = await response.json();
  const rows = [];
  for (const feature of body.features || []) {
    const row = toRow(feature);
    if (row) rows.push(row);
  }
  const metadata = body.metadata || {};
  return {
    name,
    rows,
    generated: Number(metadata.generated) || Date.now(),
    fetchedAt: Date.now(),
    title: metadata.title || name,
    count: rows.length,
  };
}

/**
 * Stamp the rows that also appear in the significant feed.
 *
 * Significance is a property of the event, not of the row that happens to be
 * in hand, so it is applied from one set of ids every time a row is built.
 * Without this, a revision arriving on the ordinary feed would quietly clear
 * the flag an earlier significant row had set.
 *
 * @param {object[]} rows the rows to stamp, changed in place
 * @param {Set<string>} significantIds the ids the significant feed carried
 * @returns {object[]} the same rows
 */
export function stampSignificance(rows, significantIds) {
  for (const row of rows) row.significant = significantIds.has(row.id);
  return rows;
}

/**
 * Read the two feeds the page starts from: a week of everything, and a month
 * of the significant events.
 *
 * The week feed is the rolling window's content. The significant feed reaches
 * back a month, so it carries events the week feed has already dropped, which
 * is why the significant view is a second dataset rather than a filter over
 * the first.
 *
 * @param {{signal?: AbortSignal, onProgress?: Function}} [opts]
 * @returns {Promise<{rows: object[], significantIds: Set<string>, feeds: object[]}>}
 */
export async function fetchInitial(opts = {}) {
  const report = opts.onProgress || (() => {});
  report('Reading a week of earthquakes...', 0.1);
  const [week, significant] = await Promise.all([
    fetchFeed('week', opts),
    fetchFeed('significant', opts),
  ]);
  report('Reading the month of significant earthquakes...', 0.7);

  const significantIds = new Set(significant.rows.map((row) => row.id));

  /* The significant feed reaches further back than the week feed, so its rows
     are merged in rather than discarded. Where both carry the same event the
     fresher `updated` wins. */
  const byId = new Map();
  for (const row of [...week.rows, ...significant.rows]) {
    const held = byId.get(row.id);
    if (!held || row.updated >= held.updated) byId.set(row.id, row);
  }

  const rows = stampSignificance([...byId.values()], significantIds);
  report('Building the dashboard...', 1);
  return { rows, significantIds, feeds: [week, significant] };
}

/**
 * Poll for changes and report each result.
 *
 * The day feed is polled rather than the hour feed. An event is revised for
 * hours after it first appears, as a human reviews the magnitude and the
 * place, and the hour feed would have dropped it long before that revision
 * arrives. The day feed is about 160 kB against the hour feed's 6 kB, which
 * is the price of seeing those revisions at all.
 *
 * The significant feed is small and changes rarely, so it is read every tenth
 * poll rather than every one.
 *
 * @param {object} opts
 * @param {(result: object) => void} opts.onPoll called with each successful poll
 * @param {(error: Error) => void} [opts.onError] called when a poll fails
 * @param {number} [opts.intervalMs] how often to poll
 * @param {Set<string>} opts.significantIds the running set, updated in place
 * @returns {{stop: Function, pollNow: Function}} a handle that stops the polling
 */
export function startPolling({ onPoll, onError, intervalMs = POLL_MS, significantIds }) {
  let stopped = false;
  let timer = null;
  let polls = 0;
  const controller = new AbortController();

  const runOnce = async () => {
    if (stopped) return;
    polls += 1;
    try {
      const alsoSignificant = polls % 10 === 1;
      const jobs = [fetchFeed('day', { signal: controller.signal })];
      if (alsoSignificant) jobs.push(fetchFeed('significant', { signal: controller.signal }));
      const [day, significant] = await Promise.all(jobs);

      if (significant) {
        for (const row of significant.rows) significantIds.add(row.id);
      }
      const rows = stampSignificance(
        significant ? [...day.rows, ...significant.rows] : day.rows,
        significantIds,
      );

      if (!stopped) onPoll({ rows, generated: day.generated, fetchedAt: day.fetchedAt, poll: polls });
    } catch (error) {
      if (!stopped && onError) onError(error);
    }
  };

  timer = setInterval(runOnce, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      controller.abort();
    },
    pollNow: runOnce,
  };
}

/**
 * Replay a saved run as though it were arriving now.
 *
 * The saved rows keep their original times, so replaying them unchanged would
 * put every event outside the rolling window. Each row's clock is shifted by
 * the same amount, so the shape of the week is preserved and the newest saved
 * event lands at the moment the replay starts.
 *
 * @param {object[]} rows the saved rows
 * @param {number} [now] the instant the newest event should land on
 * @returns {{rows: object[], shiftMs: number}} shifted copies, and the shift applied
 */
export function shiftToNow(rows, now = Date.now()) {
  let newest = 0;
  for (const row of rows) if (row.time > newest) newest = row.time;
  const shiftMs = newest ? now - newest : 0;
  return {
    shiftMs,
    rows: rows.map((row) => ({
      ...row,
      time: row.time + shiftMs,
      updated: row.updated + shiftMs,
      /* The day key is derived from the time, so it has to move with it. */
      day: dayKey(row.time + shiftMs),
    })),
  };
}

/**
 * Feed the saved rows in one at a time, oldest first, so the saved copy has
 * the same arriving-data feel as the live page.
 *
 * Everything older than `leadMs` is delivered at once as the starting state,
 * and the rest is released on a timer, compressed so the tail of the week
 * plays out over about a minute.
 *
 * @param {object} opts
 * @param {object[]} opts.rows the shifted rows
 * @param {(rows: object[]) => void} opts.onBatch receives each released batch
 * @param {number} [opts.leadMs] how much of the tail to replay rather than seed
 * @param {number} [opts.stepMs] how often a batch is released
 * @param {number} [opts.steps] how many batches the tail is cut into
 * @returns {{seed: object[], stop: Function}} the starting rows, and a stop handle
 */
export function createReplay({ rows, onBatch, leadMs = 90 * 60 * 1000, stepMs = 3000, steps = 20 }) {
  const now = Date.now();
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const seed = sorted.filter((row) => row.time < now - leadMs);
  const tail = sorted.filter((row) => row.time >= now - leadMs);

  let released = 0;
  const perStep = Math.max(1, Math.ceil(tail.length / steps));
  const timer = setInterval(() => {
    if (released >= tail.length) {
      clearInterval(timer);
      return;
    }
    const batch = tail.slice(released, released + perStep);
    released += batch.length;
    onBatch(batch);
  }, stepMs);

  return { seed, stop: () => clearInterval(timer) };
}
