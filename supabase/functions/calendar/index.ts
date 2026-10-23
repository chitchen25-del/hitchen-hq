// Hitchen HQ calendar: reads the family's Google Calendar secret iCal links (stored in docs/private/calendar,
// which only signed-in family members can read) and returns upcoming events.
import { readIcs } from './ics.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const auth = req.headers.get('Authorization') || '';
  // Row Level Security decides: non-family users simply get no feeds back.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/docs?path=eq.private%2Fcalendar&select=data`, { headers: { apikey: ANON, Authorization: auth } });
  if (!r.ok) return json({ error: 'Not signed in' }, 401);
  const rows = await r.json();
  const feeds: { name?: string; url?: string; who?: string }[] = (rows[0] && rows[0].data && rows[0].data.feeds) || [];
  const body = await req.json().catch(() => ({}));
  const days = Math.min(90, Math.max(1, Number(body.days) || 14));
  const from = Date.now() - 86400000, to = Date.now() + days * 86400000;
  const calendars = await Promise.all(feeds.map(async (f) => {
    const name = f.name || 'Calendar';
    try {
      const url = String(f.url || '').trim().replace(/^webcal:\/\//i, 'https://');
      if (!/^https:\/\/[^\s]+$/i.test(url)) return { name, error: 'That link should start with https://' };
      const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'HitchenHQ/1.0' } });
      if (!res.ok) return { name, error: `Google answered ${res.status}. Check the link is the secret iCal address.` };
      const text = await res.text();
      if (!/BEGIN:VCALENDAR/i.test(text)) return { name, error: 'That link isn\'t a calendar feed. Use the secret address in iCal format.' };
      return { name, who: f.who || '', events: readIcs(text, from, to) };
    } catch (e) {
      return { name, error: 'Couldn\'t reach that calendar: ' + ((e as Error).message || String(e)) };
    }
  }));
  return json({ calendars, fetchedAt: new Date().toISOString() });
});
