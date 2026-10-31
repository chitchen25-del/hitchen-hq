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
const MODEL = 'claude-sonnet-5-5', DO_MODEL = 'claude-haiku-5-5';

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

/* ---- "do": read a photo or an instruction and propose changes for the family to confirm in the app ---- */
const addD = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function doContext(auth: string, today: string) {
  const r = await fetch(`${URL_}/rest/v1/docs?select=path,data&or=(path.eq.settings/main,path.like.kids/*,path.like.days/*,path.like.bills/*,path.like.list/*,path.eq.meals/main,path.like.plans/*)`, { headers: { apikey: ANON, Authorization: auth } });
  const rows: { path: string; data: any }[] = r.ok ? await r.json() : [];
  const lo = addD(today, -7), hi = addD(today, 90), L: string[] = [];
  for (const { path, data } of rows) {
    const [c, id] = path.split('/');
    if (c === 'settings') L.push(`children: ${JSON.stringify((data.kids || []).map((k: any) => ({ name: k.name, dob: k.dob })))}`);
    else if (c === 'kids') L.push(`kid ${id}: activities ${JSON.stringify((data.acts || []).map((a: any) => ({ n: a.n, day: a.day, from: a.from, kind: a.kind })))}; upcoming events ${JSON.stringify((data.events || []).filter((e: any) => e.d >= lo).map((e: any) => ({ d: e.d, t: e.t, kind: e.kind })))}`);
    else if (c === 'days') { const d = id.split('_')[1]; if (d >= lo && d <= hi) L.push(`day ${id}: ${data.status || ''} ${data.start || ''}${data.end ? '-' + data.end : ''}${data.oncall ? ' on call' : ''}`); }
    else if (c === 'bills') L.push(`bill: ${data.name} £${data.amount} ${data.freq}`);
    else if (c === 'list' && !data.done) L.push(`shopping list: ${data.text}`);
    else if (c === 'plans' && data.kind !== 'year') L.push(`trip/plan id=${id} kind=${data.kind || ''}: ${data.name} ${data.from || ''} to ${data.to || ''}${data.note ? ` (note: ${data.note})` : ''}`);
  }
  return L.join('\n');
}
const DO_TOOL = { name: 'propose_changes', description: 'Propose additions or changes to the family app for the family to confirm.', input_schema: { type: 'object', properties: {
  summary: { type: 'string', description: 'One short friendly sentence saying what you found, in British English.' },
  changes: { type: 'array', items: { type: 'object', properties: {
    type: { type: 'string', enum: ['kid_event', 'kid_activity', 'work_day', 'list_item', 'bill', 'meal', 'trip', 'trip_change'] },
    label: { type: 'string', description: 'Short plain description of this change for a checklist, e.g. "Ella: museum trip, Thu 29 Oct, packed lunch and £5".' },
    kid: { type: 'string', description: 'Child first name (kid_event, kid_activity).' },
    date: { type: 'string', description: 'YYYY-MM-DD (kid_event, work_day, meal, bill next payment).' },
    day: { type: 'integer', description: 'Weekday 0=Sunday..6=Saturday (kid_activity).' },
    kind: { type: 'string', description: 'kid_event: test|trip|event|nonuniform|dayoff|other. kid_activity: club|pe|swim|music|lesson|other.' },
    title: { type: 'string', description: 'Name of the event, activity, bill or dinner.' },
    from: { type: 'string', description: 'HH:MM start' }, to: { type: 'string', description: 'HH:MM end' },
    where: { type: 'string' }, kit: { type: 'string', description: 'Things to take, comma separated.' }, note: { type: 'string' },
    drop: { type: 'string', description: 'chris|viki|other name for drop-off' }, pick: { type: 'string', description: 'chris|viki|other name for pick-up' },
    term: { type: 'boolean', description: 'Activity runs in term time only (default true).' },
    who: { type: 'string', enum: ['chris', 'viki'], description: 'work_day: whose day.' },
    status: { type: 'string', description: 'work_day: chris work|holiday|sick|off; viki shift|holiday|sick|off.' },
    start: { type: 'string', description: 'HH:MM shift start' }, end: { type: 'string', description: 'HH:MM shift end' },
    oncall: { type: 'boolean', description: 'work_day for viki: on call that day.' },
    text: { type: 'string', description: 'list_item: the shopping item.' },
    amount: { type: 'number', description: 'bill: amount in pounds.' }, freq: { type: 'string', enum: ['monthly', 'weekly', 'quarterly', 'annual'] },
    category: { type: 'string' },
    plan_id: { type: 'string', description: 'trip_change: the id of the existing trip/plan to change, from the list below (e.g. pl_easter27).' },
    trip_kind: { type: 'string', enum: ['summer', 'city', 'family', 'christmas', 'birthday', 'celebration'], description: 'trip: summer = holiday, city = trip or short break, family = visit to family or friends, christmas, birthday, celebration.' },
    date_from: { type: 'string', description: 'trip, trip_change: YYYY-MM-DD the trip starts (leave).' },
    date_to: { type: 'string', description: 'trip, trip_change: YYYY-MM-DD the trip ends (back home).' } }, required: ['type', 'label'] } } }, required: ['summary', 'changes'] } };
