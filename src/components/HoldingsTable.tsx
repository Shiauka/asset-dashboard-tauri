'use client'

import React, { useMemo, useState } from 'react'
import { Trash2, LayoutGrid, Columns2, TrendingUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AppState, Category, Currency } from '@/lib/types'
import { holdingValueTwd, getCategories, computeCostBases } from '@/lib/calc'
import {
  updateHoldingPrice, updateHoldingTargetPct, updateCashAccountTargetPct,
  deleteHolding, deleteCashAccount, setHoldingCategory,
} from '@/lib/store'

const fmt = (n: number, d = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)

interface Props {
  state: AppState
  onUpdate: (s: AppState) => void
  blurred?: boolean
}

const COL = {
  symbol: 'w-[68px] shrink-0',
  name:   'w-[104px] shrink-0',
  shares: 'w-[88px] shrink-0 text-right',
  price:  'w-[80px] shrink-0 text-right',
  ccy:    'w-[40px] shrink-0 text-center',
  target: 'w-[54px] shrink-0 text-right',
  value:  'w-[92px] shrink-0 text-right',
  cat:    'w-[34px] shrink-0 flex justify-center',
  del:    'w-[28px] shrink-0 flex justify-end',
}

type HoldingField = 'price' | 'target_pct'
type EditingState =
  | { kind: 'holding'; symbol: string; field: HoldingField }
  | { kind: 'holding-cat'; symbol: string }
  | { kind: 'cash'; id: string }
type ViewMode = 'bucket' | 'account' | 'pnl'

const CCY_META: Record<Currency, { label: string; color: string }> = {
  TWD: { label: '台幣帳戶', color: '#2563EB' },
  USD: { label: '美金帳戶', color: '#16A34A' },
}

function SectionHeader({ name, color, total, targetPct, amtClass = '' }: { name: string; color: string; total: number; targetPct: number; amtClass?: string }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2.5 rounded-t-lg"
      style={{ borderLeft: `4px solid ${color}`, background: `${color}12` }}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold" style={{ color }}>{name}</span>
        {targetPct > 0 && (
          <span className="text-xs text-muted-foreground font-medium">目標 {targetPct}%</span>
        )}
      </div>
      <span className={`text-sm font-bold text-foreground ${amtClass}`}>{fmt(total / 10000, 1)} 萬</span>
    </div>
  )
}

function ColHeaders({ sharesNode, valueLabel }: { sharesNode?: React.ReactNode; valueLabel?: string }) {
  return (
    <div className="flex items-center px-4 py-1.5 text-xs text-muted-foreground border-b">
      <span className={COL.symbol}>代號</span>
      <span className={COL.name}>名稱</span>
      <span className={COL.shares}>{sharesNode ?? '股數'}</span>
      <span className={COL.price}>現價</span>
      <span className={COL.ccy}>幣</span>
      <span className={COL.target}>目標%</span>
      <span className={COL.value}>{valueLabel ?? '市值'}</span>
      <span className={`${COL.cat} block text-center`}>桶</span>
      <span className={COL.del} />
    </div>
  )
}

