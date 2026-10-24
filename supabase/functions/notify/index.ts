// Hitchen HQ notifications. Run hourly by pg_cron; sends at 07:00 (today), 19:00 (tomorrow) and Sunday 19:00 (week ahead),
// Isle of Man time. A signed-in family member can also call it to send themselves a test.
import webpush from 'npm:web-push@3.6.7';
import { readIcs } from './ics.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hhq-cron', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
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
  const D: any = { days: {}, bills: [], carrem: [], settings: {}, cal: { feeds: [] }, checks: { done: {} }, plans: [] };
  for (const r of rows) {
    const [c, id] = r.path.split('/');
    if (c === 'days') D.days[id] = r.data; else if (c === 'plans') D.plans.push({ ...r.data, id }); else if (c === 'bills') D.bills.push({ ...r.data, id }); else if (c === 'carrem') D.carrem.push({ ...r.data, id });
    else if (c === 'settings') D.settings = r.data; else if (r.path === 'private/calendar') D.cal = r.data; else if (r.path === 'state/checks') D.checks = r.data;
  }
  // calendar events for the next 9 days
  D.events = [];
  const from = Date.parse(today + 'T00:00:00Z') - 86400000, to = from + 10 * 86400000;
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

// ---- money jobs from Trips: what to pay this pay month, and Zilch payments coming out ----
const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
function moneyJobs(D: any, ym: string) {
  const jobs: string[] = [];
  for (const p of D.plans) { const done = p.done || {};
    if (p.kind === 'christmas') { const due = (p.items || []).filter((it: any) => it.ym === ym);
      const tot = due.reduce((t: number, it: any) => t + Math.max(Number(it.a) || 0, (it.gifts || []).reduce((g: number, x: any) => g + (Number(x.a) || 0), 0)), 0);
      if (tot) jobs.push(`the Christmas shopping (${money(tot)} budget)`); continue; }
    for (const s of (p.steps || [])) if (s.kind === 'do' && s.ym === ym && !done[s.key]) jobs.push(lc(s.title));
    for (const it of (p.items || [])) { const a = Number(it.a) || 0; if (it.paid || it.ym !== ym || !a) continue;
      if (it.how === 'zilch') jobs.push(`book ${it.n} on Zilch`);
      else if (it.how === 'save') jobs.push(`pay for ${it.n} from the pot`);
      else jobs.push(`${it.via === 'revolut' ? 'top up Revolut for' : (/present/i.test(it.n) ? 'buy' : 'pay for')} ${/present/i.test(it.n) ? lc(it.n) : it.n} (${money(a)})`); }
  }
  return jobs;
}
function zilchTomorrow(D: any, tm: string) {
  let total = 0; const what: string[] = [];
  for (const p of D.plans) {
    for (const s of (p.steps || [])) if (s.date === tm && (s.kind === 'auto' || s.kind === 'also') && s.amount) { total += Number(s.amount); what.push(/car/i.test(s.title + s.sub) ? 'the car' : s.title); }
    for (const it of (p.items || [])) { if (it.how !== 'zilch' || !it.zdate) continue; const a = Number(it.a) || 0, q = Math.round(a * 25) / 100, fee = a >= 75 ? Math.round(a * 1.8) / 100 : 0;
      for (let i = 1; i <= 3; i++) if (addMonths(it.zdate, i) === tm) { total += (i === 3 ? a - q * 3 : q) + fee; what.push(it.n); } }
  }
  return { total: Math.round(total * 100) / 100, what };
}
function messages(D: any, today: string, mode: string) {
  const out: { title: string; body: string; tag: string }[] = [];
  if (mode === 'moneyam' && payday(today.slice(0, 7)) === today) {
    const jobs = moneyJobs(D, today.slice(0, 7));
    if (jobs.length) out.push({ title: 'Payday money jobs', body: `${jobs.length} thing${jobs.length === 1 ? '' : 's'} to do from this pay: ${jobs.slice(0, 3).join(', ')}${jobs.length > 3 ? ` and ${jobs.length - 3} more` : ''}. Tick them off in Trips.`, tag: `money-${today}` });
  }
  if (mode === 'moneypm') {
    const tm = addDays(today, 1), z = zilchTomorrow(D, tm);
    if (z.total > 0) out.push({ title: `Zilch takes ${money(z.total)} tomorrow`, body: `For ${[...new Set(z.what)].join(', ')}. Make sure it's in the account tonight.`, tag: `zilch-${tm}` });
  }
  const bills = (from: string, to: string) => D.bills.map((b: any) => ({ ...b, nd: nextDue(b, from) })).filter((b: any) => b.nd && b.nd >= from && b.nd <= to);
  const list = (bs: any[]) => bs.sort((a, b) => b.amount - a.amount).slice(0, 3).map(b => b.name).join(', ') + (bs.length > 3 ? ` and ${bs.length - 3} more` : '');
  const sum = (bs: any[]) => bs.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const oncallText = (r: any) => !r?.oncall ? '' : r.oncall.start === '08:00' && r.oncall.end === '08:00' ? 'on call all day' : `on call from ${hm(r.oncall.start)}`;
  if (mode === 'morning') {
    const parts: string[] = []; const v = D.rota('viki', today), c = D.rota('chris', today);
    if (v?.oncall) parts.push(`Viki is ${oncallText(v)}.`);
    const bt = bills(today, today); if (bt.length) parts.push(`${money(sum(bt))} going out today: ${list(bt)}.`);
    if (payday(today.slice(0, 7)) === today) parts.push('It\'s payday.');
    if (parts.length) { if (c?.status === 'shift' && c.start) parts.push(`Chris ${hm(c.start)}–${hm(c.end)}.`); out.push({ title: 'Today', body: parts.join(' '), tag: `morning-${today}` }); }
  }
  if (mode === 'evening') {
    const tm = addDays(today, 1), parts: string[] = [];
    if ((D.byDate[tm] || []).some((e: any) => /\bbins?\b|recycling/i.test(e.title))) parts.push('Bins out tonight.');
    const v = D.rota('viki', tm); if (v?.oncall) parts.push(`Viki is ${oncallText(v)} tomorrow.`);
    const bt = bills(tm, tm); if (bt.length) parts.push(`${money(sum(bt))} goes out tomorrow: ${list(bt)}.`);
    if (parts.length) out.push({ title: 'Tomorrow', body: parts.join(' '), tag: `evening-${today}` });
    // renewals at 30, 7 and 1 days
    for (const b of D.bills) { const r = b.renew || (b.freq === 'annual' ? nextDue(b, today) : null); if (!r) continue; const n = Math.round((parse(r).getTime() - parse(today).getTime()) / 86400000);
      if ([30, 7, 1].includes(n)) out.push({ title: `${b.name} renews ${n === 1 ? 'tomorrow' : `in ${n} days`}`, body: 'Check the renewal price and shop around before it renews automatically.', tag: `renew-${b.id}-${n}` }); }
    for (const c of D.carrem) { if (!c.date) continue; const n = Math.round((parse(c.date).getTime() - parse(today).getTime()) / 86400000);
      if ([30, 7, 1].includes(n)) out.push({ title: `Car: ${c.name} ${n === 1 ? 'tomorrow' : `in ${n} days`}`, body: c.note || 'Due soon. Open the Car page for details.', tag: `car-${c.id}-${n}` }); }
  }
  if (mode === 'weekly') {
    const mon = addDays(today, 1), sun = addDays(today, 7), parts: string[] = [];
    const oc: string[] = []; for (let d = mon; d <= sun; d = addDays(d, 1)) { if (D.rota('viki', d)?.oncall) oc.push(DOWS[dow(d)]); }
    parts.push(oc.length ? `Viki on call ${oc.join(', ')}.` : 'Viki has no on call this week.');
    const bw = bills(mon, sun); if (bw.length) parts.push(`${money(sum(bw))} of bills, biggest ${bw.sort((a: any, b: any) => b.amount - a.amount)[0].name}.`);
    const bd: string[] = []; for (let d = mon; d <= sun; d = addDays(d, 1)) (D.byDate[d] || []).forEach((e: any) => { if (/birthday|bday/i.test(e.title)) bd.push(`${e.title.replace(/\(.*?\)/g, '').replace(/\b(19|20)\d\d\b/g, '').replace(/['\u2019]s\b/g, '').replace(/birthday|bday|🎈|🎉/ig, '').replace(/\s+/g, ' ').trim()} (${DOWS[dow(d)]})`); });
    if (bd.length) parts.push(`Birthdays: ${bd.join(', ')}.`);
    out.push({ title: 'The week ahead', body: parts.join(' '), tag: `week-${today}` });
  }
  return out;
}

