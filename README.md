# Hitchen HQ

The Hitchen family app: work days and call-outs, Viki's shifts and overtime pay, bills, budget, savings goals and the car. It installs on a phone's home screen and keeps working offline with the last saved copy.

## How it works

- `index.html`: the whole app.
- `manifest.webmanifest`, `sw.js`, `icons/`: what makes it installable as an app (PWA).
- Data lives in the Supabase project **hitchen-hq**, in one table called `docs`. Only signed-in people whose email is on the family list (the `allowed_users` table) can read or change it. This repository holds code only, no family data.

## Install on a phone

1. Open the GitHub Pages address in Safari (iPhone) or Chrome (Android).
2. iPhone: Share → Add to Home Screen. Android: menu → Install app.
3. Open it from the home screen. First time: "Create an account" with your family-list email and a password. After that, "Sign in".

## Adding someone to the family list

In Supabase, open the SQL editor for the hitchen-hq project and run:

```sql
insert into public.allowed_users (email) values ('their.email@example.com');
```

## Updating the app

Edit `index.html`, then bump the `CACHE` name in `sw.js` (for example `hitchen-hq-v2`) so installed copies pick up the change.