const DO_RULES = (n: ReturnType<typeof localNow>) => `You help a family keep their organiser app up to date. Today is ${n.weekday} ${n.date} (Isle of Man).
Read the photo and/or instruction and propose the changes to make, using the propose_changes tool. Rules:
- Only propose what the photo or instruction actually says. Never invent dates, times or amounts; leave a field out if it isn't given.
- Resolve relative dates ("next Tuesday", "the 29th") to YYYY-MM-DD from today. Dates in letters without a year are the next occurrence.
- A school letter about a one-off day is a kid_event; a weekly club or lesson is a kid_activity. If a letter doesn't say which child, use the child it names, or leave kid empty.
- A work rota becomes one work_day per listed day. "C:" or Chris means who=chris; Viki's NHS rota means who=viki (status shift with start/end; on call days set oncall true).
- Receipts or bills with a regular payment become a bill; groceries to buy become list_item entries; dinners become meal entries.
- Holidays, trips and visits live in the Treats planner. A new one is a trip (title, trip_kind, date_from, date_to, note). Moving, renaming or re-dating one that's already listed below is a trip_change with its plan_id, giving only the fields that change (title for a new name). Times of day like "pm" or "evening" go in note, e.g. "Leave 23 Jul afternoon, back 28 Jul afternoon". If it's unclear which existing trip is meant, pick the closest match by name and say which in the label.
- Avoid duplicates of what's already in the app (listed below).
- If nothing can be added, return an empty changes list and say why in the summary.
What's already in the app:`;

