import { bench, describe } from 'vitest'
import type { AppState, Holding, CashAccount, Transaction, DailySnapshot, Currency } from './types'
import { DEFAULT_CATEGORIES } from './calc'
import {
  totalAssetsTwd, categorySummaries, rebalanceRows, categoryDrillDown,
  computeNewMoneyAllocation, computeTWR,
} from './calc'

// ── 效能基準的「測試數據條件」（固定、可重現，不用亂數/now） ──────────────────
// 規模刻意放大到遠超一般使用者，作為日後改動的回歸比較點。
// 條件：60 檔持倉 / 10 個現金帳戶 / 3000 筆交易 / 1825 筆每日快照（≈5 年）/ 5 個桶。
const COND = { nHoldings: 60, nCash: 10, nTx: 3000, nSnap: 1825 } as const

const BASE = Date.UTC(2019, 0, 1)
const isoDate = (addDays: number) => new Date(BASE + addDays * 86_400_000).toISOString().slice(0, 10)

function makeLargeState(c: typeof COND): AppState {
  const cats = DEFAULT_CATEGORIES
  const catIds = cats.map(x => x.id)

  const holdings: Holding[] = Array.from({ length: c.nHoldings }, (_, i) => ({
    symbol: `SYM${i}`,
    name: `標的 ${i}`,
    currency: (i % 2 === 0 ? 'USD' : 'TWD') as Currency,
    category: catIds[i % catIds.length],
    shares: 10 + (i % 90),
    price: 50 + (i % 500),
    target_pct: (i % 7),
  }))

  const cash_accounts: CashAccount[] = Array.from({ length: c.nCash }, (_, i) => ({
    id: `cash_${i}`,
    bank: `銀行${i} 帳戶`,
    currency: (i % 2 === 0 ? 'TWD' : 'USD') as Currency,
    amount: 10_000 + i * 5_000,
    type: 'bank',
    target_pct: i % 3,
  }))

  // 交易：循環 buy/sell/cash_in/cash_out；日期均勻散在快照區間內。
  const types: Transaction['type'][] = ['buy', 'sell', 'cash_in', 'cash_out']
  const transactions: Transaction[] = Array.from({ length: c.nTx }, (_, i) => {
    const type = types[i % types.length]
    const day = Math.floor((i / c.nTx) * c.nSnap)
    const sym = `SYM${i % c.nHoldings}`
    const ccy = (i % 2 === 0 ? 'USD' : 'TWD') as Currency
    return {
      id: `tx_${i}`,
      date: isoDate(day),
      type,
      symbol: type === 'buy' || type === 'sell' ? sym : undefined,
      shares: type === 'buy' || type === 'sell' ? 1 + (i % 10) : undefined,
      price: type === 'buy' || type === 'sell' ? 50 + (i % 500) : undefined,
      currency: ccy,
      amount: 1000 + (i % 9000),
    }
  })

  // 快照：每日一筆，總額單調成長；bucket_pct / holdings_twd / holdings_shares 都填。
  const snapshots: DailySnapshot[] = Array.from({ length: c.nSnap }, (_, i) => {
    const bucket_pct: Record<string, number> = {}
    catIds.forEach((id, k) => { bucket_pct[id] = 20 + ((i + k) % 10) - 5 })
    const holdings_twd: Record<string, number> = {}
    const holdings_shares: Record<string, number> = {}
    for (let h = 0; h < c.nHoldings; h++) {
      holdings_twd[`SYM${h}`] = 1000 + ((i + h) % 5000)
      holdings_shares[`SYM${h}`] = 10 + ((i + h) % 90)
    }
    return {
      date: isoDate(i),
      total_twd: 1_000_000 + i * 1500,
      bucket_pct,
      holdings_twd,
      holdings_shares,
    }
  })

  return {
    exchange_rate: 32,
    holdings,
    cash_accounts,
    transactions,
    snapshots,
    retirement: { target_amount_twd: 3e7, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1990, retirement_age: 50 },
    categories: cats,
  }
}

const S = makeLargeState(COND)

describe(`calc 熱路徑基準（${COND.nHoldings}持倉/${COND.nCash}現金/${COND.nTx}交易/${COND.nSnap}快照）`, () => {
  bench('totalAssetsTwd', () => { totalAssetsTwd(S) })
  bench('categorySummaries', () => { categorySummaries(S) })
  bench('rebalanceRows', () => { rebalanceRows(S) })
  bench('categoryDrillDown(core)', () => { categoryDrillDown(S, 'core') })
  bench('computeNewMoneyAllocation', () => { computeNewMoneyAllocation(S, 1_000_000) })
  // 傳新陣列參考避開 computeTWR 的單筆 memo cache，量到真實計算成本。
  bench('computeTWR', () => { computeTWR([...S.snapshots], [...S.transactions], S.exchange_rate) })
})
