// Hitchen HQ widget feed: who's working and the week's activities, for an iPhone home-screen widget (Scriptable). No money.
// Called with ?k=<widget token>; the token lives in app_secrets, never in the public code.
import { readIcs } from './ics.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
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
const dow = (s: string) => parse(s).getUTCDay();
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (t?: string) => t ? String(t).replace(/^0(\d)/, '$1') : '';
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
  const rows: { path: string; data: any }[] = await (await rest('docs?select=path,data&or=(path.like.days/*,path.eq.settings/main,path.eq.private/calendar,path.eq.leave/main)')).json();
  const D: any = { days: {}, settings: {}, cal: { feeds: [] }, leave: null };
  for (const r of rows) {
    const [c, id] = r.path.split('/');
    if (c === 'days') D.days[id] = r.data;
    else if (c === 'settings') D.settings = r.data; else if (r.path === 'private/calendar') D.cal = r.data; else if (r.path === 'leave/main') D.leave = r.data;
  }
  // calendar events for the next fortnight
  D.events = [];
  const from = Date.parse(today + 'T00:00:00Z') - 86400000, to = from + 16 * 86400000;
  for (const [fi, f] of (D.cal.feeds || []).entries()) {
    try { const res = await fetch(String(f.url).replace(/^webcal:\/\//i, 'https://'), { signal: AbortSignal.timeout(12000) }); if (res.ok) D.events.push(...readIcs(await res.text(), from, to).map((e: any) => ({ ...e, feed: fi }))); } catch (_) { /* skip a feed that fails */ }
  }
  const evDate = (e: any) => e.allDay ? e.start : localParts(new Date(e.start)).date;
  D.byDate = {}; D.events.forEach((e: any) => { if (e.allDay) { for (let d = e.start; d < e.end; d = addDays(d, 1)) (D.byDate[d] = D.byDate[d] || []).push(e); } else (D.byDate[evDate(e)] = D.byDate[evDate(e)] || []).push(e); });
  D.rota = (who: string, date: string) => {
    if (D.days[`${who}_${date}`]) return D.days[`${who}_${date}`];
    const out: any = {}; let oc = false;
    for (const e of (D.byDate[date] || [])) { const r = parseRota(e.title); if (!r || r.who !== who) continue; if (r.kind === 'oncall') oc = true; else if (r.kind === 'shift') Object.assign(out, { status: 'shift', start: r.start, end: r.end }); else if (!out.status) out.status = r.kind; }
    if (oc && who === 'viki') { const wk = dow(date) === 0 || dow(date) === 6; out.oncall = wk ? { start: '08:00', end: '08:00' } : { start: out.end || (dow(date) === 5 ? '18:00' : '18:30'), end: '08:00' }; if (!out.status) out.status = wk ? 'off' : 'shift'; }
    if (!out.status && who === 'viki' && D.leave && dow(date) % 6 !== 0) { for (const y of Object.values<any>(D.leave.years || {})) if (y.days && y.days[date] === 'al') out.status = 'holiday'; }
    return out.status || out.oncall ? out : null;
  };
  return D;
}


const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOWL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const short = (s: string) => { const d = parse(s); return `${DOWS[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const GCOL: Record<string, string> = { tomato:'#D50000', flamingo:'#E67C73', tangerine:'#F4511E', banana:'#F6BF26', sage:'#33B679', basil:'#0B8043', peacock:'#039BE5', blueberry:'#3F51B5', lavender:'#7986CB', grape:'#8E24AA', graphite:'#616161' };
const DEFAULT_RULES = [{ m:'V:', c:'flamingo' }, { m:'VH-', c:'flamingo' }, { m:'C:', c:'peacock' }, { m:'birthday', c:'banana' }, { m:'bday', c:'banana' }, { m:'anniversary', c:'banana' }, { m:'pay day', c:'tangerine' }, { m:'payday', c:'tangerine' }, { m:'bin', c:'graphite' }, { m:'recycling', c:'graphite' }];
function evColor(D: any, title: string, feedIdx: number) {
  const t = String(title || '').trim().toLowerCase(), rules = Array.isArray(D.cal.rules) ? D.cal.rules : DEFAULT_RULES;
  for (const r of rules) { const m = String(r.m || '').trim().toLowerCase(); if (!m) continue; if (/[:\-]$/.test(m) ? t.startsWith(m) : t.includes(m)) return GCOL[r.c] || GCOL.blueberry; }
  const f = (D.cal.feeds || [])[feedIdx] || {}; return GCOL[f.color] || GCOL.blueberry;
}
function niceTitle(title: string) {
  const m = /^\s*(VH|V|C)\s*[:\-]\s*/i.exec(String(title || '')); if (!m) return title;
  const rest = title.slice(m[0].length).trim().replace(/^(\d{1,2}(?:[:.]\d{2})?)\s*-\s*/, '$1–');
  return /^on\s*call$/i.test(rest) ? 'On call' : /^AL\b/i.test(rest) ? 'Annual leave' : rest.charAt(0).toUpperCase() + rest.slice(1);
}
function evIcon(title: string) {
  const r = parseRota(title), t = String(title || '').toLowerCase();
  if (r) return r.kind === 'oncall' ? 'moon' : r.kind === 'holiday' ? 'sun' : r.kind === 'sick' ? 'therm' : r.who === 'viki' ? 'cross' : 'wrench';
  if (/birthday|bday/.test(t)) return 'cake';
  if (/anniversar|valentine/.test(t)) return 'heart';
  if (/\bbins?\b|recycling/.test(t)) return 'bin';
  if (/pay ?day/.test(t)) return 'pay';
  if (/swim|gymnast|badminton|football|dance|training|lesson|rugby|netball|karate/.test(t)) return 'ball';
  if (/school|term|holiday|parents eve|residential|world book/.test(t)) return 'flag';
  if (/stay at|hotel|flight|ferry|holyhead/.test(t)) return 'bed';
  if (/\bcar\b|garage|service|evoque|tyre/.test(t)) return 'car';
  return 'dot';
}
function summary(D: any, today: string) {
  const lt = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const evDate = (e: any) => e.allDay ? e.start : localParts(new Date(e.start)).date;
  // the next 7 days of activities, coloured like the calendar
  const days: any[] = [];
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); days.push({ date: d, label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : short(d), dow: DOWS[dow(d)], num: parse(d).getUTCDate(), items: [] as any[] }); }
  const byDate: Record<string, any> = {}; days.forEach(x => byDate[x.date] = x);
  const calOncall = new Set<string>();
  (D.events || []).forEach((e: any) => {
    const r = parseRota(e.title); if (r && r.kind === 'oncall') calOncall.add(`${r.who}_${evDate(e)}`);
    const item = (time: string) => ({ time, title: niceTitle(e.title), color: evColor(D, e.title, e.feed || 0), who: r ? r.who : '', icon: evIcon(e.title) });
    if (e.allDay) { for (let d = e.start; d < (e.end || addDays(e.start, 1)); d = addDays(d, 1)) if (byDate[d]) byDate[d].items.push(item('')); }
    else { const d = evDate(e); if (byDate[d]) byDate[d].items.push(item(lt(e.start))); }
  });
  for (const x of days) { const r = D.days[`viki_${x.date}`]; if (r?.oncall && !calOncall.has(`viki_${x.date}`)) x.items.push({ time: hm(r.oncall.start), title: r.oncall.kind === 'second' ? '2nd on call' : 'On call', color: evColor(D, 'V: on call', 0), who: 'viki', icon: 'moon' }); }
  days.forEach(x => x.items.sort((a: any, b: any) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  // where Viki and Chris are today, and what's next
  const vt = D.rota('viki', today), ct = D.rota('chris', today);
  const vText = !vt ? 'Off' : vt.status === 'holiday' ? 'On leave' : vt.status === 'sick' ? 'Off sick' : vt.oncall ? (vt.oncall.start === '08:00' && vt.oncall.end === '08:00' ? 'On call' : vt.status === 'shift' ? `Working, then on call` : 'On call') : vt.status === 'shift' && vt.start ? `${hm(vt.start)}–${hm(vt.end)}` : 'Off';
  let vNext = ''; for (let i = 1; i <= 21; i++) { const d = addDays(today, i), r = D.rota('viki', d); if (r?.oncall) { vNext = `on call ${i === 1 ? 'tomorrow' : short(d)}`; break; } }
  const cText = !ct ? 'Off' : ct.status === 'holiday' ? 'On holiday' : ct.status === 'sick' ? 'Off sick' : (ct.status === 'shift' || ct.status === 'work') && ct.start ? `${hm(ct.start)}–${hm(ct.end)}` : ct.status === 'callout' ? 'On call-out' : 'Off';
  let cNext = ''; for (let i = 1; i <= 21; i++) { const d = addDays(today, i), r = D.rota('chris', d); if (r && (r.status === 'shift' || r.status === 'work') && r.start) { cNext = `next ${i === 1 ? 'tomorrow' : i < 7 ? DOWL[dow(d)] : short(d)} ${hm(r.start)}`; break; } }
  return {
    updated: new Date().toISOString(), today, title: `${DOWL[dow(today)]} ${parse(today).getUTCDate()} ${MON[parse(today).getUTCMonth()]}`,
    viki: { text: vText, sub: vt?.oncall && vt.status === 'shift' ? `on call from ${hm(vt.oncall.start)}` : vNext },
    chris: { text: cText, sub: cNext },
    days,
  };
}

async function secrets() { const r = await (await rest('app_secrets?select=name,value&name=eq.widget_token')).json(); const s: Record<string, string> = {}; r.forEach((x: any) => { s[x.name] = x.value; }); return s; }

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const k = new URL(req.url).searchParams.get('k') || '';
  const sec = await secrets();
  if (!sec.widget_token || k !== sec.widget_token) return json({ error: 'Not allowed' }, 403);
  const lp = localParts();
  const D = await loadData(lp.date);
  return json(summary(D, lp.date));
});
