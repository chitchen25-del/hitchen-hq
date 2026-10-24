// Hitchen HQ widget feed: a small JSON summary for an iPhone home-screen widget (Scriptable).
// Called with ?k=<widget token>; the token lives in app_secrets, never in the public code.
import { readIcs } from './ics.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hhq-cron', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });

// ---- dates in island time ----
function localParts(d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}
const pad = (n: number) => String(n).padStart(2, '0');
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (s: string, n: number) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const addMonths = (s: string, n: number) => { const d = parse(s); const day = d.getUTCDate(); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(day, dim)); return ymd(t); };
const dow = (s: string) => parse(s).getUTCDay();
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (t?: string) => t ? String(t).replace(/^0(\d)/, '$1') : '';
const money = (n: number) => '£' + (Math.round(n * 100) / 100).toLocaleString('en-GB', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
function payday(ym: string) { let d = `${ym}-25`; const w = dow(d); if (w === 6) d = addDays(d, -1); if (w === 0) d = addDays(d, -2); return d; }
function nextDue(b: any, from: string) {
  if (!b.due) return null; let d = b.due, g = 0;
  const step = (s: string) => b.freq === 'weekly' ? addDays(s, 7) : b.freq === 'quarterly' ? addMonths(s, 3) : b.freq === 'annual' ? addMonths(s, 12) : addMonths(s, 1);
  while (d < from && g++ < 600) d = step(d); return d;
}

// ---- rota entries: "V: 8-6", "V: on call", "C: 8-5" ----
function parseRota(title: string) {
  const m = /^\s*(VH|V|C)\s*[:\-]\s*/i.exec(String(title || '')); if (!m) return null;
  const who = m[1].toUpperCase() === 'C' ? 'chris' : 'viki', t = title.slice(m[0].length).trim();
  if (/on\s*-?\s*call/i.test(t)) return { who, kind: 'oncall' };
  if (/\bAL\b|annual leave|holiday/i.test(t)) return { who, kind: 'holiday' };
  if (/sick/i.test(t)) return { who, kind: 'sick' };
  if (/\bR?DO\b|day off|pay\s*back|toil/i.test(t)) return { who, kind: 'off' };
  const x = /(\d{1,2})(?:[:.](\d{2}))?\s*-\s*(\d{1,2})(?:[:.](\d{2}))?/.exec(t);
  if (x) { const sh = +x[1], sm = +(x[2] || 0); let eh = +x[3]; const em = +(x[4] || 0); if (eh * 60 + em <= sh * 60 + sm && eh < 12) eh += 12; return { who, kind: 'shift', start: `${pad(sh)}:${pad(sm)}`, end: `${pad(eh % 24)}:${pad(em)}` }; }
  return null;
}

async function loadData(today: string) {
  const rows: { path: string; data: any }[] = await (await rest('docs?select=path,data')).json();
  const D: any = { days: {}, bills: [], carrem: [], settings: {}, cal: { feeds: [] }, checks: { done: {} } };
  for (const r of rows) {
    const [c, id] = r.path.split('/');
    if (c === 'days') D.days[id] = r.data; else if (c === 'bills') D.bills.push({ ...r.data, id }); else if (c === 'carrem') D.carrem.push({ ...r.data, id });
    else if (c === 'settings') D.settings = r.data; else if (r.path === 'private/calendar') D.cal = r.data; else if (r.path === 'state/checks') D.checks = r.data;
  }
  // calendar events for the next 9 days
  D.events = [];
  const from = Date.parse(today + 'T00:00:00Z') - 86400000, to = from + 16 * 86400000;
  for (const f of (D.cal.feeds || [])) {
    try { const res = await fetch(String(f.url).replace(/^webcal:\/\//i, 'https://'), { signal: AbortSignal.timeout(12000) }); if (res.ok) D.events.push(...readIcs(await res.text(), from, to)); } catch (_) { /* skip a feed that fails */ }
  }
  const evDate = (e: any) => e.allDay ? e.start : localParts(new Date(e.start)).date;
  D.byDate = {}; D.events.forEach((e: any) => { if (e.allDay) { for (let d = e.start; d < e.end; d = addDays(d, 1)) (D.byDate[d] = D.byDate[d] || []).push(e); } else (D.byDate[evDate(e)] = D.byDate[evDate(e)] || []).push(e); });
  D.rota = (who: string, date: string) => {
    if (D.days[`${who}_${date}`]) return D.days[`${who}_${date}`];
    const out: any = {}; let oc = false;
    for (const e of (D.byDate[date] || [])) { const r = parseRota(e.title); if (!r || r.who !== who) continue; if (r.kind === 'oncall') oc = true; else if (r.kind === 'shift') Object.assign(out, { status: 'shift', start: r.start, end: r.end }); else if (!out.status) out.status = r.kind; }
    if (oc && who === 'viki') { const wk = dow(date) === 0 || dow(date) === 6; out.oncall = wk ? { start: '08:00', end: '08:00' } : { start: out.end || (dow(date) === 5 ? '18:00' : '18:30'), end: '08:00' }; if (!out.status) out.status = wk ? 'off' : 'shift'; }
    return out.status || out.oncall ? out : null;
  };
  return D;
}


const BANK_HOLS = new Set(['2026-01-01','2026-04-03','2026-04-06','2026-05-04','2026-05-25','2026-06-05','2026-07-05','2026-07-06','2026-08-31','2026-12-25','2026-12-26','2026-12-28',   '2027-01-01','2027-03-26','2027-03-29','2027-05-03','2027-05-31','2027-06-11','2027-07-05','2027-08-30','2027-12-25','2027-12-26','2027-12-27','2027-12-28']);
const toMin = (t?: string) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
const span = (a?: string, b?: string) => { const x = toMin(a), y = toMin(b); if (x === null || y === null) return 0; let d = y - x; if (d <= 0) d += 1440; return d / 60; };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const short = (s: string) => { const d = parse(s); return `${DOWS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

function summary(D: any, today: string) {
  const v = { ...(D.settings.viki || {}) }, base = Number(v.base) || 0, cutoff = Number(v.cutoff) || 0, coMin = Number(v.coMin ?? 2);
  const claimYM = (date: string) => (cutoff && cutoff < 28 && parse(date).getUTCDate() >= cutoff) ? addMonths(date.slice(0, 7) + '-01', 1).slice(0, 7) : date.slice(0, 7);
  const claimRange = (ym: string) => cutoff && cutoff < 28 ? { from: `${addMonths(ym + '-01', -1).slice(0, 7)}-${pad(cutoff)}`, to: `${ym}-${pad(cutoff - 1)}` } : { from: `${ym}-01`, to: `${ym}-31` };
  const cos: any[] = [], oncalls: string[] = [];
  for (const [id, d] of Object.entries<any>(D.days)) {
    if (!id.startsWith('viki_')) continue;
    if (d.oncall) oncalls.push(d.date);
    for (const c of (d.callouts || [])) {
      if (!c.from || !c.to) continue;
      const os = toMin(d.oncall ? d.oncall.start : (d.end || '00:00')), s = toMin(c.from);
      const when = s !== null && os !== null && s < os ? addDays(d.date, 1) : d.date;
      const mult = c.mult ? Number(c.mult) : (dow(when) === 0 || BANK_HOLS.has(when) || (when === d.date && d.bh)) ? 2 : 1.5;
      const worked = span(c.from, c.to), paid = worked > 0 ? Math.max(worked, coMin) : 0;
      cos.push({ day: d.date, when, from: c.from, to: c.to, worked, paid, mult, pay: paid * base * mult, note: c.note || '' });
    }
  }
  const cym = claimYM(today), cr = claimRange(cym);
  const inClaim = cos.filter(x => x.day >= cr.from && x.day <= cr.to), yr = cos.filter(x => x.day > addMonths(today, -12) && x.day <= today);
  const tot = (a: any[]) => ({ count: a.length, hours: Math.round(a.reduce((s, x) => s + x.paid, 0) * 10) / 10, pay: Math.round(a.reduce((s, x) => s + x.pay, 0)) });
  const last = cos.filter(x => x.when <= today).sort((a, b) => (a.when + a.from) < (b.when + b.from) ? 1 : -1)[0];
  // today and the next on call (logged days first, then the calendar rota)
  const label = (r: any) => !r ? 'Off' : r.status === 'holiday' ? 'On leave' : r.oncall ? (r.oncall.start === '08:00' && r.oncall.end === '08:00' ? 'On call all day' : `On call from ${hm(r.oncall.start)}`) : r.status === 'shift' && r.start ? `Working ${hm(r.start)}–${hm(r.end)}` : 'Off';
  const vt = D.rota('viki', today);
  let next: any = null; for (let i = vt?.oncall ? 1 : 0; i <= 14 && !next; i++) { const d = addDays(today, i), r = D.rota('viki', d); if (r?.oncall) next = { date: d, label: short(d), days: i, text: label(r) }; }
  let pd = payday(today.slice(0, 7)); if (today > pd) pd = payday(addMonths(today.slice(0, 7) + '-01', 1).slice(0, 7));
  const cl = (s: string) => { const d = parse(s); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  return {
    updated: new Date().toISOString(), today,
    viki: { today: label(vt), onCallToday: !!vt?.oncall, next },
    claim: { label: `${cl(cr.from)} – ${cl(cr.to)}`, oncalls: oncalls.filter(d => d >= cr.from && d <= cr.to).length, ...tot(inClaim) },
    year: { oncalls: oncalls.filter(d => d > addMonths(today, -12) && d <= today).length, ...tot(yr) },
    last: last ? { date: short(last.when), from: hm(last.from), to: hm(last.to), hours: last.worked, note: last.note } : null,
    payday: { date: short(pd), days: Math.round((parse(pd).getTime() - parse(today).getTime()) / 86400000) },
  };
}

async function secrets() { const r = await (await rest('app_secrets?select=name,value')).json(); const s: Record<string, string> = {}; r.forEach((x: any) => { s[x.name] = x.value; }); return s; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const k = new URL(req.url).searchParams.get('k') || '';
  const sec = await secrets();
  if (!sec.widget_token || k !== sec.widget_token) return json({ error: 'Not allowed' }, 403);
  const lp = localParts();
  const D = await loadData(lp.date);
  return json(summary(D, lp.date));
});
