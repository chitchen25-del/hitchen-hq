# Hitchen HQ

The Hitchen family app: work days and call-outs, Viki's shifts and overtime pay, bills, budget, savings goals and the car. It installs on a phone's home screen and keeps working offline with the last saved copy.

## How it works

- `index.html`: the whole app.
- `manifest.webmanifest`, `sw.js`, `icons/`: what makes it installable as an app (PWA).
- Data lives in the Supabase project **hitchen-hq**, in one table called `docs`. Only signed-in family accounts (listed in the `allowed_users` table) can read or change it. This repository holds code only, no family data.

## Install on a phone

1. Open the GitHub Pages address in Safari (iPhone) or Chrome (Android).
2. iPhone: Share → Add to Home Screen. Android: menu → Install app.
3. Open it from the home screen and sign in with your username and password. Change your password any time in Settings (the gear icon).

## The girls

Family → Aalish / Grayse: Isle of Man school term dates (public DESC dates in `SCHOOL_YEARS` in `index.html`; add next year's each summer), activities with drop-off and pick-up, childcare gaps (days the girls are off school while both parents work, with who's covering), pocket money and phone, jobs and stars, savings pots, achievements and reports, and height and weight. "Hand her the phone" opens her own corner (jobs, savings, wishes); press and hold at the bottom to leave it. Their figures live in the private database (`kids/<name>`, `state/cover`), never in this repository.

## Dinners

Money → This month → Dinners plans the week's tea, saves meals with their ingredients, adds them to the shopping list and compares the cost with the week's food shop (`meals/main`).

## Year in review

Settings → Year in review, and on Home from mid-December to January: swipe through the family's year.

## Chris's hours

Family → Chris → Hours & leave shows Chris's hours balance (Saturdays in, minus time short), holiday left and a link to the report for his manager. Tap Log time to add a Saturday or a short day. The figures are stored in the private database as `state/hours`, never in this code.

## Car trips

Export your journeys from the Land Rover app (each export holds up to 300 trips, so do a few) and tap Import car trips on Chris → Hours & leave. Duplicates are ignored. The import fills in work days on the calendar, adds Saturdays and short days to the hours balance, lists weekdays the car didn't go to work so you can say what they were, and keeps a day-by-day car log. The work location and the log are stored privately (`settings.chrisWork`, `state/carlog`). Car → Fuel and costs shows what the driving really costs from that log. The Sunday evening notification on the first Sunday of the month gives Chris his hours balance and nudges for a new export when the log is a month old.

## Holiday plans

A suggested holiday plan (`state/leaveplan`) shows on Leave → Chris for its year, with a year-at-a-glance strip and a Book button for each block.

## Trip drive plans

A trip can carry `drive` (day-by-day legs) and `alerts`; they show as The drive on the trip, with a fuel estimate.

## Viki's pay

Her pay rates are stored only in the private database (never in this repository) and can be changed in the app: Work → Viki → Viki's rates → Edit. On call and call-outs are paid on the 25th of the following month. The on-call claim table follows the layout of her claim form.

## Google Calendar

Home shows the next 7 days from linked Google Calendars. Add links in Settings → Google Calendar links, using each calendar's "Secret address in iCal format". The links are stored in the private database. The Supabase Edge Function `calendar` (source in `supabase/functions/calendar/`) reads them; only signed-in family members can use it.

## Notifications

Each phone turns them on in Settings (on an iPhone the app must be added to the Home Screen first). The Supabase Edge Function `notify` (source in `supabase/functions/notify/`) is called every hour by a `pg_cron` job and sends at 7am, 7pm and Sunday 7pm Isle of Man time. Each phone can also turn on the girls' reminders: pocket money day, clubs, school holidays and back to school, childcare gaps, dinners and measuring. Push keys and the cron secret live in the `app_secrets` table, which the app can't read.

## Documents

Car documents are stored in the private Supabase Storage bucket `family-files`, readable only by the family. Once opened they're kept on the phone for offline use.

## Bank statements

Money → Budget → Import statement reads a CSV file downloaded from online banking. Isle of Man bank accounts aren't covered by Open Banking, so live bank feeds aren't available.

## Backups

Settings → Download a backup saves everything in the app as one file (on a phone it opens the share sheet, so it can go to iCloud Drive or Google Drive). Do it every so often and before big changes.

## Yearly update

Each March, after the Manx budget, the app needs that tax year's income tax and NI figures (`IOM_YEARS` in `index.html`), the next year's official bank holidays including TT race day (`BANK_HOLS`), and Viki's confirmed pay award (in the private database). Home shows a notice when any of these are missing. Years without official bank holidays use the fixed rules, without TT day.

## Checks

`node tests/pay.test.mjs` checks the take-home, pension, NI and tax engine, pay rises, paydays and bank holidays against the Isle of Man rules, using made-up figures. GitHub runs it on every push (Actions → Pay rules check).

## Usernames

Sign-in uses a username and password. Behind the scenes each username is stored as `<username>@hitchen.example.com`; that address is never emailed. Current accounts: `chris`, `viki`.

## Adding someone

In Supabase, open the SQL editor for the hitchen-hq project and run (swap in their username and a temporary password):

```sql
do $$
declare uname text := 'newname'; pw text := 'temporary-password'; uid uuid := gen_random_uuid(); em text;
begin
  em := uname || '@hitchen.example.com';
  insert into public.allowed_users (email) values (em);
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
    extensions.crypt(pw, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('username', uname), now(), now(), '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
  values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
end $$;
```

To reset a forgotten password: `update auth.users set encrypted_password = extensions.crypt('new-password', extensions.gen_salt('bf')) where email = 'chris@hitchen.example.com';`

## Updating the app

Edit `index.html`, then bump the `CACHE` name in `sw.js` (for example `hitchen-hq-v2`) so installed copies pick up the change.
