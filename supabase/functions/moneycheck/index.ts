// Hitchen HQ money warning. Run hourly by pg_cron; at 07:00 Isle of Man time it reads the Money check summary the app
// keeps in state/bank and warns the phones when the account is running short before payday.
// Red warns every morning, amber every third morning, and a nudge goes out when the balance is getting old.
// It also reminds the family to type in the balance on payday and on Fridays, and sends a short weekly summary on Sunday at 20:00 (after the weekly bank check-in).
import webpush from 'npm:web-push@3.6.7';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
function localParts(d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const gap = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (d: string) => `${DOWS[parse(d).getUTCDay()]} ${Number(d.slice(8))} ${MON3[Number(d.slice(5, 7)) - 1]}`;
const money = (n: number) => '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');

export function moneyCheck(bank: any, today: string) {
  const c = bank && bank.calc; if (!c || !c.next) return [];
  if (today === c.next) return [{ title: 'Payday! Start the month right', body: 'Once the wages are in, open Hitchen HQ and type in the new bank balance. Money check then shows this week\'s spending money and how last month went.', tag: `mc-${today}` }];
  if (today > c.next) return (gap(c.next, today) % 3 === 1) ? [{ title: 'Update the bank balance', body: 'Money check is still on last pay month. Type in today\'s balance to see what you can spend each day.', tag: `mc-${today}` }] : [];
  const days = gap(today, c.next), age = gap(c.asOf || c.on || today, today), dn = `${days} day${days === 1 ? '' : 's'}`;
  const old = age >= 3 ? ` The balance is ${age} days old, so update it in the app for a true picture.` : '';
  if (c.level === 'red') return [{ title: `Money warning: ${money(c.free)} short before payday`, body: `${c.runOut && c.runOut > today ? `On the current plan the account runs out around ${nice(c.runOut)}. ` : ''}Payday is ${nice(c.next)}, ${dn} away. Open Money check to see what's still to go out.${old}`, tag: `mc-${today}` }];
  if (c.level === 'amber' && days % 3 === 0) return [{ title: `Money is tight: ${money(c.daily || 0)} a day until payday`, body: `That's for everything, food and fuel included. Payday is ${nice(c.next)}, ${dn} away.${old}`, tag: `mc-${today}` }];
  if (parse(today).getUTCDay() === 5 && age >= 1) return [{ title: `New week: about ${money((c.daily || 0) * Math.min(7, days))} to spend`, body: `That's ${money(c.daily || 0)} a day for food, fuel and treats until ${days <= 7 ? 'payday' : 'next Friday'}. The balance is ${age} day${age === 1 ? '' : 's'} old, so type in today's to make it exact.`, tag: `mc-${today}` }];
  if (age >= 5 && age % 5 === 0) return [{ title: 'Update the bank balance', body: `The balance in Hitchen HQ is ${age} days old. Type in today's and the app will say whether it lasts until payday (${dn} away).`, tag: `mc-${today}` }];
  return [];
}

