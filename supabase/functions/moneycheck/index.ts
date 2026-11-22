// Hitchen HQ money warning. Run hourly by pg_cron; at 07:00 Isle of Man time it reads the Money check summary the app
// keeps in state/bank and warns the phones when the account is running short before payday.
// Red warns every morning, amber every third morning, and a nudge goes out when the balance is getting old.
import webpush from 'npm:web-push@3.6.7';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TZ = 'Europe/Isle_of_Man';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const rest = (path: string, init: RequestInit = {}) => fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
function localParts(d = new Date()) {
  const p: Record<string, string> = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const gap = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (d: string) => `${DOWS[parse(d).getUTCDay()]} ${Number(d.slice(8))} ${MON3[Number(d.slice(5, 7)) - 1]}`;
const money = (n: number) => '£' + Math.round(Math.abs(n)).toLocaleString('en-GB');

export function moneyCheck(bank: any, today: string) {
  const c = bank && bank.calc; if (!c || !c.next || today >= c.next) return [];
  const days = gap(today, c.next), age = gap(c.asOf || c.on || today, today), dn = `${days} day${days === 1 ? '' : 's'}`;
  const old = age >= 3 ? ` The balance is ${age} days old, so update it in the app for a true picture.` : '';
  if (c.level === 'red') return [{ title: `Money warning: ${money(c.free)} short before payday`, body: `${c.runOut && c.runOut > today ? `On the current plan the account runs out around ${nice(c.runOut)}. ` : ''}Payday is ${nice(c.next)}, ${dn} away. Open Money check to see what's still to go out.${old}`, tag: `mc-${today}` }];
  if (c.level === 'amber' && days % 3 === 0) return [{ title: `Money is tight: ${money(c.free)} spare until payday`, body: `Everything planned is covered, with very little left over. Payday is ${nice(c.next)}, ${dn} away.${old}`, tag: `mc-${today}` }];
  if (age >= 5 && age % 5 === 0) return [{ title: 'Update the bank balance', body: `The balance in Hitchen HQ is ${age} days old. Type in today's and the app will say whether it lasts until payday (${dn} away).`, tag: `mc-${today}` }];
  return [];
}

Deno.serve(async (req: Request) => {
  const sec: Record<string, string> = {}; (await (await rest('app_secrets?select=name,value')).json()).forEach((x: any) => { sec[x.name] = x.value; });
  if (!req.headers.get('x-hhq-cron') || req.headers.get('x-hhq-cron') !== sec.notify_secret) return json({ error: 'Not allowed' }, 403);
  const body = await req.json().catch(() => ({})), lp = localParts();
  if (lp.hour !== 7 && !body.force) return json({ skipped: true, hour: lp.hour });
  const rows = await (await rest('docs?select=data&path=eq.state/bank')).json();
  const msgs = moneyCheck(rows[0] && rows[0].data, lp.date);
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
