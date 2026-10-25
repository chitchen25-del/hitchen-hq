// Hitchen HQ "Ask": answers a family member's question in plain English from the family's own data.
// The data is read with the asker's own sign-in (so Row Level Security decides what's visible), then sent with the
// question to Claude. The Anthropic API key is kept server-side in app_secrets and never reaches the app.
import { readIcs } from './ics.js';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const svc = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const MODEL = 'claude-sonnet-5-5';

function localNow() {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}
async function getKey() { const r = await (await svc('app_secrets?select=value&name=eq.anthropic_key')).json(); return r[0] ? r[0].value : null; }
async function setKey(v: string) {
  const has = await getKey();
  if (has !== null) await svc('app_secrets?name=eq.anthropic_key', { method: 'PATCH', body: JSON.stringify({ value: v }) });
  else await svc('app_secrets', { method: 'POST', body: JSON.stringify({ name: 'anthropic_key', value: v }) });
}

/* the family's data as compact text: what a well-briefed assistant needs, without photos or secret links */
async function context(auth: string, today: string) {
  const r = await fetch(`${URL_}/rest/v1/docs?select=path,data`, { headers: { apikey: ANON, Authorization: auth } });
  const rows: { path: string; data: any }[] = r.ok ? await r.json() : [];
  const out: string[] = [], days: string[] = []; let feeds: any[] = [];
  for (const { path, data } of rows) {
    const [c, id] = path.split('/');
    if (c === 'media') continue;
    if (path === 'private/calendar') { feeds = data.feeds || []; continue; }
    if (c === 'private') continue;
    if (c === 'days') { const d = data || {}; days.push(`${id.replace('_', ' ')}: ${d.status || ''}${d.start ? ` ${d.start}-${d.end || ''}` : ''}${d.note ? ` (${d.note})` : ''}${d.callouts ? ` callouts ${d.callouts}` : ''}`); continue; }
    if (path === 'state/carlog') { const m: Record<string, number[]> = {}; Object.entries(data.days || {}).forEach(([d, v]: any) => { const k = d.slice(0, 7); m[k] = m[k] || [0, 0, 0, 0]; m[k][0] += v[0]; m[k][1] += v[1]; m[k][2] += v[3]; m[k][3] += v[4]; });
      out.push(`## car journey log by month (miles, litres, work miles, work litres)\n${Object.entries(m).map(([k, v]) => `${k}: ${v.map(x => Math.round(x)).join(', ')}`).join('\n')}`); continue; }
    if (c === 'settings') { const s = { ...data }; delete s.chrisWork; out.push(`## settings\n${JSON.stringify(s)}`); continue; }
    out.push(`## ${path}\n${JSON.stringify(data)}`);
  }
  days.sort();
  out.push(`## work calendar records (who date: status times note)\n${days.join('\n')}`);
  // calendar events: the past week and the next eight weeks (Viki's rota lines start "V:", Chris's "C:")
  const from = Date.parse(today + 'T00:00:00Z') - 7 * 86400000, to = from + 63 * 86400000, ev: string[] = [];
  await Promise.all(feeds.map(async (f: any) => { try {
    const res = await fetch(String(f.url || '').replace(/^webcal:\/\//i, 'https://'), { signal: AbortSignal.timeout(10000) });
    if (res.ok) readIcs(await res.text(), from, to).forEach((e: any) => ev.push(`${e.allDay ? e.start : new Date(e.start).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' })}${e.allDay ? '' : '–' + new Date(e.end).toLocaleTimeString('en-GB', { timeZone: TZ, timeStyle: 'short' })} ${e.title}${f.name ? ` [${f.name}]` : ''}`));
  } catch (_) { /* skip a calendar that fails */ } }));
  ev.sort(); out.push(`## calendar events, last week and next 8 weeks\n${ev.join('\n')}`);
  let text = out.join('\n\n'); if (text.length > 380000) text = text.slice(0, 380000) + '\n…(trimmed)';
  return text;
}

const RULES = (n: ReturnType<typeof localNow>) => `You are the assistant inside Hitchen HQ, a family's own organiser app on the Isle of Man. Who's who is in the settings and data below.
Today is ${n.weekday} ${n.date}, ${n.time} Isle of Man time.
Answer the question using the family's data below. Work things out properly (dates, money, hours) rather than guessing, and say plainly if the data doesn't cover it.
Style: warm, brief and direct, in British English. Lead with the answer in the first sentence. Use £, 12-hour times like 5:30pm and dates like Thursday 3 December. Keep it short enough to read on a phone; use a few bullets only when listing several things. No headings, no tables.
Notes on the data: money is in pounds. "state/hours" holds an hours balance in minutes (positive means owed to that person) and their contract hours. Calendar lines starting "V:" or "C:" are rota entries for the person with that initial. School dates are the Isle of Man ones. Bank statements ("stmt") are summaries the family imported.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') || '';
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!u.ok) return json({ error: 'Not signed in' }, 401);
  const email = (await u.json()).email;
  const fam = await (await svc(`allowed_users?select=email&email=eq.${encodeURIComponent(email)}`)).json();
  if (!fam.length) return json({ error: 'Not allowed' }, 403);
  const body = await req.json().catch(() => ({}));
  if (body.action === 'status') return json({ hasKey: !!(await getKey()) });
  if (body.action === 'setkey') {
    const k = String(body.key || '').trim(); if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(k)) return json({ error: 'That doesn\'t look like an Anthropic API key (it starts sk-ant-)' }, 400);
    await setKey(k); return json({ ok: true });
  }
  if (body.action === 'forgetkey') { await svc('app_secrets?name=eq.anthropic_key', { method: 'DELETE' }); return json({ ok: true }); }
  const q = String(body.q || '').trim().slice(0, 1500); if (!q) return json({ error: 'Ask a question' }, 400);
  const key = await getKey(); if (!key) return json({ error: 'nokey' }, 400);
  const n = localNow(), ctx = await context(auth, n.date);
  const hist = (Array.isArray(body.history) ? body.history : []).slice(-6).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && m.text).map((m: any) => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: [{ type: 'text', text: RULES(n) }, { type: 'text', text: `# The family's data\n\n${ctx}`, cache_control: { type: 'ephemeral' } }], messages: [...hist, { role: 'user', content: q }] }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const m = out?.error?.message || `Claude answered ${res.status}`; return json({ error: res.status === 401 ? 'The API key was turned down. Add a new one in Ask settings.' : m }, 502); }
  const answer = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
  return json({ answer, usage: out.usage });
});
