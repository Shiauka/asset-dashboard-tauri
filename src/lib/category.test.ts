import { describe, it, expect } from 'vitest'
import type { AppState, Holding } from './types'
import { DEFAULT_CATEGORIES, getCategories, categorySummaries } from './calc'
import {
  setHoldingCategory, addCategory, updateCategory,
  deleteCategory, canDeleteCategory, moveCategory,
} from './store'

const holding = (symbol: string, category: string): Holding => ({
  symbol, name: symbol, currency: 'TWD', category, shares: 100, price: 10, target_pct: 5,
})

function mkState(over: Partial<AppState> = {}): AppState {
  return {
    exchange_rate: 32,
    holdings: [],
    cash_accounts: [],
    transactions: [],
    snapshots: [],
    retirement: { target_amount_twd: 2e7, monthly_contribution_wan: 5, expected_annual_return: 0.07, birth_year: 1990, retirement_age: 50 },
    categories: DEFAULT_CATEGORIES,
    ...over,
  }
}

describe('getCategories', () => {
  it('沒帶 categories → 回預設五桶（依 order 排序）', () => {
    const cats = getCategories(mkState({ categories: undefined }))
    expect(cats.map(c => c.id)).toEqual(['core', 'aggressive', 'global', 'alternative', 'defensive'])
  })

  it('亂序的 categories → 依 order 排序', () => {
    const shuffled = [...DEFAULT_CATEGORIES].reverse()
    const cats = getCategories(mkState({ categories: shuffled }))
    expect(cats.map(c => c.order)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('addCategory', () => {
  it('附加一個新分類：id 以 cat_ 開頭、order = max+1、原分類不動', () => {
    const s = addCategory(mkState())
    expect(s.categories).toHaveLength(6)
    const added = s.categories![5]
    expect(added.id.startsWith('cat_')).toBe(true)
    expect(added.order).toBe(5)
    expect(added.is_cash).toBeUndefined()
    // 原五桶原樣保留
    expect(s.categories!.slice(0, 5)).toEqual(DEFAULT_CATEGORIES)
  })
})

describe('updateCategory', () => {
  it('改名與改色生效、palette 跟著主色走', () => {
    const s = updateCategory(mkState(), 'core', { name: '我的核心', color: '#123456' })
    const core = s.categories!.find(c => c.id === 'core')!
    expect(core.name).toBe('我的核心')
    expect(core.color).toBe('#123456')
    expect(core.palette).toEqual(['#123456'])
  })

  it('patch 內的 id / is_cash 會被忽略（保護現金桶歸屬）', () => {
    const s = updateCategory(mkState(), 'core', { id: 'hacked', is_cash: true, name: 'x' } as never)
    const ids = s.categories!.map(c => c.id)
    expect(ids).toContain('core')
    expect(ids).not.toContain('hacked')
    expect(s.categories!.find(c => c.id === 'core')!.is_cash).toBeUndefined()
    // 現金桶仍然只有 defensive 一個
    expect(s.categories!.filter(c => c.is_cash).map(c => c.id)).toEqual(['defensive'])
  })
})

describe('setHoldingCategory', () => {
  it('只改目標持倉的分類', () => {
    const s = mkState({ holdings: [holding('VOO', 'core'), holding('QQQ', 'aggressive')] })
    const next = setHoldingCategory(s, 'VOO', 'global')
    expect(next.holdings.find(h => h.symbol === 'VOO')!.category).toBe('global')
    expect(next.holdings.find(h => h.symbol === 'QQQ')!.category).toBe('aggressive')
  })
})

describe('canDeleteCategory / deleteCategory', () => {
  it('現金桶不可刪', () => {
    const s = mkState()
    expect(canDeleteCategory(s, 'defensive').ok).toBe(false)
    expect(deleteCategory(s, 'defensive').categories!.map(c => c.id)).toContain('defensive')
  })

  it('仍有持倉的分類不可刪，理由含數量', () => {
    const s = mkState({ holdings: [holding('VOO', 'core')] })
    const res = canDeleteCategory(s, 'core')
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('1')
    expect(deleteCategory(s, 'core').categories!.map(c => c.id)).toContain('core')
  })

  it('空的非現金桶可刪，且從 summaries 消失', () => {
    const s = mkState()
    expect(canDeleteCategory(s, 'global').ok).toBe(true)
    const next = deleteCategory(s, 'global')
    expect(next.categories!.map(c => c.id)).not.toContain('global')
    expect(categorySummaries(next).map(x => x.key)).not.toContain('global')
  })
})

describe('moveCategory', () => {
  it('下移與相鄰桶交換 order', () => {
    const s = moveCategory(mkState(), 'core', 1)
    const ordered = getCategories(s).map(c => c.id)
    expect(ordered).toEqual(['aggressive', 'core', 'global', 'alternative', 'defensive'])
  })

  it('已在最上時上移為 no-op', () => {
    const s = moveCategory(mkState(), 'core', -1)
    expect(getCategories(s).map(c => c.id)).toEqual(['core', 'aggressive', 'global', 'alternative', 'defensive'])
  })
})

describe('categorySummaries 反映自訂分類', () => {
  it('改名後 summary 名稱跟著變', () => {
    const s = updateCategory(mkState(), 'core', { name: '我的核心' })
    expect(categorySummaries(s).find(x => x.key === 'core')!.name).toBe('我的核心')
  })

  it('現金帳戶歸到 is_cash 桶（即使改名）', () => {
    const renamed = updateCategory(
      mkState({ cash_accounts: [{ id: 'c1', bank: '台幣', currency: 'TWD', amount: 100000, type: 'bank', target_pct: 0 }] }),
      'defensive', { name: '我的現金' },
    )
    const cashRow = categorySummaries(renamed).find(x => x.key === 'defensive')!
    expect(cashRow.name).toBe('我的現金')
    expect(cashRow.value_twd).toBe(100000)
  })
})
