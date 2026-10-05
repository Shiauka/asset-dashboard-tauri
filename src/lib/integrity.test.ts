import { describe, it, expect } from 'vitest'
import type { AppState, DailySnapshot } from './types'
import { computeTWR } from './calc'
import { addSnapshot, setSnapshotUnexplained, editTransaction } from './store'
import { INITIAL_STATE } from './initialData'
import { getTaiwanToday } from './dateUtils'

// 2026-10-03 事件：已刪的帳戶在歷史裡被回沖出一筆餘額，刪除那天的報酬率憑空大跌。
// 後端把「找不到對應交易的變動」附在快照上（unexplained），報酬率要把它當成資金進出排除。
describe('績效自我檢查：找不到對應交易的變動不算賺賠', () => {
  const snaps = (unexplainedTwd?: number): DailySnapshot[] => [
    { date: '2026-09-29', total_twd: 10_000_000 },
    {
      date: '2026-10-01', total_twd: 9_400_000,
      ...(unexplainedTwd != null ? { unexplained: [{ kind: 'cash' as const, name: '甲 儲蓄險', delta: -20000, currency: 'USD', twd: unexplainedTwd }] } : {}),
    },
  ]

  it('沒有標記時（舊行為）：帳戶消失被算成虧損', () => {
    const r = computeTWR(snaps(), [], 30)!
    expect(r.twr).toBeLessThan(-0.06)
  })

  it('標記的變動排除在報酬率與損益之外', () => {
    const r = computeTWR(snaps(-600_000), [], 30)!
    expect(r.twr).toBeCloseTo(0, 10)
    expect(r.totalGain).toBeCloseTo(0, 4)
  })

  it('跟一般現金流同一天也正確相加', () => {
    const s = snaps(-600_000)
    s[1] = { ...s[1], total_twd: s[1].total_twd - 100_000 }
    const r = computeTWR(s, [{ id: 'x', type: 'cash_out', date: '2026-10-01', amount: 100_000, currency: 'TWD' }], 30)!
    expect(r.twr).toBeCloseTo(0, 10)
  })
})

describe('addSnapshot 保留今天這張的標記', () => {
  it('重算今天的快照時不弄丟後端算的 unexplained', () => {
    const today = getTaiwanToday()
    const u = [{ kind: 'cash' as const, name: 'A', delta: -5, currency: 'TWD', twd: -5 }]
    const st: AppState = { ...INITIAL_STATE, snapshots: [{ date: today, total_twd: 1, unexplained: u }] }
    const next = addSnapshot(st, 2)
    expect(next.snapshots.find(s => s.date === today)?.unexplained).toEqual(u)
  })
})

describe('新增帳戶／持倉帶進來的金額不算報酬', () => {
  const s: DailySnapshot[] = [
    { date: '2026-09-01', total_twd: 1000, holdings_twd: { A: 1000 } },
    { date: '2026-09-02', total_twd: 2000, holdings_twd: { A: 1000, X: 1000, N: 1000 } },
  ]
  it('新增持倉（1000 元）當天報酬率 0，不是 +100%', () => {
    const r = computeTWR(s, [{ id: 'p', type: 'new_position', date: '2026-09-02', symbol: 'X', shares: 10, price: 100, amount: 1000, currency: 'TWD' }], 31)!
    expect(r.twr).toBeCloseTo(0, 10)
  })
  it('新增現金帳戶（期初 1000 元）同理', () => {
    const r = computeTWR(s, [{ id: 'c', type: 'new_cash_account', date: '2026-09-02', bank: 'N', amount: 1000, currency: 'TWD' }], 31)!
    expect(r.twr).toBeCloseTo(0, 10)
  })
})

describe('setSnapshotUnexplained', () => {
  const u = [{ kind: 'cash' as const, name: 'A', delta: -5, currency: 'TWD', twd: -5 }]
  const base: AppState = { ...INITIAL_STATE, snapshots: [{ date: '2026-09-02', total_twd: 1, unexplained: u }] }
  it('後端說今天沒問題 → 清掉舊標記', () => {
    expect(setSnapshotUnexplained(base, '2026-09-02', undefined).snapshots[0].unexplained).toBeUndefined()
  })
  it('後端回新標記 → 換上', () => {
    const v = [{ ...u[0], delta: -9, twd: -9 }]
    expect(setSnapshotUnexplained(base, '2026-09-02', v).snapshots[0].unexplained).toEqual(v)
  })
})

