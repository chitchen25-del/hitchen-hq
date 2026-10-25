// Hitchen HQ "Me" coach: one person's private trainer, health guide, motivator, mate and rival, built on Claude.
// Only the owner (app_secrets me_owner) can use it. It reads the owner-only me_* tables (Apple Health data, profile, logs,
// chat) and nothing from the family's docs. The Anthropic key stays server-side. pg_cron calls it with x-hhq-cron for the
// morning brief, evening check-in and Sunday review, which arrive as phone notifications.
import webpush from 'npm:web-push@3.6.7';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const MODEL = 'claude-sonnet-5-5';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hhq-cron', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
async function secrets() { const r = await (await rest('app_secrets?select=name,value')).json(); const s: Record<string, string> = {}; r.forEach((x: any) => { s[x.name] = x.value; }); return s; }

function localNow(d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'long' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}
const addDays = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const r1 = (n: number) => Math.round(n * 10) / 10;

// ---------- the owner's data ----------
async function getDoc(owner: string, path: string) { const r = await (await rest(`me_docs?select=data&owner=eq.${owner}&path=eq.${path}`)).json(); return r[0] ? r[0].data : null; }
async function putDoc(owner: string, path: string, data: unknown) {
  await rest('me_docs?on_conflict=owner,path', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ owner, path, data, updated_at: new Date().toISOString() }]) });
}
/* the database hands back at most 1,000 rows at a time, so read the last 400 days in pages */
async function recentMetrics(owner: string, today: string) {
  const out: any[] = [];
  for (let off = 0; off < 40000; off += 1000) {
    const r = await rest(`me_metrics?select=day,metric,qty,units,data&owner=eq.${owner}&day=gte.${addDays(today, -400)}&order=day.desc,metric.asc&limit=1000&offset=${off}`);
    const rows = r.ok ? await r.json() : []; out.push(...rows); if (rows.length < 1000) break;
  }
  return out.reverse();
}
async function loadAll(owner: string, today: string) {
  const [docs, metrics, workouts, monthly] = await Promise.all([
    rest(`me_docs?select=path,data&owner=eq.${owner}`).then(r => r.json()),
    recentMetrics(owner, today),
    rest(`me_workouts?select=start_at,name,data&owner=eq.${owner}&start_at=gte.${addDays(today, -60)}T00:00:00Z&order=start_at.desc&limit=200`).then(r => r.json()),
    rest('rpc/me_monthly', { method: 'POST', body: JSON.stringify({ p_owner: owner }) }).then(r => r.ok ? r.json() : []).catch(() => []),
  ]);
  const D: any = { profile: {}, log: { entries: [] }, chat: { msgs: [] }, commits: { items: [] }, sync: null };
  for (const d of docs) { if (d.path === 'profile') D.profile = d.data || {}; else if (d.path === 'log') D.log = d.data || { entries: [] }; else if (d.path === 'chat') D.chat = d.data || { msgs: [] }; else if (d.path === 'commits') D.commits = d.data || { items: [] }; else if (d.path === 'sync') D.sync = d.data; }
  D.log.entries = D.log.entries || []; D.chat.msgs = D.chat.msgs || []; D.commits.items = D.commits.items || [];
  D.metrics = metrics; D.workouts = workouts; D.monthly = Array.isArray(monthly) ? monthly : []; return D;
}

// headline metrics in the order a coach looks at them: [Health Auto Export name, label, decimals]
const KEY: [string, string, number][] = [['step_count', 'steps', 0], ['active_energy', 'active kcal', 0], ['apple_exercise_time', 'exercise min', 0], ['apple_stand_hour', 'stand hrs', 0],
  ['sleep_analysis', 'sleep h', 1], ['resting_heart_rate', 'resting HR', 0], ['heart_rate_variability', 'HRV ms', 0], ['body_mass', 'weight', 1], ['body_fat_percentage', 'body fat %', 1],
  ['walking_heart_rate_average', 'walking HR', 0], ['vo2_max', 'VO2 max', 1], ['respiratory_rate', 'breaths/min', 1], ['blood_oxygen_saturation', 'SpO2 %', 0],
  ['dietary_water', 'water', 1], ['protein', 'protein g', 0], ['dietary_energy', 'food kcal', 0], ['walking_running_distance', 'distance', 1], ['flights_climbed', 'flights', 0], ['time_in_daylight', 'daylight min', 0], ['blood_glucose', 'glucose mmol/L', 1]];

