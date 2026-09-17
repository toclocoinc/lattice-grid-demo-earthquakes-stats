# Earthquakes around the world, and what the numbers say

A live dashboard of every earthquake the United States Geological Survey has recorded in the last seven days, built on Lattice Grid and reading the USGS feeds directly from the browser — and then a Statistics tab that puts the grid's statistics engine to work on the same rows and writes out what it finds in plain English.

**[See it running](https://toclocoinc.github.io/lattice-grid-demo-earthquakes-stats/)**

| | |
| --- | --- |
| Grid on npm | [@toclocoinc/lattice-grid](https://www.npmjs.com/package/@toclocoinc/lattice-grid) |
| This demo | [toclocoinc/lattice-grid-demo-earthquakes-stats](https://github.com/toclocoinc/lattice-grid-demo-earthquakes-stats) |
| The plain edition | [toclocoinc/lattice-grid-demo-earthquakes](https://github.com/toclocoinc/lattice-grid-demo-earthquakes) &nbsp;·&nbsp; [running](https://toclocoinc.github.io/lattice-grid-demo-earthquakes/) |
| Product site | [latticegrid.dev](https://www.latticegrid.dev) |

This is the [plain edition](https://github.com/toclocoinc/lattice-grid-demo-earthquakes) with a Statistics tab and a verdict panel added. Everything that edition does — two USGS feeds through one data router, a table, a second table of the significant events, bound KPI tiles, four charts, a rolling seven-day window, corrections landing on the row they belong to, and the saved copy that stands in when the feeds cannot be reached — it does too. What follows covers the new part; the [plain edition's README](https://github.com/toclocoinc/lattice-grid-demo-earthquakes#readme) covers the rest.

## The point

A grid that can hold a million rows is a table. A grid that can tell you what is in them is something else.

Everything on the Statistics tab is a figure the grid produced, and every figure is shown with the call that produced it. Nothing on the page works out a mean, a slope, a control limit or an outlier by hand and prints it beside the grid's charts — that would prove nothing. The verification (`npm run verify`) exists to hold that line: it reads the raw rows out of the table, computes all of it a second and completely independent way in Node, and insists the two agree to the last significant figure.

## The five analyses

Each one runs over whatever the table currently matches. Turn on "Only M4.5 and above" and all five are recomputed and all seven verdicts are rewritten.

### 1. How many at each magnitude — the b-value

Count the earthquakes in each tenth of a magnitude and the counts fall away as a straight line on a log scale. That is the Gutenberg–Richter law, and the slope of the line is the **b-value**: how many small earthquakes there are for each large one. Around 1 is ordinary crust almost everywhere on earth, which is what makes a departure from it interesting.

| What | Which grid call |
| --- | --- |
| The count in each band | a derived grid, `source: { mode: 'derived', groupBy: 'band', select: { n: { fn: 'count' } } }` |
| The completeness magnitude | `grid.statistics.reduce('band', 'mode')` — the fullest band, the usual quick estimate of where the catalogue stops being complete |
| The b-value and its 95% interval | `grid.statistics.regressionModel({ predictors: ['band'], response: 'logN' })`, then the `band` coefficient's `estimate`, `lower` and `upper` |
| R² | the same model's `r2` |
| The fitted line and its confidence band | a `scatter` chart with `fit: true` and `band: model.band` — the ribbon is the model's own interval, not a second line drawn here |

The fit is held to two magnitude units above the completeness magnitude. That is the usual range, and there is a second reason here: this feed is several networks at once. A Californian network hears down to about magnitude 1 and the global network to about 4.5, so the combined catalogue is not one population, and a line across all of it is a line across two catalogues. The page says so, and an apparent b-value below one is what a mixture does to the slope.

### 2. How long between one earthquake and the next

If earthquakes arrived independently of one another, the gaps between them would follow an exponential curve: mostly short, occasionally long, and nothing like a bell. Testing that is the point, because where the gaps are shorter than the model says, earthquakes are triggering each other.

| What | Which grid call |
| --- | --- |
| The mean gap and its 95% interval | `grid.statistics.interval('gapMin', { kind: 'mean', confidence: 0.95 })` |
| The median and the 95th percentile | `grid.statistics.reduce('gapMin', 'median' \| 'p95')` |
| The normality verdict | `grid.statistics.reduce('gapMin', 'jarqueBera')`, against the 5.99 cut the grid's own documentation states |
| Skew and kurtosis | `reduce('gapMin', 'skewness' \| 'kurtosis')` |
| The shape | a `histogram` with `curve: true` — the bars, and the grid's kernel density estimate over them, which has no bin edges and so says which part of the shape is the data's |
| The cumulative shape | an `ecdf` chart |
| How far from normal | a `qq` chart |

The exponential model is stated as figures beside the grid's own — an exponential with that mean puts its median at `mean × ln 2` and its 95th percentile at `mean × ln 20` — rather than drawn on the cumulative chart, so the model and the data stay easy to read side by side.

### 3. How an aftershock sequence dies away

Omori's law says the rate of aftershocks falls off as a power of the time since the mainshock: half as many in the second hour as the first, and so on down. On a log-log plot that is a straight line, and the exponent is its slope. Typical values run from about 0.7 to 1.5.

| What | Which grid call |
| --- | --- |
| The count in each time bin | a derived grid, `groupBy: 'bin', select: { n: { fn: 'count' } }` |
| The decay exponent and its interval | `grid.statistics.regressionModel({ predictors: ['logT'], response: 'logRate' })` |
| The fitted line and its band | a `scatter` chart with `fit: true` and `band: model.band` |

The sequence is chosen rather than assumed. The obvious choice is the largest earthquake in the window, and that is where the page starts — but it is often the wrong one. A deep event under an ocean is recorded by the global network alone, which hears nothing below about magnitude 4.5, so its aftershocks happened and were never recorded; at the time of writing the largest earthquake in the saved copy is an M6.5 under the Java Sea with **zero** recorded aftershocks within 300 km. A magnitude 5 under Alaska, where the network hears down to about magnitude 1, leaves sixty. So the page walks the candidates down from the largest and takes the first one that has a sequence in the data, and then says which earthquake was the largest, which one it is showing, and why they differ.

### 4. How deep they are, by network and by region

Depth is the one measurement in the feed that is not a single number per group: it has a shape, and the shape is the interesting part. A shallow network and a subduction zone look nothing alike, and an average hides exactly that.

| What | Which grid call |
| --- | --- |
| Each group's median, mean and trimmed mean | a derived grid, `select: { median: { of: 'depth', fn: 'median' }, raw: { of: 'depth', fn: 'avg' }, trimmed: { of: 'depth', fn: 'trimmedMean' } }` |
| The overall raw and trimmed means | `grid.statistics.reduce('depth', 'avg' \| 'trimmedMean')` |
| The outliers | `grid.statistics.anomalies({ columns: ['depth'], method: 'modifiedZScore' })` — the median and the spread around it, so one very deep earthquake cannot widen the ruler it is being measured with |
| The shapes | a `violin` chart per group |

"Group depth by" switches the comparison between the recording network and the region USGS names in the place string. Both recompute everything.

### 5. Is the number recorded each day steady?

A control chart asks whether a process is doing the same thing every day or has moved. Its limits are three sigma from the **moving range** — the day-to-day jump, not the overall spread — so a step change cannot widen the limits that are supposed to catch it.

| What | Which grid call |
| --- | --- |
| The count each day | a derived grid, `groupBy: 'day', select: { n: { fn: 'count' } }` |
| The centre line, sigma and the control limits | `grid.statistics.capability('n', { rules: 'nelson' }).limits` |
| The rule breaks | the same call's `violations`, each with the rule number and its description; the Western Electric count comes from the same call with `rules: 'westernElectric'` |
| The chart | a `control` chart, which draws the limits and marks the breaks |

The first and last days in the window are part days — the window starts seven days ago at this time of day, not at midnight — so only the whole days between them are charted, and the page says so.

## The verdict panel

Seven sentences at the top of the tab, each built from the figures beneath it and each carrying the call that produced it. They are the deliverable: a reader who wants the numbers can have them, and a reader who wants to know what the week did can read seven sentences and stop.

They are rewritten on every pass, so they can never be stale, and the verification insists that at least five of the seven actually change when the table is narrowed.

## Reading the depth violins and the gap chart

Two things worth knowing so the charts read the way they are meant to.

The depth violins show each group's shape, and the number to read off them is
the median and trimmed mean printed beside the chart, not the width of the
plot itself — those two figures are the grid's own and are exact regardless of
how the violin is scaled.

The exponential model for the time-between-earthquakes chart is stated as
figures beside the grid's own rather than drawn as a second line on the
cumulative chart, so the two are easy to compare without one obscuring the
other.

## Running it

You need Node 22. Nothing is compiled and there is no build step.

```
npm install
npm start
```

The server prints the address to open. It picks a free port each time so it will not clash with anything else you have running.

| Address | What you get |
| --- | --- |
| `/` | live, reading the USGS feeds and polling every minute |
| `/?source=snapshot` | the saved copy in `data/snapshot`, no network needed |
| `/?source=snapshot&replay=1` | the saved copy fed in over time, so it moves offline |

The saved copy is shown as though its newest event had just arrived, so the seven day window is never empty however long ago the file was built; the page says so under the title. To take a fresh one, `npm run snapshot`.

`preview.html` is the whole dashboard, statistics tab included, in one file with the saved data written into it — open it straight from disk. Rebuild it with `npm run preview` after taking a new snapshot; it refuses to write anything unless every library file it points at answers 200 from the CDN and is byte for byte identical to the copy installed locally.

## Where the data comes from

The [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php), read directly from your browser with no server in the middle: `all_week.geojson` and `significant_month.geojson` when the page opens, and `all_day.geojson` every minute after that for new events and revisions.

Two things worth knowing before you read the statistics. The feed is a **union of catalogues**, not one: the regional US networks hear down to about magnitude 1 and the global network to about 4.5, which is why the b-value fit is held to a stated range and why the largest earthquake in the window often has no recorded aftershocks. And magnitudes are **revised for hours** after an event, so a figure here is a figure about the catalogue as it stands right now, which is the honest thing for a live page to be.

Times in the feed are UTC; the table shows your local time and UTC side by side. Depth is in kilometres, from the third GeoJSON coordinate. A magnitude is `null` on a handful of records, so nothing assumes it is a number.

## Files

```
index.html                page shell
main.js                   works out where the data comes from, then starts
src/licence.js            the key for the demo's own published address
src/usgs-feed.js          the feeds: fetching, parsing, polling, replay
src/dashboard.js          the views: router, tables, tiles, charts, tabs
src/analysis.js           preparing rows: bands, regions, gaps, sequences, bins
src/statistics.js         the Statistics tab: the five analyses and the verdicts
styles.css                the page around the grid
tools/serve.mjs           a small static file server
tools/build-snapshot.mjs  save a real run into data/snapshot
tools/build-preview.mjs   build the single file preview
tools/crosscheck.mjs      the same statistics, computed again from scratch
tools/verify.mjs          open it in a real browser and check all of it
data/snapshot/            a saved run, so the demo works with no network
```

`src/analysis.js` shapes data and computes no statistics; `src/statistics.js` computes no statistics either, it asks the grid for them. The line between the two files is the honest claim this demo makes.

## Checking it

```
npm run verify            # the saved copy, the statistics tab, and the fallback
npm run verify -- --all   # also the live feeds and preview.html from disk
```

Needs Node 22 and a Chrome or Chromium on the machine. It is not a smoke test. Alongside everything the plain edition checks — the tiles against the saved feed, a revision landing on its row, the window dropping one event and keeping another, the fallback when the feeds are blocked — it opens the Statistics tab on a fresh page and then:

- reads the **raw rows** out of the table and recomputes every verdict figure in Node from textbook definitions, in `tools/crosscheck.mjs`, which imports nothing the page uses: its own least squares with a Student-t interval from an incomplete beta function, its own mean and confidence interval, its own Jarque–Bera, its own quantiles and trimmed means, its own modified z-scores, its own moving-range control limits, and its own aftershock selection and log-spaced binning;
- insists every one of them agrees with the page, and prints both numbers and the gap between them for each;
- insists every analysis drew marks, and that both regression charts drew a fitted line and a confidence band;
- regroups the depth comparison by region and cross-checks the whole thing again;
- narrows the table to the notable earthquakes, cross-checks the whole thing a third time, and insists the figures moved **consistently** — the completeness magnitude rises, the mean gap lengthens roughly in proportion to the rows that were removed, the mean depth deepens, the daily centre line falls, and at least five of the seven sentences are rewritten;
- insists on nought console errors and nought page errors throughout, and on no watermark on localhost.

At the time of writing that is 366 checks with `--all`, and none of them reads a number off the page and compares it with itself.

## Licence

The code in this repository is available under the MIT licence. See [LICENSE](LICENSE).

Lattice Grid itself is a separate commercial product with its own terms. It is free to use on localhost, with no key and no watermark, so a copy of this repository runs unrestricted on your own machine. This demo carries a key for its own published address only, which is why you will find one in the source. Keys for your own sites come from [latticegrid.dev](https://www.latticegrid.dev).

The earthquake data comes from the [United States Geological Survey earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php). USGS data are in the public domain and free to use.
