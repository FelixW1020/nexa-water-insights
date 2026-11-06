# Nexa water insights

A single-page tool for the Nexa pilot at Duke. It started as a water cost simulator and a live leak demo. It now also reads real sensor exports, finds leaks, and shows what each one cost and what a Nexa alert could have saved.

Everything runs in the browser. Uploaded files are never sent anywhere.

## Use it

**Live site:** https://felixw1020.github.io/nexa-water-insights/

Or open `index.html` in any modern browser. No build step or server is needed.

1. Go to the **Your data** tab (or press "Analyze your sensor data" at the top).
2. Drop in one or more CSV exports, or press "Try the Wilkinson sample".
3. Read the results, then change the alert time, crew response time or water rates to see the numbers update.

The page has three tabs:

- **Cost simulator.** What-if scenarios on monthly use. After an upload it switches to your meter's real monthly totals and adds a "Remove the leak" option.
- **Live leak detection.** The original hourly demo. Each leak found in your data has a "Replay in the live demo" button that loads its leak rate and duration here.
- **Your data.** The upload and the analysis.

## What the analysis shows

- When each leak started and ended, the extra gallons, the leak rate, the worst day and the cost.
- What a Nexa alert would have saved, given how fast it fires and how fast a crew responds.
- Shorter rises that are worth a look, and short spikes that are more likely planned work.
- Normal weekday and weekend use, the busiest weekday, and use and cost by month.
- Hot water shutdowns, time spent in the 77 to 113°F range where Legionella grows best (per [CDC](https://www.cdc.gov/control-Legionella/php/guidance/monitor-water-guidance.html)), heat lost around the recirculation loop, and whether hot water switched on or off when a leak started or stopped.
- Data problems: impossible readings, days when the meter wasn't reporting, and sensors with almost no data.
- A daily CSV of the results.

## Files it accepts

The page is built around Monnit exports from the Nexa dashboard: a `timestamp` column and one column per sensor named like `monnit-1265064 (Wilkinson Flow Meter, FlowVolume, gal)`. It also handles:

- Other CSVs with a date column and a flow column (for example `Date, Water use (gal)`).
- Daily, hourly or 10-minute readings. With hourly or finer data it also checks overnight flow and reports how long water ran without stopping.
- Gallons, kgal, liters, cubic meters, cubic feet and ccf, or flow rates in gpm or L/min.
- Running meter totals, which are converted to use per reading.
- Temperatures in °F or °C.
- The same sensor in several files. Repeated readings count once, and if the files use different time steps the most detailed one wins.

## How leaks are found

Each day is compared with the same weekday in the four weeks before and after it, so a busy Monday is measured against other Mondays. A day is clearly high when it beats that normal level by three times the usual day-to-day swing and by at least 35%. Moderately high neighbors join the run. A likely leak is three or more days clearly above normal, or two days at double. The days in a leak are then removed and the normal levels are worked out again.

Daily totals more than 50 times the meter's typical day are treated as bad readings and left out.

The Nexa estimate assumes the leak starts at the beginning of its first day, the alert fires after the set number of hours, and the crew stops it after the response time. Water lost before that point counts as lost. The rest counts as saved. Rates default to the simulator's placeholders ($6.42 water and $8.15 sewer per 1,000 gallons) with no tiers or fixed fees.

## Tests

```
node tests/engine.test.mjs
```

Needs Node 18 or newer. The tests pull the analysis code out of `index.html`, run it on the Wilkinson sample and on synthetic data (10-minute readings with a 181-hour leak, a small overnight leak, running totals, gpm, Celsius, duplicate files), and check that the sample data embedded in the page matches `sample-data/`.

## Layout

```
index.html        the whole app (styles, analysis engine, UI, embedded sample)
sample-data/      Wilkinson flow (daily) and hot water temperature exports
tests/            engine tests
```

## Notes

- The sample is real sensor data from the Wilkinson Building pilot (Mar 30 to Nov 5, 2026). Check with Duke Facilities and Watts before making this repo public.
- Times are shown as written in the file.