function metricText(D: any, today: string) {
  const by: Record<string, Record<string, any>> = {}, units: Record<string, string> = {};
  for (const m of D.metrics) { (by[m.day] = by[m.day] || {})[m.metric] = m; if (m.units) units[m.metric] = m.units; }
  const days = Object.keys(by).sort(); if (!days.length) return 'No Apple Health data has arrived yet.';
  const present = KEY.filter(([k]) => days.some(d => by[d][k]));
  const others = [...new Set(D.metrics.map((m: any) => m.metric))].filter(k => !KEY.some(([x]) => x === k)) as string[];
  const fmt = (m: any, dp: number) => { if (!m || m.qty === null || m.qty === undefined) return '-'; let s = Number(m.qty).toFixed(dp);
    if (m.metric === 'sleep_analysis' && m.data) s += ` (deep ${r1(m.data.deep || 0)}, REM ${r1(m.data.rem || 0)}, awake ${r1(m.data.awake || 0)})`;
    if (m.metric === 'blood_pressure' && m.data) s = `${Math.round(m.qty)}/${Math.round(m.data.diastolic)}`; return s; };
  const out: string[] = [];
  out.push(`Units: ${present.map(([k, l]) => `${l} in ${units[k] || '?'}`).join(', ')}`);
  out.push(`\n### Daily, last 21 days (newest last)\ndate | ${present.map(p => p[1]).join(' | ')}${by[days[days.length - 1]].blood_pressure || days.some(d => by[d].blood_pressure) ? ' | BP' : ''}`);
  for (const d of days.filter(d => d >= addDays(today, -20))) out.push(`${d} | ${present.map(([k, , dp]) => fmt(by[d][k], dp)).join(' | ')}${days.some(x => by[x].blood_pressure) ? ` | ${fmt(by[d].blood_pressure, 0)}` : ''}`);
  // weekly averages further back
  const weeks: string[] = [];
  for (let w = 3; w < 26; w++) {
    const to = addDays(today, -7 * w), from = addDays(to, -6), sel = days.filter(d => d >= from && d <= to); if (!sel.length) continue;
    weeks.push(`w/c ${from} | ${present.map(([k, , dp]) => { const v = sel.map(d => by[d][k]?.qty).filter((x: any) => typeof x === 'number'); return v.length ? (v.reduce((a: number, b: number) => a + b, 0) / v.length).toFixed(dp) : '-'; }).join(' | ')}`);
  }
  if (weeks.length) out.push(`\n### Weekly averages, older (newest first)\n${weeks.join('\n')}`);
  // personal bests
  const best = (k: string, hi: boolean) => { let b: any = null; for (const d of days) { const q = by[d][k]?.qty; if (typeof q === 'number' && q > 0 && (!b || (hi ? q > b.q : q < b.q))) b = { d, q }; } return b; };
  const pbs = [['step_count', true, 'most steps'], ['apple_exercise_time', true, 'most exercise minutes'], ['active_energy', true, 'most active kcal'], ['resting_heart_rate', false, 'lowest resting HR'], ['heart_rate_variability', true, 'highest HRV'], ['body_mass', false, 'lowest weight'], ['vo2_max', true, 'best VO2 max'], ['sleep_analysis', true, 'longest sleep']]
    .map(([k, hi, l]) => { const b = best(k as string, hi as boolean); return b ? `${l}: ${r1(b.q)} on ${b.d}` : ''; }).filter(Boolean);
  if (pbs.length) out.push(`\n### Personal records since data began (${days[0]})\n${pbs.join('\n')}`);
  if (others.length) out.push(`\nOther metrics also arriving: ${others.join(', ')}`);
  return out.join('\n');
}

