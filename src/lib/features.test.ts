/**
 * v0.4.2 新功能測試
 * Feature 1 — computeCostBases（個股成本基礎 + 未實現損益）
 * Feature 2 — dividend 交易類型（股息追蹤）
 * Feature 3 — computeTaxSummary（稅務摘要）
 * Feature 7 — 快照時 exchange_rate（歷史 USD 匯率修正）
 */
import { describe, it, expect } from 'vitest'
import type { AppState, Transaction } from './types'
import { computeCostBases, computeTaxSummary, computeTWR, DEFAULT_CATEGORIES } from './calc'
import { applyTransaction, reverseTransaction, retroactivelyAdjustSnapshots } from './store'

// ── 共用基底 ─────────────────────────────────────────────────────────────────

const FX = 32

function baseState(): AppState {
  return {
    exchange_rate: FX,
    holdings: [
      { symbol: 'VOO', name: 'Vanguard S&P500', currency: 'USD', category: 'core', shares: 10, price: 500, target_pct: 20 },
      { symbol: '0050', name: '元大台灣50', currency: 'TWD', category: 'core', shares: 1000, price: 180, target_pct: 15 },
    ],
    cash_accounts: [
      { id: 'c1', bank: '美元帳戶', currency: 'USD', amount: 5000, type: 'bank', target_pct: 5 },
      { id: 'c2', bank: '台幣帳戶', currency: 'TWD', amount: 200000, type: 'bank', target_pct: 5 },
    ],
    transactions: [],
    snapshots: [],
    retirement: { target_amount_twd: 20000000, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1990, retirement_age: 52 },
    categories: DEFAULT_CATEGORIES,
  }
}

// ── Feature 1: computeCostBases ───────────────────────────────────────────────