async function secrets() { const r = await (await rest('app_secrets?select=name,value')).json(); const s: Record<string, string> = {}; r.forEach((x: any) => { s[x.name] = x.value; }); return s; }
async function send(subs: any[], msgs: any[], sec: Record<string, string>) {
  webpush.setVapidDetails('mailto:hitchen-hq@users.noreply.github.com', sec.vapid_public, sec.vapid_private);
  const results: any[] = [];
  for (const s of subs) for (const m of msgs) {
    try { const r = await webpush.sendNotification(s.sub, JSON.stringify({ ...m, url: './' }), { TTL: 6 * 3600 }); results.push({ who: s.who, tag: m.tag, status: r.statusCode }); }
    catch (e: any) { results.push({ who: s.who, tag: m.tag, status: e.statusCode || 'error', error: String(e.body || e.message || e).slice(0, 120) });
      if (e.statusCode === 404 || e.statusCode === 410) await rest(`push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' }); }
  }
  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sec = await secrets();
  const body = await req.json().catch(() => ({}));
  const lp = localParts();
  // scheduled run
  if (req.headers.get('x-hhq-cron') && req.headers.get('x-hhq-cron') === sec.notify_secret) {
    const modes: string[] = body.mode ? [body.mode] : lp.hour === 7 ? ['morning', 'moneyam'] : lp.hour === 19 ? (lp.weekday === 'Sun' ? ['evening', 'moneypm', 'weekly'] : ['evening', 'moneypm']) : [];
    if (!modes.length) return json({ skipped: true, hour: lp.hour });
    const D = await loadData(lp.date);
    const subs = await (await rest('push_subs?select=endpoint,sub,who,prefs')).json();
    const out: any = { date: lp.date, modes, sent: [] };
    for (const mode of modes) {
      const msgs = messages(D, lp.date, mode); out[mode] = msgs;
      if (body.dry) continue;
      const pref = mode === 'weekly' ? 'weekly' : mode.startsWith('money') ? 'money' : mode;
      out.sent.push(...await send(subs.filter((s: any) => s.prefs?.[pref] !== false), msgs, sec));
    }
    return json(out);
  }
  // a family member sending themselves a test
  const auth = req.headers.get('Authorization') || '';
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!u.ok) return json({ error: 'Not signed in' }, 401);
  const email = (await u.json()).email;
  const fam = await (await rest(`allowed_users?select=email&email=eq.${encodeURIComponent(email)}`)).json();
  if (!fam.length) return json({ error: 'Not allowed' }, 403);
  const subs = await (await rest(`push_subs?select=endpoint,sub,who,prefs&owner=eq.${encodeURIComponent(email)}`)).json();
  if (body.endpoint) { const mine = subs.filter((s: any) => s.endpoint === body.endpoint); if (mine.length) subs.splice(0, subs.length, ...mine); }
  const results = await send(subs, [{ title: 'Hitchen HQ', body: 'Notifications are working on this phone.', tag: 'test' }], sec);
  return json({ results });
});