/* every month since the data began, for the long view: is he better or worse than a year ago, two years ago? */
function monthlyText(D: any) {
  const COLS: [string, string, number][] = [['step_count', 'steps', 0], ['apple_exercise_time', 'exercise min', 0], ['resting_heart_rate', 'resting HR', 0], ['heart_rate_variability', 'HRV', 0], ['walking_heart_rate_average', 'walking HR', 0], ['sleep_analysis', 'sleep h', 1], ['body_mass', 'weight kg', 1], ['vo2_max', 'VO2 max', 1], ['blood_glucose', 'glucose', 1]];
  const by: Record<string, Record<string, number>> = {}; (D.monthly || []).forEach((r: any) => { (by[r.month] = by[r.month] || {})[r.metric] = Number(r.avg); });
  const ms = Object.keys(by).sort(); if (ms.length < 2) return '';
  const cols = COLS.filter(([k]) => ms.some(m => by[m][k] !== undefined));
  return `## Monthly averages since the data began (from his Apple Health history)\nmonth | ${cols.map(c => c[1]).join(' | ')}\n${ms.map(m => `${m} | ${cols.map(([k, , dp]) => by[m][k] === undefined ? '-' : by[m][k].toFixed(dp)).join(' | ')}`).join('\n')}`;
}
function contextText(D: any, n: ReturnType<typeof localNow>) {
  const s = D.sync;
  const w = D.workouts.slice(0, 40).map((x: any) => { const d = x.data || {}; const kcal = d.activeEnergyBurned?.qty ?? d.activeEnergy?.qty; const dist = d.distance?.qty;
    const t = x.start_at ? localNow(new Date(x.start_at)) : null;
    return `${t ? `${t.date} ${t.time}` : '?'} ${x.name || 'Workout'}${d.duration ? `, ${Math.round(d.duration / 60)} min` : ''}${kcal ? `, ${Math.round(kcal)} kcal` : ''}${dist ? `, ${r1(dist)} ${d.distance.units || ''}` : ''}${d.avgHeartRate?.qty ? `, avg HR ${Math.round(d.avgHeartRate.qty)}` : ''}`; });
  const open = D.commits.items.filter((c: any) => !c.done && !c.missed), recent = D.commits.items.filter((c: any) => c.done || c.missed).slice(-15);
  return [
    `## Profile (what he's told you)\n${JSON.stringify(D.profile)}`,
    `## Apple Health sync\n${s && s.at ? `Last delivery ${s.at} UTC: ${s.readings} readings, ${s.workouts} workouts, days ${s.from || '?'} to ${s.to || '?'}` : 'Not connected yet. He is setting up the Health Auto Export app.'}`,
    `## Apple Health numbers\n${metricText(D, n.date)}`,
    monthlyText(D),
    `## Workouts, last 60 days (newest first)\n${w.length ? w.join('\n') : 'None recorded.'}`,
    `## His log (injections, weigh-ins, mood, side effects, wins; newest last)\n${D.log.entries.slice(-60).map((e: any) => `${e.date} ${e.type}${e.value !== undefined && e.value !== null && e.value !== '' ? ` ${e.value}` : ''}${e.text ? `: ${e.text}` : ''}`).join('\n') || 'Nothing yet.'}`,
    `## Commitments he's made\nOpen:\n${open.map((c: any) => `[${c.id}] ${c.text}${c.due ? ` (by ${c.due})` : ''}, set ${c.set}`).join('\n') || 'none'}\nRecent:\n${recent.map((c: any) => `[${c.id}] ${c.text}: ${c.done ? 'DONE ' + c.done : 'MISSED ' + c.missed}`).join('\n') || 'none'}`,
  ].join('\n\n');
}

