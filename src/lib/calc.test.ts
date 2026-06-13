import { describe, it, expect } from 'vitest'
import {
  totalAssetsTwd, assetsByCurrency, totalTargetPct, categorySummaries, categoryDrillDown,
  rebalanceRows, computeTWR, computeNewMoneyAllocation, requiredAnnualReturn,
} from './calc'
import type { AppState, Category } from './types'

// ── 決定性測試資料（不可用 Math.random，否則 snapshot 每次不同）──
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const HOLDINGS = [
  { symbol: '0050', name: '元大台灣50', currency: 'TWD' as const, category: 'core' as const, shares: 5000, price: 180, target_pct: 20 },
  { symbol: 'VOO', name: 'Vanguard S&P500', currency: 'USD' as const, category: 'core' as const, shares: 30, price: 480, target_pct: 15 },
  { symbol: '00631L', name: '元大台灣50正2', currency: 'TWD' as const, category: 'aggressive' as const, shares: 3000, price: 160, target_pct: 15 },
  { symbol: 'QQQ', name: 'Invesco QQQ', currency: 'USD' as const, category: 'aggressive' as const, shares: 20, price: 440, target_pct: 15 },
  { symbol: 'VEA', name: 'Vanguard 成熟', currency: 'USD' as const, category: 'global' as const, shares: 50, price: 50, target_pct: 8 },
  { symbol: 'VWO', name: 'Vanguard 新興', currency: 'USD' as const, category: 'global' as const, shares: 40, price: 44, target_pct: 7 },
  { symbol: 'IAU', name: 'iShares 黃金', currency: 'USD' as const, category: 'alternative' as const, shares: 60, price: 55, target_pct: 3 },
  { symbol: 'IBIT', name: 'iShares 比特幣', currency: 'USD' as const, category: 'alternative' as const, shares: 10, price: 60, target_pct: 2 },
  { symbol: 'SGOV', name: 'iShares 短債', currency: 'USD' as const, category: 'defensive' as const, shares: 25, price: 100, target_pct: 5 },
]
const CASH = [
  { id: 'c1', bank: '台幣銀行', currency: 'TWD' as const, amount: 300000, type: 'bank' as const, target_pct: 6 },
  { id: 'c2', bank: '美元銀行', currency: 'USD' as const, amount: 5000, type: 'bank' as const, target_pct: 4 },
]
const RET = { target_amount_twd: 20000000, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1990, retirement_age: 52 }

function baseState(): AppState {
  return { exchange_rate: 32.0, holdings: HOLDINGS.map(h => ({ ...h })), cash_accounts: CASH.map(c => ({ ...c })), transactions: [], retirement: { ...RET }, snapshots: [] }
}
function genSnapshots(start: string, nDays: number, seed: number, skipProb: number) {
  const rnd = mulberry32(seed); const snaps: { date: string; total_twd: number }[] = []; let total = 8_000_000
  for (let i = 0; i < nDays; i++) {
    if (i > 0 && rnd() < skipProb) continue
    total *= (1 + (rnd() - 0.48) * 0.02)
    snaps.push({ date: addDays(start, i), total_twd: Math.round(total) })
  }
  return snaps
}
function genCashFlows(start: string, nDays: number, seed: number) {
  const rnd = mulberry32(seed); const txs: any[] = []; let k = 0
  for (let i = 3; i < nDays; i += 30) {
    txs.push({ id: `ci${k++}`, date: addDays(start, i), type: 'cash_in', currency: 'TWD', amount: 50000 })
    if (rnd() < 0.25) txs.push({ id: `co${k++}`, date: addDays(start, i + 12), type: 'cash_out', currency: rnd() < 0.5 ? 'USD' : 'TWD', amount: rnd() < 0.5 ? 500 : 20000 })
  }
  return txs
}

function datasets(): Record<string, AppState> {
  const out: Record<string, AppState> = {}
  { const s = baseState(); s.snapshots = genSnapshots('2025-01-02', 40, 11, 0); s.transactions = genCashFlows('2025-01-02', 40, 12); out.small = s }
  { const s = baseState(); s.snapshots = genSnapshots('2022-06-01', 1095, 21, 0.18); s.transactions = genCashFlows('2022-06-01', 1095, 22); out.large = s }
  { const s = baseState(); s.snapshots = [{ date: '2024-12-30', total_twd: 5_000_000 }, { date: '2025-01-03', total_twd: 5_200_000 }]
    s.transactions = [{ id: 'a', date: '2024-12-01', type: 'cash_in', currency: 'TWD', amount: 100000 }, { id: 'b', date: '2025-01-02', type: 'cash_in', currency: 'USD', amount: 1000 }, { id: 'c', date: '2025-09-09', type: 'cash_in', currency: 'TWD', amount: 99999 }] as any; out.edge = s }
  { const s = baseState(); s.snapshots = genSnapshots('2024-03-01', 420, 31, 0.35); s.transactions = genCashFlows('2024-03-01', 420, 32); out.gappy = s }
  { const s = baseState(); s.snapshots = [{ date: '2025-05-05', total_twd: 7_000_000 }]; out.single = s }
  return out
}

const CATS: Category[] = ['core', 'aggressive', 'global', 'alternative', 'defensive']

// TWR.series 可能很長（每快照一點），snapshot 只留長度與首尾，其餘欄位全保留
function summarizeTWR(t: ReturnType<typeof computeTWR>) {
  if (!t) return null
  const { series, ...rest } = t
  return { ...rest, series: { length: series.length, first: series[0], last: series[series.length - 1] } }
}

