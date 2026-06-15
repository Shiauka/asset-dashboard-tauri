import { describe, it, expect } from 'vitest'
import type { AppState, Transaction } from './types'
import { INITIAL_STATE } from './initialData'
import { categorySummaries, totalAssetsTwd, rebalanceRows, computeNewMoneyAllocation, getCategories, DEFAULT_CATEGORIES } from './calc'
import {
  setHoldingCategory, addCategory, deleteCategory, deleteHolding,
  updateExchangeRate, applyTransaction,
} from './store'

// 以「預設範例資料」為起點，對它做各種非常規操作，確認 app 的計算層不會
// 產生 NaN / Infinity、不漏算資產、不崩潰。store 函式皆為純函式，可直接串接。

const base = INITIAL_STATE

// 不變量：每個桶的 value/百分比/目標都是有限數
const summariesFinite = (s: AppState) =>
  categorySummaries(s).every(c =>
    Number.isFinite(c.value_twd) && Number.isFinite(c.actual_pct) && Number.isFinite(c.target_pct))

// 不變量：再平衡每列數字都是有限數
const rebalanceFinite = (s: AppState) =>
  rebalanceRows(s).every(r =>
    [r.current_value_twd, r.target_value_twd, r.delta_twd].every(Number.isFinite) &&
    (r.delta_usd === undefined || Number.isFinite(r.delta_usd)) &&
    (r.delta_shares === undefined || Number.isFinite(r.delta_shares)))

// 不變量：各桶市值加總 = 總資產（無孤兒、無漏算）
const sumCats = (s: AppState) => categorySummaries(s).reduce((a, c) => a + c.value_twd, 0)

describe('預設範例 — 非常規操作穩健性', () => {
  it('把所有持倉移到單一桶：總額不變、加總一致、無 NaN', () => {
    const s = base.holdings.reduce((acc, h) => setHoldingCategory(acc, h.symbol, 'core'), base as AppState)
    expect(totalAssetsTwd(s)).toBeCloseTo(totalAssetsTwd(base), 2)
    expect(sumCats(s)).toBeCloseTo(totalAssetsTwd(s), 2)
    expect(summariesFinite(s)).toBe(true)
    expect(rebalanceFinite(s)).toBe(true)
  })

  it('把所有持倉移到現金桶(defensive)：非現金桶皆空、加總一致、無 NaN', () => {
    const s = base.holdings.reduce((acc, h) => setHoldingCategory(acc, h.symbol, 'defensive'), base as AppState)
    const sums = categorySummaries(s)
    for (const row of sums) {
      if (row.key !== 'defensive') expect(row.value_twd).toBe(0)
    }
    expect(sumCats(s)).toBeCloseTo(totalAssetsTwd(s), 2)
    expect(rebalanceFinite(s)).toBe(true)
  })

  it('新增 3 個空桶：summaries 變長、空桶值為 0、總額不變、無 NaN', () => {
    const s = addCategory(addCategory(addCategory(base as AppState)))
    expect(getCategories(s)).toHaveLength(DEFAULT_CATEGORIES.length + 3)
    expect(totalAssetsTwd(s)).toBeCloseTo(totalAssetsTwd(base), 2)
    const newOnes = categorySummaries(s).filter(c => c.key.startsWith('cat_'))
    expect(newOnes).toHaveLength(3)
    // 純空桶：value 與 target 皆為 0 → 總覽的 visibleCats 過濾（value>0||target>0）會把它隱藏
    expect(newOnes.every(c => c.value_twd === 0 && c.target_pct === 0)).toBe(true)
    expect(summariesFinite(s)).toBe(true)
  })

  it('清掉某桶全部持倉後刪掉該桶：summaries 不再含該桶、其餘不受影響', () => {
    let s = deleteHolding(base as AppState, 'VEA')
    s = deleteHolding(s, 'VWO')        // 清空 global 桶
    s = deleteCategory(s, 'global')
    expect(getCategories(s).map(c => c.id)).not.toContain('global')
    expect(categorySummaries(s).map(c => c.key)).not.toContain('global')
    expect(sumCats(s)).toBeCloseTo(totalAssetsTwd(s), 2)
  })

  it('匯率設為 0：不產生 NaN / Infinity', () => {
    const s = updateExchangeRate(base as AppState, 0)
    expect(Number.isFinite(totalAssetsTwd(s))).toBe(true)
    expect(summariesFinite(s)).toBe(true)
    expect(rebalanceFinite(s)).toBe(true)   // delta_usd 已對 fx=0 設防
  })

  it('賣出超過持有股數：持倉變負但計算仍有限、不崩', () => {
    const sell: Transaction = { id: 's1', date: '2026-01-01', type: 'sell', symbol: 'QQQ', shares: 9999, price: 480, currency: 'USD', amount: 0 }
    const s = applyTransaction(base as AppState, sell)
    expect(s.holdings.find(h => h.symbol === 'QQQ')!.shares).toBeLessThan(0)
    expect(Number.isFinite(totalAssetsTwd(s))).toBe(true)
    expect(summariesFinite(s)).toBe(true)
    expect(rebalanceFinite(s)).toBe(true)
  })

  it('現金提領超過餘額：餘額變負但計算仍有限', () => {
    const out: Transaction = { id: 'c1', date: '2026-01-01', type: 'cash_out', bank: '台幣帳戶', currency: 'TWD', amount: 9_999_999 }
    const s = applyTransaction(base as AppState, out)
    expect(s.cash_accounts.find(c => c.bank === '台幣帳戶')!.amount).toBeLessThan(0)
    expect(Number.isFinite(totalAssetsTwd(s))).toBe(true)
    expect(summariesFinite(s)).toBe(true)
  })

  it('投入新資金分配：金額有限、不超過投入額', () => {
    const r = computeNewMoneyAllocation(base as AppState, 1_000_000)
    expect(Number.isFinite(r.unallocated_twd)).toBe(true)
    const allocated = r.rows.reduce((a, x) => a + (x.buy_amount_twd ?? 0), 0)
    expect(allocated).toBeLessThanOrEqual(1_000_000 + 1) // 容許浮點誤差
    expect(allocated).toBeGreaterThanOrEqual(0)
  })

  it('空組合（無持倉無現金）：總額 0、百分比 0、無 NaN', () => {
    const empty: AppState = { ...base, holdings: [], cash_accounts: [], categories: DEFAULT_CATEGORIES }
    expect(totalAssetsTwd(empty)).toBe(0)
    expect(categorySummaries(empty).every(c => c.value_twd === 0 && c.actual_pct === 0)).toBe(true)
    expect(summariesFinite(empty)).toBe(true)
  })
})
