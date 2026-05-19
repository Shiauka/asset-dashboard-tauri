'use client'

import { useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { DailySnapshot, Category, Holding, CashAccount } from '@/lib/types'
import { CATEGORY_META } from '@/lib/calc'

interface Props {
  snapshots: DailySnapshot[]
  blurred?: boolean
  holdings: Holding[]
  cashAccounts: CashAccount[]
}

type Period = 'daily' | 'weekly' | 'monthly'
type ViewMode = 'total' | 'bucket' | 'holding'

const BUCKET_KEYS: Category[] = ['core', 'aggressive', 'global', 'alternative', 'defensive']

function isoWeekKey(date: string): string {
  const d = new Date(date)
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const week = Math.ceil(((d.getTime() - jan4.getTime()) / 86400000 + jan4.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function aggregate(snapshots: DailySnapshot[], period: Period): DailySnapshot[] {
  if (period === 'daily') return snapshots
  const map = new Map<string, DailySnapshot>()
  for (const s of snapshots) {
    const key = period === 'weekly' ? isoWeekKey(s.date) : s.date.slice(0, 7)
    map.set(key, s)
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
}

const fmtWan = (n: number) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 10000)

const fmtPct = (n: number) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n)

export default function HistoryChart({ snapshots, blurred = false, holdings, cashAccounts }: Props) {
  const [period, setPeriod] = useState<Period>('daily')
  const [viewMode, setViewMode] = useState<ViewMode>('total')
  const [selectedSymbol, setSelectedSymbol] = useState<string>('')

  const allItems = [
    ...holdings.map(h => ({ id: h.symbol, label: `${h.symbol}　${h.name}` })),
    ...cashAccounts.map(c => ({ id: c.bank, label: c.bank })),
  ]
  const activeSymbol = selectedSymbol || allItems[0]?.id || ''

  const agg = aggregate(snapshots ?? [], period)

  const data = agg.map(s => {
    const label = period === 'monthly' ? s.date.slice(0, 7) : s.date.slice(5)
    if (viewMode === 'total') {
      return { date: s.date, label, total: s.total_twd }
    }
    if (viewMode === 'bucket') {
      const row: Record<string, string | number | null> = { date: s.date, label }
      for (const key of BUCKET_KEYS) row[key] = s.bucket_pct?.[key] ?? null
      return row
    }
    return { date: s.date, label, value: s.holdings_twd?.[activeSymbol] ?? null, shares: s.holdings_shares?.[activeSymbol] ?? null }
  })

  const PERIODS: { key: Period; label: string }[] = [
    { key: 'daily', label: '每日' },
    { key: 'weekly', label: '每週' },
    { key: 'monthly', label: '每月' },
  ]

  const VIEW_MODES: { key: ViewMode; label: string }[] = [
    { key: 'total', label: '總資產' },
    { key: 'bucket', label: '資產比例' },
    { key: 'holding', label: '個股走勢' },
  ]

  if (!snapshots || snapshots.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        尚無快照資料。每次在「更新報價」儲存後會自動記錄當日資產。
      </div>
    )
  }

  const btn = (active: boolean) =>
    `px-3 py-1 text-sm rounded-md border transition-colors ${active ? 'bg-slate-800 text-white border-slate-800' : 'border-input hover:bg-muted'}`

  return (
    <div className="space-y-3">
      {/* View mode */}
      <div className="flex gap-1.5 flex-wrap">
        {VIEW_MODES.map(m => (
          <button key={m.key} onClick={() => setViewMode(m.key)} className={btn(viewMode === m.key)}>
            {m.label}
          </button>
        ))}
      </div>

      {/* Holding selector */}
      {viewMode === 'holding' && (
        <select
          value={activeSymbol}
          onChange={e => setSelectedSymbol(e.target.value)}
          className="text-sm border border-input rounded-md px-2 py-1.5 bg-background w-full max-w-xs"
        >
          {allItems.map(item => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      )}

      {/* Period */}
      <div className="flex gap-1.5">
        {PERIODS.map(p => (
          <button key={p.key} onClick={() => setPeriod(p.key)} className={btn(period === p.key)}>
            {p.label}
          </button>
        ))}
      </div>

      <div className={blurred ? 'blur-sm select-none' : ''}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
            {viewMode === 'bucket' ? (
              <YAxis
                tickFormatter={v => `${fmtPct(v)}%`}
                domain={[0, 60]}
                width={52}
                tick={{ fontSize: 11 }}
              />
            ) : (
              <YAxis
                tickFormatter={v => `${fmtWan(v)}萬`}
                width={68}
                tick={{ fontSize: 11 }}
              />
            )}
            <Tooltip
              formatter={(v, name, item) => {
                if (v === null || v === undefined) return ['—', name]
                if (viewMode === 'bucket') {
                  return [`${fmtPct(Number(v))}%`, CATEGORY_META[name as Category]?.name ?? name]
                }
                if (viewMode === 'holding') {
                  const shares = (item as { payload?: { shares?: number | null } }).payload?.shares
                  const sharesStr = shares != null ? ` (${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 4 }).format(shares)} 股)` : ''
                  return [`${fmtWan(Number(v))} 萬 TWD${sharesStr}`, activeSymbol]
                }
                return [`${fmtWan(Number(v))} 萬 TWD`, '總資產']
              }}
              labelFormatter={label => `日期：${label}`}
            />
            {viewMode === 'bucket' && (
              <Legend formatter={v => CATEGORY_META[v as Category]?.name ?? v} />
            )}

            {viewMode === 'total' && (
              <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2}
                dot={data.length < 60} connectNulls />
            )}
            {viewMode === 'bucket' && BUCKET_KEYS.map(key => (
              <Line key={key} type="monotone" dataKey={key}
                stroke={CATEGORY_META[key].color} strokeWidth={2}
                dot={data.length < 60} connectNulls />
            ))}
            {viewMode === 'holding' && (
              <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2}
                dot={data.length < 60} connectNulls />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-xs text-muted-foreground text-right">{data.length} 筆資料</p>
    </div>
  )
}