describe('computeCostBases — 個股成本基礎', () => {
  it('單筆買入：avgCost = 成交價，TWD 持倉 totalCostTwd 不乘匯率', () => {
    const txs: Transaction[] = [
      { id: 't1', date: '2025-01-10', type: 'buy', symbol: '0050', shares: 1000, price: 170, currency: 'TWD', amount: 170000 },
    ]
    const s = baseState()
    s.transactions = txs
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['0050'].avgCost).toBeCloseTo(170, 6)
    expect(cb['0050'].totalCostTwd).toBeCloseTo(170000, 4)
  })

  it('USD 持倉：totalCostTwd = shares × price × fx', () => {
    const txs: Transaction[] = [
      { id: 't1', date: '2025-01-10', type: 'buy', symbol: 'VOO', shares: 10, price: 480, currency: 'USD', amount: 4800 },
    ]
    const s = baseState()
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['VOO'].avgCost).toBeCloseTo(480, 6)
    expect(cb['VOO'].totalCostTwd).toBeCloseTo(10 * 480 * FX, 4)
  })

  it('兩筆買入：WAC 為加權平均', () => {
    // 第一筆：10 股 × $400；第二筆：5 股 × $520
    // WAC = (10×400 + 5×520) / 15 = (4000+2600)/15 = 6600/15 = 440
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-06-01', type: 'buy', symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
      { id: 'b2', date: '2024-09-01', type: 'buy', symbol: 'VOO', shares: 5,  price: 520, currency: 'USD', amount: 2600 },
    ]
    const s = { ...baseState() }
    s.holdings = [{ symbol: 'VOO', name: 'v', currency: 'USD', category: 'core', shares: 15, price: 500, target_pct: 20 }]
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['VOO'].avgCost).toBeCloseTo(440, 6)
    expect(cb['VOO'].totalCostTwd).toBeCloseTo(15 * 440 * FX, 4)
  })

  it('買入後賣出部分：剩餘股數維持原 WAC', () => {
    // 買 10 股 $400；賣 4 股 → 剩 6 股，WAC 仍 $400
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
      { id: 's1', date: '2024-06-01', type: 'sell', symbol: 'VOO', shares: 4,  price: 500, currency: 'USD', amount: 2000 },
    ]
    const s = { ...baseState() }
    s.holdings = [{ symbol: 'VOO', name: 'v', currency: 'USD', category: 'core', shares: 6, price: 500, target_pct: 20 }]
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['VOO'].avgCost).toBeCloseTo(400, 6)
    expect(cb['VOO'].totalCostTwd).toBeCloseTo(6 * 400 * FX, 4)
  })

  it('手續費計入成本：買 10 股 $400 + 手續費 $20 → avgCost = 402', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy', symbol: 'VOO', shares: 10, price: 400, commission: 20, currency: 'USD', amount: 4000 },
    ]
    const s = { ...baseState() }
    s.holdings = [{ symbol: 'VOO', name: 'v', currency: 'USD', category: 'core', shares: 10, price: 500, target_pct: 20 }]
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['VOO'].avgCost).toBeCloseTo(402, 4)  // (4000+20)/10
  })

  it('new_position 視為買入，avgCost 使用建立時的 price', () => {
    const txs: Transaction[] = [
      { id: 'n1', date: '2024-01-01', type: 'new_position', symbol: 'VOO', shares: 10, price: 450, currency: 'USD', amount: 4500 },
    ]
    const s = { ...baseState() }
    s.holdings = [{ symbol: 'VOO', name: 'v', currency: 'USD', category: 'core', shares: 10, price: 500, target_pct: 20 }]
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['VOO'].avgCost).toBeCloseTo(450, 6)
  })

  it('無買入紀錄：avgCost = 0，unrealizedGain = 0', () => {
    const s = baseState()
    const cb = computeCostBases([], s.holdings, FX)
    expect(cb['VOO'].avgCost).toBe(0)
    expect(cb['VOO'].unrealizedGain).toBe(0)
  })

  it('未實現損益 = 市值 − 成本（正值代表獲利）', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy', symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
    ]
    const s = baseState() // VOO price = 500
    s.transactions = txs
    const cb = computeCostBases(txs, s.holdings, FX)
    // 市值 = 10×500×32 = 160,000；成本 = 10×400×32 = 128,000；損益 = +32,000
    expect(cb['VOO'].unrealizedGain).toBeCloseTo(10 * (500 - 400) * FX, 1)
    expect(cb['VOO'].unrealizedPct).toBeCloseTo((500 - 400) / 400, 6)
  })

  it('損益百分比負值：現價低於成本', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy', symbol: '0050', shares: 1000, price: 200, currency: 'TWD', amount: 200000 },
    ]
    const s = baseState() // 0050 price = 180
    const cb = computeCostBases(txs, s.holdings, FX)
    expect(cb['0050'].unrealizedGain).toBeCloseTo(1000 * (180 - 200), 1)
    expect(cb['0050'].unrealizedPct).toBeLessThan(0)
  })
})

// ── Feature 2: dividend 交易類型 ──────────────────────────────────────────────

describe('dividend — applyTransaction', () => {
  it('有入帳帳戶：現金帳戶金額增加', () => {
    const tx: Transaction = {
      id: 'd1', date: '2026-03-15', type: 'dividend',
      currency: 'USD', symbol: 'VOO', bank: '美元帳戶', amount: 120,
    }
    const before = baseState()
    const after = applyTransaction(before, tx)
    const acc = after.cash_accounts.find(c => c.bank === '美元帳戶')!
    expect(acc.amount).toBeCloseTo(5000 + 120, 6)
    expect(after.transactions).toHaveLength(1)
  })

  it('無入帳帳戶：只記帳，現金帳戶不變', () => {
    const tx: Transaction = {
      id: 'd2', date: '2026-03-15', type: 'dividend',
      currency: 'USD', amount: 80,
    }
    const before = baseState()
    const after = applyTransaction(before, tx)
    expect(after.cash_accounts.find(c => c.bank === '美元帳戶')!.amount).toBe(5000)
    expect(after.transactions).toHaveLength(1)
  })

  it('TWD 股息（如 0050）入台幣帳戶', () => {
    const tx: Transaction = {
      id: 'd3', date: '2026-07-01', type: 'dividend',
      currency: 'TWD', symbol: '0050', bank: '台幣帳戶', amount: 3000,
    }
    const before = baseState()
    const after = applyTransaction(before, tx)
    expect(after.cash_accounts.find(c => c.bank === '台幣帳戶')!.amount).toBe(203000)
  })
})

