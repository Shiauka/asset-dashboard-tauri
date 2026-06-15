import { INITIAL_STATE } from './initialData'
import type { AppState, Holding, CashAccount, Transaction, Category, CategoryDef, RetirementSettings } from './types'
import { getTaiwanToday } from './dateUtils'
import { categorySummaries, holdingValueTwd, DEFAULT_CATEGORIES, getCategories } from './calc'

const KEY = 'asset_dashboard_v1'

export function loadState(): AppState {
  if (typeof window === 'undefined') return INITIAL_STATE

  // Only treat genuinely corrupt JSON as unrecoverable. A valid-but-old-schema
  // blob must NOT fall through to INITIAL_STATE — that would silently wipe the
  // user's holdings/transactions/snapshots. Guard every field instead.
  let parsed: Partial<AppState> | null = null
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return INITIAL_STATE
    parsed = JSON.parse(raw) as Partial<AppState>
  } catch {
    return INITIAL_STATE
  }
  if (!parsed || typeof parsed !== 'object') return INITIAL_STATE

  // Migrate old retirement format (target_year / annual_contribution_wan → new fields);
  // tolerate a missing retirement object entirely.
  const r = (parsed.retirement ?? {}) as unknown as Record<string, unknown>
  const migratedRetirement: RetirementSettings = r.birth_year != null
    ? (parsed.retirement as RetirementSettings)
    : {
        target_amount_twd:       (r.target_amount_twd as number)        ?? 20000000,
        monthly_contribution_wan:((r.annual_contribution_wan as number) ?? 60) / 12,
        expected_annual_return:  (r.expected_annual_return as number)   ?? 0.07,
        birth_year:              1990,
        retirement_age:          ((r.target_year as number) ?? 2040) - 1990,
      }

  // 舊存檔沒帶 categories → 補上預設五桶，畫面與數字維持不變。
  const categories = parsed.categories?.length ? parsed.categories : DEFAULT_CATEGORIES
  // 孤兒持倉防呆：若持倉的桶 id 不在桶清單裡（只可能來自竄改/匯入/sync 漂移），
  // 自動歸到現金桶，避免市值從總覽默默消失（圓餅加總≠總資產）。正常操作不會觸發。
  const validCatIds = new Set(categories.map(c => c.id))
  const cashId = categories.find(c => c.is_cash)?.id
    ?? (validCatIds.has('defensive') ? 'defensive' : categories[0]?.id ?? 'defensive')
  const holdings = (parsed.holdings ?? []).map(h =>
    validCatIds.has(h.category) ? h : { ...h, category: cashId },
  )

  return {
    ...(parsed as AppState),
    exchange_rate: parsed.exchange_rate ?? INITIAL_STATE.exchange_rate,
    holdings,
    transactions:  parsed.transactions ?? [],
    retirement:    migratedRetirement,
    snapshots:     parsed.snapshots ?? [],
    cash_accounts: (parsed.cash_accounts ?? []).map(c => ({
      ...c,
      target_pct: c.target_pct ?? 0,
    })),
    categories,
  }
}

export function saveState(state: AppState): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(state))
}

export function resetState(): AppState {
  if (typeof window === 'undefined') return INITIAL_STATE
  localStorage.setItem(KEY, JSON.stringify(INITIAL_STATE))
  return INITIAL_STATE
}

export function clearState(): AppState {
  if (typeof window === 'undefined') return INITIAL_STATE
  const empty: AppState = {
    exchange_rate: 32.0,
    holdings: [],
    cash_accounts: [],
    transactions: [],
    snapshots: [],
    retirement: INITIAL_STATE.retirement,
    categories: DEFAULT_CATEGORIES,
  }
  localStorage.setItem(KEY, JSON.stringify(empty))
  return empty
}

