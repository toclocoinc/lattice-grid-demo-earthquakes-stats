/**
 * The statistics, computed again, from scratch, in Node.
 *
 * Nothing in this file imports the grid or anything the page uses. It takes
 * the raw rows the table is holding — id, time, magnitude, depth, network,
 * place, and nothing else — and works out the same figures the Statistics tab
 * shows, by hand, from textbook definitions.
 *
 * That is the whole point. A check that read the page's own numbers back and
 * agreed with them would prove only that the page can print. These numbers are
 * arrived at a second, independent way, and the check is that the two agree.
 *
 * Where the grid's kernel has a documented definition that is not the only
 * reasonable one — a quantile can be interpolated or not, a trimmed mean can
 * drop a fraction or a count, a skew can be the population one or the sample
 * one — the documented definition is the one implemented here, and the comment
 * says which.
 *
 * Used by `tools/verify.mjs`. Nothing the page loads imports it.
 */

/* ------------------------------------------------------------------ */
/* The distributions the intervals need                                */
/* ------------------------------------------------------------------ */

/** The natural log of the gamma function, by the Lanczos approximation. */
function logGamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < g.length; i += 1) a += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularised incomplete beta function, by Lentz's continued fraction. */
function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front =
    Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  /* The fraction converges quickly only on one side, so the other side is
     reached through the symmetry I(x; a, b) = 1 - I(1-x; b, a). */
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(b, a, 1 - x);

  const tiny = 1e-30;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 300; i += 1) {
    const m = Math.floor(i / 2);
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -(((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1)));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    const step = c * d;
    f *= step;
    if (Math.abs(1 - step) < 1e-12) break;
  }
  return (front * (f - 1)) / a;
}

/** P(T <= t) for Student's t with `df` degrees of freedom. */
export function studentCdf(t, df) {
  const x = df / (df + t * t);
  const half = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - half : half;
}

/**
 * The two-sided critical value of Student's t: the number an interval at
 * `confidence` multiplies a standard error by.
 *
 * Found by bisection on the CDF rather than by a closed form, because there is
 * no closed form and a table would only cover the levels someone thought of.
 *
 * @param {number} df degrees of freedom
 * @param {number} [confidence] the level, 0.95 by default
 * @returns {number} the critical value
 */
