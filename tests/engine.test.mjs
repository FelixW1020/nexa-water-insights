// Tests for the analysis engine inside index.html.
// Run: node tests/engine.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "index.html");

function loadEngine(file) {
  let code = fs.readFileSync(file, "utf8");
  if (file.endsWith(".html")) {
    const m = code.match(/<script id="nexa-engine">([\s\S]*?)<\/script>/);
    if (!m) throw new Error("engine script block not found in " + file);
    code = m[1];
  }
  const sandbox = { module: { exports: {} }, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}
const E = loadEngine(src);

const DAY = 864e5, HOUR = 36e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
// arrays made inside the vm sandbox have a different prototype, so copy before deepEqual
const plain = (x) => JSON.parse(JSON.stringify(x));
const results = [];
function test(name, fn) {
  try { fn(); results.push(["ok", name]); }
  catch (e) { results.push(["FAIL", name, e.message]); }
}
const sample = (f) => fs.readFileSync(path.join(root, "sample-data", f), "utf8");
const FLOW = "wilkinson-flow-daily.csv", TEMP = "wilkinson-hot-water-temps.csv";
const rates = { rate: 14.57, alertHours: 24, crewHours: 4, regularDays: 30 };

/* ---------- the Wilkinson sample ---------- */
const real = E.analyze([E.readFile(FLOW, sample(FLOW)), E.readFile(TEMP, sample(TEMP))]);
const flow = real.flows[0];

test("reads both Monnit exports", () => {
  assert.equal(real.flows.length, 1);
  assert.equal(flow.sensor.name, "Wilkinson Flow Meter");
  assert.equal(flow.resolution, "daily");
  assert.equal(real.temps.hot.length, 3);
  assert.deepEqual(plain(real.temps.sparse.map((s) => s.n)), [1, 1, 1]);
});

test("finds the October leak", () => {
  assert.equal(flow.likely.length, 1);
  const ev = flow.likely[0];
  assert.ok(["2026-10-06", "2026-10-07"].includes(iso(ev.startT)), "start " + iso(ev.startT));
  assert.ok(["2026-10-14", "2026-10-15"].includes(iso(ev.endT)), "end " + iso(ev.endT));
  assert.ok(ev.excess > 33000 && ev.excess < 44000, "excess " + ev.excess);
  assert.equal(iso(ev.peak.t), "2026-10-13");
  assert.equal(ev.ongoing, false);
});

test("leaves out the start-up readings and the offline days", () => {
  assert.deepEqual(plain(flow.quality.glitches.map((g) => iso(g.t))), ["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"]);
  assert.equal(flow.quality.offline.length, 1);
  assert.equal(flow.quality.offline[0].days, 4);
  assert.equal(flow.quality.offline[0].atStart, true);
});

test("prices the leak and the Nexa counterfactual", () => {
  const p = E.price(flow, rates);
  const ev = flow.likely[0];
  assert.ok(Math.abs(p.leakCost - ev.excess / 1000 * 14.57) < 0.01);
  assert.ok(p.savedCost > 0.9 * p.leakCost, "a one-day alert should save most of a 10-day leak");
  assert.ok(Math.abs(p.savedGal + ev.nexaGal - ev.excess) < 1e-6);
  const slow = E.price(flow, { ...rates, alertHours: 24 * 20 });
  assert.equal(Math.round(slow.savedGal), 0, "an alert after the leak ended saves nothing");
});

test("links the leak to the hot water system", () => {
  const c = flow.likely[0].clue;
  assert.ok(c && c.onT && c.offT, "expected on/off near the leak");
  assert.equal(iso(c.backT), "2026-10-19");
  assert.equal(c.backNormal, true);
  assert.equal(real.temps.main.name, "Mixing Valve Outlet Temperature");
  assert.ok(real.temps.loop && Math.abs(real.temps.loop.drop - 10) < 2, "loop drop " + (real.temps.loop && real.temps.loop.drop));
});

test("finds the long hot water shutdown", () => {
  const longest = real.temps.main.cold.filter((c) => !c.atStart).sort((a, b) => b.days - a.days)[0];
  assert.equal(iso(longest.start), "2026-09-05");
  assert.ok(longest.days > 29 && longest.days < 32);
});

test("monthly totals feed the simulator", () => {
  const s = E.simSeries(flow);
  assert.deepEqual(plain(s.months), ["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  const oct = s.use[5], sep = s.use[4];
  assert.ok(oct > 1.8 * sep, "October should be about double September");
  assert.ok(Math.abs(s.leak[5] * 1000 - flow.likely[0].excess) < 1);
});

/* ---------- synthetic data ---------- */
// 10-minute readings, gallons per reading. Busy 7 AM-9 PM, silent at night.
function synth({ days = 70, leakFrom = null, leakTo = null, gpm = 3, start = Date.UTC(2026, 0, 5) } = {}) {
  const rows = [];
  for (let t = start; t < start + days * DAY; t += 10 * 6e4) {
    const d = new Date(t), h = d.getUTCHours(), wk = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    let v = h >= 7 && h < 21 ? (wk ? 4 : 12) * (0.8 + 0.4 * ((t / 6e5) % 7) / 7) : 0;
    if (leakFrom != null && t >= leakFrom && t < leakTo) v += gpm * 10;
    rows.push([t, v]);
  }
  return rows;
}
const fmt = (t) => {
  const d = new Date(t), p = (n) => String(n).padStart(2, "0");
  let h = d.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)} ${p(h)}:${p(d.getUTCMinutes())}:00 ${ap}`;
};
const toCSV = (rows, header, map = (v) => v) => [`"timestamp","${header}"`].concat(rows.map(([t, v]) => `"${fmt(t)}","${map(v)}"`)).join("\n");

const L0 = Date.UTC(2026, 1, 9, 7), L1 = L0 + 181 * HOUR;

test("10-minute data: catches a 181-hour nonstop leak", () => {
  const csv = toCSV(synth({ leakFrom: L0, leakTo: L1 }), "monnit-1 (Test Meter, FlowVolume, gal)");
  const f = E.analyze([E.readFile("t.csv", csv)]).flows[0];
  assert.equal(f.resolution, "subdaily");
  assert.equal(f.likely.length, 1, "events: " + f.events.map((e) => e.type + iso(e.startT)).join(","));
  const ev = f.likely[0];
  assert.ok(ev.nonstop && Math.abs(ev.nonstop.hours - 181) <= 2, "nonstop " + (ev.nonstop && ev.nonstop.hours));
  const truth = 3 * 60 * 181;
  assert.ok(Math.abs(ev.excess - truth) / truth < 0.15, `excess ${Math.round(ev.excess)} vs ${truth}`);
  assert.ok(f.night.applies);
});

test("10-minute data: no leak, no alarm", () => {
  const f = E.analyze([E.readFile("t.csv", toCSV(synth({}), "monnit-1 (Test Meter, FlowVolume, gal)"))]).flows[0];
  assert.equal(f.likely.length, 0);
  assert.equal(f.possible.length, 0);
});

test("small overnight leak that daily totals alone would miss", () => {
  const csv = toCSV(synth({ leakFrom: L0, leakTo: L0 + 5 * DAY, gpm: 0.3 }), "monnit-1 (Test Meter, FlowVolume, gal)");
  const f = E.analyze([E.readFile("t.csv", csv)]).flows[0];
  assert.ok(f.leaks.length >= 1, "expected the overnight check to flag it");
});

test("running meter totals are converted to use", () => {
  let acc = 1e6;
  const rows = synth({ leakFrom: L0, leakTo: L1 }).map(([t, v]) => [t, (acc += v)]);
  const f = E.analyze([E.readFile("t.csv", toCSV(rows, "Main Meter (gal)"))]).flows[0];
  assert.ok(f.notes.some((n) => /running meter total/.test(n)));
  assert.equal(f.likely.length, 1);
});

test("flow given as a rate (gpm) is integrated", () => {
  const rows = synth({ leakFrom: L0, leakTo: L1 }).map(([t, v]) => [t, v / 10]);
  const f = E.analyze([E.readFile("t.csv", toCSV(rows, "monnit-1 (Test Meter, FlowRate, gpm)"))]).flows[0];
  const ev = f.likely[0];
  assert.ok(ev && Math.abs(ev.excess - 3 * 60 * 181) / (3 * 60 * 181) < 0.15);
});

test("generic daily CSV with ISO dates", () => {
  const lines = ["Date,Water use (gal)"];
  for (let i = 0; i < 60; i++) {
    const t = Date.UTC(2026, 2, 1) + i * DAY, wk = [0, 6].includes(new Date(t).getUTCDay());
    let v = wk ? 500 : 1500;
    if (i >= 30 && i < 36) v += 3000;
    lines.push(`${iso(t)},${v}`);
  }
  const f = E.analyze([E.readFile("d.csv", lines.join("\n"))]).flows[0];
  assert.equal(f.likely.length, 1);
  assert.equal(iso(f.likely[0].startT), "2026-03-31");
  assert.equal(Math.round(f.likely[0].excess), 18000);
});

test("Celsius temperatures are converted", () => {
  const lines = ['"timestamp","monnit-9 (Boiler Supply, Temperature, c)"'];
  for (let i = 0; i < 40; i++) lines.push(`"${fmt(Date.UTC(2026, 0, 1) + i * DAY)}","${i >= 10 && i < 20 ? 25 : 55}"`);
  const t = E.analyze([E.readFile("c.csv", lines.join("\n"))]).temps;
  assert.equal(t.hot.length, 1);
  assert.ok(Math.abs(t.hot[0].onLevel - 131) < 0.5);
  assert.equal(t.main.cold.filter((c) => !c.atStart).length, 1);
});

test("same sensor in two files at different steps uses the detailed one", () => {
  const fine = toCSV(synth({ days: 30 }), "monnit-1 (Test Meter, FlowVolume, gal)");
  const daily = E.readFile("daily.csv", fine);
  const byDay = {};
  for (const p of daily.sensors[0].points) byDay[Math.floor(p.t / DAY) * DAY] = (byDay[Math.floor(p.t / DAY) * DAY] || 0) + p.v;
  const dcsv = toCSV(Object.entries(byDay).map(([t, v]) => [+t, v]), "monnit-1 (Test Meter, FlowVolume, gal)");
  const r = E.analyze([E.readFile("fine.csv", fine), E.readFile("daily.csv", dcsv)]);
  assert.equal(r.flows.length, 1);
  assert.equal(r.flows[0].resolution, "subdaily");
  assert.ok(r.notes.some((n) => /most detailed file/.test(n)));
});

test("semicolon CSV with Monnit-style headers", () => {
  // the commas inside the quoted header must not win the delimiter vote
  const lines = ['"timestamp";"monnit-1 (Test Meter, FlowVolume, gal)"'];
  for (let i = 0; i < 40; i++) lines.push(`"${iso(Date.UTC(2026, 0, 1) + i * DAY)}";"${i >= 20 && i < 26 ? "4500,5" : "1500,5"}"`);
  const f = E.analyze([E.readFile("s.csv", lines.join("\n"))]).flows[0];
  assert.ok(f && !f.error, "flow not read");
  assert.equal(Math.round(f.days[0].total), 1501);
  assert.equal(f.likely.length, 1);
});

test("running meter total in a building that is quiet half the day", () => {
  // busy only 8 AM-6 PM, so the total is flat for most readings
  let acc = 5e5;
  const rows = synth({}).map(([t, v]) => { const h = new Date(t).getUTCHours(); return [t, (acc += h >= 8 && h < 18 ? v : 0)]; });
  const f = E.analyze([E.readFile("t.csv", toCSV(rows, "Main Meter (gal)"))]).flows[0];
  assert.ok(f.notes.some((n) => /running meter total/.test(n)));
  assert.equal(f.quality.glitches.length, 0);
});

test("day-first dates in 10-minute data are spotted past the first day", () => {
  // the first ~2 days have day <= 12, so they read either way
  const p = (n) => String(n).padStart(2, "0");
  const lines = ["Date,Water use (gal)"];
  for (const [t, v] of synth({ days: 30, start: Date.UTC(2026, 2, 11) })) {
    const d = new Date(t);
    lines.push(`${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())},${v}`);
  }
  const file = E.readFile("dmy.csv", lines.join("\n"));
  assert.ok(!file.notes.some((n) => /couldn't read/.test(n)), file.notes.join(" | "));
  const f = E.analyze([file]).flows[0];
  assert.equal(iso(f.days[0].t), "2026-03-11");
  assert.equal(f.days.length, 30);
});

test("rejects files without a time column", () => {
  const f = E.readFile("x.csv", "a,b\n1,2\n3,4");
  assert.ok(f.error);
});

test("sample data in the page matches sample-data/", () => {
  if (!src.endsWith(".html")) return;
  const html = fs.readFileSync(src, "utf8");
  for (const [id, file] of [["sample-flow", FLOW], ["sample-temp", TEMP]]) {
    const m = html.match(new RegExp(`<script type="text/plain" id="${id}"[^>]*>\\n?([\\s\\S]*?)</script>`));
    assert.ok(m, "missing embedded " + id);
    assert.equal(m[1].trim(), sample(file).replace(/\r\n/g, "\n").trim());
  }
});

let failed = 0;
for (const [s, n, msg] of results) { console.log(`${s === "ok" ? "  ok  " : "  FAIL"} ${n}${msg ? "\n        " + msg : ""}`); if (s !== "ok") failed++; }
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
