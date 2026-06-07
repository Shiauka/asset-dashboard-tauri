import { describe, it, expect, beforeEach } from 'vitest'
import { loadState, saveState } from './store'

// store.ts 用全域 window + localStorage；node 環境手動 polyfill（in-memory）
const KEY = 'asset_dashboard_v1'
let mem: Record<string, string>
beforeEach(() => {
  mem = {}
  ;(globalThis as Record<string, unknown>).window = {}
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => { mem[k] = String(v) },
    removeItem: (k: string) => { delete mem[k] },
  }
})
const setLS = (obj: unknown) => { mem[KEY] = typeof obj === 'string' ? obj : JSON.stringify(obj) }

describe('loadState — 防呆與容錯', () => {
  it('空 localStorage → 回 INITIAL_STATE（有預設持倉、不崩）', () => {
    const s = loadState()
    expect(Array.isArray(s.holdings)).toBe(true)
    expect(s.holdings.length).toBeGreaterThan(0)
  })
  it('壞 JSON → graceful 回 INITIAL_STATE，不清空也不丟例外', () => {
    setLS('{壞掉的 json')
    const s = loadState()
    expect(s.holdings.length).toBeGreaterThan(0)
  })
  it('parsed 非物件（如數字）→ INITIAL_STATE', () => {
    setLS('42')
    expect(loadState().holdings.length).toBeGreaterThan(0)
  })
})

describe('loadState — 舊格式遷移（資料相容性核心）', () => {
  it('舊 retirement 格式（target_year / annual_contribution_wan）正確換算', () => {
    setLS({
      exchange_rate: 31.5,
      holdings: [{ symbol: '0050', name: 'x', currency: 'TWD', category: 'core', shares: 1000, price: 180, target_pct: 20 }],
      transactions: [{ id: 't1', date: '2024-01-01', type: 'cash_in', currency: 'TWD', amount: 100000 }],
      snapshots: [{ date: '2024-01-01', total_twd: 5000000 }],
      cash_accounts: [{ id: 'c1', bank: 'B', currency: 'TWD', amount: 100000, type: 'bank' }], // 缺 target_pct
      retirement: { target_year: 2045, annual_contribution_wan: 72, target_amount_twd: 18000000, expected_annual_return: 0.06 },
    })
    const s = loadState()
    expect(s.retirement.birth_year).toBe(1990)
    expect(s.retirement.retirement_age).toBe(55)            // 2045 - 1990
    expect(s.retirement.monthly_contribution_wan).toBeCloseTo(6, 10) // 72 / 12
    expect(s.retirement.target_amount_twd).toBe(18000000)   // 保留
    expect(s.cash_accounts[0].target_pct).toBe(0)           // 缺 → 補 0
    expect(s.holdings).toHaveLength(1)                       // 無資料遺失
    expect(s.transactions).toHaveLength(1)
    expect(s.snapshots).toHaveLength(1)
  })

  it('舊最小備份（只有 holdings/cash/exchange_rate/retirement，缺 transactions+snapshots）', () => {
    setLS({
      exchange_rate: 30.9,
      holdings: [{ symbol: 'VOO', name: 'v', currency: 'USD', category: 'core', shares: 10, price: 480, target_pct: 15 }],
      cash_accounts: [{ id: 'c1', bank: 'B', currency: 'USD', amount: 1000, type: 'bank' }],
      retirement: { target_year: 2040, annual_contribution_wan: 60, target_amount_twd: 20000000, expected_annual_return: 0.07 },
    })
    const s = loadState()
    expect(s.transactions).toEqual([])     // 缺 → 補 []
    expect(s.snapshots).toEqual([])
    expect(s.holdings).toHaveLength(1)      // 無遺失
    expect(s.retirement.birth_year).toBe(1990)
    expect(Number.isFinite(s.retirement.monthly_contribution_wan)).toBe(true)
  })

  it('已是新格式（含 birth_year）→ 原樣保留，不二次遷移', () => {
    const ret = { target_amount_twd: 25000000, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1988, retirement_age: 55 }
    setLS({ exchange_rate: 32, holdings: [], cash_accounts: [], transactions: [], snapshots: [], retirement: ret })
    expect(loadState().retirement).toEqual(ret)
  })

  it('缺 exchange_rate → 補預設值（>0）', () => {
    setLS({ holdings: [], cash_accounts: [], transactions: [], snapshots: [], retirement: { target_year: 2040, annual_contribution_wan: 60, target_amount_twd: 2e7, expected_annual_return: 0.07 } })
    expect(loadState().exchange_rate).toBeGreaterThan(0)
  })
})

describe('saveState / loadState — 備份還原無損', () => {
  it('完整新格式 state：save → load 完全一致', () => {
    const full = {
      exchange_rate: 32.1,
      holdings: [{ symbol: 'VOO', name: 'v', currency: 'USD' as const, category: 'core' as const, shares: 10, price: 480, target_pct: 15 }],
      cash_accounts: [{ id: 'c1', bank: 'B', currency: 'TWD' as const, amount: 50000, type: 'bank' as const, target_pct: 5 }],
      transactions: [{ id: 't1', date: '2025-01-01', type: 'buy' as const, symbol: 'VOO', shares: 10, price: 480, currency: 'USD' as const, amount: 4800 }],
      snapshots: [{ date: '2025-01-01', total_twd: 1000000, bucket_pct: { core: 100 } }],
      retirement: { target_amount_twd: 20000000, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1990, retirement_age: 52 },
    }
    saveState(full)
    expect(loadState()).toEqual(full)
  })

  it('舊格式 load → save → load 收斂（第二次 load 與第一次相同）', () => {
    setLS({
      exchange_rate: 31, holdings: [], cash_accounts: [{ id: 'c1', bank: 'B', currency: 'TWD', amount: 1, type: 'bank' }],
      retirement: { target_year: 2050, annual_contribution_wan: 36, target_amount_twd: 3e7, expected_annual_return: 0.05 },
    })
    const first = loadState()
    saveState(first)
    expect(loadState()).toEqual(first)
  })
})