export function tCritical(df, confidence = 0.95) {
  const target = 1 - (1 - confidence) / 2;
  let low = 0;
  let high = 1000;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (studentCdf(mid, df) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/* ------------------------------------------------------------------ */
/* The reductions                                                      */
/* ------------------------------------------------------------------ */

/** The finite numbers in a list, in ascending order. */
export function sortedNumbers(values) {
  return values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
}

export function mean(values) {
  const xs = sortedNumbers(values);
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * A quantile by linear interpolation between order statistics, which is what
 * `median`, `p25`, `p75`, `p90`, `p95` and `p99` push down to DuckDB as
 * `quantile_cont`.
 */
export function quantile(values, p) {
  const xs = sortedNumbers(values);
  if (!xs.length) return null;
  if (xs.length === 1) return xs[0];
  const position = p * (xs.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return xs[low];
  return xs[low] + (position - low) * (xs[high] - xs[low]);
}

/**
 * The 10% trimmed mean, dropping `floor(n * 0.1)` readings from each end —
 * a count, not a fraction, which is what the documented SQL does.
 */
export function trimmedMean(values) {
  const xs = sortedNumbers(values);
  if (!xs.length) return null;
  const drop = Math.floor(xs.length * 0.1);
  const kept = xs.slice(drop, xs.length - drop);
  if (!kept.length) return null;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/** The sample standard deviation, dividing by n - 1. */
export function stddev(values) {
  const xs = sortedNumbers(values);
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** The kth central moment about the mean, divided by n: the population form. */
function centralMoment(xs, k, m) {
  return xs.reduce((a, x) => a + (x - m) ** k, 0) / xs.length;
}

/**
 * The Jarque-Bera statistic, in the population form the grid's own documented
 * SQL uses: `(n/6) * (S^2 + (K-3)^2/4)` with `S` and `K` computed from the
 * moments divided by `n`, not by `n - 1`. Null below eight readings.
 */
export function jarqueBera(values) {
  const xs = sortedNumbers(values);
  if (xs.length < 8) return null;
  const m = mean(xs);
  const m2 = centralMoment(xs, 2, m);
  if (m2 === 0) return null;
  const skew = centralMoment(xs, 3, m) / m2 ** 1.5;
  const kurt = centralMoment(xs, 4, m) / m2 ** 2;
  return (xs.length / 6) * (skew ** 2 + (kurt - 3) ** 2 / 4);
}

/** The sample skewness, the adjusted Fisher-Pearson form DuckDB reports. */
export function skewness(values) {
  const xs = sortedNumbers(values);
  const n = xs.length;
  if (n < 3) return null;
  const m = mean(xs);
  const m2 = centralMoment(xs, 2, m);
  if (m2 === 0) return null;
  const g1 = centralMoment(xs, 3, m) / m2 ** 1.5;
  return (g1 * Math.sqrt(n * (n - 1))) / (n - 2);
}

/** A confidence interval for the mean: the t interval. */
export function meanInterval(values, confidence = 0.95) {
  const xs = sortedNumbers(values);
  if (xs.length < 2) return null;
  const m = mean(xs);
  const s = stddev(xs);
  const margin = tCritical(xs.length - 1, confidence) * (s / Math.sqrt(xs.length));
  return { mean: m, lower: m - margin, upper: m + margin, margin, n: xs.length };
}

/**
 * The rows a modified z-score flags: `0.6745 * (x - median) / MAD` past 3.5,
 * where MAD is the median of the absolute deviations from the median.
 */
export function modifiedZOutliers(values, threshold = 3.5) {
  const xs = sortedNumbers(values);
  if (!xs.length) return { flagged: 0, scores: [], median: null, mad: null };
  const med = quantileExact(xs, 0.5);
  const mad = quantileExact(sortedNumbers(xs.map((x) => Math.abs(x - med))), 0.5);
  if (!mad) return { flagged: 0, scores: [], median: med, mad };
  const scores = xs.map((x) => (0.6745 * (x - med)) / mad);
  return { flagged: scores.filter((s) => Math.abs(s) > threshold).length, scores, median: med, mad };
}

/**
 * The median as `list_median` computes it: the mean of the two middle values
 * on an even count, which is `quantile_cont` at 0.5 and is what the anomaly
 * kernel's own documented SQL uses.
 */
export function quantileExact(values, p) {
  return quantile(values, p);
}

/* ------------------------------------------------------------------ */
/* Least squares                                                       */
/* ------------------------------------------------------------------ */

/**
 * An ordinary least-squares line through `(x, y)` pairs, with the slope's
 * confidence interval.
 *
 * @param {Array<[number, number]>} pairs the points
 * @param {number} [confidence] the level for the interval
 * @returns {object|null} `{slope, intercept, r2, stdError, lower, upper, n}`
 */
export function leastSquares(pairs, confidence = 0.95) {
  const usable = pairs.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = usable.length;
  if (n < 3) return null;
  const mx = usable.reduce((a, [x]) => a + x, 0) / n;
  const my = usable.reduce((a, [, y]) => a + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of usable) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let rss = 0;
  for (const [x, y] of usable) rss += (y - (intercept + slope * x)) ** 2;
  const df = n - 2;
  const sigma2 = rss / df;
  const stdError = Math.sqrt(sigma2 / sxx);
  const t = tCritical(df, confidence);
  return {
    slope,
    intercept,
    r2: syy === 0 ? null : 1 - rss / syy,
    stdError,
    lower: slope - t * stdError,
    upper: slope + t * stdError,
    n,
  };
}

/* ------------------------------------------------------------------ */
/* The five analyses, worked out again                                 */
/* ------------------------------------------------------------------ */

/**
 * The magnitude band: the magnitude rounded to a tenth, halves going up.
 *
 * The band is an input convention rather than a statistic, so both sides have
 * to agree on it before there is anything to check; the nudge pins "a half
 * rounds up" against the binary representation, exactly as `src/analysis.js`
 * documents.
 */
export function bandOf(mag) {
  if (typeof mag !== 'number' || !Number.isFinite(mag)) return null;
  return Math.round(mag * 10 + 1e-9) / 10;
}

/** The region: the tail of the place string after the last comma. */
export function regionOf(place) {
  if (typeof place !== 'string' || !place.trim()) return 'Not given';
  const at = place.lastIndexOf(', ');
  return (at >= 0 ? place.slice(at + 2) : place).trim() || 'Not given';
}

/**
 * The b-value: minus the slope of log10(count) against magnitude, over the
 * bands from the completeness magnitude up to two magnitudes above it.
 *
 * @param {object[]} rows the earthquakes
 * @param {number} completeness the magnitude the fit starts at
 * @returns {object|null} the fit, with `b`, `bLower`, `bUpper`, `r2`, `bands`
 */
export function bValue(rows, completeness, range = 2) {
  const counts = new Map();
  for (const row of rows) {
    const band = bandOf(row.mag);
    if (band == null) continue;
    counts.set(band, (counts.get(band) || 0) + 1);
  }
  const top = completeness + range;
  const pairs = [...counts.entries()]
    .filter(([band, n]) => band >= completeness - 1e-9 && band <= top + 1e-9 && n > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([band, n]) => [band, Math.log10(n)]);
  const fit = leastSquares(pairs);
  if (!fit) return null;
  return {
    b: -fit.slope,
    bLower: -fit.upper,
    bUpper: -fit.lower,
    r2: fit.r2,
    bands: pairs.length,
    counts,
  };
}

/** Which band holds the most earthquakes, and how many that is. */
export function modalBand(rows) {
  const counts = new Map();
  for (const row of rows) {
    const band = bandOf(row.mag);
    if (band == null) continue;
    counts.set(band, (counts.get(band) || 0) + 1);
  }
  let best = null;
  let most = -1;
  for (const [band, n] of counts) {
    if (n > most) {
      most = n;
      best = band;
    }
  }
  return { band: best, count: most, counts };
}

/** The gaps between consecutive earthquakes, in minutes. */
export function gaps(rows) {
  const times = rows
    .map((row) => row.time)
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < times.length; i += 1) out.push((times[i] - times[i - 1]) / 60000);
  return out;
}

/** The great-circle distance in kilometres. */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  if (![a.lat, a.lng, b.lat, b.lng].every((v) => Number.isFinite(Number(v)))) return NaN;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The aftershock sequence and its decay exponent, chosen and binned the same
 * way the page describes, then fitted here.
 */
export function omori(rows, opts = {}) {
  const radiusKm = opts.radiusKm || 300;
  const hours = opts.hours || 72;
  const minEvents = opts.minEvents || 8;
  const bins = opts.bins || 8;
  const spanMs = hours * 3600000;

  const usable = rows.filter(
    (r) => typeof r.mag === 'number' && Number.isFinite(r.time) && Number.isFinite(r.lat),
  );
  const byMagnitude = [...usable].sort((a, b) => b.mag - a.mag);
  const after = (main) =>
    usable.filter(
      (r) =>
        r.id !== main.id &&
        r.time > main.time &&
        r.time - main.time <= spanMs &&
        distanceKm(main, r) <= radiusKm,
    );

  let mainshock = null;
  let sequence = [];
  for (const candidate of byMagnitude.filter((r) => r.mag >= 3.5).slice(0, 20)) {
    const found = after(candidate);
    if (found.length >= minEvents) {
      mainshock = candidate;
      sequence = found;
      break;
    }
  }
  if (!mainshock) {
    return { ok: false, largest: byMagnitude[0] || null, aftershocks: byMagnitude[0] ? after(byMagnitude[0]).length : 0 };
  }

  const from = 1 / 12;
  const logFrom = Math.log10(from);
  const logTo = Math.log10(hours);
  const edges = [];
  for (let i = 0; i <= bins; i += 1) edges.push(10 ** (logFrom + ((logTo - logFrom) * i) / bins));

  const perBin = new Array(bins).fill(0);
  for (const row of sequence) {
    const t = (row.time - mainshock.time) / 3600000;
    if (!(t > 0)) continue;
    for (let i = 0; i < bins; i += 1) {
      const last = i === bins - 1;
      if (t >= edges[i] && (last ? t <= edges[i + 1] : t < edges[i + 1])) {
        perBin[i] += 1;
        break;
      }
    }
  }

  const pairs = [];
  for (let i = 0; i < bins; i += 1) {
    if (!perBin[i]) continue;
    const width = edges[i + 1] - edges[i];
    const mid = Math.sqrt(edges[i] * edges[i + 1]);
    pairs.push([Math.log10(mid), Math.log10(perBin[i] / width)]);
  }
  const fit = leastSquares(pairs);
  if (!fit) return { ok: false, mainshock, aftershocks: sequence.length };
  return {
    ok: true,
    mainshock,
    aftershocks: sequence.length,
    bins: pairs.length,
    p: -fit.slope,
    pLower: -fit.upper,
    pUpper: -fit.lower,
    r2: fit.r2,
  };
}

/**
 * The individuals control limits: the centre line, and three sigma either side
 * where sigma is the mean moving range over d2 = 1.128, which is what a chart
 * of individual readings uses.
 *
 * @param {number[]} series the readings, in order
 * @returns {object|null} `{centre, sigma, upper, lower, breaches}`
 */
export function controlLimits(series) {
  const xs = series.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return null;
  const centre = xs.reduce((a, b) => a + b, 0) / xs.length;
  let ranges = 0;
  for (let i = 1; i < xs.length; i += 1) ranges += Math.abs(xs[i] - xs[i - 1]);
  const sigma = ranges / (xs.length - 1) / 1.128;
  const upper = centre + 3 * sigma;
  const lower = centre - 3 * sigma;
  const breaches = [];
  xs.forEach((value, index) => {
    if (value > upper || value < lower) breaches.push({ index, value, rule: 'beyond three sigma' });
  });
  return { centre, sigma, upper, lower, breaches };
}

/** Earthquakes per local calendar day, oldest day first. */
export function perDay(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.time)) continue;
    const d = new Date(row.time);
    const pad = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
