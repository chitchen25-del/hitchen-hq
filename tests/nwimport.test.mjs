// Checks the Nationwide transactions import straight from index.html.
// Run: node tests/nwimport.test.mjs  (no installs needed). Uses made-up payees and figures only:
// family figures never go in this public repository.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.sort((a, b) => b.length - a.length)[0];
const grab = (from, to) => { const i = src.indexOf(from); if (i < 0) throw new Error(`index.html no longer has "${from}"`); const j = src.indexOf(to, i); if (j < 0) throw new Error(`index.html no longer has "${to}" after "${from}"`); return src.slice(i, j); };
const line = name => { const m = src.match(new RegExp(`^const ${name} = .*$`, 'm')); if (!m) throw new Error(`index.html no longer has const ${name}`); return m[0]; };

const code = [
  ...['pad', 'ymd', 'parse', 'ymOf', 'MONTHS'].map(line),
  'const today = () => "2026-01-20"; const me = () => "chris"; const mcSync = () => {}; const setTimeout = () => {};',
  'const S = { stmt: {}, stmtMeta: null }; const saved = {};',
  'async function put(path, data) { saved[path] = data; const [c, id] = path.split("/"); if (id === "meta") S.stmtMeta = data; else S.stmt[id] = data; }',
  grab('function parseCSV', 'const SPEND_RULES'),
  grab('const stmtCache', 'const fullMonths'),
  grab('const NW_RULES', 'let nwPlanNow'),
  'globalThis.T = { S, saved, nwParse, nwPlan, nwSave, nwSplit, nwTidy };',
].join('\n');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const T = ctx.T;

let failed = 0, passed = 0;
function check(name, ok, detail = '') { if (ok) passed++; else { failed++; console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`); } }

// What the app already holds: January up to the 10th, loaded earlier from statements (names cut short, as statements do).
T.S.stmtMeta = { from: '2026-01-01', to: '2026-01-10', months: ['2026-01'], count: 4, account: 'Test account',
  cats: ['Between our accounts', 'Groceries', 'Pay', 'Zilch repayments', 'Zilch fees', 'Eating out and takeaways', 'Other'],
  tos: ['', 'Revolut', 'Other Nationwide account'] };
T.S.stmt['2026-01'] = { b: [[9, 500], [10, 480.5]],
  m: ['Acme Widgets Lim', 'Tesco Stores', 'Pat Example', 'Zilch Technology L', 'Snooze Fee', ''],
  r: [[9, 0, 0, 1000, 2], [9, 1, 19.5, 0, 1, 1], [10, 2, 20, 0, 0, 0, 1], [10, 3, 50, 0, 3, 0, 0]] };

// A made-up download in Nationwide's layout, newest first, saved in Windows-1252 (the £ sign is byte A3).
const csv = [
  '"Account Name:","Test account ****0000"',
  '"Account Balance:","£370.25"',
  '"Available Balance: ","£370.25"',
  '',
  '"Date","Transaction type","Description","Paid out","Paid in","Balance"',
  '"12 Jan 2026","Contactless payment","ZILCH Snooze Fee","£0.75","","£370.25"',
  '"12 Jan 2026","Contactless payment","ZILCH TESCO STORES","£25.00","","£371.00"',
  '"11 Jan 2026","Transfer between your accounts","Transfer to 07-00-00 12345678","£10.00","","£396.00"',
  '"11 Jan 2026","Money out","Pat Example Sent from Revolut","£20.00","","£406.00"',
  '"11 Jan 2026","Contactless payment","CORNER CAFE DOUGLAS","£6.50","","£426.00"',
  '"11 Jan 2026","Money in","ACME WIDGETS LIMITED Wages","","£1,000.00","£432.50"',
  '"11 Jan 2026","Contactless payment","ZILCH INSTALMENT","£48.00","","£-567.50"',
  '"10 Jan 2026","Money out","Pat Example","£20.00","","£480.50"',
  '"10 Jan 2026","Money out","Zilch Technology Ltd via Plaid","£50.00","","£500.50"',
].join('\r\n');
const bytes = Buffer.from(csv, 'latin1');
let text = new TextDecoder('utf-8').decode(bytes); if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes);

const parsed = T.nwParse(text);
check('reads all rows', parsed.rows.length === 9, `${parsed.rows.length}`);
check('oldest first', parsed.rows[0].date === '2026-01-10' && parsed.rows[8].date === '2026-01-12');
check('account line', /0000/.test(parsed.acct), parsed.acct);
check('commas and £ in amounts', parsed.rows.find(r => r.in === 1000) != null);
check('negative balance', parsed.rows.find(r => r.bal === -567.5) != null);

const P = T.nwPlan(parsed);
const fresh = P.fresh, by = d => fresh.find(x => x.desc.includes(d));
check('skips what the app already has', fresh.length === 7, `${fresh.length} new`);
check('learned salary category', by('ACME').cat === 'Pay', by('ACME').cat);
check('learned transfer to Revolut', by('Sent from Revolut').cat === 'Between our accounts' && by('Sent from Revolut').to === 'Revolut', JSON.stringify(by('Sent from Revolut')));
check('Zilch card payment flagged', by('TESCO').z === 1 && by('TESCO').cat === 'Groceries' && by('TESCO').m === 'Tesco Stores', JSON.stringify(by('TESCO')));
check('snooze fee is a Zilch fee', by('Snooze').cat === 'Zilch fees' && by('Snooze').z === 1);
check('instalment is a repayment, not a card payment', by('INSTALMENT').cat === 'Zilch repayments' && by('INSTALMENT').z === 0, JSON.stringify(by('INSTALMENT')));
check('own-account transfer', by('Transfer to').cat === 'Between our accounts' && by('Transfer to').to === 'Other Nationwide account' && by('Transfer to').m === '');
check('new payee falls back to the rules', by('CORNER CAFE').cat === 'Eating out and takeaways' && by('CORNER CAFE').guess === true);
check('names tidied', by('CORNER CAFE').m === 'Corner Cafe Douglas', by('CORNER CAFE').m);

const added = await T.nwSave(P);
check('adds the new ones', added === 7, `${added}`);
const doc = T.S.stmt['2026-01'];
check('rows kept and added', doc.r.length === 11, `${doc.r.length}`);
check('rows in day order', doc.r.every((r, i) => !i || doc.r[i - 1][0] <= r[0]));
check('closing balance per day', JSON.stringify(doc.b) === JSON.stringify([[9, 500], [10, 480.5], [11, 396], [12, 370.25]]), JSON.stringify(doc.b));
check('meta moved on', T.S.stmtMeta.to === '2026-01-12' && T.S.stmtMeta.count === 11 && T.S.stmtMeta.cats.length === 7, JSON.stringify(T.S.stmtMeta));
check('old category indexes untouched', T.S.stmtMeta.cats[2] === 'Pay');

const again = T.nwPlan(T.nwParse(text));
check('importing the same file twice adds nothing', again.fresh.length === 0, `${again.fresh.length}`);

check('ZILCH prefix split', JSON.stringify(T.nwSplit('ZILCH McDonalds 123')) === JSON.stringify({ name: 'McDonalds 123', z: 1 }));
check('Zilch Technology not split', T.nwSplit('Zilch Technology Ltd').z === 0);

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
