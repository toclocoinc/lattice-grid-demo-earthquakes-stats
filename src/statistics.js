/**
 * The Statistics tab, and the verdict panel under it.
 *
 * Five questions are asked of the same week of earthquakes that the table on
 * the first tab is showing, and each one is answered by the grid rather than
 * by this file:
 *
 *   1  How many earthquakes at each magnitude, and what does the slope say?
 *   2  How long between one earthquake and the next, and is that gap normal?
 *   3  How fast does an aftershock sequence die away?
 *   4  How deep are they, by network and by region, and which are outliers?
 *   5  Is the number recorded each day a stable process, or is it moving?
 *
 * Every number on the page comes from one of three places, and each figure is
 * shown with the call that produced it:
 *
 *   - a reduction, `grid.statistics.reduce(column, kernel)`;
 *   - a derived grid's own aggregate, `select: { n: { fn: 'count' } }`;
 *   - the statistics API proper: `regressionModel`, `interval`, `capability`,
 *     `anomalies`, `acf`, `adf`.
 *
 * Nothing here works out a mean, a slope, a control limit or an outlier by
 * hand. Where the grid cannot reach a figure, the page says so in words rather
 * than filling the gap quietly; the README lists those gaps.
 *
 * Everything is rebuilt from the table's CURRENT rows, so narrowing to the
 * notable earthquakes moves every verdict on the page.
 */

import {
  SEQUENCE_HOURS,
  SEQUENCE_MIN_EVENTS,
  SEQUENCE_RADIUS_KM,
  decayBinRows,
  gapRows,
  pickSequence,
  toDecayPoint,
  withDerivedFields,
} from './analysis.js';

/* The Jarque-Bera statistic above which a column is not plausibly normal: the
   0.95 point of a chi-squared with two degrees of freedom. The grid's own
   documentation states this cut, so the page uses the same one. */
const JARQUE_BERA_CUT = 5.99;

/**
 * How far above the completeness magnitude the b-value is fitted.
 *
 * Two magnitude units is the usual range, and there is a reason for the cap as
 * well as for the floor: this feed is several networks at once. A Californian
 * network hears down to about magnitude 1 and the global network to about 4.5,
 * so the counts fall away, flatten, and then rise again as the global
 * catalogue's own population starts. A line fitted across all of that is a line
 * across two catalogues.
 */
const BVALUE_RANGE = 2;

/** How many groups the depth comparison shows before it becomes a smear. */
const DEPTH_GROUPS = 6;

/** Make an element with a class and optional text. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A number to a fixed number of places, or a dash when there is not one. */
function num(value, places = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(places) : '-';
}

/** A whole number with thousands separators. */
function count(value) {
  return Number(value || 0).toLocaleString('en-GB');
}

/** A span of minutes said the way a person would say it. */
function minutesText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value < 1) return `${(value * 60).toFixed(0)} seconds`;
  if (value < 90) return `${value.toFixed(1)} minutes`;
  return `${(value / 60).toFixed(1)} hours`;
}

/* ------------------------------------------------------------------ */
/* The panel                                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the statistics panel into `host`.
 *
 * @param {object} options
 * @param {HTMLElement} options.host where the panel is drawn
 * @param {object} options.grid the All table, whose current rows are the input
 * @param {Function} options.createHeadlessGrid the headless grid factory
 * @param {Function} options.createChart the charts module's factory
 * @param {number} options.notableMag the magnitude the quick filter cuts at
 * @param {Function} [options.onNotableToggle] called when the panel's own copy
 *   of the notable toggle is pressed; it is the host that owns the filter
 * @returns {object} `{ el, refresh, state, destroy }`
 */
