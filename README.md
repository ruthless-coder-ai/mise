# Mise — a daily plate ledger

Photograph a meal, get an estimate of its calories and nutrients, and see it charted against the day's targets.

No build step, no framework, no server required. Four files.

```
index.html
styles.css
app.js
manifest.webmanifest       ← home-screen install
icon-180/192/512.png
functions/api/analyze.js   ← optional, only used if a server-side key is set
```

## Run it

```bash
cd "mise" && python3 -m http.server 4321
```

Then open http://localhost:4321. Opening `index.html` directly with `file://` also works, but a local server behaves more like the deployed site.

Press **Load a sample** to see the whole interface working with canned data — no key needed.

## Getting real analyses

The photo is read by Google's **Gemini API**, which has a free tier.

1. Create a key at https://aistudio.google.com/apikey
2. Open **Targets & setup** in the app and paste it in.

The model defaults to `gemini-3.6-flash`. Google retires model ids periodically and starts refusing them — when that happens the error says which id to move to, and you change it in the **Model** field under the same settings sheet. Ids in `RETIRED_MODELS` (in `app.js`) are auto-upgraded to the current default on load, so a device that saved a dead id doesn't stay stuck on it.

The key is kept in this browser's `localStorage` and sent straight to Google — it never passes through anyone else's server. That's fine for personal use on your own machine.

## Deployed

Live at **https://mise-1fi.pages.dev** (Cloudflare Pages, project `mise`).

```bash
npx wrangler pages deploy . --project-name mise --branch main --commit-dirty=true
```

The URL is public but **deliberately has no server-side key**, so `/api/analyze` answers 501 and a stranger who finds it cannot spend your Gemini quota. Each device you use holds its own key in its own `localStorage`.

On a phone, use **Add to Home Screen** — the manifest makes it open full-screen without browser chrome. Note that iOS gives a home-screen app its own storage separate from Safari, so add the key *inside the installed app*, not in Safari beforehand.

### Switching to a server-side key later

If you ever want the key held by Cloudflare instead of by each browser — worth doing if you also put an access policy in front of the site:

```bash
npx wrangler pages secret put GEMINI_API_KEY --project-name mise
```

Nothing in the code needs changing. The frontend probes `/api/analyze` on load and on every request: if it answers, the settings key field is ignored; if it 501s, the app falls back to the local key.

Don't set that secret while the URL is open to the world, or anyone who finds it is spending your quota.

## The targets

Set for a 29-year-old woman, 60 kg, and — this one is an assumption, correct it in settings — 163 cm, lightly active.

| | |
|---|---|
| Energy | Mifflin–St Jeor BMR × activity factor |
| Protein | 1.2 g per kg body weight |
| Fat | 30% of energy |
| Carbs | the remainder |
| Fibre | 14 g per 1000 kcal |
| Free sugar | ceiling at 10% of energy (WHO) |
| Saturated fat | ceiling at 10% of energy |
| Sodium | ceiling at 2000 mg (WHO) |

With the defaults that lands at roughly **1800 kcal · 72 g protein · 240 g carbs · 60 g fat · 25 g fibre**, sugar capped at 45 g and saturated fat at 20 g. Change age, weight, height, activity or goal and every ring recalculates.

Free sugar means added sugar — the sugar in whole fruit and plain milk doesn't count against the ceiling.

## Data

Everything stays in `localStorage`: your profile, your key, and one entry list per day (`mise.log.2026-08-17`). Clearing site data clears the lot. There is no account and nothing is uploaded except the photo itself, at the moment you ask for an analysis.

## Honest limits

Portion size from a single photo is genuinely hard — a bowl of rice can be 150 g or 300 g and look nearly identical. Calories from a photo typically land within about ±20–25% for simple plated food and worse for mixed dishes, soups, and anything where oil or sauce is hidden. The portion slider exists for exactly that: adjust it to what you actually ate before logging.

Use this for direction, not for precision. It is not medical advice.
