import type { AppState, CategorySummary, RebalanceRow, DrillItem, Category, CategoryDef, DailySnapshot, Transaction, Currency, Holding } from './types'

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

// 五桶的唯一真相來源（single source of truth）。CATEGORY_META 與 DEFAULT_PALETTES
// 皆由此衍生，避免重複；舊存檔沒帶 categories 時也會 fallback 到這份。
export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: 'core',        name: '核心資產', color: '#3b82f6', target_pct: 35, order: 0, palette: ['#3b82f6','#60a5fa','#93c5fd','#bfdbfe'] },
  { id: 'aggressive',  name: '攻擊資產', color: '#ef4444', target_pct: 30, order: 1, palette: ['#ef4444','#f87171','#fca5a5'] },
  { id: 'global',      name: '分散資產', color: '#10b981', target_pct: 15, order: 2, palette: ['#10b981','#34d399','#6ee7b7'] },
  { id: 'alternative', name: '另類資產', color: '#f59e0b', target_pct: 5,  order: 3, palette: ['#f59e0b','#fbbf24'] },
  { id: 'defensive',   name: '防禦資產', color: '#6366f1', target_pct: 15, order: 4, is_cash: true, palette: ['#6366f1','#818cf8','#a5b4fc','#c7d2fe','#e0e7ff'] },
]

// 靜態預設五桶 meta（衍生自 DEFAULT_CATEGORIES）。尚未接 state 的元件先用這份，
// 因為 step 1 的 state.categories 必等於預設值，所以畫面與數字完全不變。
export const CATEGORY_META: Record<Category, { name: string; color: string; target_pct: number }> =
  Object.fromEntries(
    DEFAULT_CATEGORIES.map(c => [c.id, { name: c.name, color: c.color, target_pct: c.target_pct }])
  ) as Record<Category, { name: string; color: string; target_pct: number }>

const DEFAULT_PALETTES: Record<Category, string[]> =
  Object.fromEntries(
    DEFAULT_CATEGORIES.map(c => [c.id, c.palette ?? [c.color]])
  ) as Record<Category, string[]>

// 取得目前生效的分類清單（依 order 排序）；舊資料沒帶就用預設五桶。
export function getCategories(state: AppState): CategoryDef[] {
  const cats = state.categories?.length ? state.categories : DEFAULT_CATEGORIES
  return [...cats].sort((a, b) => a.order - b.order)
}

