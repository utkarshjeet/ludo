# Ludo with Friends

Tiny Ludo game: plain HTML/CSS/JS, no build step, no framework (~30 KB total).
Offline mode needs nothing. Online rooms use Supabase (free tier is plenty).

## Modes
- **Play offline**: one phone, pass it around. Each color can be Player / Bot / Off.
- **Online room**: tap *Create room*, share the 4-letter code (or the invite link), friends tap *Join*.
  2–4 players, host taps *Start*. Refreshing or reopening the link puts you back in your seat.
  If someone disappears, the host gets a *Skip* button after 20 seconds.

## Rules used
Dice is crypto-random. Need a 6 to leave the yard. A 6, cutting someone, or reaching home gives another roll.
Three 6s in a row = turn lost. Colored start squares and ★ squares are safe. Exact roll needed to reach home.
If only one move is possible it is played automatically.

## 1. Supabase setup (for online mode, ~2 min)
1. Create a project at supabase.com.
2. SQL Editor → New query → paste `supabase.sql` → Run.
3. Project Settings → API → copy **Project URL** and **anon public** key into `config.js`.

### What is safe to push to GitHub
- `config.js` with the **Project URL + anon (public) key**: safe. That key is meant to be public, since every
  player's browser downloads it anyway. Vercel needs this file in the repo for online mode to work.
- **Never push**: the `service_role` key, your database password, or any `.env` file. This game never needs them.
- Because the `rooms` table is open to the anon key, someone who has the key could mess with room data.
  That's fine for a friends-only game, but don't store anything private in this Supabase project.
- Free Supabase projects pause after about a week with no activity. Open the dashboard and click *Restore* if online stops working.

## 2. Deploy to Vercel
- Easiest: `npx vercel` from inside this `ludo` folder (framework: **Other**, no build command, output = `.`).
- Or push to GitHub, import in Vercel, and set **Root Directory** to `ludo`.

## Run locally
```
python -m http.server 5190
```
then open http://localhost:5190