export function applyTransaction(
  state: AppState,
  tx: Transaction & { category?: Category; holdingName?: string; accountType?: 'bank' | 'savings_insurance'; target_pct?: number }
): AppState {
  const next = { ...state, transactions: [...state.transactions, tx] }

  if (tx.type === 'new_cash_account' && tx.bank) {
    const exists = next.cash_accounts.findIndex(c => c.bank === tx.bank)
    if (exists < 0) {
      const newAccount: CashAccount = {
        id: `cash_${Date.now()}`,
        bank: tx.bank,
        currency: tx.currency,
        amount: tx.amount,
        type: tx.accountType ?? 'bank',
        target_pct: 0,
      }
      next.cash_accounts = [...next.cash_accounts, newAccount]
    }
    return next
  }

  if (tx.type === 'new_position' && tx.symbol) {
    const exists = next.holdings.findIndex(h => h.symbol === tx.symbol)
    if (exists < 0) {
      const newHolding: Holding = {
        symbol: tx.symbol,
        name: tx.holdingName || tx.symbol,
        currency: tx.currency,
        category: tx.category ?? 'core',
        shares: tx.shares ?? 0,
        price: tx.price ?? 0,
        target_pct: tx.target_pct ?? 0,
      }
      next.holdings = [...next.holdings, newHolding]
    }
    return next
  }

  if (tx.type === 'transfer' && tx.bank && tx.bank_to) {
    const accounts = [...next.cash_accounts]
    const fromIdx = accounts.findIndex(c => c.bank === tx.bank)
    const toIdx = accounts.findIndex(c => c.bank === tx.bank_to)
    if (fromIdx >= 0) accounts[fromIdx] = { ...accounts[fromIdx], amount: accounts[fromIdx].amount - tx.amount }
    if (toIdx >= 0) accounts[toIdx] = { ...accounts[toIdx], amount: accounts[toIdx].amount + (tx.amount_to ?? tx.amount) }
    next.cash_accounts = accounts
    return next
  }

  if ((tx.type === 'buy' || tx.type === 'sell') && tx.symbol && tx.shares && tx.price) {
    const idx = next.holdings.findIndex(h => h.symbol === tx.symbol)
    if (idx >= 0) {
      const h = { ...next.holdings[idx] }
      h.shares = tx.type === 'buy' ? h.shares + tx.shares : h.shares - tx.shares
      h.price = tx.price
      next.holdings = [...next.holdings]
      next.holdings[idx] = h
    }
  }

  if (tx.bank && tx.bank !== '__none') {
    const idx = next.cash_accounts.findIndex(c => c.bank === tx.bank)
    if (idx >= 0) {
      const c = { ...next.cash_accounts[idx] }
      const fee = tx.commission ?? 0
      if (tx.type === 'cash_in') c.amount += tx.amount
      else if (tx.type === 'cash_out') c.amount -= tx.amount
      else if (tx.type === 'buy') c.amount -= tx.amount + fee
      else if (tx.type === 'sell') c.amount += tx.amount - fee
      next.cash_accounts = [...next.cash_accounts]
      next.cash_accounts[idx] = c
    }
  }

  return next
}

export function updateHoldingPrice(state: AppState, symbol: string, price: number): AppState {
  const holdings = state.holdings.map(h => h.symbol === symbol ? { ...h, price } : h)
  return { ...state, holdings }
}

export function updateHoldingTargetPct(state: AppState, symbol: string, target_pct: number): AppState {
  const holdings = state.holdings.map(h => h.symbol === symbol ? { ...h, target_pct } : h)
  return { ...state, holdings }
}

export function updateCashAccountTargetPct(state: AppState, id: string, target_pct: number): AppState {
  const cash_accounts = state.cash_accounts.map(c => c.id === id ? { ...c, target_pct } : c)
  return { ...state, cash_accounts }
}

export function updateExchangeRate(state: AppState, rate: number): AppState {
  return { ...state, exchange_rate: rate }
}

export function updateRetirement(state: AppState, settings: Partial<AppState['retirement']>): AppState {
  return { ...state, retirement: { ...state.retirement, ...settings } }
}

export function deleteHolding(state: AppState, symbol: string): AppState {
  return { ...state, holdings: state.holdings.filter(h => h.symbol !== symbol) }
}

export function deleteCashAccount(state: AppState, id: string): AppState {
  return { ...state, cash_accounts: state.cash_accounts.filter(c => c.id !== id) }
}