// ---------- who the coach is ----------
const RULES = (n: ReturnType<typeof localNow>) => `You are Chris Hitchen's personal "better me" coach, living in a private corner of his family app. Nobody else sees this chat.
Today is ${n.weekday} ${n.date}, ${n.time} Isle of Man time.

# Who you are
You are five people in one, and you switch between them as the moment needs:
- Coach: plans his training and daily movement around how he actually slept and recovered. Progressive, realistic, specific ("20 min brisk walk at lunch, then 3 rounds of push-ups, squats, rows"). Builds strength, not just steps.
- Doctor: reads his numbers like a good GP would, explains what they mean in plain English, spots trends early (resting heart rate creeping up, HRV dropping, sleep sliding, weight stalling or dropping too fast, blood pressure). You inform, you don't diagnose or prescribe. Say clearly when something is a "book a GP appointment" thing, and when it's a "call 111 or 999 now" thing.
- Motivator: fires him up with his own reasons, his own wins and his own goals, not generic quotes.
- Mate: asks how he's actually doing, listens, remembers what's going on in his life, has a laugh with him.
- Rival: competes with him. Past-Chris is the opponent: last week, last month, his personal records. Lays down challenges and keeps score. Gloats a little when he loses, gives him his flowers when he wins.
Above all you keep him honest: check what he said he'd do against what his phone recorded, and call it out, kindly but straight, when they don't match. No sugar-coating, no lectures.

# How you talk: like Chris
He wants you to sound like him, so write the way he does:
- Casual British, straight to the point, warm underneath. Talks to you like a mate: "Right then", "mate", "Brilliant", "thing is though", "sorted", "pin that in", "let's crack on".
- Says it how it is. Direct, a bit cheeky, backs himself, banter welcome. Mild swearing now and then for emphasis when it lands (he swears a bit himself), never at him in a nasty way, and not in every message.
- Practical and outcome-focused: what's the plan, what's the number, what's next.
- Short. Phone-sized messages: usually 2 to 6 sentences. A few short lines or bullets only when giving a plan. No headings, no tables, no essays, no therapy-speak, no "great question", no emojis unless he uses them first (one is fine for a win).
- Use real numbers from his data. Use £, km or miles as he prefers, weights in stone and pounds unless he says otherwise (Apple Health sends kg: 1 kg = 2.2046 lb, 14 lb = 1 st).

# Weight-loss jabs (tirzepatide, e.g. Mounjaro; semaglutide, e.g. Wegovy)
His medicines, and any dose, are in his profile. If one of these is there, know it well and coach around it:
- It's usually stepped up by 2.5 mg no faster than every 4 weeks (2.5, 5, 7.5, 10, 12.5, 15). Dose decisions belong to his prescriber. Never tell him to change, skip or double a dose; if he asks, give him the facts and the question to ask the prescriber.
- Priorities while on it: enough protein at every meal to hold on to muscle, strength training two or three times a week, plenty of water, fibre, smaller meals, go steady on alcohol and greasy food. Losing muscle along with fat is the main thing to guard against, so it's strength over endless cardio.
- Appetite will be low, especially the day or two after the jab. Make sure he still eats properly; under-eating makes him weak and grumpy and loses muscle.
- Common side effects: nausea, reflux, constipation or diarrhoea, tiredness, often worst after a dose increase. Practical tips are fine.
- Red flags, say plainly and urgently: severe stomach pain that won't go away, especially going through to the back, with or without vomiting (possible pancreatitis); pain under the right ribs, yellow skin or eyes (gallbladder); can't keep fluids down, very dark wee or dizziness (dehydration); signs of an allergic reaction; low mood or dark thoughts. Severe or sudden = 111 or 999. Otherwise his GP or prescriber.
- Weight loss on it usually comes in fits and starts; plateaus are normal. Very fast loss is worth mentioning to the prescriber.
- Track injection day and dose from his log; remind him on jab day if he's made it a habit, and note side effects against dose changes.

# Using tools
- remember: whenever he tells you something lasting about himself (age, height, goal weight, conditions, injuries, medicines or dose changes, his "why", his work pattern, food likes, what motivates him, preferred units), save it. Set onboarded true once you know his main goals, starting point and anything health-wise you need to know.
- log: record things he reports in chat: injections (value = dose in mg), weigh-ins he tells you (value with units), mood (value 1 to 10), side effects, food, wins, notes. Use today's date unless he says otherwise.
- commit: when he agrees to a specific thing ("10k steps tomorrow", "gym Tuesday"), add it. Mark them done or missed when the data or he says so. These are how you keep him honest, so keep them specific and checkable.
Don't mention the tools. Just talk.

# First conversation
If the profile says onboarded is false, you're meeting him. Introduce yourself in his style in a couple of lines, then get to know him over the next few messages, one or two questions at a time (not a form): where he's at now, what "better me" looks like in 6 and 12 months, height and current weight, health conditions and any medicines not already in his profile, injuries, work and sleep pattern, what's derailed him before, what actually motivates him, and how hard he wants you to push (1 = gentle, 10 = drill sergeant).

# Care
If he mentions not eating at all, making himself sick, bingeing and feeling out of control, or feeling hopeless or worthless, drop the banter, be kind and human, and encourage him to talk to his GP; Samaritans are on 116 123 any time. Never shame him about his body or food.
Use the monthly averages for the long view (this month against the same month last year, his best months, how things moved since starting Mounjaro if his log or profile says when). The numbers come from an Apple Watch, iPhone and a glucose sensor he wore for a while: good for trends, not medical-grade. If no Apple Health data has arrived yet, say so honestly and work from what he tells you.`;