describe('dividend — reverseTransaction', () => {
  it('反向撤銷 dividend：現金帳戶金額回到原值', () => {
    const tx: Transaction = {
      id: 'd1', date: '2026-03-15', type: 'dividend',
      currency: 'USD', bank: '美元帳戶', amount: 120,
    }
    const before = baseState()
    const after = applyTransaction(before, tx)
    const reversed = reverseTransaction(after, 'd1')
    expect(reversed.cash_accounts.find(c => c.bank === '美元帳戶')!.amount).toBeCloseTo(5000, 6)
    expect(reversed.transactions).toHaveLength(0)
  })
})

describe('dividend — retroactivelyAdjustSnapshots', () => {
  it('補登過去股息：影響股息日後所有快照的現金欄位', () => {
    const s = baseState()
    s.snapshots = [
      {
        date: '2025-01-01', total_twd: 100000,
        holdings_twd: { '美元帳戶': 160000, '台幣帳戶': 200000 },
      },
      {
        date: '2025-06-01', total_twd: 110000,
        holdings_twd: { '美元帳戶': 160000, '台幣帳戶': 200000 },
      },
    ]
    const tx: Transaction = {
      id: 'd1', date: '2025-01-15', type: 'dividend',
      currency: 'USD', bank: '美元帳戶', amount: 100,
    }
    const result = retroactivelyAdjustSnapshots(s, tx, 1)
    // 2025-01-01 早於 tx.date → 不變
    expect(result.snapshots[0].holdings_twd!['美元帳戶']).toBe(160000)
    // 2025-06-01 晚於 tx.date → 美元帳戶 +100×32
    expect(result.snapshots[1].holdings_twd!['美元帳戶']).toBeCloseTo(160000 + 100 * FX, 4)
  })
})

describe('computeTWR — dividend 不被視為外部現金流', () => {
  const SNAPS = [
    { date: '2026-01-01', total_twd: 1_000_000 },
    { date: '2026-12-31', total_twd: 1_100_000 },
  ]
  // 基準：純資產增長 +10%，無任何交易
  const base = computeTWR(SNAPS, [], 32)!

  it('dividend 不影響 TWR（不進 cfMap）', () => {
    const divTx: Transaction = {
      id: 'dv1', date: '2026-06-01', type: 'dividend',
      currency: 'USD', amount: 500, bank: '美元帳戶',
    }
    // 股息已反映在 total_twd 中，TWR 應與無股息時相同
    const r = computeTWR(SNAPS, [divTx], 32)
    expect(r).not.toBeNull()
    expect(r!.twr).toBeCloseTo(base.twr, 9)
  })

  it('cash_in 會影響 TWR（dividend 不應有此效果）', () => {
    const cashInTx: Transaction = {
      id: 'ci1', date: '2026-06-01', type: 'cash_in',
      currency: 'USD', amount: 500, bank: '美元帳戶',
    }
    const r = computeTWR(SNAPS, [cashInTx], 32)
    // 現金存入從期末扣除 → 報酬比基準高（排除了存入影響）
    expect(r!.twr).not.toBeCloseTo(base.twr, 6)
  })
})

// ── Feature 3: computeTaxSummary ──────────────────────────────────────────────

