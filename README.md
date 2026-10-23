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