describe('calc 金標準回歸（snapshot）', () => {
  const ds = datasets()
  for (const key of Object.keys(ds)) {
    it(`資料集 ${key} 的所有計算輸出固定不變`, () => {
      const s = ds[key]
      expect({
        totalAssetsTwd: totalAssetsTwd(s),
        totalTargetPct: totalTargetPct(s),
        categorySummaries: categorySummaries(s),
        drill: Object.fromEntries(CATS.map(c => [c, categoryDrillDown(s, c)])),
        rebalanceRows: rebalanceRows(s),
        twr: summarizeTWR(computeTWR(s.snapshots, s.transactions, s.exchange_rate)),
        alloc: [30000, 80000, 500000, 3000000].map(m => computeNewMoneyAllocation(s, m)),
      }).toMatchSnapshot()
    })
  }

  it('requiredAnnualReturn 多組參數固定不變', () => {
    expect([
      requiredAnnualReturn(8000000, 20000000, 16, 600000),
      requiredAnnualReturn(0, 10000000, 20, 500000),
      requiredAnnualReturn(15000000, 20000000, 5, 0),
      requiredAnnualReturn(20000000, 20000000, 10, 0),
    ]).toMatchSnapshot()
  })

  it('computeTWR 單一快照回 null', () => {
    expect(computeTWR([{ date: '2025-01-01', total_twd: 100 }], [], 32)).toBeNull()
  })
})

// ── assetsByCurrency：按計價幣別拆分，且要與 totalAssetsTwd 對帳 ────────────────
describe('assetsByCurrency', () => {
  it('台幣資產用原值、美元資產用原值，不互相換算', () => {
    const s = baseState()
    const { twd, usd } = assetsByCurrency(s)
    // 台幣持倉 0050(900,000) + 00631L(480,000) + 台幣現金(300,000)
    expect(twd).toBe(1_680_000)
    // 美元持倉 14,400+8,800+2,500+1,760+3,300+600+2,500 + 美元現金 5,000
    expect(usd).toBe(38_860)
  })

  it('台幣資產 + 美元資產折台幣 = totalAssetsTwd（對帳不變量）', () => {
    const s = baseState()
    const { twd, usdInTwd } = assetsByCurrency(s)
    expect(twd + usdInTwd).toBeCloseTo(totalAssetsTwd(s), 6)
  })

  it('沒有美元部位時 usd 為 0', () => {
    const s = baseState()
    s.holdings = s.holdings.filter(h => h.currency === 'TWD')
    s.cash_accounts = s.cash_accounts.filter(c => c.currency === 'TWD')
    const { usd, usdInTwd } = assetsByCurrency(s)
    expect(usd).toBe(0)
    expect(usdInTwd).toBe(0)
  })
})

// ── budget sync 邊界：transfer / 缺 currency 不應污染 TWR ──────────────────────
// computeTWR 只把 cash_in/cash_out 當外部現金流；transfer/buy/sell 應被忽略。
// 記帳同步進來的交易可能缺 currency 欄位，需 fallback TWD 不崩潰。
describe('computeTWR — budget sync 邊界場景', () => {
  const SNAPS = [
    { date: '2026-06-01', total_twd: 1_000_000 },
    { date: '2026-06-30', total_twd: 1_100_000 },
  ]

  // 基準：完全沒有交易時的 TWR（無外部現金流，純報酬 +10%）
  const base = computeTWR(SNAPS, [], 32)!

  it('C1：type=transfer 不被當現金流，TWR 與無交易時相同', () => {
    const txs = [{
      id: 't1', date: '2026-06-15', type: 'transfer' as const, currency: 'TWD' as const,
      bank: '富邦 台幣現金', bank_to: '元大 台幣現金', amount: 40000, amount_to: 40000,
    }]
    const r = computeTWR(SNAPS, txs, 32)
    expect(r).not.toBeNull()
    // transfer 不進 cfMap，期末不被扣除 → 與 base 完全一致
    expect(r!.twr).toBeCloseTo(base.twr, 9)
  })

  it('C2：缺 currency 欄位的 cash_out 不崩潰且 fallback TWD', () => {
    // 故意省略 currency（模擬舊版同步資料）
    const txs = [{
      id: 'c1', date: '2026-06-15', type: 'cash_out', bank: '富邦 台幣現金', amount: 50000,
    } as unknown as Parameters<typeof computeTWR>[1][number]]
    const r = computeTWR(SNAPS, txs, 32)
    expect(r).not.toBeNull()
    // 50000 被當 TWD 從期末扣除 → 報酬高於 base（因為剝離了流出的本金影響）
    expect(Number.isFinite(r!.twr)).toBe(true)
    expect(r!.twr).not.toBeCloseTo(base.twr, 6)
  })

  it('C3：含 bank_to/amount_to 的跨幣別 transfer 不影響 TWR', () => {
    const txs = [{
      id: 't2', date: '2026-06-10', type: 'transfer' as const, currency: 'TWD' as const,
      bank: '富邦 台幣現金', bank_to: '嘉信 美元現金', amount: 32000, amount_to: 1000,
    }]
    const r = computeTWR(SNAPS, txs, 32)
    expect(r).not.toBeNull()
    expect(r!.twr).toBeCloseTo(base.twr, 9)
  })
})