const RULES = (n: ReturnType<typeof localNow>) => `You are the assistant inside Hitchen HQ, a family's own organiser app on the Isle of Man. Who's who is in the settings and data below.
Today is ${n.weekday} ${n.date}, ${n.time} Isle of Man time.
Answer the question using the family's data below. Work things out properly (dates, money, hours) rather than guessing, and say plainly if the data doesn't cover it.
Style: warm, brief and direct, in British English. Lead with the answer in the first sentence. Use £, 12-hour times like 5:30pm and dates like Thursday 3 December. Keep it short enough to read on a phone; use a few bullets only when listing several things. No headings, no tables.
Notes on the data: money is in pounds. "state/hours" holds an hours balance in minutes (positive means owed to that person) and their contract hours. Calendar lines starting "V:" or "C:" are rota entries for the person with that initial. School dates are the Isle of Man ones. Bank statements ("stmt") are summaries the family imported.
You can't change anything from this chat. If they ask you to add, move or change something (a trip, visit, shift, event), tell them to send it as an instruction starting with Add, Move or Change, for example "Move the Easter visit to 23 to 28 July", and the app will show it as a change to confirm.`;

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
  if (body.action === 'do') {
    const key = await getKey(); if (!key) return json({ error: 'nokey' }, 400);
    const text = String(body.text || '').trim().slice(0, 2000), img = typeof body.image === 'string' && body.image.length < 6_000_000 ? body.image : '';
    if (!text && !img) return json({ error: 'Add a photo or say what to add' }, 400);
    const n = localNow(), ctx = await doContext(auth, n.date);
    const content: any[] = []; if (img) content.push({ type: 'image', source: { type: 'base64', media_type: /^image\/(png|webp|gif)$/.test(body.mediaType) ? body.mediaType : 'image/jpeg', data: img } });
    content.push({ type: 'text', text: text || 'Add what this shows to the app.' });
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: DO_MODEL, max_tokens: 4000, output_config: { effort: 'low' }, system: `${DO_RULES(n)}\n${ctx}`, tools: [DO_TOOL], tool_choice: { type: 'tool', name: 'propose_changes' }, messages: [{ role: 'user', content }] }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const m = out?.error?.message || `Claude answered ${res.status}`; return json({ error: res.status === 401 ? 'The API key was turned down. Add a new one in Ask settings.' : m }, 502); }
    const use = (out.content || []).find((c: any) => c.type === 'tool_use');
    if (!use) return json({ error: out.stop_reason === 'max_tokens' ? 'That was too much to read in one go. Try a clearer or smaller photo.' : `No changes came back (${out.stop_reason || 'unknown'})` }, 502);
    return json({ summary: use.input.summary || '', changes: Array.isArray(use.input.changes) ? use.input.changes : [], usage: out.usage });
  }
  if (body.action === 'bank') {
    /* read screenshots of the bank app: the balance and every transaction line, nothing else. Matching is done in the app. */
    const key = await getKey(); if (!key) return json({ error: 'nokey' }, 400);
    const imgs = (Array.isArray(body.images) ? body.images : []).filter((x: any) => typeof x === 'string' && x.length < 6_000_000).slice(0, 6);
    if (!imgs.length) return json({ error: 'Add a screenshot of the bank app' }, 400);
    const n = localNow();
    const content: any[] = imgs.map((d: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } }));
    content.push({ type: 'text', text: `Today is ${n.date}. Read these bank app screenshots. Give the account balance shown (the main "balance" figure; if there's also an "available" figure give that as available). List every transaction line exactly once (screenshots may overlap: don't repeat a line that appears on two screenshots), with its date as YYYY-MM-DD (work out the year from today; "Today"/"Yesterday" count back from today), the payee text as shown, the amount as a positive number, dir "out" for money leaving and "in" for money arriving, and pending true if it's marked pending. Don't guess anything you can't read.` });
    const tool = { name: 'bank_lines', description: 'The balance and transactions read from the screenshots', input_schema: { type: 'object', properties: {
      balance: { type: 'number', description: 'The balance shown, negative if overdrawn' }, available: { type: 'number' },
      lines: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, text: { type: 'string' }, amount: { type: 'number' }, dir: { type: 'string', enum: ['in', 'out'] }, pending: { type: 'boolean' } }, required: ['text', 'amount', 'dir'] } } }, required: ['lines'] } };
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 6000, output_config: { effort: 'low' }, tools: [tool], tool_choice: { type: 'tool', name: 'bank_lines' }, messages: [{ role: 'user', content }] }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { const m = out?.error?.message || `Claude answered ${res.status}`; return json({ error: res.status === 401 ? 'The API key was turned down. Add a new one in Ask settings.' : m }, 502); }
    const use = (out.content || []).find((c: any) => c.type === 'tool_use');
    if (!use) return json({ error: 'Couldn\'t read those screenshots. Try clearer ones.' }, 502);
    return json({ balance: use.input.balance ?? null, available: use.input.available ?? null, lines: Array.isArray(use.input.lines) ? use.input.lines : [] });
  }
  const q = String(body.q || '').trim().slice(0, 1500); if (!q) return json({ error: 'Ask a question' }, 400);
  const key = await getKey(); if (!key) return json({ error: 'nokey' }, 400);
  const n = localNow(), ctx = await context(auth, n.date);
  const hist = (Array.isArray(body.history) ? body.history : []).slice(-6).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && m.text).map((m: any) => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, output_config: { effort: 'low' }, system: [{ type: 'text', text: RULES(n) }, { type: 'text', text: `# The family's data\n\n${ctx}`, cache_control: { type: 'ephemeral' } }], messages: [...hist, { role: 'user', content: q }] }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) { const m = out?.error?.message || `Claude answered ${res.status}`; return json({ error: res.status === 401 ? 'The API key was turned down. Add a new one in Ask settings.' : m }, 502); }
  const answer = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim();
  /* these models think before answering, and the thinking counts towards max_tokens: effort 'low' keeps it short, and a cut-off answer is still shown */
  if (!answer) return json({ error: out.stop_reason === 'max_tokens' ? 'That one needed more working out than Ask allows. Try asking it in smaller parts.' : `Claude didn't send an answer (${out.stop_reason || 'unknown'}). Try asking again.` }, 502);
  return json({ answer: out.stop_reason === 'max_tokens' ? `${answer}…\n\n(That answer was cut short. Ask for the rest if you need it.)` : answer, usage: out.usage });
});
