import type { AppState, CategorySummary, RebalanceRow, DrillItem, Category, DailySnapshot, Transaction, Currency } from './types'

export interface AllocationRow {
  symbol: string
  name: string
  currency: Currency
  price?: number           // 每股/每單位價格（防禦大桶無此欄）
  current_value_twd: number
  target_pct: number
  buy_amount_twd: number   // 建議投入金額 (TWD)
  buy_shares?: number      // 換算股數（防禦大桶無此欄）
  is_defensive: boolean    // true = 防禦大桶合計列
  is_overweight: boolean   // 目前超配，新資金不分配
}

export interface AllocationResult {
  rows: AllocationRow[]
  unallocated_twd: number  // 資金充足，填完缺口後的餘額，建議存防禦桶
  new_total_twd: number
}

export interface TWRResult {
  twr: number
  annualized: number | null
  days: number
  startDate: string
  endDate: string
  ytdReturn: number | null
  oneYearReturn: number | null
  totalGain: number | null      // 累計投資損益金額 (TWD)，排除存入/提出
  ytdGain: number | null        // 今年至今投資損益金額 (TWD)
  oneYearGain: number | null    // 近一年投資損益金額 (TWD)
  yearlyReturns:  { year: string;  return: number; startValue: number; endValue: number; gain: number }[]
  monthlyReturns: { month: string; return: number; startValue: number; endValue: number; gain: number }[]
  series: { date: string; nav: number }[]
}

export const CATEGORY_META: Record<Category, { name: string; color: string; target_pct: number }> = {
  core:        { name: '核心資產', color: '#3b82f6', target_pct: 35 },
  aggressive:  { name: '攻擊資產', color: '#ef4444', target_pct: 30 },
  global:      { name: '分散資產', color: '#10b981', target_pct: 15 },
  alternative: { name: '另類資產', color: '#f59e0b', target_pct: 5  },
  defensive:   { name: '防禦資產', color: '#6366f1', target_pct: 15 },
}

const DRILL_PALETTES: Record<Category, string[]> = {
  core:        ['#3b82f6','#60a5fa','#93c5fd','#bfdbfe'],
  aggressive:  ['#ef4444','#f87171','#fca5a5'],
  global:      ['#10b981','#34d399','#6ee7b7'],
  alternative: ['#f59e0b','#fbbf24'],
  defensive:   ['#6366f1','#818cf8','#a5b4fc','#c7d2fe','#e0e7ff'],
}

export function holdingValueTwd(shares: number, price: number, currency: 'USD' | 'TWD', fx: number): number {
  return currency === 'USD' ? shares * price * fx : shares * price
}