/* Sunday evening: the week in one message, from the bank payments (stmt docs) */
export function weekSummary(meta: any, months: Record<string, any>, bank: any, today: string) {
  if (!meta || !meta.to) return [];
  if (gap(meta.to, today) > 3) return [{ title: 'No weekly summary this week', body: `The bank payments in Hitchen HQ stop at ${nice(meta.to)}. Sign in to Nationwide in the Claude browser and run the weekly bank check-in to bring them up to date.`, tag: `mcw-${today}` }];
  const from = ymd(new Date(parse(today).getTime() - 6 * 86400000)), cats: string[] = meta.cats || [], rows: any[] = [];
  for (const [ym, doc] of Object.entries(months)) for (const r of ((doc as any).r || [])) { const d = `${ym}-${String(r[0]).padStart(2, '0')}`; if (d >= from && d <= today) rows.push({ d, m: String((doc as any).m[r[1]] || ''), out: Number(r[2]) || 0, cat: cats[r[4]] || '', z: r[5] === 1 }); }
  const outs = rows.filter(r => r.out > 0 && r.cat !== 'Between our accounts'), sum = (f: (r: any) => boolean) => outs.filter(f).reduce((s, r) => s + r.out, 0);
  const total = sum(() => true), eat = sum(r => r.cat === 'Eating out and takeaways' || r.cat === 'Food at work'), fees = outs.filter(r => r.cat === 'Zilch fees').length, zil = outs.filter(r => r.z && r.cat !== 'Zilch fees' && !/^membership$/i.test(r.m.trim()));
  const by: Record<string, number> = {}; outs.forEach(r => { by[r.cat] = (by[r.cat] || 0) + r.out; }); const top = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
  const good = !zil.length ? 'Nothing went on Zilch all week. 👏' : !fees && eat < 30 ? 'No Zilch fees and barely anything on takeaways. 👏' : !fees ? 'No Zilch snooze fees this week. 👍' : eat < 30 ? 'Hardly anything on takeaways this week. 👍' : '';
  const c = bank && bank.calc, parts = [`${money(total)} went out this week${top ? `, most of it on ${top[0].toLowerCase()} (${money(top[1])})` : ''}.`, `Eating out ${money(eat)}.`, zil.length ? `Zilch: ${zil.length} purchase${zil.length === 1 ? '' : 's'}${fees ? ` and ${fees} snooze fee${fees === 1 ? '' : 's'}` : ''}.` : '', good, c && c.over > 20 ? `${money(c.over)} outside the plan so far this pay month.` : '', c && c.next > today ? `${money(c.daily || 0)} a day until payday.` : ''];
  return [{ title: 'Your money week', body: parts.filter(Boolean).join(' '), tag: `mcw-${today}` }];
}
const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

Deno.serve(async (req: Request) => {
  const sec: Record<string, string> = {}; (await (await rest('app_secrets?select=name,value')).json()).forEach((x: any) => { sec[x.name] = x.value; });
  if (!req.headers.get('x-hhq-cron') || req.headers.get('x-hhq-cron') !== sec.notify_secret) return json({ error: 'Not allowed' }, 403);
  const body = await req.json().catch(() => ({})), lp = localParts();
  const weekly = body.mode ? body.mode === 'weekly' : lp.hour === 20 && lp.weekday === 'Sun';
  if (!weekly && lp.hour !== 7 && !body.force) return json({ skipped: true, hour: lp.hour });
  const rows = await (await rest('docs?select=data&path=eq.state/bank')).json(), bank = rows[0] && rows[0].data;
  let msgs: any[];
  if (weekly) { const st: any[] = await (await rest('docs?select=path,data&coll=eq.stmt')).json(), meta = (st.find(x => x.path === 'stmt/meta') || {}).data, months: Record<string, any> = {};
    const keep = [lp.date.slice(0, 7), ymd(new Date(parse(lp.date).getTime() - 7 * 86400000)).slice(0, 7)]; st.forEach(x => { const ym = x.path.slice(5); if (keep.includes(ym)) months[ym] = x.data; });
    msgs = weekSummary(meta, months, bank, lp.date); }
  else msgs = moneyCheck(bank, lp.date);
  if (body.dry || !msgs.length) return json({ date: lp.date, msgs, sent: [] });
  const subs = (await (await rest('push_subs?select=endpoint,sub,who,prefs')).json()).filter((s: any) => s.prefs?.money !== false);
  webpush.setVapidDetails('mailto:hitchen-hq@users.noreply.github.com', sec.vapid_public, sec.vapid_private);
  const sent: any[] = [];
  for (const s of subs) for (const m of msgs) {
    try { const r = await webpush.sendNotification(s.sub, JSON.stringify({ ...m, url: './' }), { TTL: 6 * 3600 }); sent.push({ who: s.who, status: r.statusCode }); }
    catch (e: any) { sent.push({ who: s.who, status: e.statusCode || 'error' }); if (e.statusCode === 404 || e.statusCode === 410) await rest(`push_subs?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE' }); }
  }
  return json({ date: lp.date, msgs, sent });
});
