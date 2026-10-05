# service/

Offline scripts that build data the app ships with. Nothing here runs on Vercel.

## `fetch-tanks.js` — populate `data/tanks.json`

Pulls every vehicle from Wargaming's Blitz encyclopedia API and writes the shared tank table.
The page fetches `/data/tanks.json` at load, so **commit the file** — it is the one table every
browser and account uses; users layer personal overrides on top of it in the page.

```
WG_APPLICATION_ID=xxxxxxxx node service/fetch-tanks.js            # → data/tanks.json + data/tanks.meta.json
npm run tanks                                                      # same thing
node service/fetch-tanks.js --tank 9297,14129 --out /tmp/two.json  # quick smoke test
node service/fetch-tanks.js --stock                                # encyclopedia defaults only, ~10 requests
node service/fetch-tanks.js --region na                            # eu (default) · na · asia
```

You need a free application id: https://developers.wargaming.net → My applications → add a
**mobile** application (a "server" one is tied to fixed IP addresses and answers
`INVALID_APPLICATION_ID` from anywhere else). Put it in `.env` as `WG_APPLICATION_ID=…` (`.env*` is git-ignored) and
run with `node --env-file=.env service/fetch-tanks.js`, or export it in the shell.

### What one entry looks like

```json
{ "tank_id": 9297, "name": "FV215b 183", "nation": "uk", "tier": 10, "type": "AT-SPG", "premium": false,
  "hp": 2100, "gun": "183 mm L4",
  "max_roll": { "AP": 1187, "HE (prem)": 1512, "HE": 1737 },
  "alpha":    { "AP": 950,  "HE (prem)": 1210, "HE": 1390 },
  "note": "950 / 1210 / 1390 · 183 mm L4" }
```

- `max_roll` keys are in **shell-slot order** (standard, premium, HE) because the replay records
  the slot that fired, not the shell's name. `max_roll = floor(1.25 × alpha)`.
- Shell labels come from the API's shell type (`AP`, `APCR`, `HEAT`, `HE`). The API calls HESH
  `HIGH_EXPLOSIVE` too, so when a label repeats the HE slot keeps the bare `HE` and the earlier
  slot is marked `HE (prem)`; the page's HE-family check (`/HE/`) still matches both.
- `tier`, `nation`, `type`, `premium`, `hp` are there for the roadmap filters (tier thresholds,
  damage percentile within tier, HP for death inference).
- The encyclopedia's `default_profile` is the **stock** configuration. By default the script
  asks `/vehicleprofile/` for every gun × turret combination in the vehicle's module tree (a
  gun only mounts on some turrets; the API answers `INCOMPATIBLE_MODULE_IDS` for the rest, which
  is skipped silently) and scores against the **biggest-alpha gun** — the one that makes clips;
  on derp tanks like the KV-2 that is the stock gun, so "most expensive" would pick wrong — with the
  **highest HP** of any combination. The tank's other guns are kept under `guns` (name, alpha,
  max_roll) so a shot bigger than the chosen gun's max roll can be re-scored later. `--stock` skips that and marks the note `· stock`.
- A tank whose profile lookups fail is still written, from the stock profile, with a `warning`
  field — check `grep warning data/tanks.json` after a run.

### Manual entries

Some tanks are missing from the encyclopedia entirely — newer premiums such as the BZT-70 (14129),
and 9825 / 26113 return null on EU. Add
them to `data/tanks.json` by hand with `"manual": true` and they survive the next refresh —
a manual entry also overrides the API's version of the same `tank_id`.

### Rate limits and cost

A full run is roughly 1 + 9 + (guns + turrets per tank) requests — on the order of a thousand,
paced at 8 requests/second with 4 in flight (WG allows 10/s for a server application), so a
couple of minutes. `REQUEST_LIMIT_EXCEEDED`, `SOURCE_NOT_AVAILABLE`, HTTP 5xx and network
errors are retried with backoff; a bad application id is not.

### Verify on first run

`node --test test/fetch-tanks.test.js` exercises the script against a fake of the API, so the
one thing a real run should confirm is that the shells the API returns are in slot order — check
one tank you know (the FV215b 183 should read AP / HESH / HE) before trusting the whole file.

## `scrape-wotinspector.js` — source replays from WoTInspector

Walks WoTInspector's public Blitz replay list and keeps the battles worth recording: **max-damage
rolls** first, then **one-clip 100-to-0 kills**. Hits are downloaded to `out/wotinspector/replays/`
(drop that folder on the page to review them) and listed, ranked, in `out/wotinspector/candidates.json`.

```
npm run scrape -- --pages 5                     # newest 5 list pages
node service/scrape-wotinspector.js --dry-run   # show what would be downloaded, fetch nothing else
node service/scrape-wotinspector.js --overrides my-tanks.json --min-damage 1500 --filter vehicle_id=9297
```

It works in two stages so it doesn't over-analyse:

1. **Prefilter on the list summary** (tank, total damage, kills — no download). A **single-shot** gun
   is only worth a look if the battle's total damage could hold a max roll: at least `--min-damage`
   (default **1000**) and at least `--min-roll-pct` (default **95 %**) of the gun's smallest shell
   max roll. A tank that can mount a **clip** gun is also kept when it killed something.
2. **Analyse the candidates**: fetch the replay's details (the gun actually mounted, every player's
   tank and entity id) and the `.wotbreplay`, parse it with the page's parser (`lib/replay-parser.js`)
   and score it with `lib/highlights.js`. A replay is a hit when its best shot is ≥ `--min-roll-pct` of
   the max roll of the shell it fired, or it has a one-clip 100-to-0.

**Gun type.** `data/tanks.json` (WG's encyclopedia) is trusted: `gun_type` is `autoloader` when the gun's
`clip_capacity` > 1, with `clip` and `clip_reload`; alternates under `guns` carry the same fields and
their `gun_id`, so the gun WoTInspector says was mounted is the one scored. The tank's **override wins**
over both: a `"manual": true` entry in the table, or an entry in `--overrides` (the page's personal
overrides — "Copy JSON"), that has `gun_type` / `clip`. Overrides are merged onto the shared entry, so
`{"tank_id": 1121, "gun_type": "autoloader", "clip": 4}` is enough. A tank with no `gun_type` (a table
built before this field existed) is treated as single-shot until the table is regenerated with `npm run tanks`.

**One-clip 100-to-0.** An enemy that took no damage from anyone before your first hit on it, destroyed by
you with at most `clip` direct hits, no gap between them as long as a clip reload (`clip_reload`, or
`--max-gap` seconds, default 8, when unknown), and nobody else damaging it in between (your own fire
ticks are fine). When the victim's tank HP is known it must have been at full HP when you found it
(`verified: true`); otherwise the moment is listed as unverified.

Every replay looked at is remembered in `out/wotinspector/seen.json`, so a re-run only fetches the list
pages. The default pace is one request every 4 s (`--rps 0.25`), `429 Retry-After` is honoured, and
requests carry a `blitzclip-content-finder` user agent — WoTInspector is a community site, keep it gentle.