export function totalAssetsTwd(state: AppState): number {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const holdingsVal = holdings.reduce((sum, h) => sum + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
  const cashVal = cash_accounts.reduce((sum, c) => sum + (c.currency === 'USD' ? c.amount * fx : c.amount), 0)
  return holdingsVal + cashVal
}

// 計算全部目標%加總（用於警示是否超過/低於 100%）
export function totalTargetPct(state: AppState): number {
  const holdingTotal = state.holdings.reduce((s, h) => s + h.target_pct, 0)
  const cashTotal = state.cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  return holdingTotal + cashTotal
}

export function categorySummaries(state: AppState): CategorySummary[] {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const total = totalAssetsTwd(state)

  const catValues: Record<Category, number> = {
    core: 0, aggressive: 0, global: 0, alternative: 0, defensive: 0,
  }
  const catTargets: Record<Category, number> = {
    core: 0, aggressive: 0, global: 0, alternative: 0, defensive: 0,
  }

  for (const h of holdings) {
    catValues[h.category] += holdingValueTwd(h.shares, h.price, h.currency, fx)
    catTargets[h.category] += h.target_pct
  }
  for (const c of cash_accounts) {
    catValues.defensive += c.currency === 'USD' ? c.amount * fx : c.amount
    catTargets.defensive += c.target_pct ?? 0
  }

  return (Object.keys(CATEGORY_META) as Category[]).map(key => ({
    name: CATEGORY_META[key].name,
    key,
    value_twd: catValues[key],
    target_pct: catTargets[key],
    actual_pct: total > 0 ? (catValues[key] / total) * 100 : 0,
    color: CATEGORY_META[key].color,
  }))
}

export function categoryDrillDown(state: AppState, cat: Category): DrillItem[] {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const palette = DRILL_PALETTES[cat]
  const items: DrillItem[] = []

  if (cat === 'defensive') {
    for (const h of holdings.filter(h => h.category === 'defensive')) {
      items.push({
        id: h.symbol,
        symbol: h.symbol,
        name: h.name,
        value_twd: holdingValueTwd(h.shares, h.price, h.currency, fx),
        color: '',
      })
    }
    for (const c of cash_accounts) {
      const parts = c.bank.split(' ')
      items.push({
        id: c.bank,
        symbol: parts[0],
        name: parts.slice(1).join(' ') || '',
        value_twd: c.currency === 'USD' ? c.amount * fx : c.amount,
        color: '',
      })
    }
  } else {
    for (const h of holdings.filter(h => h.category === cat)) {
      items.push({
        id: h.symbol,
        symbol: h.symbol,
        name: h.name,
        value_twd: holdingValueTwd(h.shares, h.price, h.currency, fx),
        color: '',
      })
    }
  }

  return items
    .filter(i => i.value_twd > 0)
    .sort((a, b) => b.value_twd - a.value_twd)
    .map((item, i) => ({ ...item, color: palette[i % palette.length] }))
}

// FV = PV*(1+r)^n + PMT*((1+r)^n - 1)/r  →  solve for r
export function requiredAnnualReturn(pv: number, fv: number, n: number, pmt: number): number {
  if (n <= 0 || fv <= 0) return 0
  if (pv >= fv) return 0

  const calc = (r: number) => {
    const g = Math.pow(1 + r, n)
    if (Math.abs(r) < 1e-9) return pv * g + pmt * n
    return pv * g + pmt * (g - 1) / r
  }

  let lo = -0.2, hi = 3.0
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2
    if (calc(mid) < fv) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

export function rebalanceRows(state: AppState): RebalanceRow[] {
  const { exchange_rate: fx, holdings } = state
  const total = totalAssetsTwd(state)
  const rows: RebalanceRow[] = []

  const defSymbols = new Set(holdings.filter(h => h.category === 'defensive').map(h => h.symbol))

  for (const h of holdings.filter(h => !defSymbols.has(h.symbol))) {
    const current_value_twd = holdingValueTwd(h.shares, h.price, h.currency, fx)
    const target_value_twd = (h.target_pct / 100) * total
    const delta_twd = target_value_twd - current_value_twd
    const price_twd = h.currency === 'USD' ? h.price * fx : h.price
    rows.push({
      symbol: h.symbol,
      name: h.name,
      currency: h.currency,
      current_value_twd,
      target_pct: h.target_pct,
      target_value_twd,
      delta_twd,
      delta_usd: h.currency === 'USD' ? delta_twd / fx : undefined,
      delta_shares: price_twd > 0 ? delta_twd / price_twd : 0,
      price: h.price,
    })
  }

  // 防禦資產大桶（動態 target_pct = 防禦持倉 + 現金帳戶目標加總）
  const defHoldingsVal = holdings
    .filter(h => h.category === 'defensive')
    .reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
  const cashAccVal = state.cash_accounts.reduce((sum, c) =>
    sum + (c.currency === 'USD' ? c.amount * fx : c.amount), 0)
  const defensiveTotal = defHoldingsVal + cashAccVal

  const defensiveTargetPct =
    holdings.filter(h => h.category === 'defensive').reduce((s, h) => s + h.target_pct, 0) +
    state.cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  const defensiveTarget = (defensiveTargetPct / 100) * total

  rows.push({
    symbol: 'DEFENSIVE',
    name: '防禦資產 (含儲蓄險)',
    currency: 'TWD',
    current_value_twd: defensiveTotal,
    target_pct: defensiveTargetPct,
    target_value_twd: defensiveTarget,
    delta_twd: defensiveTarget - defensiveTotal,
  })

  return rows.sort((a, b) => b.current_value_twd - a.current_value_twd)
}

// Time-Weighted Return (TWR)
// Chains sub-period HPRs between consecutive snapshots.
// Cash flows (cash_in / cash_out) are stripped out so deposits don't inflate returns.
// HPR_i = (V_end - CF_on_end_date) / V_start
// One-entry memo cache. TwrPanel and RetirementProgressPanel both call computeTWR with
// the same state.snapshots / state.transactions / exchange_rate references in a render
// cycle; this lets the second caller reuse the first result instead of recomputing.
// State is treated immutably (commit replaces the arrays), so reference equality is a
// valid cache key — a new snapshot/transaction array means a cache miss and one recompute.
let _twrCache: {
  s: DailySnapshot[]; t: Transaction[]; fx: number; r: TWRResult | null
} | null = null

export function computeTWR(
  snapshots: DailySnapshot[],
  transactions: Transaction[],
  exchangeRate: number,
): TWRResult | null {
  if (_twrCache && _twrCache.s === snapshots && _twrCache.t === transactions && _twrCache.fx === exchangeRate) {
    return _twrCache.r
  }
  const r = computeTWRImpl(snapshots, transactions, exchangeRate)
  _twrCache = { s: snapshots, t: transactions, fx: exchangeRate, r }
  return r
}

function computeTWRImpl(
  snapshots: DailySnapshot[],
  transactions: Transaction[],
  exchangeRate: number,
): TWRResult | null {
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
  if (sorted.length < 2) return null

  // Net external cash flows (TWD). Only cash_in / cash_out are external.
  // Attach each flow to the first snapshot ON OR AFTER its date, so a flow on a
  // day without a snapshot (app not opened that day) is still stripped from the
  // return instead of being miscounted as investment P/L.
  const snapDates = sorted.map(s => s.date)
  const cfMap: Record<string, number> = {}
  for (const tx of transactions) {
    if (tx.type !== 'cash_in' && tx.type !== 'cash_out') continue
    // budget-synced transactions may lack currency; default to TWD
    const twd = (tx.currency ?? 'TWD') === 'TWD' ? tx.amount : tx.amount * exchangeRate
    const sign = tx.type === 'cash_in' ? 1 : -1
    const target = snapDates.find(d => d >= tx.date)
    if (target == null) continue // flow after the last snapshot — applied once a later snapshot exists
    cfMap[target] = (cfMap[target] ?? 0) + sign * twd
  }

  // Build NAV series (starts at 100) and chain HPRs
  const series: { date: string; nav: number }[] = [{ date: sorted[0].date, nav: 100 }]
  let nav = 100.0

  for (let i = 1; i < sorted.length; i++) {
    const vStart = sorted[i - 1].total_twd
    const vEnd = sorted[i].total_twd
    const cf = cfMap[sorted[i].date] ?? 0
    if (vStart > 0) {
      // Net-of-flow end value. A non-positive value only arises from bad/incomplete
      // cashflow data; clamp at 0 (=full loss) rather than silently skipping the
      // period, which would let inflated-positive flows bias the return upward.
      const adj = vEnd - cf
      nav *= adj > 0 ? adj / vStart : 0
    }
    series.push({ date: sorted[i].date, nav })
  }

  const twr = nav / 100 - 1
  const startDate = sorted[0].date
  const endDate = sorted[sorted.length - 1].date
  const MS_DAY = 86_400_000
  const days = Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / MS_DAY))
  const annualized = days >= 30 ? Math.pow(nav / 100, 365 / days) - 1 : null

  // Binary search: index of last element whose .date <= target (arr ascending by date).
  // Replaces the previous [...arr].reverse().find() which copied the whole array per call.
  const lastLE = <T extends { date: string }>(arr: T[], target: string): number => {
    let lo = 0, hi = arr.length - 1, res = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid].date <= target) { res = mid; lo = mid + 1 } else hi = mid - 1
    }
    return res
  }

  // Helper: get NAV at a snapshot date (nearest on or before target date)
  const navAt = (date: string): number | null => {
    const i = lastLE(series, date)
    return i >= 0 ? series[i].nav : null
  }

  // Helper: portfolio TWD value at a date (nearest snapshot on or before)
  const valueAt = (date: string): number | null => {
    const i = lastLE(sorted, date)
    return i >= 0 ? sorted[i].total_twd : null
  }
  // Net external cash flow within (fromExclusive, toInclusive]. The flow attached
  // to the period's base snapshot is treated as starting capital, not a flow.
  const netCF = (fromExclusive: string, toInclusive: string): number => {
    let sum = 0
    for (const d in cfMap) if (d > fromExclusive && d <= toInclusive) sum += cfMap[d]
    return sum
  }
  // Actual investment P/L in TWD over a period = ΔValue − net cash flow.
  const gainBetween = (fromDate: string, toDate: string): number | null => {
    const a = valueAt(fromDate), b = valueAt(toDate)
    if (a == null || b == null) return null
    return b - a - netCF(fromDate, toDate)
  }

  // YTD return
  const currentYear = endDate.slice(0, 4)
  const ytdBaseDate = `${currentYear}-01-01`
  const ytdBaseNav = navAt(new Date(new Date(ytdBaseDate).getTime() - MS_DAY).toISOString().slice(0, 10))
  const ytdReturn = ytdBaseNav != null && ytdBaseNav > 0 ? nav / ytdBaseNav - 1 : twr

  // Trailing 1-year return
  const oneYearAgoDate = new Date(new Date(endDate).getTime() - 365 * MS_DAY).toISOString().slice(0, 10)
  const oneYearBaseNav = navAt(oneYearAgoDate)
  const oneYearReturn = oneYearBaseNav != null && oneYearBaseNav > 0 && days >= 365
    ? nav / oneYearBaseNav - 1
    : null

  // Per-year & per-month breakdown.
  // `sorted` is ascending, so snapshots of the same year/month are contiguous — one
  // linear pass records each period's [first,last] index, replacing the previous
  // O(periods × N) `sorted.filter()` per period. The period's base snapshot is the
  // element immediately before its first index (= last snapshot before the period),
  // which is exactly what the old `sorted.filter(s => s.date < periodStart).at(-1)` returned.
  type PeriodGrp = { key: string; first: number; last: number }
  const yearGrp: PeriodGrp[] = []
  const monthGrp: PeriodGrp[] = []
  for (let i = 0; i < sorted.length; i++) {
    const y = sorted[i].date.slice(0, 4)
    const m = sorted[i].date.slice(0, 7)
    const yg = yearGrp[yearGrp.length - 1]
    if (!yg || yg.key !== y) yearGrp.push({ key: y, first: i, last: i }); else yg.last = i
    const mg = monthGrp[monthGrp.length - 1]
    if (!mg || mg.key !== m) monthGrp.push({ key: m, first: i, last: i }); else mg.last = i
  }

  const yearlyReturns: TWRResult['yearlyReturns'] = []
  for (const g of yearGrp) {
    const base = g.first > 0 ? sorted[g.first - 1] : sorted[g.first]
    const endSnap = sorted[g.last]
    const baseNav = navAt(base.date)
    const endNavY = navAt(endSnap.date)
    if (baseNav == null || endNavY == null || baseNav <= 0) continue
    yearlyReturns.push({
      year: g.key,
      return: endNavY / baseNav - 1,
      startValue: base.total_twd,
      endValue: endSnap.total_twd,
      gain: endSnap.total_twd - base.total_twd - netCF(base.date, endSnap.date),
    })
  }

  const monthlyReturns: TWRResult['monthlyReturns'] = []
  for (const g of monthGrp) {
    const base = g.first > 0 ? sorted[g.first - 1] : sorted[g.first]
    const endSnap = sorted[g.last]
    const baseNav = navAt(base.date)
    const endNavM = navAt(endSnap.date)
    if (baseNav == null || endNavM == null || baseNav <= 0) continue
    monthlyReturns.push({
      month: g.key,
      return: endNavM / baseNav - 1,
      startValue: base.total_twd,
      endValue: endSnap.total_twd,
      gain: endSnap.total_twd - base.total_twd - netCF(base.date, endSnap.date),
    })
  }

  // Dollar gains for summary cards (actual investment P/L, excludes flows)
  const totalGain = gainBetween(startDate, endDate)
  const ytdBaseSnapDate = new Date(new Date(ytdBaseDate).getTime() - MS_DAY).toISOString().slice(0, 10)
  // If no snapshot exists before this year, YTD spans the whole observation period
  const ytdGain = valueAt(ytdBaseSnapDate) != null ? gainBetween(ytdBaseSnapDate, endDate) : totalGain
  const oneYearGain = oneYearReturn != null ? gainBetween(oneYearAgoDate, endDate) : null

  return { twr, annualized, days, startDate, endDate, ytdReturn, oneYearReturn, totalGain, ytdGain, oneYearGain, yearlyReturns, monthlyReturns, series }
}

