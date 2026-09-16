/**
 * Preparing rows for the statistics tab.
 *
 * Everything here shapes DATA: it puts a magnitude band, a region name, a gap
 * to the previous earthquake or an hour-since-the-mainshock on a row, the way
 * the feed already puts a calendar day on one. Nothing here computes a
 * statistic. Every figure the page shows comes from the grid: a reduction, a
 * derived grid's aggregate, `grid.statistics`, or a chart's own fit.
 *
 * That line is deliberate and worth stating plainly, because the whole point
 * of this edition is to show the grid's statistics engine working on real
 * data. A mean worked out in this file and printed beside the grid's charts
 * would prove nothing.
 */

/** The width of a magnitude band, in magnitude units. The convention is 0.1. */
export const BAND_WIDTH = 0.1;

/** How far from a mainshock an earthquake is counted as part of its sequence. */
export const SEQUENCE_RADIUS_KM = 300;

/** How long after a mainshock the sequence is followed. */
export const SEQUENCE_HOURS = 72;

/**
 * How many earthquakes a sequence needs before a decay exponent is worth
 * quoting. Below this the fit would be a line through noise.
 */
export const SEQUENCE_MIN_EVENTS = 8;

/** The earth's mean radius in kilometres, for the great-circle distance. */
const EARTH_RADIUS_KM = 6371;

/**
 * The magnitude band an earthquake falls in: the magnitude rounded to a tenth,
 * halves going up.
 *
 * The tiny nudge is not superstition. A magnitude of exactly 1.15 is held in
 * binary as a shade under 1.15, so `Math.round(1.15 * 10)` can land on either
 * side depending on how the multiplication is written — `mag * 10` and
 * `mag / 0.1` disagree on fifty of the rows in the saved copy. The nudge fixes
 * the convention at "a half rounds up", which is what a reader means by a
 * magnitude band, and makes the answer the same however it is computed.
 *
 * @param {number|null} mag the magnitude
 * @returns {number|null} the band as a number, or null
 */
export function bandOf(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return null;
  /* Divided back, never multiplied by the width: `Math.round(12) * 0.1` is
     1.2000000000000002, which is a different band from 1.2 to a Map. */
  const scale = 1 / BAND_WIDTH;
  return Math.round(mag * scale + 1e-9) / scale;
}

/**
 * The region an earthquake is described as being in.
 *
 * USGS writes a place as "12 km NE of Somewhere, Alaska" or as a bare region
 * name like "northern Mid-Atlantic Ridge". The tail after the last comma is
 * the region in the first form and the whole string is the region in the
 * second, which is exactly what taking the tail does.
 *
 * @param {string|null} place the feed's place string
 * @returns {string} the region, or 'Not given'
 */
export function regionOf(place) {
  if (typeof place !== 'string' || !place.trim()) return 'Not given';
  const at = place.lastIndexOf(', ');
  const tail = at >= 0 ? place.slice(at + 2) : place;
  return tail.trim() || 'Not given';
}

/**
 * Put the derived fields on a copy of each row.
 *
 * Fields, not computed columns: a derived grid's `groupBy` reads the row's own
 * field, so a magnitude band that only existed inside the grid's value
 * pipeline could not be grouped on (see the findings in the README).
 *
 * @param {object[]} rows the earthquakes
 * @returns {object[]} the same earthquakes with `band` and `region` added
 */
export function withDerivedFields(rows) {
  return rows.map((row) => ({
    ...row,
    band: bandOf(row.mag),
    region: regionOf(row.place),
  }));
}

/**
 * The great-circle distance between two points, in kilometres.
 *
 * The haversine form rather than the spherical law of cosines, which loses its
 * precision at short distances, and short distances are most of an aftershock
 * sequence.
 *
 * @param {{lat: number, lng: number}} a one point
 * @param {{lat: number, lng: number}} b the other
 * @returns {number} kilometres, or NaN when either point is incomplete
 */
export function distanceKm(a, b) {
  if (!a || !b) return NaN;
  const rad = (d) => (d * Math.PI) / 180;
  const lat1 = Number(a.lat);
  const lat2 = Number(b.lat);
  const lng1 = Number(a.lng);
  const lng2 = Number(b.lng);
  if (![lat1, lat2, lng1, lng2].every(Number.isFinite)) return NaN;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The gap from each earthquake to the one before it, in minutes.
 *
 * The rows are put in time order first: the table's own order is whatever the
 * reader last sorted it by, and a gap read off that would be a gap between two
 * rows that happen to sit next to each other on screen.
 *
 * The first earthquake has no earthquake before it and so no gap; it is left
 * out rather than given a zero, because a zero would be a reading.
 *
 * @param {object[]} rows the earthquakes
 * @returns {object[]} one row per gap: `{id, at, gapMin}`
 */
export function gapRows(rows) {
  const ordered = rows
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);
  const gaps = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const minutes = (ordered[i].time - ordered[i - 1].time) / 60000;
    if (!Number.isFinite(minutes) || minutes < 0) continue;
    gaps.push({ id: ordered[i].id, at: ordered[i].time, gapMin: minutes });
  }
  return gaps;
}

