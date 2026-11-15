// Token Radar 03 — the risk-adjusted momentum model (radar-3).
//
// Raw 7-day growth rewards noise: a protocol that spiked +180% in a week
// looks hot, but a move that big is also the least reliable signal in the
// snapshot. This model divides momentum by realized volatility — a
// Sharpe-like ratio — then blends it with liquidity depth and holder growth:
//
//   momentum   = clamp(change_7d, -60, +200) per cent (null -> 0)
//   volatility = 8 + 0.6 * |momentum|  (points; the 7d change is the only
//                move series the snapshot carries, so a protocol that moved
//                a lot in a week is demonstrably the more volatile one)
//   sharpe     = momentum / volatility
//   sharpeScore= clamp((sharpe + 1.4) / 3.0, 0, 1)
//   liquidity  = 0.7 * log10(TVL) depth + 0.3 * chain breadth (cap 12)
//   holder     = min(age_days, 1095) / 1095 (unknown age -> 365 days)
//   riskScore  = 0.45 * sharpeScore + 0.30 * liquidity + 0.25 * holder
//   implied    = max(1, round(tvl_usd * 0.25 * (0.55 + 0.90 * riskScore)))
//
// No protocol name is ever special-cased: the same function scores every row.
// The board covers the whole watchlist (the floor) plus every rankable
// pre-token protocol below it — 40 + 186 = 226 rows on this snapshot.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base_multiple: number;
  risk_floor: number;
  risk_range: number;
  sharpe_weight: number;
  liquidity_weight: number;
  holder_weight: number;
  vol_floor: number;
  vol_slope: number;
  growth_floor: number;
  growth_cap: number;
  sharpe_shift: number;
  sharpe_span: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  risk_floor: 0.55,
  risk_range: 0.9,
  sharpe_weight: 0.45,
  liquidity_weight: 0.3,
  holder_weight: 0.25,
  vol_floor: 8,
  vol_slope: 0.6,
  growth_floor: -60,
  growth_cap: 200,
  sharpe_shift: 1.4,
  sharpe_span: 3.0,
  maturity_days: 1095,
  unknown_age_days: 365,
  chain_cap: 12,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  sharpe: number;
  volatility: number;
  liquidity: number;
  holder: number;
  risk_score: number;
  model: {
    momentum_pct: number;
    volatility: number;
    sharpe: number;
    sharpe_score: number;
    liquidity: number;
    holder: number;
    risk_score: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  sharpe: number;
  volatility: number;
  liquidity: number;
  holder: number;
  risk_score: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The risk-adjusted score of one protocol: momentum over volatility, liquidity, holder growth. */
export function riskScoreOf(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { momentum: number; volatility: number; sharpe: number; sharpeScore: number; liquidity: number; holder: number; risk: number; age: number | null; implied: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const momentum = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const volatility = model.vol_floor + model.vol_slope * Math.abs(momentum);
  const sharpe = momentum / volatility;
  const sharpeScore = clamp((sharpe + model.sharpe_shift) / model.sharpe_span, 0, 1);
  const logTvl = Math.log10(Math.max(protocol.tvl_usd, 1));
  const logFloor = Math.log10(5_000_000);
  const logCeil = Math.log10(116_100_000_000);
  const depth = clamp((logTvl - logFloor) / (logCeil - logFloor), 0, 1);
  const breadth = Math.min(protocol.chains.length, model.chain_cap) / model.chain_cap;
  const liquidity = 0.7 * depth + 0.3 * breadth;
  const ageForModel = age ?? model.unknown_age_days;
  const holder = clamp(Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days, 0, 1);
  const risk = model.sharpe_weight * sharpeScore + model.liquidity_weight * liquidity + model.holder_weight * holder;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * model.base_multiple * (model.risk_floor + model.risk_range * risk)));
  return { momentum, volatility, sharpe, sharpeScore, liquidity, holder, risk, age, implied };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const watchSet = new Set(snapshot.watchlist);
  const chosen: SnapshotProtocol[] = [];
  const taken = new Set<string>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && !taken.has(slug)) {
      taken.add(slug);
      chosen.push(p);
    }
  }
  // The early radar: every rankable pre-token protocol below the floor.
  // On this snapshot that is exactly 186, so the board is 40 + 186 = 226.
  const below: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    if (!taken.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) below.push(p);
  }
  below.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of below) {
    taken.add(p.slug);
    chosen.push(p);
  }

  const scored: { p: SnapshotProtocol; s: ReturnType<typeof riskScoreOf> }[] = [];
  for (const p of chosen) scored.push({ p, s: riskScoreOf(p, snapshot.as_of, model) });
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const rows: BoardRow[] = [];
  for (let i = 0; i < scored.length; i++) {
    const s = scored[i]!;
    rows.push({
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      watchlist: watchSet.has(s.p.slug),
      age_days: s.s.age,
      implied_value_usd: s.s.implied,
      sharpe: round4(s.s.sharpe),
      volatility: round4(s.s.volatility),
      liquidity: round4(s.s.liquidity),
      holder: round4(s.s.holder),
      risk_score: round4(s.s.risk),
      model: {
        momentum_pct: round4(s.s.momentum),
        volatility: round4(s.s.volatility),
        sharpe: round4(s.s.sharpe),
        sharpe_score: round4(s.s.sharpeScore),
        liquidity: round4(s.s.liquidity),
        holder: round4(s.s.holder),
        risk_score: round4(s.s.risk),
        age_days: s.s.age,
      },
      farm_steps: farmSteps(s.p, s.s.age, s.s.volatility).map(stepText),
    });
  }
  return rows;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  const joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (joined.length > 600) return `${joined.slice(0, 596)}...`;
  if (joined.length < 20) return `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  const tvl = p.tvl_usd;
  if (tvl >= 5_000_000_000) return 250;
  if (tvl >= 1_000_000_000) return 150;
  if (tvl >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The volatility-sized first tranche: jumpy protocols get a smaller opening position. */
function trancheFor(capital: number, volatility: number): number {
  if (volatility >= 40) return Math.round(capital * 0.4);
  if (volatility >= 25) return Math.round(capital * 0.6);
  return capital;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} (${chain}) and leave the loan open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Add $${capital} of liquidity to the main ${name} pool on ${chain} and leave it in place.`;
  if (c.includes('bridge')) return `Move $${capital} of USDC onto ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain staking asset via ${name} and hold on to the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open a single small hedged trade.`;
  if (c.includes('prediction')) return `Put $${capital} behind one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Place $${capital} in a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset ${name} issues on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  return `Put $${capital} of USDC to work in ${name} on ${chain} and leave the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * Derived from the protocol's own record (category, chains, TVL, age and
 * volatility), never from a hand-written list of names. The opening tranche
 * is sized by volatility: the jumpier the protocol, the smaller the first
 * position, with the rest added only after a week of steady activity.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, volatility: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const tranche = trancheFor(capital, volatility);
  const hold = holdDaysFor(age);
  const action = actionFor(p, tranche, chain);
  const volNote = volatility >= 40 ? 'its 7-day move was large, so this first tranche is deliberately small' : volatility >= 25 ? 'its 7-day move was middling, so open at about three-fifths of full size' : 'its 7-day move was calm, so a full opening tranche is reasonable';
  return [
    {
      text: `Set aside a fresh wallet for this farm alone, holding only the funds you mean to use, and store its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `${action} Open with $${tranche} of the $${capital} plan, because ${volNote}.`,
      cost: `$${tranche} of capital now and about $${tranche >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Do one qualifying action every week — a deposit, a borrow, a swap or a vote — and add the remaining $${capital - tranche} only after a week without a sharp reversal.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Keep the position open for at least ${hold} days so the activity lands in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before withdrawing, open the protocol's own points or rewards page and claim only through the link it publishes itself.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Record the wallet, the dates and every transaction in a farm log, so you can repeat the position or unwind it cleanly.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const trading: SnapshotProtocol[] = [];
  for (const p of snapshot.protocols) {
    if (!isPreToken(p) && p.category !== 'CEX') trading.push(p);
  }
  trading.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  const rows: LiveRow[] = [];
  for (const p of trading.slice(0, LIVE_ROWS)) {
    rows.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    });
  }
  return rows;
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    sharpe: row.sharpe,
    volatility: row.volatility,
    liquidity: row.liquidity,
    holder: row.holder,
    risk_score: row.risk_score,
    watchlist: row.watchlist,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  let early = 0;
  for (const r of board) if (!snapshot.watchlist.includes(r.slug)) early++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  const asOf = typeof o.as_of === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.as_of) ? o.as_of : null;
  if (asOf === null) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  const watchlist = o.watchlist;
  if (!Array.isArray(watchlist) || watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols: SnapshotProtocol[] = [];
  for (let i = 0; i < o.protocols.length; i++) {
    const v = o.protocols[i] as Record<string, unknown>;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const slug = typeof v.slug === 'string' ? v.slug : null;
    const name = typeof v.name === 'string' ? v.name : null;
    const tvl = typeof v.tvl_usd === 'number' && Number.isFinite(v.tvl_usd) ? v.tvl_usd : null;
    if (slug === null || name === null || tvl === null) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    const change = typeof v.change_7d === 'number' && Number.isFinite(v.change_7d) ? v.change_7d : null;
    const mcap = typeof v.mcap_usd === 'number' && Number.isFinite(v.mcap_usd) ? v.mcap_usd : null;
    const chains: string[] = [];
    if (Array.isArray(v.chains)) for (const c of v.chains) if (typeof c === 'string') chains.push(c);
    protocols.push({
      slug,
      name,
      category: typeof v.category === 'string' ? v.category : null,
      chains,
      tvl_usd: tvl,
      change_7d: change,
      mcap_usd: mcap,
      listed_at: typeof v.listed_at === 'string' ? v.listed_at : null,
      gecko_id: typeof v.gecko_id === 'string' ? v.gecko_id : null,
      symbol: typeof v.symbol === 'string' ? v.symbol : null,
    });
  }
  return { as_of: asOf, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const seen = new Set<string>();
  for (const r of board) seen.add(r.slug);
  const missing: string[] = [];
  for (const s of snapshot.watchlist) if (!seen.has(s)) missing.push(s);
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
    if (i > 0 && board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    const steps = board[i]!.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${board[i]!.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${board[i]!.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(board[i]!.implied_value_usd) || board[i]!.implied_value_usd <= 0) return `${board[i]!.slug} has implied value ${board[i]!.implied_value_usd}`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