// Rebalance assistant: given new money (in TWD), compute how to allocate across holdings.
// Only buys, never sells. Underweight buckets get filled first; if new money exceeds all gaps,
// the remainder is reported as unallocated (suggest putting in defensive bucket).
export function computeNewMoneyAllocation(
  state: AppState,
  newMoneyTwd: number,
): AllocationResult {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const currentTotal = totalAssetsTwd(state)
  const newTotal = currentTotal + newMoneyTwd

  // ── Non-defensive holdings ──
  const defSymbols = new Set(holdings.filter(h => h.category === 'defensive').map(h => h.symbol))
  const activeHoldings = holdings.filter(h => !defSymbols.has(h.symbol))

  // ── Bucket-level gap capping ──────────────────────────────────────────────
  // Problem: an individual holding's gap can be much larger than the bucket's
  // allowed room. Filling the holding gap fully would push the whole bucket
  // over target. Solution: cap total allocation per bucket at its own gap.
  //
  // Algorithm:
  //   1. bucketGap[cat] = (sum of holdings' target_pct in cat / 100) * newTotal
  //                       - current bucket value
  //   2. If bucketGap <= 0 → whole bucket overweight, skip all holdings
  //   3. If bucketGap > 0  → compute individual gaps, then scale them down so
  //      their sum equals bucketGap (if sum > bucketGap)
  // ──────────────────────────────────────────────────────────────────────────

  // Step 1: per-bucket current value and configured target %
  const bucketCurrent:   Partial<Record<Category, number>> = {}
  const bucketTargetPct: Partial<Record<Category, number>> = {}
  for (const h of activeHoldings) {
    bucketCurrent[h.category]   = (bucketCurrent[h.category]   ?? 0) + holdingValueTwd(h.shares, h.price, h.currency, fx)
    bucketTargetPct[h.category] = (bucketTargetPct[h.category] ?? 0) + h.target_pct
  }

  // Step 2: per-bucket gap (positive = underweight)
  const bucketGap: Partial<Record<Category, number>> = {}
  for (const cat of Object.keys(bucketCurrent) as Category[]) {
    const target = ((bucketTargetPct[cat] ?? 0) / 100) * newTotal
    bucketGap[cat] = target - (bucketCurrent[cat] ?? 0)
  }

  // Step 3: per-holding raw gap (only meaningful for underweight buckets)
  const rawGapMap = new Map<string, number>()
  for (const h of activeHoldings) {
    if ((bucketGap[h.category] ?? 0) <= 0) { rawGapMap.set(h.symbol, 0); continue }
    const current = holdingValueTwd(h.shares, h.price, h.currency, fx)
    rawGapMap.set(h.symbol, Math.max(0, (h.target_pct / 100) * newTotal - current))
  }

  // Step 4: if sum of individual gaps in a bucket exceeds bucketGap, scale down
  const bucketIndSum: Partial<Record<Category, number>> = {}
  for (const h of activeHoldings) {
    if ((bucketGap[h.category] ?? 0) > 0)
      bucketIndSum[h.category] = (bucketIndSum[h.category] ?? 0) + (rawGapMap.get(h.symbol) ?? 0)
  }
  const bucketScale: Partial<Record<Category, number>> = {}
  for (const cat of Object.keys(bucketGap) as Category[]) {
    const bg = bucketGap[cat] ?? 0
    const bs = bucketIndSum[cat] ?? 0
    bucketScale[cat] = (bg > 0 && bs > bg) ? bg / bs : 1.0
  }

  // Step 5: build rows with bucket-capped buy amounts
  const rows: AllocationRow[] = activeHoldings.map(h => {
    const current_value_twd = holdingValueTwd(h.shares, h.price, h.currency, fx)
    if ((bucketGap[h.category] ?? 0) <= 0) {
      return { symbol: h.symbol, name: h.name, currency: h.currency, price: h.price,
               current_value_twd, target_pct: h.target_pct,
               buy_amount_twd: 0, is_defensive: false, is_overweight: true }
    }
    const raw            = rawGapMap.get(h.symbol) ?? 0
    const buy_amount_twd = raw * (bucketScale[h.category] ?? 1.0)
    return { symbol: h.symbol, name: h.name, currency: h.currency, price: h.price,
             current_value_twd, target_pct: h.target_pct,
             buy_amount_twd, is_defensive: false, is_overweight: raw <= 0 }
  })

  // ── Defensive bucket aggregate ──
  const defHoldingsVal = holdings
    .filter(h => h.category === 'defensive')
    .reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
  const cashAccVal = cash_accounts.reduce(
    (s, c) => s + (c.currency === 'USD' ? c.amount * fx : c.amount), 0,
  )
  const defensiveCurrent = defHoldingsVal + cashAccVal
  const defensiveTargetPct =
    holdings.filter(h => h.category === 'defensive').reduce((s, h) => s + h.target_pct, 0) +
    cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  const defensiveNewTarget = (defensiveTargetPct / 100) * newTotal
  const defensiveGap       = defensiveNewTarget - defensiveCurrent
  const defensiveOverweight = defensiveGap <= 0

  rows.push({
    symbol: 'DEFENSIVE',
    name: '防禦資產 (SGOV / 現金)',
    currency: 'TWD',
    current_value_twd: defensiveCurrent,
    target_pct: defensiveTargetPct,
    buy_amount_twd: defensiveOverweight ? 0 : defensiveGap,
    is_defensive: true,
    is_overweight: defensiveOverweight,
  })

  // ── Scale if total gaps exceed new money ──
  const sumGaps = rows.reduce((s, r) => s + r.buy_amount_twd, 0)
  let unallocated_twd = 0

  if (sumGaps <= 0) {
    // Everything is overweight — distribute proportionally to target_pct
    for (const r of rows) {
      r.buy_amount_twd = (r.target_pct / 100) * newMoneyTwd
      r.is_overweight  = false
    }
  } else if (sumGaps > newMoneyTwd) {
    // Not enough money to fill all gaps → scale proportionally
    const scale = newMoneyTwd / sumGaps
    for (const r of rows) r.buy_amount_twd = r.buy_amount_twd * scale
  } else {
    // More money than gaps → record remainder as unallocated
    unallocated_twd = newMoneyTwd - sumGaps
  }

  // ── Compute share counts (rounded to tradeable lots) ──
  // TWD stocks: 1 lot = 1000 shares (台股整張)
  // USD stocks: 1 share minimum
  // buy_amount_twd is recalculated from rounded shares so the table is self-consistent.
  for (const r of rows) {
    if (r.is_defensive || !r.price || r.price <= 0) continue
    const price_twd  = r.currency === 'USD' ? r.price * fx : r.price
    const raw_shares = r.buy_amount_twd / price_twd
    r.buy_shares     = r.currency === 'TWD'
      ? Math.floor(raw_shares / 1000) * 1000
      : Math.floor(raw_shares)
    r.buy_amount_twd = r.buy_shares * price_twd
  }

  // ── Recalculate unallocated after rounding down shares ──
  unallocated_twd = newMoneyTwd - rows.reduce((s, r) => s + r.buy_amount_twd, 0)

  // Sort: largest allocation first
  rows.sort((a, b) => b.buy_amount_twd - a.buy_amount_twd)

  return { rows, unallocated_twd, new_total_twd: newTotal }
}