// 第二輪審查 R1：補登過去日期的建立持倉，錢是到記錄當天才出現在快照上 → 流入要掛在那天，不是交易日
describe('補登的新增資金掛在第一次出現的那天', () => {
  const s: DailySnapshot[] = [
    { date: '2026-09-01', total_twd: 1000, holdings_twd: { A: 1000 } },
    { date: '2026-09-02', total_twd: 1000, holdings_twd: { A: 1000 } },
    { date: '2026-09-03', total_twd: 2000, holdings_twd: { A: 1000, X: 1000 } },
  ]
  const np = (date: string) => ({ id: 'p', type: 'new_position' as const, date, symbol: 'X', shares: 10, price: 100, amount: 1000, currency: 'TWD' as const })
  it('交易日在中間：報酬率 0，不是 −100%', () => {
    expect(computeTWR(s, [np('2026-09-02')], 31)!.twr).toBeCloseTo(0, 10)
  })
  it('交易日在第一張快照之前：報酬率 0，不是 +100%', () => {
    expect(computeTWR(s, [np('2026-08-01')], 31)!.twr).toBeCloseTo(0, 10)
  })
  it('既有持倉加碼（回填會從交易日起加股數）：掛在交易日', () => {
    const t: DailySnapshot[] = [
      { date: '2026-09-01', total_twd: 1000, holdings_twd: { X: 1000 } },
      { date: '2026-09-02', total_twd: 2000, holdings_twd: { X: 2000 } },
      { date: '2026-09-03', total_twd: 2000, holdings_twd: { X: 2000 } },
    ]
    expect(computeTWR(t, [np('2026-09-02')], 31)!.twr).toBeCloseTo(0, 10)
  })
  it('帳戶早就存在時的 new_cash_account 不算流入', () => {
    const t: DailySnapshot[] = [
      { date: '2026-09-01', total_twd: 1000, holdings_twd: { B: 1000 } },
      { date: '2026-09-02', total_twd: 1100, holdings_twd: { B: 1100 } },
    ]
    const r = computeTWR(t, [{ id: 'c', type: 'new_cash_account', date: '2026-09-02', bank: 'B', amount: 500, currency: 'TWD' }], 31)!
    expect(r.twr).toBeCloseTo(0.1, 10)
  })
})

// 第二輪審查：未來日期／改日期的交易，報酬率的資金進出要掛在「實際進到看板」那天（跟後端同一套規則）
describe('交易的生效日', () => {
  const s: DailySnapshot[] = [
    { date: '2026-09-01', total_twd: 1000 },
    { date: '2026-09-02', total_twd: 900 },
    { date: '2026-09-10', total_twd: 900 },
  ]
  it('9/2 記的 9/10 cash_out：掛在 9/2', () => {
    const tx = { id: String(Date.UTC(2026, 8, 2, 4)), type: 'cash_out' as const, date: '2026-09-10', amount: 100, currency: 'TWD' as const }
    expect(computeTWR(s, [tx], 31)!.twr).toBeCloseTo(0, 10)
  })
  it('有 recorded_at 時以它為準', () => {
    const tx = { id: 'x', recorded_at: '2026-09-02', type: 'cash_out' as const, date: '2026-09-10', amount: 100, currency: 'TWD' as const }
    expect(computeTWR(s, [tx], 31)!.twr).toBeCloseTo(0, 10)
  })
})

// 第三輪審查 P14（v0.8.1 以前就有）：編輯「建立現金」會把帳戶餘額重設回期初金額
describe('建立類交易只能改備註', () => {
  it('改建立現金的備註不會動到餘額', () => {
    const st: AppState = {
      ...INITIAL_STATE,
      cash_accounts: [{ id: 'c', bank: 'C', currency: 'TWD', amount: 150, type: 'bank', target_pct: 0 }],
      transactions: [
        { id: 'n', type: 'new_cash_account', date: '2026-09-01', bank: 'C', amount: 100, currency: 'TWD' },
        { id: 'i', type: 'cash_in', date: '2026-09-02', bank: 'C', amount: 50, currency: 'TWD' },
      ],
    }
    const r = editTransaction(st, 'n', { note: '新備註', amount: 999 })!
    expect(r.next.cash_accounts.find(c => c.bank === 'C')!.amount).toBe(150)
    expect(r.newTx.note).toBe('新備註')
    expect(r.newTx.amount).toBe(100)
  })
})

// 第四輪審查 P15：刪掉帳戶後用同名補登、日期填在刪除前 → 新帳戶的期初金額是流入，不是獲利
it('同名補登在刪除前的日期：仍算流入', () => {
  const s: DailySnapshot[] = [
    { date: '2026-09-01', total_twd: 1000, holdings_twd: { A: 500, C: 500 } },
    { date: '2026-09-05', total_twd: 500, holdings_twd: { A: 500 } },
    { date: '2026-09-10', total_twd: 800, holdings_twd: { A: 500, C: 300 } },
  ]
  const txs = [
    { id: 'old', type: 'new_cash_account' as const, date: '2026-08-01', bank: 'C', amount: 500, currency: 'TWD' as const },
    { id: 'new', type: 'new_cash_account' as const, date: '2026-09-03', bank: 'C', amount: 300, currency: 'TWD' as const },
  ]
  const unexplained = [{ kind: 'cash' as const, name: 'C', delta: -500, currency: 'TWD', twd: -500 }]
  const r = computeTWR([s[0], { ...s[1], unexplained }, s[2]], txs, 31)!
  expect(r.twr).toBeCloseTo(0, 10)
})