const BRIEF: Record<string, string> = {
  morning: 'Write his morning brief for today, to arrive as a phone notification and in this chat. Look at last night\'s sleep and recovery and yesterday\'s numbers against his goals and commitments. Then one clear plan for today, one honest call-out if yesterday slipped, and one line of fire. 3 to 5 short sentences, first sentence must work on its own as the notification.',
  evening: 'Write his evening check-in. Score today so far against what he committed to and his usual (use the numbers), say what\'s still winnable before bed, then ask him one real question about how he\'s doing or how the day went. 3 to 4 short sentences, first sentence must work on its own as the notification.',
  weekly: 'Write his Sunday weekly review. This week vs last week vs his best: steps, exercise, sleep, resting HR, weight trend, commitments kept vs missed. Who won, him or past-Chris. One thing to fix, one thing to keep, and propose 2 or 3 specific commitments for the week ahead for him to agree to. Keep it tight: under 150 words, first sentence must work on its own as the notification.',
};

const TOOLS = [
  { name: 'remember', description: 'Save lasting facts about Chris to his profile.', input_schema: { type: 'object', properties: {
    facts: { type: 'object', description: 'Short keys to short values, e.g. {"height":"6ft 1","goal_weight":"15st","why":"..."}. A null value removes a fact.', additionalProperties: true },
    goals: { type: 'array', items: { type: 'string' }, description: 'His current goals (replaces the list).' },
    focus: { type: 'string', description: 'The one main focus for this month.' },
    meds: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, dose: { type: 'string' }, how: { type: 'string' } }, required: ['name'] }, description: 'Full current medicine list (replaces it).' },
    push_level: { type: 'integer', minimum: 1, maximum: 10 },
    onboarded: { type: 'boolean' } } } },
  { name: 'log', description: 'Record things he reports.', input_schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', properties: {
    type: { type: 'string', enum: ['injection', 'weight', 'mood', 'side_effect', 'food', 'win', 'note', 'measure'] }, date: { type: 'string', description: 'YYYY-MM-DD' }, value: { type: ['string', 'number'] }, text: { type: 'string' } }, required: ['type'] } } }, required: ['entries'] } },
  { name: 'commit', description: 'Track specific commitments.', input_schema: { type: 'object', properties: {
    add: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['text'] } },
    done: { type: 'array', items: { type: 'string' }, description: 'ids' }, missed: { type: 'array', items: { type: 'string' }, description: 'ids' } } } },
];

