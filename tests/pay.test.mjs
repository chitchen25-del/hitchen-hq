// Checks Hitchen HQ's pay, payday and bank-holiday rules straight from index.html.
// Run: node tests/pay.test.mjs  (no installs needed). Uses made-up pay figures only:
// family figures never go in this public repository.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.sort((a, b) => b.length - a.length)[0];
const grab = (from, to) => { const i = src.indexOf(from); if (i < 0) throw new Error(`index.html no longer has "${from}"`); const j = src.indexOf(to, i); if (j < 0) throw new Error(`index.html no longer has "${to}" after "${from}"`); return src.slice(i, j); };
const line = name => { const m = src.match(new RegExp(`^const ${name} = .*$`, 'm')); if (!m) throw new Error(`index.html no longer has const ${name}`); return m[0]; };

const code = [
  ...['pad', 'ymd', 'parse', 'ymOf', 'today', 'addDays', 'isWeekend'].map(line),
  grab('const addMonths', 'const daysBetween'),
  'const ymAdd = (ym, n) => ymOf(addMonths(`${ym}-01`, n));',
  'let SETTINGS = {}; const vk = () => ({ ...SETTINGS });',
  grab('const BANK_HOLS', 'const DOWS'),
  grab('function payday', 'const dayShort'),
  grab('const IOM_YEARS', 'function slipAdjust'),
  'globalThis.T = { set: s => { SETTINGS = s; }, takeHome, payslip, awardFactor, payday, isBH, ruleBankHols, iomYear, BANK_HOLS };',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const T = ctx.T;

let failed = 0, passed = 0;
const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;
function check(name, ok, detail = '') { if (ok) passed++; else { failed++; console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); } }

// --- reference calculation, written independently of the app, from the Isle of Man rules ---
function reference({ pensionable, other, pct, code, year }) {
  const r = { 2025: { pt: 168, uel: 1032 }, 2026: { pt: 176, uel: 1082 } }[year];
  const gross = pensionable + other, pension = Math.round(pensionable * pct) / 100;
  const pt = r.pt * 52 / 12, uel = r.uel * 52 / 12;
  const ni = Math.round((Math.max(0, Math.min(gross, uel) - pt) * 0.11 + Math.max(0, gross - uel) * 0.01) * 100) / 100;
  const taxable = Math.max(0, gross - pension - (code * 10 + 9) / 12), band = 6500 / 12;
  const tax = Math.round((Math.min(taxable, band) * 0.10 + Math.max(0, taxable - band) * 0.21) * 100) / 100;
  return { gross, pension, ni, tax, net: Math.round((gross - pension - ni - tax) * 100) / 100 };
}

// --- take-home engine against the reference, across low, middle and high pay ---
const cases = [
  { pensionable: 2000, other: 0, pct: 7.5, code: 1250, date: '2026-09-25', year: 2026 },
  { pensionable: 4000, other: 800, pct: 7.5, code: 1500, date: '2026-11-25', year: 2026 },
  { pensionable: 5500, other: 2500, pct: 5, code: 1700, date: '2027-01-25', year: 2026 },
  { pensionable: 3000, other: 0, pct: 7.5, code: 1475, date: '2026-03-25', year: 2025 },
  { pensionable: 600, other: 0, pct: 7.5, code: 1250, date: '2026-09-25', year: 2026 },
];
for (const c of cases) {
  T.set({ pension: c.pct, taxCode: c.code });
  const got = T.takeHome(c.pensionable, c.other, c.date), want = reference(c);
  for (const k of ['gross', 'pension', 'ni', 'tax', 'net']) check(`takeHome ${k} for ${c.pensionable}+${c.other} on ${c.date}`, near(got[k], want[k]), `got ${got[k]}, want ${want[k]}`);
  check(`tax year for ${c.date}`, T.iomYear(c.date).year === c.year, `got ${T.iomYear(c.date).year}`);
}
// call-outs and overtime are never pensionable
T.set({ pension: 7.5, taxCode: 1250, salary: 3000, enh: 0, arrears: true, ratesFrom: '2026-04', awards: [] });
const slip = T.payslip(400, 900, 0, 100, '2026-10');
check('payslip pension only on salary and on call', near(slip.pension, Math.round(3400 * 7.5) / 100), `got ${slip.pension}`);
check('payslip gross includes call-outs and overtime', near(slip.gross, 4400), `got ${slip.gross}`);

// --- pay awards: salary rises in the award month, arrears extras a month later, never twice ---
T.set({ pension: 7.5, taxCode: 1250, salary: 3000, enh: 0, arrears: true, ratesFrom: '2026-04',
  awards: [{ from: '2026-04', pct: 4 }, { from: '2027-04', pct: 5 }, { from: '2028-04', pct: 10 }] });
check('no rise before April 2027', near(T.awardFactor('2027-03'), 1));
check('April 2027 rise applies', near(T.awardFactor('2027-04'), 1.05, 1e-9));
check('rises compound', near(T.awardFactor('2028-05'), 1.155, 1e-9));
const apr = T.payslip(0, 1000, 0, 0, '2027-04'), may = T.payslip(0, 1000, 0, 0, '2027-05');
check('April pay: new salary, March call-outs at the old rate', near(apr.gross, 3150 + 1000), `got ${apr.gross}`);
check('May pay: April call-outs at the new rate', near(may.gross, 3150 + 1050), `got ${may.gross}`);
T.set({ pension: 7.5, taxCode: 1250, salary: 3150, arrears: true, ratesFrom: '2027-05', awards: [{ from: '2027-04', pct: 5 }] });
check('a rise already in the rates is not counted again', near(T.awardFactor('2027-06'), 1));

// --- payday: the 25th, or the working day before a weekend or public holiday ---
check('payday Sunday 25 Oct 2026 -> Fri 23', T.payday('2026-10') === '2026-10-23', T.payday('2026-10'));
check('payday Christmas Day 2026 -> Thu 24 Dec', T.payday('2026-12') === '2026-12-24', T.payday('2026-12'));
check('payday Sunday 25 Apr 2027 -> Fri 23', T.payday('2027-04') === '2027-04-23', T.payday('2027-04'));
check('payday weekday 25 Nov 2026 stays', T.payday('2026-11') === '2026-11-25', T.payday('2026-11'));

// --- bank holiday rules match the official lists (TT race day is the only one not worked out) ---
for (const y of [2026, 2027]) {
  const official = [...T.BANK_HOLS].filter(d => d.startsWith(String(y))), rule = [...T.ruleBankHols(y)];
  const missing = official.filter(d => !rule.includes(d)), extra = rule.filter(d => !official.includes(d));
  check(`${y} bank holiday rules match the official list apart from TT day`, missing.length === 1 && extra.length === 0, `missing ${missing}, extra ${extra}`);
}
check('2028 Good Friday', T.isBH('2028-04-14'));
check('2028 New Year moved to Monday 3 Jan', T.isBH('2028-01-03') && !T.isBH('2028-01-01'));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