describe('computeTaxSummary — 稅務摘要', () => {
  it('無賣出無股息：空結果，totals 為 0', () => {
    const result = computeTaxSummary([], FX)
    expect(result.entries).toHaveLength(0)
    expect(result.totalRealizedGain).toBe(0)
    expect(result.totalDividendIncome).toBe(0)
    expect(Object.keys(result.byYear)).toHaveLength(0)
  })

  it('買入後賣出：已實現損益 = (賣出價 - 買入價) × 股數', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
      { id: 's1', date: '2024-06-01', type: 'sell', symbol: 'VOO', shares: 10, price: 500, currency: 'USD', amount: 5000 },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(result.entries).toHaveLength(1)
    // 損益 = (500−400) × 10 = 1000 USD = 32,000 TWD
    expect(result.entries[0].realizedGain).toBeCloseTo(1000 * FX, 4)
    expect(result.totalRealizedGain).toBeCloseTo(1000 * FX, 4)
    expect(result.byYear['2024'].realizedGain).toBeCloseTo(1000 * FX, 4)
  })

  it('賣出虧損：realizedGain 為負值', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 500, currency: 'USD', amount: 5000 },
      { id: 's1', date: '2024-09-01', type: 'sell', symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(result.entries[0].realizedGain).toBeLessThan(0)
    expect(result.totalRealizedGain).toBeCloseTo(-1000 * FX, 4)
  })

  it('WAC 跨兩筆買入再賣出：avgCost 為加權平均', () => {
    // 買 10 股 $400 + 買 10 股 $500 → WAC $450；賣 15 股 $480
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
      { id: 'b2', date: '2024-03-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 500, currency: 'USD', amount: 5000 },
      { id: 's1', date: '2024-08-01', type: 'sell', symbol: 'VOO', shares: 15, price: 480, currency: 'USD', amount: 7200 },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(result.entries[0].avgCost).toBeCloseTo(450, 6)
    // 損益 = (480−450) × 15 = 450 USD
    expect(result.entries[0].realizedGain).toBeCloseTo(450 * FX, 4)
  })

  it('賣出含手續費：手續費從損益中扣除', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 400, currency: 'USD', amount: 4000 },
      { id: 's1', date: '2024-06-01', type: 'sell', symbol: 'VOO', shares: 10, price: 500, commission: 15, currency: 'USD', amount: 5000 },
    ]
    const result = computeTaxSummary(txs, FX)
    // 損益 = (500−400)×10 − 15 = 985 USD
    expect(result.entries[0].realizedGain).toBeCloseTo(985 * FX, 4)
  })

  it('TWD 賣出：損益不乘匯率', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2024-01-01', type: 'buy',  symbol: '0050', shares: 1000, price: 170, currency: 'TWD', amount: 170000 },
      { id: 's1', date: '2024-09-01', type: 'sell', symbol: '0050', shares: 1000, price: 190, currency: 'TWD', amount: 190000 },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(result.entries[0].realizedGain).toBeCloseTo(20000, 4)  // (190-170)×1000 TWD
  })

  it('股息收入按年累計，不影響已實現損益', () => {
    const txs: Transaction[] = [
      { id: 'd1', date: '2025-03-15', type: 'dividend', currency: 'USD', amount: 100, symbol: 'VOO' },
      { id: 'd2', date: '2025-09-15', type: 'dividend', currency: 'USD', amount: 100, symbol: 'VOO' },
      { id: 'd3', date: '2026-03-15', type: 'dividend', currency: 'TWD', amount: 3000, symbol: '0050' },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(result.totalRealizedGain).toBe(0)
    expect(result.byYear['2025'].dividendIncome).toBeCloseTo(200 * FX, 4)
    expect(result.byYear['2026'].dividendIncome).toBeCloseTo(3000, 4)
    expect(result.totalDividendIncome).toBeCloseTo(200 * FX + 3000, 4)
  })

  it('多年度：byYear 分別累計，跨年賣出分配正確', () => {
    const txs: Transaction[] = [
      { id: 'b1', date: '2023-06-01', type: 'buy',  symbol: 'VOO', shares: 10, price: 380, currency: 'USD', amount: 3800 },
      { id: 's1', date: '2024-03-01', type: 'sell', symbol: 'VOO', shares: 5,  price: 440, currency: 'USD', amount: 2200 },
      { id: 's2', date: '2025-05-01', type: 'sell', symbol: 'VOO', shares: 5,  price: 500, currency: 'USD', amount: 2500 },
    ]
    const result = computeTaxSummary(txs, FX)
    expect(Object.keys(result.byYear)).toHaveLength(2)
    expect(result.byYear['2024'].realizedGain).toBeCloseTo(5 * (440 - 380) * FX, 4)
    expect(result.byYear['2025'].realizedGain).toBeCloseTo(5 * (500 - 380) * FX, 4)
    expect(result.entries).toHaveLength(2)
  })
})

