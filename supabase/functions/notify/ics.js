// Minimal iCalendar (.ics) reader: events in a date window, with time zones, RRULE, EXDATE and moved instances.
const DAY = 86400000;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n'); }
function unescapeText(s) { return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1'); }

function parseLine(line) {
  const i = line.indexOf(':'); if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(';'); const name = parts.shift().toUpperCase(); const params = {};
  parts.forEach(p => { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); });
  return { name, params, value };
}

// offset (ms) of a time zone at a UTC instant
function tzOffset(tz, utcMs) {
  try {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {}; f.formatToParts(new Date(utcMs)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
  } catch (e) { return 0; }
}
function wallToUtc(w, tz) { // w = {y,m,d,h,mi,s} wall clock in tz
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  if (!tz) return guess;
  let t = guess - tzOffset(tz, guess); t = guess - tzOffset(tz, t); return t;
}
// parse an ICS date or date-time into { wall, tz, utc, allDay }
function parseDT(prop, defaultTz) {
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v); if (!m) return null;
  const wall = { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0) };
  const allDay = !m[4] || prop.params.VALUE === 'DATE';
  if (allDay) return { wall, allDay: true, tz: null, utc: Date.UTC(wall.y, wall.m - 1, wall.d) };
  if (m[7]) return { wall, allDay: false, tz: 'UTC', utc: Date.UTC(wall.y, wall.m - 1, wall.d, wall.h, wall.mi, wall.s) };
  const tz = prop.params.TZID || defaultTz || null;
  return { wall, allDay: false, tz, utc: wallToUtc(wall, tz) };
}
function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || ''); if (!m) return 0;
  const ms = (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60000 + +(m[6] || 0) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// wall-clock date helpers (all-day arithmetic in UTC to avoid DST)
const wallMs = w => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
const fromMs = (ms, w) => { const d = new Date(ms); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s }; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parseRule(v) { const r = {}; v.split(';').forEach(p => { const [k, x] = p.split('='); if (k) r[k.toUpperCase()] = x; }); return r; }

// candidate wall dates for one period of the rule
function periodDates(rule, start, cursor) {
  const out = [];
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map(s => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null; }).filter(Boolean) : null;
  const bymd = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : null;
  const bymonth = rule.BYMONTH ? rule.BYMONTH.split(',').map(Number) : null;
  const f = rule.FREQ;
  if (f === 'DAILY') { if ((!byday || byday.some(b => b.wd === new Date(wallMs(cursor)).getUTCDay())) && (!bymonth || bymonth.includes(cursor.m))) out.push(cursor); }
  else if (f === 'WEEKLY') {
    const wkst = WD[rule.WKST || 'MO'];
    const dow = new Date(wallMs(cursor)).getUTCDay(); const back = (dow - wkst + 7) % 7;
    const weekStart = wallMs(cursor) - back * DAY;
    const days = byday ? byday.map(b => b.wd) : [new Date(wallMs(start)).getUTCDay()];
    for (let i = 0; i < 7; i++) { const ms = weekStart + i * DAY; if (days.includes(new Date(ms).getUTCDay())) out.push(fromMs(ms, start)); }
  } else if (f === 'MONTHLY' || f === 'YEARLY') {
    const months = f === 'MONTHLY' ? [cursor.m] : (bymonth || [start.m]);
    months.forEach(mo => {
      const y = cursor.y, dim = daysInMonth(y, mo);
      if (byday) {
        byday.forEach(b => {
          const all = []; for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === b.wd) all.push(d);
          const pick = b.n === 0 ? all : [b.n > 0 ? all[b.n - 1] : all[all.length + b.n]];
          pick.forEach(d => { if (d && (!bymd || bymd.includes(d))) out.push({ ...start, y, m: mo, d }); });
        });
      } else {
        (bymd || [start.d]).forEach(d => { const dd = d < 0 ? dim + d + 1 : d; if (dd >= 1 && dd <= dim) out.push({ ...start, y, m: mo, d: dd }); });
      }
    });
    out.sort((a, b) => wallMs(a) - wallMs(b));
  }
  return out;
}
function nextCursor(rule, c, interval) {
  const f = rule.FREQ;
  if (f === 'DAILY') return fromMs(wallMs(c) + interval * DAY, c);
  if (f === 'WEEKLY') return fromMs(wallMs(c) + interval * 7 * DAY, c);
  if (f === 'MONTHLY') { let m = c.m - 1 + interval; return { ...c, y: c.y + Math.floor(m / 12), m: (m % 12) + 1, d: 1 }; }
  return { ...c, y: c.y + interval, d: 1 };
}