// ── 分類（桶）管理 ──────────────────────────────────────────────────────────
// 改某持倉的分類（move bucket）。
export function setHoldingCategory(state: AppState, symbol: string, category: Category): AppState {
  return { ...state, holdings: state.holdings.map(h => h.symbol === symbol ? { ...h, category } : h) }
}

const CATEGORY_PALETTE_POOL = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#6366f1',
  '#ec4899', '#14b8a6', '#8b5cf6', '#f97316', '#0ea5e9',
]

// 新增一個分類（非現金桶）。id 自動產生且不再變動。
export function addCategory(state: AppState): AppState {
  const cats = getCategories(state)
  const id = `cat_${Date.now()}`
  const order = cats.reduce((m, c) => Math.max(m, c.order), -1) + 1
  const color = CATEGORY_PALETTE_POOL[cats.length % CATEGORY_PALETTE_POOL.length]
  const def: CategoryDef = { id, name: '新桶', color, target_pct: 0, order, palette: [color] }
  return { ...state, categories: [...cats, def] }
}

// 改名/改色/改目標%（id 與 is_cash 不開放改，避免動到現金桶歸屬）。
export function updateCategory(state: AppState, id: string, patch: Partial<CategoryDef>): AppState {
  const { id: _id, is_cash: _isCash, ...rest } = patch
  const cats = getCategories(state).map(c => {
    if (c.id !== id) return c
    const merged: CategoryDef = { ...c, ...rest }
    if (rest.color) merged.palette = [rest.color]   // drill-down 配色跟著主色走
    return merged
  })
  return { ...state, categories: cats }
}

// 是否可刪：現金桶不可刪、仍有持倉的桶不可刪。
export function canDeleteCategory(state: AppState, id: string): { ok: boolean; reason?: string } {
  const def = getCategories(state).find(c => c.id === id)
  if (!def) return { ok: false, reason: '桶不存在' }
  if (def.is_cash) return { ok: false, reason: '現金桶不可刪除' }
  const count = state.holdings.filter(h => h.category === id).length
  if (count > 0) return { ok: false, reason: `還有 ${count} 個持倉在此桶，請先移走或刪除` }
  return { ok: true }
}

export function deleteCategory(state: AppState, id: string): AppState {
  if (!canDeleteCategory(state, id).ok) return state
  return { ...state, categories: getCategories(state).filter(c => c.id !== id) }
}

// 上/下移一格（dir = -1 上移、+1 下移），並重排 order。
export function moveCategory(state: AppState, id: string, dir: -1 | 1): AppState {
  const cats = getCategories(state)   // 已依 order 排序
  const idx = cats.findIndex(c => c.id === id)
  const swap = idx + dir
  if (idx < 0 || swap < 0 || swap >= cats.length) return state
  const reordered = [...cats]
  ;[reordered[idx], reordered[swap]] = [reordered[swap], reordered[idx]]
  return { ...state, categories: reordered.map((c, i) => ({ ...c, order: i })) }
}