// 收納現金帳戶的桶（預設 defensive）。
function cashCategoryId(cats: CategoryDef[]): Category {
  return (cats.find(c => c.is_cash)?.id ?? 'defensive') as Category
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

// ── 緊急備用金 ──────────────────────────────────────────────────────────────
// 一筆釘住的絕對金額，完全不參與配置比例計算：其他資產的目標% 加總仍是 100%，
// 只是分母改成「可配置資產」＝ 總資產 − 已到位的備用金。
//
// ⚠️ 關鍵：這筆錢實際躺在指定的現金帳戶裡，所以除了縮分母，還必須從現金桶的
// 現值扣掉同一筆。只做前者的話現金桶會虛胖這筆錢，再平衡會反過來叫你賣防禦資產。
//
// 未設定（emergency_fund 不存在 / target 為 0 / 沒指定帳戶）時三個函式一律回 0 /
// 原值，所有下游計算與加入此功能前逐位元相同。

// 認列帳戶的餘額合計（TWD）。指定帳戶不存在就當 0，不會炸。
export function emergencyFundSourceTwd(state: AppState): number {
  const ef = state.emergency_fund
  if (!ef?.account_ids?.length) return 0
  const fx = state.exchange_rate
  const ids = new Set(ef.account_ids)
  return state.cash_accounts
    .filter(c => ids.has(c.id))
    .reduce((s, c) => s + (c.currency === 'USD' ? c.amount * fx : c.amount), 0)
}

// 實際到位的備用金 = min(想備的金額, 認列帳戶真的有的錢)。
// 帳戶被花掉時自動縮水（而不是算出負的現金桶），缺口交給 UI 顯示警告。
export function emergencyFundTwd(state: AppState): number {
  const target = Math.max(0, state.emergency_fund?.target_twd ?? 0)
  if (target <= 0) return 0
  return Math.min(target, Math.max(0, emergencyFundSourceTwd(state)))
}

// 可配置資產 = 總資產 − 已到位的備用金。所有比例計算的分母都用這個，
// 而「總資產」卡片仍顯示 totalAssetsTwd（完整淨值），兩者刻意分開。
export function investableTotalTwd(state: AppState): number {
  return Math.max(0, totalAssetsTwd(state) - emergencyFundTwd(state))
}

// 防禦大桶合計（防禦持倉 + 所有現金帳戶 − 已到位的備用金），TWD 計。
// rebalanceRows 與 computeNewMoneyAllocation 共用，避免兩處算法各自漂移。
export function defensiveBucketValueTwd(state: AppState): number {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const defHoldingsVal = holdings
    .filter(h => h.category === 'defensive')
    .reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
  const cashAccVal = cash_accounts.reduce(
    (s, c) => s + (c.currency === 'USD' ? c.amount * fx : c.amount), 0,
  )
  return Math.max(0, defHoldingsVal + cashAccVal - emergencyFundTwd(state))
}

// 按計價幣別拆分資產：台幣資產用台幣原值加總、美元資產用美元原值加總。
// usdInTwd 是美元資產的台幣折算值，twd + usdInTwd 必然等於 totalAssetsTwd（可對帳）。
export function assetsByCurrency(state: AppState): { twd: number; usd: number; usdInTwd: number } {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  let twd = 0
  let usd = 0
  for (const h of holdings) {
    if (h.currency === 'USD') usd += h.shares * h.price
    else twd += h.shares * h.price
  }
  for (const c of cash_accounts) {
    if (c.currency === 'USD') usd += c.amount
    else twd += c.amount
  }
  return { twd, usd, usdInTwd: usd * fx }
}

// 計算全部目標%加總（用於警示是否超過/低於 100%）
export function totalTargetPct(state: AppState): number {
  const holdingTotal = state.holdings.reduce((s, h) => s + h.target_pct, 0)
  const cashTotal = state.cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  return holdingTotal + cashTotal
}

export function categorySummaries(state: AppState): CategorySummary[] {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  // 分母＝可配置資產（已扣掉緊急備用金），這樣各桶 actual_pct 加總才會是 100%
  const total = investableTotalTwd(state)
  const reserve = emergencyFundTwd(state)
  const cats = getCategories(state)
  const cashId = cashCategoryId(cats)

  const catValues: Record<string, number> = {}
  const catTargets: Record<string, number> = {}
  for (const c of cats) { catValues[c.id] = 0; catTargets[c.id] = 0 }

  for (const h of holdings) {
    catValues[h.category] = (catValues[h.category] ?? 0) + holdingValueTwd(h.shares, h.price, h.currency, fx)
    catTargets[h.category] = (catTargets[h.category] ?? 0) + h.target_pct
  }
  for (const c of cash_accounts) {
    catValues[cashId] = (catValues[cashId] ?? 0) + (c.currency === 'USD' ? c.amount * fx : c.amount)
    catTargets[cashId] = (catTargets[cashId] ?? 0) + (c.target_pct ?? 0)
  }
  // 備用金躺在現金帳戶裡，上面那圈已經把它加進現金桶了，這裡扣回來
  if (reserve > 0) catValues[cashId] = Math.max(0, (catValues[cashId] ?? 0) - reserve)

  return cats.map(c => ({
    name: c.name,
    key: c.id,
    value_twd: catValues[c.id] ?? 0,
    target_pct: catTargets[c.id] ?? 0,
    actual_pct: total > 0 ? ((catValues[c.id] ?? 0) / total) * 100 : 0,
    color: c.color,
  }))
}

export function categoryDrillDown(state: AppState, cat: Category): DrillItem[] {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  const def = getCategories(state).find(c => c.id === cat)
  const palette = def?.palette ?? DEFAULT_PALETTES[cat] ?? [def?.color ?? '#6b7280']
  const isCash = def?.is_cash ?? (cat === 'defensive')
  const items: DrillItem[] = []

  for (const h of holdings.filter(h => h.category === cat)) {
    items.push({
      id: h.symbol,
      symbol: h.symbol,
      name: h.name,
      value_twd: holdingValueTwd(h.shares, h.price, h.currency, fx),
      color: '',
    })
  }
  if (isCash) {
    // 備用金躺在認列帳戶裡但不屬於這個桶，從那些帳戶按比例扣掉，
    // 這樣 drill-down 各項加總才會等於 categorySummaries 給的桶現值。
    const reserve = emergencyFundTwd(state)
    const reserveIds = new Set(state.emergency_fund?.account_ids ?? [])
    const sourceTotal = emergencyFundSourceTwd(state)
    for (const c of cash_accounts) {
      const parts = c.bank.split(' ')
      const raw = c.currency === 'USD' ? c.amount * fx : c.amount
      const deduct =
        reserve > 0 && sourceTotal > 0 && reserveIds.has(c.id)
          ? reserve * (raw / sourceTotal)
          : 0
      items.push({
        id: c.bank,
        symbol: parts[0],
        name: parts.slice(1).join(' ') || '',
        value_twd: Math.max(0, raw - deduct),
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
  // 分母＝可配置資產（已扣掉緊急備用金）；備用金是釘住的絕對金額，不參與比例
  const total = investableTotalTwd(state)
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
      delta_usd: h.currency === 'USD' && fx > 0 ? delta_twd / fx : undefined,
      delta_shares: price_twd > 0 ? delta_twd / price_twd : 0,
      price: h.price,
    })
  }

  // 防禦資產大桶（動態 target_pct = 防禦持倉 + 現金帳戶目標加總）
  const defensiveTotal = defensiveBucketValueTwd(state)

  const defensiveTargetPct =
    holdings.filter(h => h.category === 'defensive').reduce((s, h) => s + h.target_pct, 0) +
    state.cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  const defensiveTarget = (defensiveTargetPct / 100) * total

  const cashName = getCategories(state).find(c => c.is_cash)?.name ?? '防禦資產'
  rows.push({
    symbol: 'DEFENSIVE',
    name: `${cashName} (含儲蓄險)`,
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
  // dividend is portfolio income (not external) and must NOT appear here.
  // Attach each flow to the first snapshot ON OR AFTER its date, so a flow on a
  // day without a snapshot (app not opened that day) is still stripped from the
  // return instead of being miscounted as investment P/L.
  const snapDates = sorted.map(s => s.date)

  // Feature 7: use snapshot-time FX when available; fall back to current rate.
  // Snapshots taken after this fix will carry exchange_rate; older ones won't.
  const fxBySnapDate: Record<string, number> = {}
  for (const s of sorted) {
    if (s.exchange_rate && s.exchange_rate > 0) fxBySnapDate[s.date] = s.exchange_rate
  }

  const cfMap: Record<string, number> = {}
  // 交易「實際進到看板」的日期：看板存檔當下就把交易套到現況（未來日期也是）→ 取交易日與記錄日較早的那個。
  // 跟後端績效自我檢查（lib.rs effective_date）同一套規則
  const effectiveDate = (tx: Transaction): string => {
    let rec = tx.recorded_at
    if (!rec && /^\d{13}$/.test(tx.id)) rec = new Date(Number(tx.id) + 8 * 3600_000).toISOString().slice(0, 10)
    return rec && rec < tx.date ? rec : tx.date
  }
  // 新增現金帳戶（帶期初金額）、新增持倉：是「把原本就有的錢開始記進來」，不是賺來的 → 跟 cash_in 一樣當成流入。
  // 但要掛在它「第一次出現在快照上」的那天：補登過去日期時，回填不會在歷史快照建出新帳戶／新持倉，
  // 錢是到記錄當天才出現在快照上（掛在交易日會讓那段報酬變成 −100%）
  const shows = (s: DailySnapshot, key: string) => key in (s.holdings_twd ?? {}) || key in (s.holdings_shares ?? {})
  const newMoneyTarget = (tx: Transaction): string | undefined => {
    const key = tx.type === 'new_position' ? tx.symbol : tx.bank
    if (!key) return undefined
    const idx = sorted.findIndex(s => s.date >= effectiveDate(tx))
    if (idx < 0) return undefined
    const j = sorted.findIndex((s, i) => i >= idx && shows(s, key))
    if (j < 0) return undefined
    // 帳戶早就存在（第一次出現的那張的前一張就有）：前端的 new_cash_account 什麼都不做，不是新的錢。
    // 要在「出現的那張」判斷，不是交易日之前：刪掉後用同名補登、日期填在刪除前，仍是新的錢
    if (tx.type === 'new_cash_account' && j > 0 && shows(sorted[j - 1], key)) return undefined
    return sorted[j].date
  }
  for (const tx of transactions) {
    const isNew = tx.type === 'new_cash_account' || tx.type === 'new_position'
    if (tx.type !== 'cash_in' && tx.type !== 'cash_out' && !isNew) continue
    const target = isNew ? newMoneyTarget(tx) : snapDates.find(d => d >= effectiveDate(tx))
    if (target == null) continue // flow after the last snapshot — applied once a later snapshot exists
    const txFx = fxBySnapDate[target] ?? exchangeRate
    const native = tx.type === 'new_position' ? (tx.shares ?? 0) * (tx.price ?? 0) : tx.amount
    // budget-synced transactions may lack currency; default to TWD
    const twd = (tx.currency ?? 'TWD') === 'TWD' ? native : native * txFx
    const sign = tx.type === 'cash_out' ? -1 : 1
    cfMap[target] = (cfMap[target] ?? 0) + sign * twd
  }

  // 找不到對應交易的變動（帳戶帶餘額消失、歷史被改…）不算賺賠：當成資金進出排除（報酬率與損益金額都是），
  // 績效頁另外標出。第一張快照之前沒有區間，不適用
  for (let i = 1; i < sorted.length; i++) {
    const u = (sorted[i].unexplained ?? []).reduce((sum, x) => sum + x.twd, 0)
    if (u !== 0) cfMap[sorted[i].date] = (cfMap[sorted[i].date] ?? 0) + u
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

// ── Feature 1: Cost basis + unrealized P/L ─────────────────────────────────
// Weighted-average cost (WAC) per holding, derived from buy / new_position / sell history.
// dividend does not affect cost basis; sell reduces the WAC pool proportionally.
export interface CostBasis {
  avgCost: number        // per share in original currency
  totalCostTwd: number   // total cost in TWD (USD shares × current fx)
  unrealizedGain: number // current value − totalCostTwd in TWD
  unrealizedPct: number  // unrealizedGain / totalCostTwd
}

export function computeCostBases(
  transactions: Transaction[],
  holdings: Holding[],
  fx: number,
): Record<string, CostBasis> {
  const wac: Record<string, { shares: number; costOrig: number; currency: Currency }> = {}
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date))

  for (const tx of sorted) {
    if ((tx.type === 'buy' || tx.type === 'new_position') && tx.symbol && tx.shares != null && tx.price != null) {
      const sym = tx.symbol
      if (!wac[sym]) wac[sym] = { shares: 0, costOrig: 0, currency: tx.currency }
      wac[sym].shares += tx.shares
      wac[sym].costOrig += tx.shares * tx.price + (tx.commission ?? 0)
    }
    if (tx.type === 'sell' && tx.symbol && tx.shares != null) {
      const entry = wac[tx.symbol]
      if (entry && entry.shares > 0) {
        const avg = entry.costOrig / entry.shares
        entry.shares = Math.max(0, entry.shares - tx.shares)
        entry.costOrig = avg * entry.shares
      }
    }
  }

  const result: Record<string, CostBasis> = {}
  for (const h of holdings) {
    const entry = wac[h.symbol]
    const currentValue = holdingValueTwd(h.shares, h.price, h.currency, fx)
    if (!entry || entry.shares <= 0 || entry.costOrig <= 0) {
      result[h.symbol] = { avgCost: 0, totalCostTwd: 0, unrealizedGain: 0, unrealizedPct: 0 }
      continue
    }
    const avgCost = entry.costOrig / entry.shares
    const totalCostTwd = entry.currency === 'USD' ? entry.costOrig * fx : entry.costOrig
    const unrealizedGain = currentValue - totalCostTwd
    const unrealizedPct = totalCostTwd > 0 ? unrealizedGain / totalCostTwd : 0
    result[h.symbol] = { avgCost, totalCostTwd, unrealizedGain, unrealizedPct }
  }
  return result
}

// ── Feature 3: Realized gains + dividend income for tax summary ─────────────
// WAC method: same pool as computeCostBases, updated on every sell.
// USD amounts converted to TWD using current fx (historical rate not stored before Feature 7).
export interface TaxSummary {
  byYear: Record<string, { realizedGain: number; dividendIncome: number }>
  entries: Array<{
    date: string; symbol: string; shares: number
    avgCost: number; salePrice: number; currency: Currency; realizedGain: number
  }>
  totalRealizedGain: number
  totalDividendIncome: number
}

export function computeTaxSummary(transactions: Transaction[], fx: number): TaxSummary {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date))
  const wac: Record<string, { shares: number; costOrig: number; currency: Currency }> = {}
  const byYear: Record<string, { realizedGain: number; dividendIncome: number }> = {}
  const entries: TaxSummary['entries'] = []

  const ensureYear = (y: string) => { if (!byYear[y]) byYear[y] = { realizedGain: 0, dividendIncome: 0 } }

  for (const tx of sorted) {
    const year = tx.date.slice(0, 4)
    if ((tx.type === 'buy' || tx.type === 'new_position') && tx.symbol && tx.shares != null && tx.price != null) {
      const sym = tx.symbol
      if (!wac[sym]) wac[sym] = { shares: 0, costOrig: 0, currency: tx.currency }
      wac[sym].shares += tx.shares
      wac[sym].costOrig += tx.shares * tx.price + (tx.commission ?? 0)
    }
    if (tx.type === 'sell' && tx.symbol && tx.shares != null && tx.price != null) {
      ensureYear(year)
      const entry = wac[tx.symbol]
      const avgCost = entry && entry.shares > 0 ? entry.costOrig / entry.shares : tx.price
      const gainOrig = (tx.price - avgCost) * tx.shares - (tx.commission ?? 0)
      const realizedGain = tx.currency === 'USD' ? gainOrig * fx : gainOrig
      entries.push({ date: tx.date, symbol: tx.symbol, shares: tx.shares, avgCost, salePrice: tx.price, currency: tx.currency, realizedGain })
      byYear[year].realizedGain += realizedGain
      if (entry && entry.shares > 0) {
        entry.shares = Math.max(0, entry.shares - tx.shares)
        entry.costOrig = avgCost * entry.shares
      }
    }
    if (tx.type === 'dividend') {
      ensureYear(year)
      byYear[year].dividendIncome += tx.currency === 'USD' ? tx.amount * fx : tx.amount
    }
  }

  const totalRealizedGain = Object.values(byYear).reduce((s, v) => s + v.realizedGain, 0)
  const totalDividendIncome = Object.values(byYear).reduce((s, v) => s + v.dividendIncome, 0)
  return { byYear, entries, totalRealizedGain, totalDividendIncome }
}

// Rebalance assistant: given new money (in TWD), compute how to allocate across holdings.
// Only buys, never sells. Underweight buckets get filled first; if new money exceeds all gaps,
// the remainder is reported as unallocated (suggest putting in defensive bucket).
//
// defensiveDrawTwd (預設 0)：從防禦桶（現金/SGOV）額外提領出來、一起當新資金分配的金額。
// 這筆錢不是外部匯入，不會讓總資產變多（newTotal 不含它），但會：
//   1. 從防禦桶目前餘額扣掉（current_value_twd 反映提領後的餘額，不會雙計）
//   2. 併入可分配的資金池（跟 newMoneyTwd 一起拿去補其他桶的缺口）
// 若提領後防禦桶反而低於自己的目標，資金池仍會照原本的缺口優先順序把錢補回去——
// 不會讓防禦桶被提到低於目標以下（除非資金池本身不夠補）。
export function computeNewMoneyAllocation(
  state: AppState,
  newMoneyTwd: number,
  defensiveDrawTwd: number = 0,
): AllocationResult {
  const { exchange_rate: fx, holdings, cash_accounts } = state
  // 分母＝可配置資產（已扣掉緊急備用金）。備用金不是可以拿去配置的錢，
  // 也不該讓新資金因為它而被要求補到更高的目標金額。
  const currentTotal = investableTotalTwd(state)
  const newTotal = currentTotal + newMoneyTwd
  const defensiveAvailable = defensiveBucketValueTwd(state)
  const drawClamped = Math.max(0, Math.min(defensiveDrawTwd, defensiveAvailable))
  const pool = newMoneyTwd + drawClamped

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

  // ── Defensive bucket aggregate（扣掉本次提領，避免雙計）──
  const defensiveCurrent = defensiveAvailable - drawClamped
  const defensiveTargetPct =
    holdings.filter(h => h.category === 'defensive').reduce((s, h) => s + h.target_pct, 0) +
    cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)
  const defensiveNewTarget = (defensiveTargetPct / 100) * newTotal
  const defensiveGap       = defensiveNewTarget - defensiveCurrent
  const defensiveOverweight = defensiveGap <= 0

  rows.push({
    symbol: 'DEFENSIVE',
    name: `${getCategories(state).find(c => c.is_cash)?.name ?? '防禦資產'} (SGOV / 現金)`,
    currency: 'TWD',
    current_value_twd: defensiveCurrent,
    target_pct: defensiveTargetPct,
    buy_amount_twd: defensiveOverweight ? 0 : defensiveGap,
    is_defensive: true,
    is_overweight: defensiveOverweight,
  })

  // ── Scale if total gaps exceed the pool（新資金 + 防禦桶提領）──
  const sumGaps = rows.reduce((s, r) => s + r.buy_amount_twd, 0)
  let unallocated_twd = 0

  if (sumGaps <= 0) {
    // Everything is overweight — distribute proportionally to target_pct
    for (const r of rows) {
      r.buy_amount_twd = (r.target_pct / 100) * pool
      r.is_overweight  = false
    }
  } else if (sumGaps > pool) {
    // Not enough money to fill all gaps → scale proportionally
    const scale = pool / sumGaps
    for (const r of rows) r.buy_amount_twd = r.buy_amount_twd * scale
  } else {
    // More money than gaps → record remainder as unallocated
    unallocated_twd = pool - sumGaps
  }

  // ── Compute share counts (rounded to whole shares) ──
  // Both TWD and USD stocks: 1 share minimum (整股交易)
  // buy_amount_twd is recalculated from rounded shares so the table is self-consistent.
  for (const r of rows) {
    if (r.is_defensive || !r.price || r.price <= 0) continue
    const price_twd  = r.currency === 'USD' ? r.price * fx : r.price
    const raw_shares = r.buy_amount_twd / price_twd
    r.buy_shares     = Math.floor(raw_shares)
    r.buy_amount_twd = r.buy_shares * price_twd
  }

  // ── Recalculate unallocated after rounding down shares ──
  unallocated_twd = pool - rows.reduce((s, r) => s + r.buy_amount_twd, 0)

  // Sort: largest allocation first
  rows.sort((a, b) => b.buy_amount_twd - a.buy_amount_twd)

  return { rows, unallocated_twd, new_total_twd: newTotal }
}
