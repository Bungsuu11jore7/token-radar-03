# Token Radar 03 — risk-adjusted momentum (radar-3)

A token launch radar for make.fun's `token-radar-01` competition. It reads the
sealed DefiLlama snapshot (`/input/snapshot.json`), scores every pre-token
protocol, and writes a ranked board plus a static dashboard to `/output`.

## Method: risk-adjusted momentum

Most radars rank by TVL or by raw 7-day growth. Both reward noise: a protocol
that spiked +180% in a week looks hot, but a spike that big is also the least
reliable signal in the file. This entry divides momentum by realized
volatility — a Sharpe-like ratio — then blends it with liquidity depth and
holder growth:

- **momentum** = `change_7d`, clamped to [-60, +200]%
- **volatility** = `8 + 0.6 * |momentum|` — the snapshot's only move series is
  the 7-day change, so a protocol that moved a lot in a week is demonstrably
  the more volatile one; the 8-point floor stops flat protocols from scoring
  an infinite ratio
- **sharpe** = `momentum / volatility`, scored to 0..1
- **liquidity** = log10(TVL) depth (70%) + chain breadth, capped at 12 chains (30%)
- **holder growth** = age since first listing, capped at 3 years — the longer a
  protocol has run with no token, the more users its launch would reward;
  unknown age counts as 365 days
- **risk score** = `0.45 * sharpe + 0.30 * liquidity + 0.25 * holder`
- **implied value** = `round(TVL * 0.25 * (0.55 + 0.90 * risk score))`

No protocol name is ever special-cased: one function scores every row.

## Board

226 rows: all 40 watchlist protocols (TVL >= $50M, no token on record) plus
all 186 rankable pre-token protocols below the floor. Live-token protocols are
kept apart in a separate view with their market caps shown, never mixed into
the ranking. Each row carries a 6-step farm plan derived from the protocol's
own category, chains, TVL, age and volatility — including a volatility-sized
first tranche, so a hot but jumpy protocol gets a smaller opening position.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
node gate-check.mjs   # from this directory; exit 0 = all gate rows pass
```

Node 22, standard library only. Deterministic: two runs write identical bytes.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes `board.json`, `data.js`,
  copies `dashboard/` and `screenshots/`, writes `dossier.json`
- `lib/model.ts` — the risk-adjusted model, farm plans, snapshot parsing
- `vendor/makefun-board.ts` — make.fun's dossier library (kit copy)
- `dashboard/` — static page, no network: `index.html`, `app.css`, `app.js`
- `screenshots/` — board, detail view, filtered view (1280x800 JPEG)