export default function HoldingsTable({ state, onUpdate, blurred = false }: Props) {
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [editVal, setEditVal] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('bucket')
  const fx = state.exchange_rate

  const costBases = useMemo(
    () => computeCostBases(state.transactions, state.holdings, fx),
    [state.transactions, state.holdings, fx],
  )
  const totalUnrealizedGain = useMemo(
    () => Object.values(costBases).reduce((s, cb) => s + cb.unrealizedGain, 0),
    [costBases],
  )

  const cats = getCategories(state)
  const catMap = new Map(cats.map(c => [c.id, c]))
  const cashCat = cats.find(c => c.is_cash) ?? catMap.get('defensive')
  const cashId = cashCat?.id ?? 'defensive'

  const startEdit = (symbol: string, field: HoldingField, current: number) => {
    setEditing({ kind: 'holding', symbol, field })
    setEditVal(String(current))
  }

  const saveEdit = (symbol: string, field: HoldingField) => {
    const n = parseFloat(editVal)
    if (!isNaN(n) && n >= 0) {
      if (field === 'price' && n > 0) onUpdate(updateHoldingPrice(state, symbol, n))
      if (field === 'target_pct' && n <= 100) onUpdate(updateHoldingTargetPct(state, symbol, n))
    }
    setEditing(null)
  }

  const startCashEdit = (id: string, current: number) => {
    setEditing({ kind: 'cash', id })
    setEditVal(String(current))
  }

  const saveCashEdit = (id: string) => {
    const n = parseFloat(editVal)
    if (!isNaN(n) && n >= 0 && n <= 100) {
      onUpdate(updateCashAccountTargetPct(state, id, n))
    }
    setEditing(null)
  }

  const isEditing = (symbol: string, field: HoldingField) =>
    editing?.kind === 'holding' && editing.symbol === symbol && editing.field === field

  const isCashEditing = (id: string) =>
    editing?.kind === 'cash' && editing.id === id

  const isCatEditing = (symbol: string) =>
    editing?.kind === 'holding-cat' && editing.symbol === symbol

  const handleDeleteHolding = (symbol: string, name: string) => {
    if (!confirm(`確定刪除「${name}」(${symbol}) 的部位？此操作無法還原。`)) return
    onUpdate(deleteHolding(state, symbol))
  }

  const handleDeleteCash = (id: string, bank: string) => {
    if (!confirm(`確定刪除「${bank}」帳戶？此操作無法還原。`)) return
    onUpdate(deleteCashAccount(state, id))
  }

  const amtClass = blurred ? 'blur-sm select-none' : ''

  // ── Shared row renderers ─────────────────────────────────────────────────

  const renderHoldingRow = (
    h: typeof state.holdings[number],
    isLast: boolean,
    valueCellFn: (h: typeof state.holdings[number]) => React.ReactNode,
  ) => (
    <div
      key={h.symbol}
      className={`flex items-center px-4 py-2 text-sm hover:bg-muted/40 transition-colors ${isLast ? '' : 'border-b'}`}
    >
      <span className={`${COL.symbol} font-mono font-semibold text-xs tracking-wider`}>{h.symbol}</span>
      <span className={`${COL.name} text-xs text-muted-foreground truncate`}>{h.name}</span>
      <span className={`${COL.shares} tabular-nums text-xs ${amtClass}`}>{fmt(h.shares, 4)}</span>

      <span className={COL.price}>
        {isEditing(h.symbol, 'price') ? (
          <Input autoFocus className="h-6 w-full text-right text-xs p-1"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => saveEdit(h.symbol, 'price')}
            onKeyDown={e => e.key === 'Enter' && saveEdit(h.symbol, 'price')} />
        ) : (
          <button onClick={() => startEdit(h.symbol, 'price', h.price)}
            className={`tabular-nums text-xs hover:underline w-full text-right block ${amtClass}`}
            title="點擊修改現價">
            {h.currency === 'USD' ? `$${fmt(h.price, 2)}` : fmt(h.price, 2)}
          </button>
        )}
      </span>

      <span className={COL.ccy}>
        <Badge variant="secondary" className="text-[10px] px-1 py-0">{h.currency}</Badge>
      </span>

      <span className={COL.target}>
        {isEditing(h.symbol, 'target_pct') ? (
          <Input autoFocus className="h-6 w-full text-right text-xs p-1"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => saveEdit(h.symbol, 'target_pct')}
            onKeyDown={e => e.key === 'Enter' && saveEdit(h.symbol, 'target_pct')} />
        ) : (
          <button onClick={() => startEdit(h.symbol, 'target_pct', h.target_pct)}
            className="text-xs hover:underline w-full text-right block"
            title="點擊修改目標%">
            {h.target_pct > 0
              ? <span className="text-muted-foreground">{h.target_pct}%</span>
              : <span className="text-muted-foreground/30">—</span>}
          </button>
        )}
      </span>

      <span className={`${COL.value} tabular-nums text-xs font-semibold ${amtClass}`}>
        {valueCellFn(h)}
      </span>
      <span className={`${COL.cat} relative`}>
        {isCatEditing(h.symbol) ? (
          <select
            autoFocus
            value={h.category}
            onChange={e => { onUpdate(setHoldingCategory(state, h.symbol, e.target.value)); setEditing(null) }}
            onBlur={() => setEditing(null)}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-20 h-6 w-[120px] text-xs border rounded bg-background"
          >
            {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <button
            onClick={() => setEditing({ kind: 'holding-cat', symbol: h.symbol })}
            title={`桶：${catMap.get(h.category)?.name ?? h.category}（點擊修改）`}
            className="w-3.5 h-3.5 rounded-full border border-black/10 hover:ring-2 hover:ring-offset-1 hover:ring-muted-foreground/30"
            style={{ background: catMap.get(h.category)?.color ?? '#9ca3af' }}
          />
        )}
      </span>
      <span className={COL.del}>
        <button onClick={() => handleDeleteHolding(h.symbol, h.name)}
          className="text-muted-foreground/40 hover:text-red-500 transition-colors" title="刪除">
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )

  const renderCashRow = (
    c: typeof state.cash_accounts[number],
    isLast: boolean,
    valueCellFn: (c: typeof state.cash_accounts[number]) => React.ReactNode,
  ) => (
    <div key={c.id}
      className={`flex items-center px-4 py-2 text-sm hover:bg-muted/40 transition-colors ${isLast ? '' : 'border-b'}`}>
      <span className={`${COL.symbol} font-semibold text-xs`}>{c.bank.split(' ')[0]}</span>
      <span className={`${COL.name} text-xs text-muted-foreground truncate`}>
        {c.type === 'savings_insurance' ? '儲蓄險' : '現金'}
      </span>
      <span className={`${COL.shares} tabular-nums text-xs text-emerald-600 ${amtClass}`}>
        {fmt(c.amount, c.currency === 'USD' ? 2 : 0)}
      </span>
      <span className={COL.price} />
      <span className={COL.ccy}>
        <Badge variant="secondary" className="text-[10px] px-1 py-0">{c.currency}</Badge>
      </span>
      <span className={COL.target}>
        {isCashEditing(c.id) ? (
          <Input autoFocus className="h-6 w-full text-right text-xs p-1"
            value={editVal}
            onChange={e => setEditVal(e.target.value)}
            onBlur={() => saveCashEdit(c.id)}
            onKeyDown={e => e.key === 'Enter' && saveCashEdit(c.id)} />
        ) : (
          <button onClick={() => startCashEdit(c.id, c.target_pct ?? 0)}
            className="text-xs hover:underline w-full text-right block"
            title="點擊修改目標%">
            {(c.target_pct ?? 0) > 0
              ? <span className="text-muted-foreground">{c.target_pct}%</span>
              : <span className="text-muted-foreground/30">—</span>}
          </button>
        )}
      </span>
      <span className={`${COL.value} tabular-nums text-xs font-semibold text-emerald-600 ${amtClass}`}>
        {valueCellFn(c)}
      </span>
      <span className={COL.cat} />
      <span className={COL.del}>
        <button onClick={() => handleDeleteCash(c.id, c.bank)}
          className="text-muted-foreground/40 hover:text-red-500 transition-colors" title="刪除">
          <Trash2 size={13} />
        </button>
      </span>
    </div>
  )

  // ── Bucket view ──────────────────────────────────────────────────────────

  const grouped = state.holdings.reduce<Record<string, typeof state.holdings>>((acc, h) => {
    acc[h.category] = [...(acc[h.category] || []), h]
    return acc
  }, {})

  const renderBucketView = () => (
    <>
      {/* 一般資產桶（非現金桶）；空桶自動不顯示 */}
      {cats
        .filter(c => c.id !== cashId)
        .map(c => {
          const items = (grouped[c.id] || []).slice().sort((a, b) =>
            holdingValueTwd(b.shares, b.price, b.currency, fx) - holdingValueTwd(a.shares, a.price, a.currency, fx)
          )
          if (items.length === 0) return null
          const catTotal = items.reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
          const catTargetPct = items.reduce((s, h) => s + h.target_pct, 0)

          return (
            <div key={c.id} className="rounded-lg border overflow-hidden">
              <SectionHeader name={c.name} color={c.color} total={catTotal} targetPct={catTargetPct} amtClass={amtClass} />
              <ColHeaders />
              {items.map((h, idx) => {
                const val = holdingValueTwd(h.shares, h.price, h.currency, fx)
                return renderHoldingRow(h, idx === items.length - 1, () => <>{fmt(val / 10000, 1)} 萬</>)
              })}
            </div>
          )
        })}

      {/* 現金桶（收納現金帳戶 + 該桶持倉） */}
      {(() => {
        const defHoldings = state.holdings.filter(h => h.category === cashId)
        const cashTotal = state.cash_accounts.reduce((s, c) => s + (c.currency === 'USD' ? c.amount * fx : c.amount), 0)
        const holdingTotal = defHoldings.reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0)
        const defTargetPct =
          defHoldings.reduce((s, h) => s + h.target_pct, 0) +
          state.cash_accounts.reduce((s, c) => s + (c.target_pct ?? 0), 0)

        const hasEtf  = defHoldings.length > 0
        const hasCash = state.cash_accounts.length > 0
        if (!hasEtf && !hasCash) return null
        const cashColor = cashCat?.color ?? '#6366f1'
        const cashName  = cashCat?.name ?? '防禦資產'
        const sharesNode = hasEtf && hasCash
          ? <><span>股數</span><span className="text-emerald-600">/金額</span></>
          : hasCash
            ? <span className="text-emerald-600">金額</span>
            : '股數'

        type DefRow =
          | { kind: 'holding'; value: number; data: typeof defHoldings[number] }
          | { kind: 'cash';    value: number; data: typeof state.cash_accounts[number] }
        const defRows: DefRow[] = [
          ...defHoldings.map(h => ({ kind: 'holding' as const, value: holdingValueTwd(h.shares, h.price, h.currency, fx), data: h })),
          ...state.cash_accounts.map(c => ({ kind: 'cash' as const, value: c.currency === 'USD' ? c.amount * fx : c.amount, data: c })),
        ].sort((a, b) => b.value - a.value)

        return (
          <div className="rounded-lg border overflow-hidden">
            <div
              className="flex items-center justify-between px-4 py-2.5 rounded-t-lg"
              style={{ borderLeft: `4px solid ${cashColor}`, background: `${cashColor}12` }}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: cashColor }}>{cashName}</span>
                {defTargetPct > 0 && (
                  <span className="text-xs text-muted-foreground font-medium">目標 {defTargetPct}%</span>
                )}
              </div>
              <span className={`text-sm font-bold text-foreground ${amtClass}`}>{fmt((cashTotal + holdingTotal) / 10000, 1)} 萬</span>
            </div>

            {defRows.length > 0 && <ColHeaders sharesNode={sharesNode} />}
            {defRows.map((row, idx) => {
              const isLast = idx === defRows.length - 1
              if (row.kind === 'holding') {
                return renderHoldingRow(row.data, isLast, () => <>{fmt(row.value / 10000, 1)} 萬</>)
              }
              return renderCashRow(row.data, isLast, (c) => <>{fmt(row.value / 10000, 1)} 萬</>)
            })}
          </div>
        )
      })()}
    </>
  )

  // ── Account view ─────────────────────────────────────────────────────────

  const renderAccountView = () =>
    (['TWD', 'USD'] as Currency[]).map(ccy => {
      const holdings = state.holdings
        .filter(h => h.currency === ccy)
        .slice()
        .sort((a, b) =>
          holdingValueTwd(b.shares, b.price, b.currency, fx) - holdingValueTwd(a.shares, a.price, a.currency, fx)
        )
      const cash = state.cash_accounts.filter(c => c.currency === ccy)

      if (holdings.length === 0 && cash.length === 0) return null

      const totalTwd =
        holdings.reduce((s, h) => s + holdingValueTwd(h.shares, h.price, h.currency, fx), 0) +
        cash.reduce((s, c) => s + (ccy === 'USD' ? c.amount * fx : c.amount), 0)

      // Native-currency total for the footer (matches brokerage/bank app display)
      const nativeTotal =
        holdings.reduce((s, h) => s + h.shares * h.price, 0) +
        cash.reduce((s, c) => s + c.amount, 0)

      const fmtNative = (amount: number) =>
        ccy === 'USD' ? `$${fmt(amount, 2)}` : fmt(amount, 0)

      const { color, label } = CCY_META[ccy]
      const sharesLabel = holdings.length > 0 && cash.length > 0
        ? <><span>股數</span><span className="text-emerald-600">/金額</span></>
        : cash.length > 0
          ? <span className="text-emerald-600">金額</span>
          : '股數'

      return (
        <div key={ccy} className="rounded-lg border overflow-hidden">
          {/* Section header */}
          <div
            className="flex items-center justify-between px-4 py-2.5 rounded-t-lg"
            style={{ borderLeft: `4px solid ${color}`, background: `${color}12` }}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color }}>{label}</span>
              <Badge variant="secondary" className="text-[10px] px-1 py-0">{ccy}</Badge>
            </div>
            <span className={`text-sm font-bold text-foreground ${amtClass}`}>{fmt(totalTwd / 10000, 1)} 萬</span>
          </div>

          <ColHeaders
            sharesNode={sharesLabel}
            valueLabel={`市值(${ccy})`}
          />

          {/* ETF rows — value in native currency */}
          {holdings.map((h, idx) => {
            const isLast = idx === holdings.length - 1 && cash.length === 0
            const nativeValue = h.shares * h.price
            return renderHoldingRow(h, isLast, () => <>{fmtNative(nativeValue)}</>)
          })}

          {/* Cash rows — value in native currency */}
          {cash.map((c, idx) => {
            const isLast = idx === cash.length - 1
            return renderCashRow(c, isLast, () => (
              <span className="text-emerald-600">{fmtNative(c.amount)}</span>
            ))
          })}

          {/* Footer: native-currency total for easy reconciliation */}
          <div className="flex items-center justify-between px-4 py-1.5 bg-muted/30 border-t">
            <span className="text-xs text-muted-foreground">帳戶合計</span>
            <span className={`${COL.value} tabular-nums text-xs font-bold text-foreground ${amtClass}`}>
              {fmtNative(nativeTotal)}
            </span>
          </div>
        </div>
      )
    })

  // ── P&L view ─────────────────────────────────────────────────────────────

  const renderPnlView = () => {
    const items = [...state.holdings].sort(
      (a, b) => holdingValueTwd(b.shares, b.price, b.currency, fx) - holdingValueTwd(a.shares, a.price, a.currency, fx)
    )
    const gainColor = totalUnrealizedGain >= 0 ? 'text-emerald-600' : 'text-red-500'
    return (
      <div className="rounded-lg border overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 rounded-t-lg">
          <span className="text-sm font-semibold">未實現損益（加權均攤成本法）</span>
          <span className={`text-sm font-bold ${gainColor} ${amtClass}`}>
            {totalUnrealizedGain >= 0 ? '+' : ''}{fmt(totalUnrealizedGain / 10000, 1)} 萬
          </span>
        </div>
        <div className="flex items-center px-4 py-1.5 text-xs text-muted-foreground border-b">
          <span className={COL.symbol}>代號</span>
          <span className={COL.name}>名稱</span>
          <span className={COL.shares}>股數</span>
          <span className={COL.price}>均攤成本</span>
          <span className={COL.ccy}>幣</span>
          <span className={COL.target}>損益%</span>
          <span className={COL.value}>未實現損益</span>
          <span className={`${COL.cat} block text-center`}>桶</span>
          <span className={COL.del} />
        </div>
        {items.map((h, idx) => {
          const cb = costBases[h.symbol]
          const hasData = cb && cb.totalCostTwd > 0
          const gainPct = hasData ? cb.unrealizedPct : null
          const gainTwd = hasData ? cb.unrealizedGain : null
          const pctColor = gainPct == null ? '' : gainPct >= 0 ? 'text-emerald-600' : 'text-red-500'
          const ttwdColor = gainTwd == null ? '' : gainTwd >= 0 ? 'text-emerald-600' : 'text-red-500'
          return (
            <div key={h.symbol}
              className={`flex items-center px-4 py-2 text-sm hover:bg-muted/40 transition-colors ${idx < items.length - 1 ? 'border-b' : ''}`}
            >
              <span className={`${COL.symbol} font-mono font-semibold text-xs tracking-wider`}>{h.symbol}</span>
              <span className={`${COL.name} text-xs text-muted-foreground truncate`}>{h.name}</span>
              <span className={`${COL.shares} tabular-nums text-xs ${amtClass}`}>{fmt(h.shares, 4)}</span>
              <span className={`${COL.price} tabular-nums text-xs ${amtClass}`}>
                {hasData
                  ? (h.currency === 'USD' ? `$${fmt(cb.avgCost, 2)}` : fmt(cb.avgCost, 2))
                  : <span className="text-muted-foreground/40">—</span>}
              </span>
              <span className={COL.ccy}>
                <Badge variant="secondary" className="text-[10px] px-1 py-0">{h.currency}</Badge>
              </span>
              <span className={`${COL.target} tabular-nums text-xs font-medium ${pctColor}`}>
                {gainPct == null
                  ? <span className="text-muted-foreground/40">—</span>
                  : `${gainPct >= 0 ? '+' : ''}${(gainPct * 100).toFixed(1)}%`}
              </span>
              <span className={`${COL.value} tabular-nums text-xs font-semibold ${ttwdColor} ${amtClass}`}>
                {gainTwd == null
                  ? <span className="text-muted-foreground/40">—</span>
                  : `${gainTwd >= 0 ? '+' : ''}${fmt(gainTwd / 10000, 1)} 萬`}
              </span>
              <span className={`${COL.cat} relative`}>
                {isCatEditing(h.symbol) ? (
                  <select autoFocus value={h.category}
                    onChange={e => { onUpdate(setHoldingCategory(state, h.symbol, e.target.value)); setEditing(null) }}
                    onBlur={() => setEditing(null)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 z-20 h-6 w-[120px] text-xs border rounded bg-background">
                    {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                ) : (
                  <button onClick={() => setEditing({ kind: 'holding-cat', symbol: h.symbol })}
                    title={`桶：${catMap.get(h.category)?.name ?? h.category}`}
                    className="w-3.5 h-3.5 rounded-full border border-black/10 hover:ring-2 hover:ring-offset-1 hover:ring-muted-foreground/30"
                    style={{ background: catMap.get(h.category)?.color ?? '#9ca3af' }} />
                )}
              </span>
              <span className={COL.del}>
                <button onClick={() => handleDeleteHolding(h.symbol, h.name)}
                  className="text-muted-foreground/40 hover:text-red-500 transition-colors" title="刪除">
                  <Trash2 size={13} />
                </button>
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setViewMode(v => v === 'bucket' ? 'account' : v === 'account' ? 'pnl' : 'bucket')}
          className="text-xs gap-1.5 h-7"
        >
          {viewMode === 'bucket'
            ? <><Columns2 size={13} /> 帳戶視圖</>
            : viewMode === 'account'
              ? <><TrendingUp size={13} /> 損益視圖</>
              : <><LayoutGrid size={13} /> 桶視圖</>}
        </Button>
      </div>

      {viewMode === 'bucket' ? renderBucketView() : viewMode === 'account' ? renderAccountView() : renderPnlView()}
    </div>
  )
}