/**
 * Choose the aftershock sequence to show, and say why it was chosen.
 *
 * The obvious choice is the largest earthquake in the window, and that is
 * where this starts. It is often the wrong one: a deep event under an ocean is
 * recorded by the global network alone, which sees nothing below about
 * magnitude 4.5, so its aftershocks are real and simply not in the feed. A
 * magnitude 5 under Alaska, where the network sees down to about magnitude 1,
 * leaves fifty.
 *
 * So the candidates are walked from the largest down, and the first one that
 * actually has a sequence in the data is taken. Both are returned: the page
 * says which earthquake was the largest and which one it is showing, because
 * quietly showing a different earthquake from the one named at the top of the
 * page would be worse than showing nothing.
 *
 * @param {object[]} rows the earthquakes in the window
 * @param {object} [opts]
 * @param {number} [opts.radiusKm] how far from the mainshock to look
 * @param {number} [opts.hours] how long after it to follow
 * @param {number} [opts.minEvents] how many it takes to be worth fitting
 * @returns {{largest: object|null, mainshock: object|null, aftershocks: object[], candidatesTried: number}}
 */
export function pickSequence(rows, opts = {}) {
  const radiusKm = opts.radiusKm || SEQUENCE_RADIUS_KM;
  const hours = opts.hours || SEQUENCE_HOURS;
  const minEvents = opts.minEvents || SEQUENCE_MIN_EVENTS;
  const spanMs = hours * 3600000;

  const usable = rows.filter(
    (row) => typeof row.mag === 'number' && Number.isFinite(row.time) && Number.isFinite(row.lat),
  );
  const byMagnitude = [...usable].sort((a, b) => b.mag - a.mag);
  const largest = byMagnitude[0] || null;

  const after = (main) =>
    usable.filter(
      (row) =>
        row.id !== main.id &&
        row.time > main.time &&
        row.time - main.time <= spanMs &&
        distanceKm(main, row) <= radiusKm,
    );

  /* Only earthquakes big enough to have a sequence at all are considered as
     the mainshock, so a swarm of magnitude 1s cannot nominate one of its own
     members. Twenty candidates is more than enough of a week. */
  const candidates = byMagnitude.filter((row) => row.mag >= 3.5).slice(0, 20);
  for (const candidate of candidates) {
    const aftershocks = after(candidate);
    if (aftershocks.length >= minEvents) {
      return { largest, mainshock: candidate, aftershocks, candidatesTried: candidates.length };
    }
  }
  return {
    largest,
    mainshock: null,
    aftershocks: largest ? after(largest) : [],
    candidatesTried: candidates.length,
  };
}

/**
 * Put the aftershocks into bins spaced evenly on a log scale.
 *
 * Omori's law says the rate falls off as a power of the time since the
 * mainshock, which is a straight line once both axes are logarithms. Even bins
 * would put thousands of seconds in the first bar and one earthquake in each
 * of the last fifty; log-spaced bins put roughly comparable numbers in each,
 * which is the whole reason the law is usually plotted this way.
 *
 * Each bin carries the count the grid will reduce, the hours the bin spans, so
 * a rate can be stated per hour rather than per bin, and the midpoint the
 * regression reads.
 *
 * @param {object[]} aftershocks the sequence
 * @param {number} mainshockTime when the mainshock was
 * @param {object} [opts]
 * @param {number} [opts.bins] how many bins
 * @param {number} [opts.fromHours] the first bin's lower edge
 * @param {number} [opts.toHours] the last bin's upper edge
 * @returns {object[]} one row per aftershock: `{id, bin, binFrom, binTo, binHours, midHours}`
 */
export function decayBinRows(aftershocks, mainshockTime, opts = {}) {
  const bins = opts.bins || 8;
  const from = opts.fromHours || 1 / 12;
  const to = opts.toHours || SEQUENCE_HOURS;
  if (!aftershocks.length || !Number.isFinite(mainshockTime)) return [];

  const logFrom = Math.log10(from);
  const logTo = Math.log10(to);
  const edges = [];
  for (let i = 0; i <= bins; i += 1) {
    edges.push(10 ** (logFrom + ((logTo - logFrom) * i) / bins));
  }

  const out = [];
  for (const row of aftershocks) {
    const hours = (row.time - mainshockTime) / 3600000;
    if (!(hours > 0)) continue;
    let index = -1;
    for (let i = 0; i < bins; i += 1) {
      /* The last bin takes its own upper edge, so an earthquake exactly at 72
         hours lands in it rather than falling off the end. */
      const last = i === bins - 1;
      if (hours >= edges[i] && (last ? hours <= edges[i + 1] : hours < edges[i + 1])) {
        index = i;
        break;
      }
    }
    if (index < 0) continue;
    const binFrom = edges[index];
    const binTo = edges[index + 1];
    out.push({
      id: row.id,
      bin: index,
      binFrom,
      binTo,
      binHours: binTo - binFrom,
      /* The geometric midpoint, which is the middle of a bin whose edges were
         chosen on a log scale. */
      midHours: Math.sqrt(binFrom * binTo),
    });
  }
  return out;
}

/**
 * Turn a count and the hours it covers into a rate per hour, and the pair of
 * logarithms the Omori fit is a straight line in.
 *
 * Arithmetic on a figure the grid produced, not a statistic: the count is the
 * grid's, and the slope through these points is the grid's too.
 *
 * @param {object} row a derived row carrying `n`, `binHours` and `midHours`
 * @returns {object|null} the row with `rate`, `logT` and `logRate`, or null
 */
export function toDecayPoint(row) {
  const n = Number(row.n);
  const hours = Number(row.binHours);
  const mid = Number(row.midHours);
  if (!(n > 0) || !(hours > 0) || !(mid > 0)) return null;
  const rate = n / hours;
  return {
    ...row,
    rate,
    logT: Math.log10(mid),
    logRate: Math.log10(rate),
  };
}