function expand(ev, fromMsUtc, toMsUtc) {
  const s = ev.start, dur = ev.durMs;
  const toUtc = w => s.allDay ? Date.UTC(w.y, w.m - 1, w.d) : wallToUtc(w, s.tz === 'UTC' ? null : s.tz);
  if (!ev.rrule) return (s.utc + Math.max(dur, 1) > fromMsUtc && s.utc < toMsUtc) ? [s.utc] : [];
  const rule = parseRule(ev.rrule), interval = Math.max(1, +(rule.INTERVAL || 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  let until = Infinity;
  if (rule.UNTIL) { const u = parseDT({ value: rule.UNTIL, params: {} }, s.tz); if (u) until = u.allDay ? u.utc + DAY - 1 : u.utc; }
  const out = []; let n = 0; let cursor = { ...s.wall }; if (rule.FREQ === 'MONTHLY' || rule.FREQ === 'YEARLY') cursor.d = 1;
  for (let guard = 0; guard < 5000; guard++) {
    const cands = periodDates(rule, s.wall, cursor);
    for (const w of cands) {
      const t = toUtc(w);
      if (t < s.utc) continue;
      if (t > until || n >= count) return out;
      n++;
      if (t + Math.max(dur, 1) > fromMsUtc && t < toMsUtc) out.push(t);
      if (t >= toMsUtc) return out;
    }
    cursor = nextCursor(rule, cursor, interval);
    if (toUtc({ ...cursor, d: 1 }) > toMsUtc + 40 * DAY) return out;
  }
  return out;
}

export function readIcs(text, fromMsUtc, toMsUtc) {
  const lines = unfold(text); const events = []; let cur = null; let calTz = null; let depth = [];
  for (const line of lines) {
    const p = parseLine(line); if (!p) continue;
    if (p.name === 'BEGIN') { depth.push(p.value.toUpperCase()); if (p.value.toUpperCase() === 'VEVENT') cur = { props: {}, exdates: [] }; continue; }
    if (p.name === 'END') { const what = depth.pop(); if (what === 'VEVENT' && cur) { events.push(cur); cur = null; } continue; }
    if (p.name === 'X-WR-TIMEZONE' && !cur) calTz = p.value.trim();
    if (!cur || depth[depth.length - 1] !== 'VEVENT') continue;
    if (p.name === 'EXDATE') { p.value.split(',').forEach(v => cur.exdates.push({ ...p, value: v })); continue; }
    cur.props[p.name] = p;
  }
  const parsed = events.map(e => {
    const P = e.props; if (!P.DTSTART) return null;
    const start = parseDT(P.DTSTART, calTz); if (!start) return null;
    let durMs = 0;
    if (P.DTEND) { const end = parseDT(P.DTEND, calTz); if (end) durMs = end.utc - start.utc; }
    else if (P.DURATION) durMs = parseDuration(P.DURATION.value);
    else durMs = start.allDay ? DAY : 0;
    return {
      uid: P.UID ? P.UID.value : Math.random().toString(36), start, durMs,
      title: P.SUMMARY ? unescapeText(P.SUMMARY.value) : '(No title)', location: P.LOCATION ? unescapeText(P.LOCATION.value) : '',
      rrule: P.RRULE ? P.RRULE.value : null, cancelled: P.STATUS && P.STATUS.value.toUpperCase() === 'CANCELLED',
      recurId: P['RECURRENCE-ID'] ? parseDT(P['RECURRENCE-ID'], calTz) : null,
      ex: new Set(e.exdates.map(x => { const d = parseDT(x, calTz); return d ? d.utc : null; }).filter(x => x !== null)),
    };
  }).filter(Boolean);
  const moved = {}; parsed.filter(e => e.recurId).forEach(e => { (moved[e.uid] = moved[e.uid] || new Set()).add(e.recurId.utc); });
  const out = [];
  parsed.forEach(e => {
    if (e.cancelled && !e.recurId) return;
    const times = e.recurId ? [e.start.utc].filter(t => t + Math.max(e.durMs, 1) > fromMsUtc && t < toMsUtc) : expand(e, fromMsUtc, toMsUtc);
    times.forEach(t => {
      if (!e.recurId && (e.ex.has(t) || (moved[e.uid] && moved[e.uid].has(t)))) return;
      if (e.cancelled) return;
      const allDay = e.start.allDay;
      const iso = ms => allDay ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString();
      out.push({ title: e.title, location: e.location, allDay, start: iso(t), end: iso(t + e.durMs) });
    });
  });
  out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return out;
}