export function buildStatistics({
  host,
  grid,
  createHeadlessGrid,
  createChart,
  notableMag,
  onNotableToggle,
}) {
  const root = el('div', 'stats');

  /* ---------------- the controls ---------------- */

  const controls = el('div', 'stats-controls');
  controls.append(el('span', 'actions-label', 'Group depth by'));

  let groupBy = 'net';
  const groupButtons = new Map();
  const setGroupBy = (id) => {
    groupBy = id;
    for (const [key, button] of groupButtons) {
      const on = key === id;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    refresh();
  };
  for (const [id, label] of [['net', 'Network'], ['region', 'Region']]) {
    const button = el('button', 'action toggle', label);
    button.type = 'button';
    button.addEventListener('click', () => setGroupBy(id));
    groupButtons.set(id, button);
    controls.append(button);
  }

  controls.append(el('span', 'actions-gap'));
  const notableButton = el('button', 'action toggle', `Only M${notableMag} and above`);
  notableButton.type = 'button';
  notableButton.setAttribute('aria-pressed', 'false');
  notableButton.addEventListener('click', () => {
    if (onNotableToggle) onNotableToggle();
  });
  controls.append(notableButton);

  controls.append(el('span', 'actions-gap'));
  const recomputeButton = el('button', 'action', 'Recompute');
  recomputeButton.type = 'button';
  recomputeButton.addEventListener('click', () => refresh());
  controls.append(recomputeButton);

  const basis = el('span', 'stats-basis');
  controls.append(basis);
  root.append(controls);

  /* ---------------- the verdict panel ---------------- */

  const verdictPanel = el('section', 'verdict');
  verdictPanel.setAttribute('aria-label', 'What the figures say');
  verdictPanel.append(el('h2', null, 'What the figures say'));
  const verdictList = el('ol', 'verdict-list');
  verdictPanel.append(verdictList);
  root.append(verdictPanel);

  /* ---------------- the five analyses ---------------- */

  const board = el('div', 'stats-board');
  root.append(board);
  host.append(root);

  /* Everything built on the last pass, torn down before the next one: a chart
     left bound to a grid that has gone is a leak and a wrong picture. */
  let built = { charts: [], grids: [] };
  const state = { analyses: {}, verdicts: [], rows: 0, error: null, passes: 0 };

  const own = (thing, kind) => {
    built[kind].push(thing);
    return thing;
  };

  /** A headless grid over prepared rows, owned by this pass. */
  const dataset = (rows, columns, extra) =>
    own(createHeadlessGrid({ rowKey: 'id', columns, rows, ...(extra || {}) }), 'grids');

  /** A headless grid derived from another, owned by this pass. */
  const derive = (from, source, columns) =>
    own(
      createHeadlessGrid({
        source: { mode: 'derived', from, follow: 'all', ...source },
        columns,
      }),
      'grids',
    );

  /** Read a grid's rows out as plain objects, leaving any group rows behind. */
  const readRows = (source) => {
    const out = [];
    source.rows.forEach((row) => {
      if (!row || row.group || !row.data) return;
      out.push(row.data);
    });
    return out;
  };

  /**
   * Draw one chart into a card, or say why it could not be drawn.
   *
   * A chart that throws must not take the rest of the page down with it: this
   * demo exists to show what the engine does, and four working analyses beside
   * one honest failure is a better page than a blank one.
   */
  const chartInto = (container, spec, label) => {
    try {
      const chart = createChart({ container, ...spec });
      built.charts.push(chart);
      return chart;
    } catch (error) {
      container.append(el('p', 'chart-error', `${label} could not be drawn: ${error.message}`));
      console.error('[earthquake statistics]', label, error);
      return null;
    }
  };

  /** One analysis card: a heading, a sentence, its charts and its figures. */
  const card = (id, title, lede) => {
    const section = el('section', 'stats-card');
    section.dataset.analysis = id;
    section.append(el('h3', null, title));
    if (lede) section.append(el('p', 'stats-lede', lede));
    const plots = el('div', 'stats-plots');
    section.append(plots);
    const figures = el('dl', 'stats-figures');
    section.append(figures);
    board.append(section);
    return {
      section,
      plots,
      plot(height) {
        const box = el('div', 'stats-plot');
        if (height) box.style.height = `${height}px`;
        plots.append(box);
        return box;
      },
      figure(label, value, source) {
        figures.append(el('dt', null, label));
        const dd = el('dd', null, String(value));
        if (source) {
          const note = el('code', 'stats-source', source);
          dd.append(document.createTextNode(' '));
          dd.append(note);
        }
        figures.append(dd);
      },
      note(text) {
        section.append(el('p', 'stats-note', text));
      },
    };
  };

  /* ------------------------------------------------------------------ */
  /* 1. Magnitude against frequency: the Gutenberg-Richter b-value       */
  /* ------------------------------------------------------------------ */

  function magnitudeFrequency(rows, verdicts) {
    const box = card(
      'gutenberg-richter',
      'How many at each magnitude',
      'Count the earthquakes in each tenth of a magnitude and the counts fall away as a ' +
        'straight line on a log scale. Its slope is the b-value: how many small earthquakes ' +
        'there are for each large one. Around 1 is ordinary crust almost everywhere on earth, ' +
        'which is what makes it worth measuring.',
    );

    const withMag = rows.filter((row) => typeof row.band === 'number');
    if (withMag.length < 30) {
      box.note('Too few earthquakes with a magnitude in view to read a slope from.');
      return { ok: false, reason: 'too few magnitudes' };
    }

    const source = dataset(withMag, [
      { id: 'band', field: 'band', type: 'number' },
      { id: 'mag', field: 'mag', type: 'number' },
    ]);

    /*
     * Below some magnitude the catalogue stops being complete: the seismometers
     * simply do not hear every small earthquake, so the counts turn over and
     * fall away again. Fitting through that turnover measures the network, not
     * the crust. The band holding the most earthquakes is the usual quick
     * estimate of where completeness ends, and it is the grid's `mode`.
     */
    const completeness = source.statistics.reduce('band', 'mode');
    const counted = derive(
      source,
      { groupBy: 'band', select: { n: { fn: 'count' } } },
      [
        { id: 'band', field: 'band', type: 'number' },
        { id: 'n', field: 'n', type: 'number' },
      ],
    );

    const top = completeness + BVALUE_RANGE;
    const points = readRows(counted)
      .filter(
        (row) =>
          typeof row.band === 'number' && row.n > 0 && row.band >= completeness && row.band <= top,
      )
      .sort((a, b) => a.band - b.band)
      .map((row) => ({
        id: `band-${row.band}`,
        band: row.band,
        n: row.n,
        /* A change of unit on the grid's own count, so the line the grid fits
           through them is a line in the coordinates the law is stated in. */
        logN: Math.log10(row.n),
      }));

    if (points.length < 4) {
      box.note('Fewer than four magnitude bands above the completeness magnitude: no slope is quoted.');
      return { ok: false, reason: 'too few bands', completeness };
    }

    const fitGrid = dataset(points, [
      { id: 'band', field: 'band', title: 'Magnitude', type: 'number' },
      { id: 'logN', field: 'logN', title: 'log10 earthquakes', type: 'number' },
      { id: 'n', field: 'n', title: 'Earthquakes', type: 'number' },
    ]);

    const model = fitGrid.statistics.regressionModel({
      predictors: ['band'],
      response: 'logN',
      confidence: 0.95,
    });

    if (!model) {
      box.note('The fit was refused on this data, so no b-value is quoted.');
      return { ok: false, reason: 'no model' };
    }

    const slope = model.coefficients.find((c) => c.name === 'band');
    /* The b-value is the fall per magnitude, so it is the slope's size. Its
       interval is the slope's interval, the same way round. */
    const b = -slope.estimate;
    const bLower = slope.upper == null ? null : -slope.upper;
    const bUpper = slope.lower == null ? null : -slope.lower;

    chartInto(
      box.plot(230),
      {
        grid: fitGrid,
        type: 'scatter',
        /*
         * The point set is handed in rather than bound to the columns, which is
         * what the charts module documents for a cartesian chart whose values
         * are a derived quantity. It also keeps the axis continuous: a numeric
         * column with fewer than thirteen distinct values is given a band scale
         * instead, and `fit` and `band` are documented as numeric-axis only, so
         * on a narrowed table the fitted line would quietly disappear. That is
         * finding F-1329-3.
         */
        points: points.map((row) => ({ x: row.band, y: row.logN, key: row.id })),
        fit: true,
        band: model.band,
        title: `Magnitude against log10 count, M${num(completeness, 1)} to M${num(top, 1)}`,
        axis: {
          x: { title: 'Magnitude', format: (value) => Number(value).toFixed(1) },
          y: 'log10 earthquakes in the band',
        },
        legend: false,
      },
      'The magnitude-frequency fit',
    );

    box.figure('b-value', num(b, 3), 'regressionModel().coefficients');
    box.figure(
      '95% interval on the b-value',
      bLower == null ? '-' : `${num(bLower, 3)} to ${num(bUpper, 3)}`,
      'coefficient.lower / .upper',
    );
    box.figure('R²', num(model.r2, 3), 'regressionModel().r2');
    box.figure(
      'Bands fitted',
      `${points.length}, M${num(completeness, 1)} to M${num(top, 1)}`,
      "derived select {n: {fn: 'count'}}",
    );
    box.figure('Completeness magnitude', `M${num(completeness, 1)}`, "reduce('band', 'mode')");
    box.note(
      'The feed is several networks at once and they hear down to different magnitudes, so the ' +
        'combined catalogue is not one population. The fit is held to two magnitude units above ' +
        'the completeness magnitude for that reason, and an apparent b-value below one is what a ' +
        'mixture of catalogues does to the slope.',
    );

    verdicts.push({
      text:
        `The b-value over this window is ${num(b, 2)}` +
        (bLower == null ? '' : `, and the fit puts it between ${num(bLower, 2)} and ${num(bUpper, 2)}`) +
        `. ${
          bLower != null && bLower <= 1 && bUpper >= 1
            ? 'One is inside that interval, which is what ordinary crust looks like.'
            : b > 1
              ? 'That is above one: small earthquakes are over-represented here compared with a ' +
                'single well-recorded region, which is what a swarm looks like.'
              : 'That is below one, which for a worldwide feed usually says more about the ' +
                'recording than the rock: several networks are mixed together here and each stops ' +
                'hearing at a different magnitude, which flattens the line.'
        } It is the slope of a straight line through ${points.length} magnitude bands from M${num(
          completeness,
          1,
        )} to M${num(top, 1)}, and the line accounts for ${num(model.r2 * 100, 1)}% of them.`,
      source: `grid.statistics.regressionModel({ predictors: ['band'], response: 'logN' })`,
    });

    return {
      ok: true,
      b,
      bLower,
      bUpper,
      r2: model.r2,
      completeness,
      top,
      bands: points.length,
      points: points.map((p) => [p.band, p.n]),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 2. The time between one earthquake and the next                     */
  /* ------------------------------------------------------------------ */

  function interArrival(rows, verdicts) {
    const box = card(
      'inter-arrival',
      'How long between one earthquake and the next',
      'If earthquakes arrived independently of one another the gaps between them would follow ' +
        'an exponential curve: mostly short, occasionally long, and nothing like a bell. ' +
        'Testing that is the point, because where the gaps are shorter than the model says, ' +
        'earthquakes are triggering each other.',
    );

    const gaps = gapRows(rows);
    if (gaps.length < 30) {
      box.note('Too few earthquakes in view to measure the gaps between them.');
      return { ok: false, reason: 'too few gaps' };
    }

    const gapsGrid = dataset(gaps, [
      { id: 'gapMin', field: 'gapMin', title: 'Gap (minutes)', type: 'number' },
      { id: 'at', field: 'at', title: 'At', type: 'number' },
    ]);
    const S = gapsGrid.statistics;

    const interval = S.interval('gapMin', { kind: 'mean', confidence: 0.95 });
    const median = S.reduce('gapMin', 'median');
    const p95 = S.reduce('gapMin', 'p95');
    const jb = S.reduce('gapMin', 'jarqueBera');
    const skew = S.reduce('gapMin', 'skewness');
    const kurt = S.reduce('gapMin', 'kurtosis');

    /*
     * The exponential a Poisson process predicts, built from the grid's own
     * mean. An exponential has a median of mean x ln 2 and a 95th percentile of
     * mean x ln 20, so the model can be put beside the grid's own median and
     * p95 as a number rather than only as a curve. It is the model, and it is
     * labelled as the model everywhere it appears.
     */
    const mean = interval ? interval.mean : null;
    const modelMedian = typeof mean === 'number' ? mean * Math.LN2 : null;
    const modelP95 = typeof mean === 'number' ? mean * Math.log(20) : null;

    chartInto(
      box.plot(210),
      {
        grid: gapsGrid,
        type: 'histogram',
        /* The column being binned, named as the measure. A histogram counts for
           itself; giving it a category on `x` and a count on `y` makes it chart
           one bar per distinct value instead, which is a different chart. */
        y: 'gapMin',
        buckets: 20,
        /* The grid's kernel density estimate over the same column: a curve with
           no bin edges, so what is in the data and what is in the binning can be
           told apart. */
        curve: true,
        title: 'Gaps between earthquakes, with a density curve',
        axis: { x: 'Minutes between one earthquake and the next', y: 'Gaps' },
        legend: false,
      },
      'The gap histogram',
    );

    chartInto(
      box.plot(210),
      {
        grid: gapsGrid,
        type: 'ecdf',
        y: 'gapMin',
        title: 'The share of gaps at or below each length',
        axis: { x: 'Minutes', y: 'Share at or below' },
        legend: false,
      },
      'The cumulative comparison',
    );

    chartInto(
      box.plot(210),
      {
        grid: gapsGrid,
        type: 'qq',
        y: 'gapMin',
        title: 'The gaps against a normal distribution',
        axis: { x: 'Normal quantile', y: 'Gap in minutes' },
        legend: false,
      },
      'The normal quantile plot',
    );

    const notNormal = typeof jb === 'number' && jb > JARQUE_BERA_CUT;

    box.figure('Mean gap', minutesText(interval && interval.mean), "interval('gapMin', {kind:'mean'})");
    box.figure(
      '95% interval on the mean',
      interval ? `${minutesText(interval.lower)} to ${minutesText(interval.upper)}` : '-',
      'interval().lower / .upper',
    );
    box.figure('Median gap', minutesText(median), "reduce('gapMin', 'median')");
    box.figure(
      'An exponential would put it at',
      minutesText(modelMedian),
      'the model: mean × ln 2',
    );
    box.figure('95th percentile', minutesText(p95), "reduce('gapMin', 'p95')");
    box.figure(
      'An exponential would put it at',
      minutesText(modelP95),
      'the model: mean × ln 20',
    );
    box.figure('Jarque-Bera', num(jb, 1), "reduce('gapMin', 'jarqueBera')");
    box.figure('Skewness', num(skew, 2), "reduce('gapMin', 'skewness')");
    box.figure('Kurtosis', num(kurt, 2), "reduce('gapMin', 'kurtosis')");
    box.figure('Gaps measured', count(gaps.length), 'one per earthquake after the first');
    box.note(
      'The exponential model is stated beside the grid’s own figures rather than drawn as a ' +
        'second line on the cumulative chart, so the model and the data stay easy to read side ' +
        'by side.',
    );

    verdicts.push({
      text:
        `The mean gap between earthquakes is ${minutesText(mean)}` +
        (interval
          ? `, and the interval around it runs from ${minutesText(interval.lower)} to ${minutesText(
              interval.upper,
            )}`
          : '') +
        `. The median is shorter, at ${minutesText(median)}. An exponential with that mean — ` +
        'the curve a Poisson process predicts — would put the median at ' +
        `${minutesText(modelMedian)} and the 95th percentile at ${minutesText(modelP95)}, against ` +
        `${minutesText(p95)} measured. ${
          modelMedian && Math.abs(median - modelMedian) / modelMedian < 0.15
            ? 'The two are close, so the arrivals look close to independent over this window.'
            : median < modelMedian
              ? 'The real gaps are shorter than the model at the middle: earthquakes are arriving ' +
                'in clusters, which is what triggering looks like.'
              : 'The real gaps are longer than the model at the middle, which a quiet spell inside ' +
                'the window will do.'
        }`,
      source: `grid.statistics.interval('gapMin', { kind: 'mean' }) and reduce('gapMin', 'median' | 'p95')`,
    });

    verdicts.push({
      text: notNormal
        ? `Jarque-Bera on the gaps is ${num(jb, 0)}, far above the 5.99 cut, so the gaps are ` +
          `not plausibly normal — which is exactly what a Poisson process predicts. The skew of ` +
          `${num(skew, 1)} says the same thing in another way: a few very long quiet spells ` +
          'pull the tail out to the right while most gaps are short.'
        : `Jarque-Bera on the gaps is ${num(jb, 1)}, below the 5.99 cut, so normality is not ` +
          'ruled out on this window. That is unusual for arrival gaps and worth a second look ' +
          'at how few of them are in view.',
      source: `grid.statistics.reduce('gapMin', 'jarqueBera')`,
    });

    return {
      ok: true,
      n: gaps.length,
      mean: interval ? interval.mean : null,
      lower: interval ? interval.lower : null,
      upper: interval ? interval.upper : null,
      median,
      p95,
      jarqueBera: jb,
      skewness: skew,
      kurtosis: kurt,
      notNormal,
      modelMedian,
      modelP95,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 3. How an aftershock sequence dies away                             */
  /* ------------------------------------------------------------------ */

  function aftershockDecay(rows, verdicts) {
    const box = card(
      'omori',
      'How an aftershock sequence dies away',
      `Omori's law says the rate of aftershocks falls off as a power of the time since the ` +
        'mainshock: half as many in the second hour as the first, and so on down. On a log-log ' +
        'plot that is a straight line, and the exponent is its slope.',
    );

    const picked = pickSequence(rows, {
      radiusKm: SEQUENCE_RADIUS_KM,
      hours: SEQUENCE_HOURS,
      minEvents: SEQUENCE_MIN_EVENTS,
    });

    if (!picked.mainshock) {
      const largest = picked.largest;
      box.note(
        largest
          ? `The largest earthquake in view is M${num(largest.mag, 1)} ${largest.place}, and ` +
            `${picked.aftershocks.length} earthquakes follow it within ${SEQUENCE_RADIUS_KM} km in ` +
            `${SEQUENCE_HOURS} hours — too few to fit a decay to. No earthquake in view has a ` +
            'recorded sequence big enough, so no exponent is quoted. That is usually not a quiet ' +
            'fault: where a network only hears down to about magnitude 4.5, the aftershocks ' +
            'happened and were never recorded.'
          : 'No earthquake in view has a recorded aftershock sequence.',
      );
      verdicts.push({
        text: largest
          ? `No aftershock decay is quoted this window: the largest earthquake in view, M${num(
              largest.mag,
              1,
            )} ${largest.place}, has ${picked.aftershocks.length} recorded earthquakes within ${
              SEQUENCE_RADIUS_KM
            } km of it in the ${SEQUENCE_HOURS} hours after, and no other earthquake has enough either.`
          : 'No aftershock decay is quoted this window: there is no sequence in view.',
        source: 'no fit attempted',
      });
      return { ok: false, reason: 'no sequence', largest: largest ? largest.id : null };
    }

    const main = picked.mainshock;
    const binned = decayBinRows(picked.aftershocks, main.time, { bins: 8, toHours: SEQUENCE_HOURS });
    if (!binned.length) {
      box.note('The sequence has no earthquakes inside the binned time range.');
      return { ok: false, reason: 'no bins' };
    }

    const binSource = dataset(binned, [
      { id: 'bin', field: 'bin', type: 'number' },
      { id: 'binHours', field: 'binHours', type: 'number' },
      { id: 'midHours', field: 'midHours', type: 'number' },
    ]);
    const counted = derive(
      binSource,
      {
        groupBy: 'bin',
        select: {
          n: { fn: 'count' },
          binHours: { of: 'binHours', fn: 'first' },
          midHours: { of: 'midHours', fn: 'first' },
        },
      },
      [
        { id: 'bin', field: 'bin', type: 'number' },
        { id: 'n', field: 'n', type: 'number' },
        { id: 'binHours', field: 'binHours', type: 'number' },
        { id: 'midHours', field: 'midHours', type: 'number' },
      ],
    );

    const points = readRows(counted)
      .map(toDecayPoint)
      .filter(Boolean)
      .sort((a, b) => a.midHours - b.midHours)
      .map((row) => ({ ...row, id: `bin-${row.bin}` }));

    if (points.length < 3) {
      box.note('Fewer than three time bins hold an earthquake, so no exponent is quoted.');
      return { ok: false, reason: 'too few bins', mainshock: main.id };
    }

    const fitGrid = dataset(points, [
      { id: 'logT', field: 'logT', title: 'log10 hours', type: 'number' },
      { id: 'logRate', field: 'logRate', title: 'log10 per hour', type: 'number' },
      { id: 'rate', field: 'rate', title: 'Per hour', type: 'number' },
      { id: 'n', field: 'n', title: 'Earthquakes', type: 'number' },
    ]);
    const model = fitGrid.statistics.regressionModel({
      predictors: ['logT'],
      response: 'logRate',
      confidence: 0.95,
    });
    if (!model) {
      box.note('The decay fit was refused on this sequence, so no exponent is quoted.');
      return { ok: false, reason: 'no model', mainshock: main.id };
    }
    const slope = model.coefficients.find((c) => c.name === 'logT');
    const p = -slope.estimate;
    const pLower = slope.upper == null ? null : -slope.upper;
    const pUpper = slope.lower == null ? null : -slope.lower;

    chartInto(
      box.plot(230),
      {
        grid: fitGrid,
        type: 'scatter',
        /* Handed in rather than bound, for the reason the magnitude-frequency
           chart gives: eight time bins is fewer than thirteen distinct x values
           and a bound numeric column below that count loses its fit line. */
        points: points.map((row) => ({ x: row.logT, y: row.logRate, key: row.id })),
        fit: true,
        band: model.band,
        title: `Aftershocks of M${num(main.mag, 1)} ${main.place}`,
        axis: {
          x: { title: 'log10 hours since the mainshock', format: (value) => Number(value).toFixed(1) },
          y: 'log10 aftershocks per hour',
        },
        legend: false,
      },
      'The Omori fit',
    );

    box.figure('Decay exponent p', num(p, 2), 'regressionModel().coefficients');
    box.figure(
      '95% interval on p',
      pLower == null ? '-' : `${num(pLower, 2)} to ${num(pUpper, 2)}`,
      'coefficient.lower / .upper',
    );
    box.figure('R²', num(model.r2, 3), 'regressionModel().r2');
    box.figure('Aftershocks', count(picked.aftershocks.length), `within ${SEQUENCE_RADIUS_KM} km, ${SEQUENCE_HOURS} h`);
    box.figure('Time bins fitted', String(points.length), "derived select {n: {fn: 'count'}}");

    if (picked.largest && picked.largest.id !== main.id) {
      box.note(
        `The largest earthquake in view is M${num(picked.largest.mag, 1)} ${picked.largest.place}, ` +
          `which has no recorded sequence: the global network hears down to about magnitude 4.5, ` +
          `so its aftershocks were not recorded. The sequence shown is the largest one that was.`,
      );
    }

    verdicts.push({
      text:
        `The aftershocks of M${num(main.mag, 1)} ${main.place} die away with an exponent of ` +
        `${num(p, 2)}` +
        (pLower == null ? '' : `, between ${num(pLower, 2)} and ${num(pUpper, 2)}`) +
        `. ${
          p >= 0.8 && p <= 1.4
            ? "That is the ordinary range Omori's law is quoted in, so this sequence is behaving as sequences do."
            : p < 0.8
              ? 'That is a slow decay: the sequence is still producing earthquakes later than a typical one would.'
              : 'That is a fast decay: the sequence burnt itself out quickly.'
        } The line was fitted through ${points.length} time bins holding ${count(
          picked.aftershocks.length,
        )} aftershocks.`,
      source: `grid.statistics.regressionModel({ predictors: ['logT'], response: 'logRate' })`,
    });

    return {
      ok: true,
      mainshock: { id: main.id, mag: main.mag, place: main.place, time: main.time },
      largest: picked.largest ? { id: picked.largest.id, mag: picked.largest.mag } : null,
      aftershocks: picked.aftershocks.length,
      bins: points.length,
      p,
      pLower,
      pUpper,
      r2: model.r2,
      points: points.map((row) => [row.midHours, row.n, row.binHours]),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4. How deep they are, by network and by region                      */
  /* ------------------------------------------------------------------ */

  function depthByGroup(rows, verdicts) {
    const label = groupBy === 'net' ? 'network' : 'region';
    const box = card(
      'depth',
      `How deep they are, by ${label}`,
      'Depth is the one measurement in the feed that is not a single number per group: it has a ' +
        'shape, and the shape is the interesting part. A shallow network and a subduction zone ' +
        'look nothing alike, and an average hides exactly that.',
    );

    const withDepth = rows.filter((row) => typeof row.depth === 'number');
    if (withDepth.length < 20) {
      box.note('Too few earthquakes with a depth in view.');
      return { ok: false, reason: 'too few depths' };
    }

    const all = dataset(withDepth, [
      { id: 'depth', field: 'depth', title: 'Depth (km)', type: 'number' },
      { id: 'net', field: 'net', title: 'Network' },
      { id: 'region', field: 'region', title: 'Region' },
    ]);

    /* The biggest groups, chosen by the grid's own count rather than by a pass
       over the rows here. */
    const perGroup = derive(
      all,
      {
        groupBy,
        select: {
          n: { fn: 'count' },
          raw: { of: 'depth', fn: 'avg' },
          trimmed: { of: 'depth', fn: 'trimmedMean' },
          median: { of: 'depth', fn: 'median' },
        },
      },
      [
        { id: 'key', field: groupBy, title: label },
        { id: 'n', field: 'n', type: 'number' },
        { id: 'raw', field: 'raw', type: 'number' },
        { id: 'trimmed', field: 'trimmed', type: 'number' },
        { id: 'median', field: 'median', type: 'number' },
      ],
    );

    const groups = readRows(perGroup)
      .map((row) => ({ ...row, key: row[groupBy] }))
      .filter((row) => row.key != null && row.n >= 5)
      .sort((a, b) => b.n - a.n)
      .slice(0, DEPTH_GROUPS);

    if (!groups.length) {
      box.note('No group in view holds enough earthquakes to compare.');
      return { ok: false, reason: 'no groups' };
    }

    const keep = new Set(groups.map((row) => row.key));
    const shown = dataset(
      withDepth.filter((row) => keep.has(row[groupBy])),
      [
        { id: 'depth', field: 'depth', title: 'Depth (km)', type: 'number' },
        { id: 'group', field: groupBy, title: label },
      ],
    );

    chartInto(
      box.plot(240),
      {
        grid: shown,
        type: 'violin',
        x: 'group',
        y: 'depth',
        title: `Depth by ${label}, the ${groups.length} busiest`,
        axis: { x: { labels: true, rotate: 'auto' }, y: 'Depth in kilometres' },
        legend: false,
      },
      'The depth violins',
    );

    box.note(
      'Read the shapes for how each group compares, and read the median and trimmed mean ' +
        'printed below for the numbers: both figures are the grid’s own, computed straight ' +
        'from the depth column.',
    );

    const rawMean = all.statistics.reduce('depth', 'avg');
    const trimmedMean = all.statistics.reduce('depth', 'trimmedMean');
    const outliers = all.statistics.anomalies({ columns: ['depth'], method: 'modifiedZScore' });

    box.figure('Mean depth', `${num(rawMean, 1)} km`, "reduce('depth', 'avg')");
    box.figure('Trimmed mean depth', `${num(trimmedMean, 1)} km`, "reduce('depth', 'trimmedMean')");
    box.figure(
      'Outliers by modified z',
      `${count(outliers.flagged)} of ${count(outliers.n)}`,
      "anomalies({columns:['depth'], method:'modifiedZScore'})",
    );
    if (outliers.rows.length) {
      const worst = outliers.rows[0];
      const depth = worst.why && worst.why[0] ? worst.why[0].value : null;
      box.figure('Deepest outlier', `${num(depth, 0)} km, score ${num(worst.score, 1)}`, 'anomalies().rows[0]');
    }
    for (const row of groups) {
      box.figure(
        `${row.key} (${count(row.n)})`,
        `median ${num(row.median, 1)} km, mean ${num(row.raw, 1)} km, trimmed ${num(row.trimmed, 1)} km`,
        'derived select {median, avg, trimmedMean}',
      );
    }

    const deepest = [...groups].sort((a, b) => b.median - a.median)[0];
    const shallowest = [...groups].sort((a, b) => a.median - b.median)[0];

    verdicts.push({
      text:
        `Depth is not one distribution. Of the ${groups.length} busiest ${label}s in view, ` +
        `${deepest.key} has the deepest earthquakes with a median of ${num(deepest.median, 1)} km ` +
        `and ${shallowest.key} the shallowest at ${num(shallowest.median, 1)} km.`,
      source: `derived grid, select: { median: { of: 'depth', fn: 'median' } }`,
    });

    verdicts.push({
      text:
        `Across everything in view the mean depth is ${num(rawMean, 1)} km and the trimmed mean ` +
        `${num(trimmedMean, 1)} km, a difference of ${num(Math.abs(rawMean - trimmedMean), 1)} km. ` +
        `${
          Math.abs(rawMean - trimmedMean) > 1
            ? 'The gap is the deep earthquakes pulling the plain average down away from where most of them are.'
            : 'The two agree, so no small group of deep earthquakes is carrying the average.'
        } ${count(outliers.flagged)} of ${count(outliers.n)} depths are flagged as outliers by the ` +
        'modified z-score, which uses the median and the spread around it so one very deep ' +
        'earthquake cannot widen the ruler it is being measured with.',
      source: `grid.statistics.reduce('depth', 'trimmedMean') and grid.statistics.anomalies(...)`,
    });

    return {
      ok: true,
      groupBy,
      rawMean,
      trimmedMean,
      flagged: outliers.flagged,
      scanned: outliers.n,
      groups: groups.map((row) => ({
        key: row.key,
        n: row.n,
        median: row.median,
        raw: row.raw,
        trimmed: row.trimmed,
      })),
      worstScore: outliers.rows.length ? outliers.rows[0].score : null,
      worstKey: outliers.rows.length ? outliers.rows[0].rowKey : null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5. Is the count each day a stable process?                          */
  /* ------------------------------------------------------------------ */

  function dailyControl(rows, verdicts) {
    const box = card(
      'control',
      'Is the number recorded each day steady?',
      'A control chart asks whether a process is doing the same thing every day or has moved. ' +
        'Its limits are three sigma from the moving range — the day-to-day jump, not the overall ' +
        'spread — so a step change cannot widen the limits that are supposed to catch it.',
    );

    const source = dataset(rows, [
      { id: 'day', field: 'day', title: 'Day' },
      { id: 'time', field: 'time', title: 'Time', type: 'number' },
    ]);
    const perDay = derive(
      source,
      { groupBy: 'day', select: { n: { fn: 'count' } } },
      [
        { id: 'day', field: 'day', title: 'Day' },
        { id: 'n', field: 'n', title: 'Earthquakes', type: 'number' },
      ],
    );

    const days = readRows(perDay)
      .filter((row) => typeof row.day === 'string' && row.day && row.n > 0)
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    /*
     * The first and last days are cut off by the window rather than by
     * midnight: the window starts seven days ago at whatever time it is now,
     * and ends now. Both are part days, and a part day on a control chart is a
     * false alarm waiting to happen, so only the whole days between them are
     * charted. The page says so rather than leaving a reader to wonder why
     * today is missing.
     */
    const whole = days.slice(1, -1);
    if (whole.length < 4) {
      box.note(
        `Only ${whole.length} whole day${whole.length === 1 ? '' : 's'} lie inside the window, ` +
          'which is too few for control limits to mean anything.',
      );
      return { ok: false, reason: 'too few days', days: whole.length };
    }

    /*
     * The tolerance. Control limits and the rule breaks are facts about the
     * data and need no customer specification, but `capability` returns null
     * without one, so the honest floor is declared: a day cannot hold fewer
     * than zero earthquakes. It is a one-sided specification, so no Cp is
     * quoted from it and none is shown. This is finding F-1329-1.
     */
    const chartGrid = dataset(
      whole.map((row) => ({ id: row.day, day: row.day, n: row.n })),
      [
        { id: 'day', field: 'day', title: 'Day' },
        { id: 'n', field: 'n', title: 'Earthquakes', type: 'number', spec: { lower: 0 } },
      ],
    );

    const nelson = chartGrid.statistics.capability('n', { lower: 0, rules: 'nelson' });
    const western = chartGrid.statistics.capability('n', { lower: 0, rules: 'westernElectric' });
    if (!nelson || !nelson.limits) {
      box.note('The control limits were refused on this data.');
      return { ok: false, reason: 'no limits' };
    }

    chartInto(
      box.plot(240),
      {
        grid: chartGrid,
        type: 'control',
        y: 'n',
        rules: 'nelson',
        spec: { lower: 0 },
        title: 'Earthquakes recorded each whole day',
        axis: { x: { labels: true, rotate: 'auto' }, y: 'Earthquakes' },
        legend: false,
      },
      'The control chart',
    );

    /* A violation names the reading by its position in the series, so the
       position is turned back into the day it belongs to. */
    const byDay = new Map();
    for (const violation of nelson.violations) {
      const day = whole[violation.index] ? whole[violation.index].day : `#${violation.index}`;
      if (!byDay.has(day)) byDay.set(day, new Set());
      byDay.get(day).add(violation.description);
    }
    const breaches = [...byDay.entries()].map(([day, rules]) => ({ day, rules: [...rules] }));

    box.figure('Centre line', `${num(nelson.limits.centre, 1)} a day`, "capability('n').limits.centre");
    box.figure(
      'Control limits',
      `${num(nelson.limits.lower, 1)} to ${num(nelson.limits.upper, 1)}`,
      'limits.lower / .upper',
    );
    box.figure('Sigma, from the moving range', num(nelson.limits.sigma, 1), 'limits.sigma');
    box.figure('Whole days charted', String(whole.length), "derived select {n: {fn: 'count'}}");
    box.figure('Nelson breaks', count(nelson.violations.length), "capability({rules:'nelson'})");
    box.figure(
      'Western Electric breaks',
      western ? count(western.violations.length) : '-',
      "capability({rules:'westernElectric'})",
    );
    for (const breach of breaches) {
      box.figure(breach.day, breach.rules.join('; '), 'violations[].description');
    }
    box.note(
      'The first and last days in the window are part days, so they are left off: the window ' +
        'starts seven days ago at this time of day, not at midnight.',
    );

    verdicts.push({
      text: breaches.length
        ? `The daily count is not a steady process. Over ${whole.length} whole days the centre ` +
          `line sits at ${num(nelson.limits.centre, 0)} earthquakes a day with limits of ${num(
            nelson.limits.lower,
            0,
          )} to ${num(nelson.limits.upper, 0)}, and ${breaches.length} day${
            breaches.length === 1 ? '' : 's'
          } break a Nelson rule: ` +
          breaches.map((b) => `${b.day} (${b.rules.join('; ')})`).join(', ') +
          '.'
        : `The daily count looks like a steady process: over ${whole.length} whole days the ` +
          `centre line is ${num(nelson.limits.centre, 0)} earthquakes a day, the limits run ` +
          `${num(nelson.limits.lower, 0)} to ${num(nelson.limits.upper, 0)}, and no day breaks a ` +
          'Nelson rule.',
      source: `grid.statistics.capability('n', { rules: 'nelson' })`,
    });

    return {
      ok: true,
      days: whole.map((row) => [row.day, row.n]),
      centre: nelson.limits.centre,
      upper: nelson.limits.upper,
      lower: nelson.limits.lower,
      sigma: nelson.limits.sigma,
      nelson: nelson.violations.length,
      western: western ? western.violations.length : null,
      breaches,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Putting it together                                                 */
  /* ------------------------------------------------------------------ */

  /** Throw away everything the last pass built. */
  function teardown() {
    for (const chart of built.charts) {
      try {
        chart.destroy();
      } catch {}
    }
    for (const instance of built.grids) {
      try {
        instance.destroy();
      } catch {}
    }
    built = { charts: [], grids: [] };
    board.textContent = '';
    verdictList.textContent = '';
  }

  /**
   * Read the table as it stands and rebuild every analysis from it.
   *
   * @returns {object} the state the checks read
   */
  function refresh() {
    teardown();
    state.passes += 1;
    state.error = null;

    let rows;
    try {
      rows = withDerivedFields(readRows(grid));
    } catch (error) {
      state.error = String((error && error.message) || error);
      board.append(el('p', 'chart-error', `The table could not be read: ${state.error}`));
      return state;
    }

    state.rows = rows.length;
    basis.textContent = `${count(rows.length)} earthquakes in view`;

    /* `filters.where()` with no arguments names the predicates in force, so the
       panel's copy of the toggle can show what the table is actually doing
       rather than what this panel last did to it. */
    try {
      const pressed = (grid.filters.where() || []).includes('notable');
      notableButton.setAttribute('aria-pressed', String(pressed));
      notableButton.classList.toggle('on', pressed);
    } catch {}

    const verdicts = [];
    const analyses = {};
    const run = (id, fn) => {
      try {
        analyses[id] = fn(rows, verdicts);
      } catch (error) {
        analyses[id] = { ok: false, reason: String((error && error.message) || error) };
        board.append(el('p', 'chart-error', `${id} could not be computed: ${analyses[id].reason}`));
        console.error('[earthquake statistics]', id, error);
      }
    };

    run('magnitudeFrequency', magnitudeFrequency);
    run('interArrival', interArrival);
    run('aftershockDecay', aftershockDecay);
    run('depthByGroup', depthByGroup);
    run('dailyControl', dailyControl);

    for (const verdict of verdicts) {
      const item = el('li');
      item.append(el('span', 'verdict-text', verdict.text));
      item.append(el('code', 'verdict-source', verdict.source));
      verdictList.append(item);
    }
    if (!verdicts.length) {
      verdictList.append(el('li', null, 'Nothing in view to read a verdict from.'));
    }

    state.analyses = analyses;
    state.verdicts = verdicts;
    state.groupBy = groupBy;
    return state;
  }

  /* The panel is only ever built when its tab is first opened, so the first
     pass happens here. */
  refresh();

  return {
    el: root,
    refresh,
    state,
    setNotable(on) {
      notableButton.setAttribute('aria-pressed', String(!!on));
      notableButton.classList.toggle('on', !!on);
    },
    groupBy: () => groupBy,
    setGroupBy,
    destroy() {
      teardown();
      root.remove();
    },
  };
}