async function applyTool(owner: string, D: any, name: string, input: any, today: string) {
  if (name === 'remember') {
    const p = D.profile; p.facts = p.facts || {};
    for (const [k, v] of Object.entries(input.facts || {})) { if (v === null) delete p.facts[k]; else p.facts[k] = v; }
    if (Array.isArray(input.goals)) p.goals = input.goals; if (input.focus) p.focus = input.focus; if (Array.isArray(input.meds)) p.meds = input.meds;
    if (input.push_level) p.push_level = input.push_level; if (typeof input.onboarded === 'boolean') p.onboarded = input.onboarded;
    p.updated = today; await putDoc(owner, 'profile', p); return 'saved';
  }
  if (name === 'log') {
    for (const e of input.entries || []) D.log.entries.push({ type: e.type, date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : today, value: e.value ?? null, text: e.text || '', at: new Date().toISOString() });
    D.log.entries = D.log.entries.slice(-1500); await putDoc(owner, 'log', D.log); return `logged ${input.entries?.length || 0}`;
  }
  if (name === 'commit') {
    const items = D.commits.items;
    for (const a of input.add || []) items.push({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: a.text, due: a.due || null, set: today });
    for (const id of input.done || []) { const c = items.find((x: any) => x.id === id); if (c) { c.done = today; delete c.missed; } }
    for (const id of input.missed || []) { const c = items.find((x: any) => x.id === id); if (c) { c.missed = today; delete c.done; } }
    D.commits.items = items.slice(-300); await putDoc(owner, 'commits', D.commits); return 'ok';
  }
  return 'unknown tool';
}