// 刪除交易紀錄並還原其對持倉/帳戶的影響
export function reverseTransaction(state: AppState, id: string): AppState {
  const tx = state.transactions.find(t => t.id === id)
  if (!tx) return state

  let next: AppState = { ...state, transactions: state.transactions.filter(t => t.id !== id) }

  switch (tx.type) {
    case 'buy': {
      if (tx.symbol && tx.shares) {
        const idx = next.holdings.findIndex(h => h.symbol === tx.symbol)
        if (idx >= 0) {
          const holdings = [...next.holdings]
          holdings[idx] = { ...holdings[idx], shares: holdings[idx].shares - tx.shares }
          next = { ...next, holdings }
        }
      }
      if (tx.bank && tx.bank !== '__none') {
        const idx = next.cash_accounts.findIndex(c => c.bank === tx.bank)
        if (idx >= 0) {
          const cash_accounts = [...next.cash_accounts]
          cash_accounts[idx] = { ...cash_accounts[idx], amount: cash_accounts[idx].amount + tx.amount + (tx.commission ?? 0) }
          next = { ...next, cash_accounts }
        }
      }
      break
    }
    case 'sell': {
      if (tx.symbol && tx.shares) {
        const idx = next.holdings.findIndex(h => h.symbol === tx.symbol)
        if (idx >= 0) {
          const holdings = [...next.holdings]
          holdings[idx] = { ...holdings[idx], shares: holdings[idx].shares + tx.shares }
          next = { ...next, holdings }
        }
      }
      if (tx.bank && tx.bank !== '__none') {
        const idx = next.cash_accounts.findIndex(c => c.bank === tx.bank)
        if (idx >= 0) {
          const cash_accounts = [...next.cash_accounts]
          cash_accounts[idx] = { ...cash_accounts[idx], amount: cash_accounts[idx].amount - tx.amount + (tx.commission ?? 0) }
          next = { ...next, cash_accounts }
        }
      }
      break
    }
    case 'cash_in': {
      if (tx.bank) {
        const idx = next.cash_accounts.findIndex(c => c.bank === tx.bank)
        if (idx >= 0) {
          const cash_accounts = [...next.cash_accounts]
          cash_accounts[idx] = { ...cash_accounts[idx], amount: cash_accounts[idx].amount - tx.amount }
          next = { ...next, cash_accounts }
        }
      }
      break
    }
    case 'cash_out': {
      if (tx.bank) {
        const idx = next.cash_accounts.findIndex(c => c.bank === tx.bank)
        if (idx >= 0) {
          const cash_accounts = [...next.cash_accounts]
          cash_accounts[idx] = { ...cash_accounts[idx], amount: cash_accounts[idx].amount + tx.amount }
          next = { ...next, cash_accounts }
        }
      }
      break
    }
    case 'new_position': {
      if (tx.symbol) {
        next = { ...next, holdings: next.holdings.filter(h => h.symbol !== tx.symbol) }
      }
      break
    }
    case 'new_cash_account': {
      if (tx.bank) {
        next = { ...next, cash_accounts: next.cash_accounts.filter(c => c.bank !== tx.bank) }
      }
      break
    }
    case 'transfer': {
      const accounts = [...next.cash_accounts]
      if (tx.bank) {
        const idx = accounts.findIndex(c => c.bank === tx.bank)
        if (idx >= 0) accounts[idx] = { ...accounts[idx], amount: accounts[idx].amount + tx.amount }
      }
      if (tx.bank_to) {
        const idx = accounts.findIndex(c => c.bank === tx.bank_to)
        if (idx >= 0) accounts[idx] = { ...accounts[idx], amount: accounts[idx].amount - (tx.amount_to ?? tx.amount) }
      }
      next = { ...next, cash_accounts: accounts }
      break
    }
  }

  return next
}

