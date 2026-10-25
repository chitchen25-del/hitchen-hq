// Hitchen HQ "Me": takes Apple Health data sent by the Health Auto Export app (REST API automation) and keeps it in the
// owner-only me_* tables. Called with ?k=<health token> (or an x-hhq-key header); the token and the owner's id live in
// app_secrets, never in this public code. Nothing here is visible to the family Ask box.
const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-hhq-key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const secret = async (name: string) => { const r = await (await rest(`app_secrets?select=value&name=eq.${name}`)).json(); return r[0] ? String(r[0].value) : ''; };

// metrics that add up through the day (several readings in one day are summed, the rest are averaged)
const SUM = new Set(['step_count', 'active_energy', 'basal_energy_burned', 'apple_exercise_time', 'apple_stand_time', 'apple_stand_hour', 'walking_running_distance',
  'cycling_distance', 'swimming_distance', 'swimming_stroke_count', 'flights_climbed', 'dietary_energy', 'protein', 'carbohydrates', 'total_fat', 'fiber', 'dietary_sugar',
  'dietary_water', 'dietary_caffeine', 'alcohol_consumption', 'number_of_times_fallen', 'mindful_minutes', 'time_in_daylight', 'push_count', 'wheelchair_distance', 'handwashing', 'toothbrushing']);
// names Health Auto Export uses that the app knows by another name
const ALIAS: Record<string, string> = { weight_body_mass: 'body_mass' };
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null);
const dayOf = (s: unknown) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '')); return m ? m[1] : null; };

function reading(name: string, p: any) {
  if (name === 'heart_rate') return { qty: num(p.Avg ?? p.avg ?? p.qty), extra: { min: num(p.Min ?? p.min), max: num(p.Max ?? p.max) } };
  if (name === 'sleep_analysis') {
    const stages = (num(p.core) || 0) + (num(p.deep) || 0) + (num(p.rem) || 0);   // newer iPhones send stages with asleep 0
    const asleep = Math.max(num(p.asleep) || 0, num(p.totalSleep) || 0, stages) || null;
    return { qty: asleep, extra: { core: num(p.core), deep: num(p.deep), rem: num(p.rem), awake: num(p.awake), inBed: num(p.inBed), start: p.sleepStart || p.inBedStart || null, end: p.sleepEnd || p.inBedEnd || null } };
  }
  if (name === 'blood_pressure') return { qty: num(p.systolic), extra: { diastolic: num(p.diastolic) } };
  if ('qty' in p) return { qty: num(p.qty), extra: null };
  for (const [k, v] of Object.entries(p)) if (!['date', 'source'].includes(k) && num(v) !== null) return { qty: num(v), extra: { field: k } };
  return { qty: null, extra: null };
}

function metricRows(owner: string, metrics: any[]) {
  const by = new Map<string, any>();
  for (const m of metrics || []) {
    const raw = String(m && m.name || '').trim(), name = ALIAS[raw] || raw; if (!name || !Array.isArray(m.data)) continue;
    const mgdl = name === 'blood_glucose' && /mg/i.test(String(m.units || '')), units = mgdl ? 'mmol/L' : (m.units || null);   // glucose kept in mmol/L, the UK unit
    for (const p of m.data) {
      const day = dayOf(p && p.date); if (!day) continue;
      const rd = reading(name, p), qty = rd.qty !== null && mgdl ? Math.round(rd.qty / 18.016 * 100) / 100 : rd.qty, extra = rd.extra; if (qty === null && !extra) continue;
      const key = `${day}|${name}`, cur = by.get(key);
      if (!cur) { by.set(key, { owner, day, metric: name, qty, units, data: { ...(extra || {}), n: 1, src: p.source || null }, updated_at: new Date().toISOString() }); continue; }
      const n = cur.data.n + 1;
      if (name === 'sleep_analysis') { cur.qty = (cur.qty || 0) + (qty || 0); for (const f of ['core', 'deep', 'rem', 'awake', 'inBed']) cur.data[f] = (cur.data[f] || 0) + ((extra as any)?.[f] || 0); const e: any = extra || {}; if (e.start && (!cur.data.start || e.start < cur.data.start)) cur.data.start = e.start; if (e.end && (!cur.data.end || e.end > cur.data.end)) cur.data.end = e.end; }
      else if (SUM.has(name)) cur.qty = (cur.qty || 0) + (qty || 0);
      else { if (qty !== null) cur.qty = cur.qty === null ? qty : (cur.qty * cur.data.n + qty) / n; if (name === 'heart_rate') { const e: any = extra || {}; if (e.min !== null && (cur.data.min === null || e.min < cur.data.min)) cur.data.min = e.min; if (e.max !== null && (cur.data.max === null || e.max > cur.data.max)) cur.data.max = e.max; } }
      cur.data.n = n;
    }
  }
  return [...by.values()].map(r => ({ ...r, qty: r.qty === null ? null : Math.round(r.qty * 1000) / 1000 }));
}

function workoutRows(owner: string, workouts: any[]) {
  return (workouts || []).filter(w => w && (w.start || w.startDate)).map(w => {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(w)) { if (Array.isArray(v)) { data[`${k}Count`] = v.length; continue; } data[k] = v; }   // drop routes and per-minute series, keep the summary
    const start = w.start || w.startDate, end = w.end || w.endDate || null;
    const toIso = (s: any) => { if (!s) return null; const d = new Date(String(s).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ?([+-]\d{2})(\d{2})$/, '$1T$2$3:$4')); return isNaN(+d) ? null : d.toISOString(); };
    return { owner, id: String(w.id || `${w.name || 'workout'}|${start}`).slice(0, 200), start_at: toIso(start), end_at: toIso(end), name: w.name || null, data, updated_at: new Date().toISOString() };
  });
}

async function upsert(table: string, conflict: string, rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const r = await rest(`${table}?on_conflict=${conflict}`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) throw new Error(`${table}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const k = new URL(req.url).searchParams.get('k') || req.headers.get('x-hhq-key') || '';
  const [token, owner] = await Promise.all([secret('health_token'), secret('me_owner')]);
  if (!token || !owner || k !== token) return json({ error: 'Wrong or missing key' }, 401);
  if (req.method === 'GET') return json({ ok: true, hello: 'Hitchen HQ is ready for your health data' });
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'Send JSON' }, 400);
  const d = body.data || body;
  const mrows = metricRows(owner, Array.isArray(d.metrics) ? d.metrics : []);
  const wrows = workoutRows(owner, Array.isArray(d.workouts) ? d.workouts : []);
  try {
    if (mrows.length) await upsert('me_metrics', 'owner,day,metric', mrows);
    if (wrows.length) await upsert('me_workouts', 'owner,id', wrows);
    const days = [...new Set(mrows.map(r => r.day))].sort();
    await upsert('me_docs', 'owner,path', [{ owner, path: 'sync', data: { at: new Date().toISOString(), metrics: [...new Set(mrows.map(r => r.metric))].sort(), readings: mrows.length, workouts: wrows.length, from: days[0] || null, to: days[days.length - 1] || null }, updated_at: new Date().toISOString() }]);
  } catch (e) { return json({ error: String((e as Error).message || e) }, 500); }
  return json({ ok: true, metrics: mrows.length, workouts: wrows.length });
});