async function talk(key: string, owner: string, D: any, n: ReturnType<typeof localNow>, userText: string) {
  const system = [{ type: 'text', text: RULES(n) }, { type: 'text', text: `# His data\n\n${contextText(D, n)}`, cache_control: { type: 'ephemeral' } }];
  // the chat as alternating turns: briefs and the hello are coach-only messages, so join neighbours from the same side
  const messages: any[] = [];
  for (const m of [...D.chat.msgs.slice(-24).map((m: any) => ({ role: m.r === 'u' ? 'user' : 'assistant', content: `${m.kind ? `(${m.kind}, ${m.day}) ` : ''}${String(m.t).slice(0, 4000)}` })), { role: 'user', content: userText }]) {
    if (!messages.length && m.role === 'assistant') messages.push({ role: 'user', content: '[opened the coach]' });
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`; else messages.push({ ...m });
  }
  let text = '', usage: any = null;
  for (let round = 0; round < 4; round++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, output_config: { effort: 'low' }, system, tools: TOOLS, messages }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? 'The API key was turned down. Add a new one in Ask settings.' : (out?.error?.message || `Claude answered ${res.status}`));
    usage = out.usage;
    const blocks = out.content || [];
    const t = blocks.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim(); if (t) text = text ? `${text}\n\n${t}` : t;
    const uses = blocks.filter((c: any) => c.type === 'tool_use');
    if (out.stop_reason !== 'tool_use' || !uses.length) break;
    messages.push({ role: 'assistant', content: blocks });
    const results = [];
    for (const u of uses) { let r = 'ok'; try { r = await applyTool(owner, D, u.name, u.input || {}, n.date); } catch (e) { r = `failed: ${(e as Error).message}`; } results.push({ type: 'tool_result', tool_use_id: u.id, content: r }); }
    messages.push({ role: 'user', content: results });
  }
  return { text: text || 'Lost my train of thought there, mate. Say that again?', usage };
}

async function saveChat(owner: string, D: any, msgs: any[]) { D.chat.msgs.push(...msgs); D.chat.msgs = D.chat.msgs.slice(-400); await putDoc(owner, 'chat', D.chat); }

async function push(sec: Record<string, string>, title: string, body: string, tag: string) {
  const subs = await (await rest('push_subs?select=endpoint,sub,who,prefs&who=eq.chris')).json();
  webpush.setVapidDetails('mailto:hitchen-hq@users.noreply.github.com', sec.vapid_public, sec.vapid_private);
  const out: any[] = [];
  for (const s of subs) { if (s.prefs?.coach === false) continue;
    try { const r = await webpush.sendNotification(s.sub, JSON.stringify({ title, body, tag, url: './#me' }), { TTL: 6 * 3600 }); out.push(r.statusCode); }
    catch (e: any) { out.push(e.statusCode || 'error'); } }
  return out;
}

const firstSentence = (t: string) => { const s = t.replace(/\s+/g, ' ').trim(); const m = /^(.{20,180}?[.!?])(\s|$)/.exec(s); return m ? m[1] : s.slice(0, 170); };

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sec = await secrets(); const owner = sec.me_owner, key = sec.anthropic_key;
  if (!owner) return json({ error: 'Not set up' }, 500);
  const body = await req.json().catch(() => ({}));
  const n = localNow();
  // scheduled briefs
  if (req.headers.get('x-hhq-cron')) {
    if (req.headers.get('x-hhq-cron') !== sec.notify_secret) return json({ error: 'Not allowed' }, 403);
    const kind = body.kind || (n.hour >= 7 && n.hour <= 10 ? 'morning' : n.hour === 20 ? 'evening' : n.hour === 19 && n.weekday === 'Sunday' ? 'weekly' : '');
    if (!kind || !BRIEF[kind] || !key) return json({ skipped: true, hour: n.hour });
    const D = await loadAll(owner, n.date);
    if (!D.profile.onboarded && !body.force) return json({ skipped: 'not onboarded yet' });
    // the morning brief waits (until 10am at the latest) for the phone to send last night's sleep after he wakes
    if (kind === 'morning' && !body.kind && n.hour < 10) { const at = D.sync && D.sync.at ? localNow(new Date(D.sync.at)) : null; if (!at || at.date !== n.date || at.hour < 5) return json({ skipped: 'waiting for this morning\'s sync' }); }
    if ((D.profile.briefs || {})[kind] === false) return json({ skipped: 'turned off' });
    if (D.chat.msgs.some((m: any) => m.kind === kind && m.day === n.date) && !body.force) return json({ skipped: 'already sent' });
    const { text } = await talk(key, owner, D, n, `[${BRIEF[kind]}]`);
    await saveChat(owner, D, [{ r: 'a', t: text, at: new Date().toISOString(), kind, day: n.date }]);
    const sent = body.dry ? [] : await push(sec, kind === 'morning' ? 'Morning, Chris' : kind === 'evening' ? 'Evening check-in' : 'Your week', firstSentence(text), `coach-${kind}-${n.date}`);
    return json({ kind, text, sent });
  }
  // the owner, signed in
  const auth = req.headers.get('Authorization') || '';
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
  if (!u.ok) return json({ error: 'Not signed in' }, 401);
  if ((await u.json()).id !== owner) return json({ error: 'This part of the app is private' }, 403);
  if (body.action === 'setup') return json({ url: `${URL_}/functions/v1/health?k=${sec.health_token}` });
  if (!key) return json({ error: 'nokey' }, 400);
  const D = await loadAll(owner, n.date);
  try {
    if (body.action === 'hello') {
      if (D.chat.msgs.length) return json({ msgs: D.chat.msgs.slice(-60) });
      const { text } = await talk(key, owner, D, n, '[He has just opened the coach for the very first time. Say hello and start getting to know him.]');
      await saveChat(owner, D, [{ r: 'a', t: text, at: new Date().toISOString(), kind: 'hello', day: n.date }]);
      return json({ msgs: D.chat.msgs.slice(-60) });
    }
    if (body.action === 'brief' && BRIEF[body.kind]) {
      const { text } = await talk(key, owner, D, n, `[${BRIEF[body.kind]}]`);
      await saveChat(owner, D, [{ r: 'a', t: text, at: new Date().toISOString(), kind: body.kind, day: n.date }]);
      return json({ reply: text, msgs: D.chat.msgs.slice(-60) });
    }
    const text = String(body.text || '').trim().slice(0, 3000); if (!text) return json({ error: 'Say something' }, 400);
    const userMsg = { r: 'u', t: text, at: new Date().toISOString() };
    const { text: reply, usage } = await talk(key, owner, D, n, text);
    await saveChat(owner, D, [userMsg, { r: 'a', t: reply, at: new Date().toISOString() }]);
    return json({ reply, usage, profile: D.profile });
  } catch (e) { return json({ error: (e as Error).message }, 502); }
});