// 補丁 tx.date 當天及之後所有已有 holdings_twd 的快照
// direction=1 套用交易, direction=-1 反向撤銷（刪除交易時用）
export function retroactivelyAdjustSnapshots(
  state: AppState,
  tx: Transaction,
  direction: 1 | -1 = 1,
): AppState {
  const today = getTaiwanToday()
  if (tx.date >= today) return state
  if (tx.type === 'new_cash_account') return state

  const fx = state.exchange_rate
  const toTwd = (amount: number, currency: 'USD' | 'TWD') =>
    currency === 'USD' ? amount * fx : amount

  const updatedSnapshots = state.snapshots.map(snap => {
    if (snap.date < tx.date || !snap.holdings_twd) return snap

    const h = { ...snap.holdings_twd }

    switch (tx.type) {
      case 'cash_in':
        if (tx.bank && h[tx.bank] !== undefined)
          h[tx.bank] += direction * toTwd(tx.amount, tx.currency)
        break
      case 'cash_out':
        if (tx.bank && h[tx.bank] !== undefined)
          h[tx.bank] -= direction * toTwd(tx.amount, tx.currency)
        break
      case 'buy':
        if (tx.symbol && tx.shares && tx.price) {
          const delta = toTwd(tx.shares * tx.price, tx.currency)
          h[tx.symbol] = (h[tx.symbol] ?? 0) + direction * delta
          if (tx.bank && tx.bank !== '__none' && h[tx.bank] !== undefined)
            h[tx.bank] -= direction * toTwd(tx.amount, tx.currency)
        }
        break
      case 'sell':
        if (tx.symbol && tx.shares && tx.price) {
          const delta = toTwd(tx.shares * tx.price, tx.currency)
          h[tx.symbol] = (h[tx.symbol] ?? 0) - direction * delta
          if (tx.bank && tx.bank !== '__none' && h[tx.bank] !== undefined)
            h[tx.bank] += direction * toTwd(tx.amount, tx.currency)
        }
        break
      case 'new_position':
        if (tx.symbol && tx.shares && tx.price) {
          const val = toTwd(tx.shares * tx.price, tx.currency)
          h[tx.symbol] = direction === 1 ? val : 0
        }
        break
      case 'transfer':
        if (tx.bank && h[tx.bank] !== undefined)
          h[tx.bank] -= direction * toTwd(tx.amount, tx.currency)
        if (tx.bank_to && h[tx.bank_to] !== undefined) {
          const amtTo = tx.amount_to ?? tx.amount
          const curTo = tx.currency_to ?? tx.currency
          h[tx.bank_to] += direction * toTwd(amtTo, curTo)
        }
        break
    }

    const newTotal = Object.values(h).reduce((s, v) => s + Math.max(0, v), 0)

    const cats: Record<string, number> = { core: 0, aggressive: 0, global: 0, alternative: 0, defensive: 0 }
    for (const [key, val] of Object.entries(h)) {
      if (val <= 0) continue
      const holding = state.holdings.find(hh => hh.symbol === key)
      const cat = holding ? holding.category : 'defensive'
      cats[cat] = (cats[cat] ?? 0) + val
    }
    const newBucketPct: Record<string, number> = {}
    for (const [k, v] of Object.entries(cats))
      newBucketPct[k] = newTotal > 0 ? (v / newTotal) * 100 : 0

    return { ...snap, holdings_twd: h, total_twd: newTotal, bucket_pct: newBucketPct }
  })

  return { ...state, snapshots: updatedSnapshots }
}

export function addSnapshot(state: AppState, total_twd: number): AppState {
  const date = getTaiwanToday()

  const summaries = categorySummaries(state)
  const bucket_pct = Object.fromEntries(
    summaries.map(s => [s.key, s.actual_pct])
  ) as Record<Category, number>

  const { exchange_rate: fx, holdings, cash_accounts } = state
  const holdings_twd: Record<string, number> = {}
  const holdings_shares: Record<string, number> = {}
  for (const h of holdings) {
    holdings_twd[h.symbol] = holdingValueTwd(h.shares, h.price, h.currency, fx)
    holdings_shares[h.symbol] = h.shares
  }
  for (const c of cash_accounts) {
    holdings_twd[c.bank] = c.currency === 'USD' ? c.amount * fx : c.amount
  }

  const snapshot = { date, total_twd, bucket_pct, holdings_twd, holdings_shares }
  const existing = state.snapshots ?? []
  const filtered = existing.filter(s => s.date !== date)
  const sorted = [...filtered, snapshot].sort((a, b) => a.date.localeCompare(b.date))
  return { ...state, snapshots: sorted }
}

export function updateTransaction(state: AppState, id: string, updates: Partial<Transaction>): AppState {
  const transactions = state.transactions.map(tx =>
    tx.id === id ? { ...tx, ...updates } : tx
  )
  return { ...state, transactions }
}

// Reverse old transaction effects, then apply updated transaction
export function editTransaction(
  state: AppState,
  id: string,
  updates: Partial<Transaction>,
): { next: AppState; oldTx: Transaction; newTx: Transaction } | null {
  const oldTx = state.transactions.find(t => t.id === id)
  if (!oldTx) return null
  const newTx: Transaction = { ...oldTx, ...updates }
  let next = reverseTransaction(state, id)
  next = applyTransaction(next, newTx as Parameters<typeof applyTransaction>[1])
  return { next, oldTx, newTx }
}