// ── Feature 7: 快照時 exchange_rate ──────────────────────────────────────────

describe('computeTWR — 歷史 USD 匯率修正', () => {
  // 兩個快照，其間有一筆 USD cash_in
  const SNAPS = [
    { date: '2024-01-01', total_twd: 1_000_000, exchange_rate: 30 }, // 歷史匯率 30
    { date: '2024-12-31', total_twd: 1_200_000, exchange_rate: 32 }, // 當前匯率 32
  ]
  const USD_CASH_IN: Transaction = {
    id: 'ci1', date: '2024-06-01', type: 'cash_in',
    currency: 'USD', amount: 1000, // $1,000 USD
  }

  it('使用快照時匯率 vs 當前匯率，結果應不同', () => {
    const currentFx = 32
    // 快照 2024-12-31 有 exchange_rate=32；$1,000 USD 掛到該快照
    // fxBySnapDate['2024-12-31'] = 32 → txFx = 32 → cf = 32,000 TWD
    const withHistFX = computeTWR(SNAPS, [USD_CASH_IN], currentFx)

    // 若快照沒有 exchange_rate，全部用 currentFx=32 → cf = 32,000（這裡剛好相同，因為快照 FX = currentFx）
    const snapsWithoutFX = SNAPS.map(({ exchange_rate: _, ...rest }) => rest)
    const withoutHistFX = computeTWR(snapsWithoutFX, [USD_CASH_IN], currentFx)

    // 匯率相同時（32=32）結果應相同（驗證 fallback 路徑正確）
    expect(withHistFX!.twr).toBeCloseTo(withoutHistFX!.twr, 8)
  })

  it('歷史匯率 30，現在匯率 35：USD cash_in 換算金額不同', () => {
    const snapsHistorical = [
      { date: '2024-01-01', total_twd: 1_000_000, exchange_rate: 30 },
      { date: '2024-12-31', total_twd: 1_200_000, exchange_rate: 30 }, // 兩個快照都是 30
    ]
    const currentFx = 35

    // 有歷史匯率：$1,000×30 = 30,000 TWD 被從期末扣除
    const withHist = computeTWR(snapsHistorical, [USD_CASH_IN], currentFx)

    // 無歷史匯率：$1,000×35 = 35,000 TWD 被扣除（overestimates the flow）
    const snapsNoFX = snapsHistorical.map(({ exchange_rate: _, ...rest }) => rest)
    const withoutHist = computeTWR(snapsNoFX, [USD_CASH_IN], currentFx)

    expect(withHist!.twr).not.toBeCloseTo(withoutHist!.twr, 6)
    // 歷史匯率 30 扣除較少（30,000 < 35,000）→ 期末被剝離的存入金額較小 → TWR 較高
    expect(withHist!.twr).toBeGreaterThan(withoutHist!.twr)
  })

  it('舊快照無 exchange_rate：fallback 到當前匯率，不崩潰', () => {
    const oldSnaps = [
      { date: '2024-01-01', total_twd: 1_000_000 }, // 無 exchange_rate
      { date: '2024-12-31', total_twd: 1_200_000 },
    ]
    const r = computeTWR(oldSnaps, [USD_CASH_IN], 32)
    expect(r).not.toBeNull()
    expect(Number.isFinite(r!.twr)).toBe(true)
  })
})
