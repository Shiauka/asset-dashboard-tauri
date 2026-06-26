'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, BarChart, Bar, Cell,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { AppState } from '@/lib/types'
import { computeTWR, computeTaxSummary } from '@/lib/calc'

const fmt = (n: number, d = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)

const fmtPct = (n: number | null) =>
  n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`

// Investment P/L in 萬 (TWD/10000) with explicit sign
const fmtGain = (n: number) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n) / 10000, 1)} 萬`

function GainBadge({ value, blurred }: { value: number | null; blurred: boolean }) {
  if (value == null) return null
  const color = value >= 0 ? 'text-emerald-600' : 'text-red-500'
  return (
    <p className={`text-sm font-semibold mt-0.5 ${color}`}>
      {blurred ? '***' : fmtGain(value)}
    </p>
  )
}

function GainLabel({ value, blurred }: { value: number | null; blurred: boolean }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>
  if (blurred) return <span className="text-xs text-muted-foreground">***</span>
  const color = value >= 0 ? 'text-emerald-600' : 'text-red-500'
  return <span className={`text-xs font-medium ${color}`}>{fmtGain(value)}</span>
}

function ReturnBadge({ value, target, compareTarget = false }: { value: number | null; target?: number; compareTarget?: boolean }) {
  if (value == null) return <span className="text-muted-foreground text-2xl font-bold">—</span>
  const t = target ?? 0
  const color = compareTarget
    ? value >= t ? 'text-emerald-600' : value >= t * 0.8 ? 'text-amber-500' : 'text-red-500'
    : value >= 0 ? 'text-emerald-600' : 'text-red-500'
  return <span className={`text-2xl font-bold ${color}`}>{fmtPct(value)}</span>
}

function SmallReturnLabel({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">—</span>
  const color = value >= 0 ? 'text-emerald-600' : 'text-red-500'
  return <span className={`text-xs font-medium ${color}`}>{fmtPct(value)}</span>
}

// Downsample to ~80 points for chart performance
function downsample<T>(arr: T[], max = 80): T[] {
  if (arr.length <= max) return arr
  const step = Math.floor(arr.length / max)
  return arr.filter((_, i) => i % step === 0 || i === arr.length - 1)
}

export default function TwrPanel({ state, blurred }: { state: AppState; blurred: boolean }) {
  const TARGET = state.retirement?.expected_annual_return ?? 0.117
  const [breakdownView, setBreakdownView] = useState<'yearly' | 'monthly'>('yearly')

  const twr = useMemo(
    () => computeTWR(state.snapshots ?? [], state.transactions, state.exchange_rate),
    [state.snapshots, state.transactions, state.exchange_rate],
  )

  const taxSummary = useMemo(
    () => computeTaxSummary(state.transactions, state.exchange_rate),
    [state.transactions, state.exchange_rate],
  )

  if (!twr) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-muted-foreground">
          需要至少 2 個不同日期的快照才能計算報酬率。
          <br />
          <span className="text-xs mt-2 block">每次開啟 Dashboard 會自動新增今日快照。</span>
        </CardContent>
      </Card>
    )
  }

  const chartData  = downsample(twr.series)
  const yearlyBar  = twr.yearlyReturns.map(y  => ({ ...y,  pct: parseFloat((y.return  * 100).toFixed(2)) }))
  const monthlyBar = twr.monthlyReturns.map(m => ({ ...m,  pct: parseFloat((m.return  * 100).toFixed(2)) }))

  // Tooltip text: "+12.34%（+5.6 萬）" — hide the amount when blurred
  const barLabel = (v: unknown, p: { payload?: { gain?: number } } | undefined) => {
    const n = Number(v)
    const g = p?.payload?.gain
    const amt = blurred || g == null ? '' : `（${fmtGain(g)}）`
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%${amt}`
  }
  // Only show last 24 months in the bar chart to avoid overcrowding
  const monthlyBarTrimmed = monthlyBar.slice(-24)

  return (
    <div className="space-y-4">

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">年化報酬率 (TWR)</CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnBadge value={twr.annualized} target={TARGET} compareTarget />
            <p className="text-xs text-muted-foreground mt-1">目標 +{(TARGET * 100).toFixed(1)}%</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">累計報酬率</CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnBadge value={twr.twr} />
            <GainBadge value={twr.totalGain} blurred={blurred} />
            <p className="text-xs text-muted-foreground mt-1">持倉 {twr.days} 天</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">今年報酬 (YTD)</CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnBadge value={twr.ytdReturn} />
            <GainBadge value={twr.ytdGain} blurred={blurred} />
            <p className="text-xs text-muted-foreground mt-1">{new Date().getFullYear()} 年至今</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">近一年報酬</CardTitle>
          </CardHeader>
          <CardContent>
            <ReturnBadge value={twr.oneYearReturn} />
            <GainBadge value={twr.oneYearGain} blurred={blurred} />
            <p className="text-xs text-muted-foreground mt-1">過去 365 天</p>
          </CardContent>
        </Card>
      </div>

      {/* NAV growth chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">投資組合 NAV 成長曲線（起始值 = 100）</CardTitle>
          <p className="text-xs text-muted-foreground">
            時間加權報酬率（TWR）排除現金存入 / 提出的影響，反映純投資決策績效
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ left: 4, right: 16, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11 }}
                tickFormatter={d => String(d).slice(0, 7)}
                interval="preserveStartEnd"
              />
              <YAxis
                domain={['auto', 'auto']}
                tickFormatter={v => Number(v).toFixed(0)}
                tick={{ fontSize: 11 }}
                width={42}
              />
              <Tooltip
                formatter={(v: unknown) => [blurred ? '***' : Number(v).toFixed(2), 'NAV']}
                labelFormatter={d => `日期：${d}`}
              />
              <ReferenceLine y={100} stroke="#94a3b8" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="nav" stroke="#3b82f6" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Yearly / Monthly breakdown */}
      {(yearlyBar.length > 0 || monthlyBarTrimmed.length > 0) && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                {breakdownView === 'yearly' ? '各年度報酬率' : '各月度報酬率（近 24 個月）'}
              </CardTitle>
              <div className="flex rounded-md border overflow-hidden text-xs">
                <button
                  onClick={() => setBreakdownView('yearly')}
                  className={`px-3 py-1 transition-colors ${breakdownView === 'yearly' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  年度
                </button>
                <button
                  onClick={() => setBreakdownView('monthly')}
                  className={`px-3 py-1 transition-colors ${breakdownView === 'monthly' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  月度
                </button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {breakdownView === 'yearly' ? (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={yearlyBar} margin={{ left: 4, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={v => `${Number(v).toFixed(0)}%`} tick={{ fontSize: 11 }} width={42} />
                    <Tooltip
                      formatter={(v: unknown, _n: unknown, p: { payload?: { gain?: number } }) =>
                        [barLabel(v, p), '年度報酬']}
                    />
                    <ReferenceLine
                      y={TARGET * 100}
                      stroke="#f59e0b"
                      strokeDasharray="4 4"
                      label={{ value: `目標 ${(TARGET * 100).toFixed(1)}%`, fontSize: 10, fill: '#f59e0b', position: 'insideTopRight' }}
                    />
                    <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                      {yearlyBar.map((y, i) => (
                        <Cell key={i} fill={y.return >= 0 ? '#3b82f6' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-xs">
                        <th className="text-left py-1.5 pr-4">年度</th>
                        <th className="text-right pr-4">年初資產</th>
                        <th className="text-right pr-4">年末資產</th>
                        <th className="text-right pr-4">損益金額</th>
                        <th className="text-right">年度報酬</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...twr.yearlyReturns].reverse().map(y => (
                        <tr key={y.year} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 pr-4 font-medium">{y.year}</td>
                          <td className="text-right pr-4 text-muted-foreground">
                            {blurred ? '***' : `${fmt(y.startValue / 10000, 1)} 萬`}
                          </td>
                          <td className="text-right pr-4">
                            {blurred ? '***' : `${fmt(y.endValue / 10000, 1)} 萬`}
                          </td>
                          <td className="text-right pr-4"><GainLabel value={y.gain} blurred={blurred} /></td>
                          <td className="text-right"><SmallReturnLabel value={y.return} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={monthlyBarTrimmed} margin={{ left: 4, right: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                    <YAxis tickFormatter={v => `${Number(v).toFixed(0)}%`} tick={{ fontSize: 11 }} width={42} />
                    <Tooltip
                      formatter={(v: unknown, _n: unknown, p: { payload?: { gain?: number } }) =>
                        [barLabel(v, p), '月度報酬']}
                    />
                    <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
                    <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                      {monthlyBarTrimmed.map((m, i) => (
                        <Cell key={i} fill={m.return >= 0 ? '#3b82f6' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-xs">
                        <th className="text-left py-1.5 pr-4">月份</th>
                        <th className="text-right pr-4">月初資產</th>
                        <th className="text-right pr-4">月末資產</th>
                        <th className="text-right pr-4">損益金額</th>
                        <th className="text-right">月度報酬</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...twr.monthlyReturns].reverse().slice(0, 24).map(m => (
                        <tr key={m.month} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 pr-4 font-medium">{m.month}</td>
                          <td className="text-right pr-4 text-muted-foreground">
                            {blurred ? '***' : `${fmt(m.startValue / 10000, 1)} 萬`}
                          </td>
                          <td className="text-right pr-4">
                            {blurred ? '***' : `${fmt(m.endValue / 10000, 1)} 萬`}
                          </td>
                          <td className="text-right pr-4"><GainLabel value={m.gain} blurred={blurred} /></td>
                          <td className="text-right"><SmallReturnLabel value={m.return} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Methodology note */}
      <p className="text-xs text-muted-foreground px-1">
        TWR 僅將 <strong>cash_in / cash_out</strong> 視為外部現金流並排除其影響；stock_dividend 屬組合內部收益不排除。
        <strong>損益金額</strong>＝期末資產−期初資產−當期淨存入，反映純投資績效帶來的實際金額變化。
        USD 現金流以快照時匯率換算（2026-06-26 前的舊快照以當前匯率近似）。
        觀測期：{twr.startDate} → {twr.endDate}（{twr.days} 天）
      </p>

      {/* Tax summary */}
      {(taxSummary.entries.length > 0 || taxSummary.totalDividendIncome > 0) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">稅務紀錄（已實現損益 + 股息）</CardTitle>
            <p className="text-xs text-muted-foreground">
              加權均攤成本法（WAC）；USD 損益以當前匯率換算（近似值）
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* By-year summary table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-1.5 pr-4">年度</th>
                    <th className="text-right pr-4">已實現損益</th>
                    <th className="text-right pr-4">股息收入</th>
                    <th className="text-right">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(taxSummary.byYear)
                    .sort((a, b) => b[0].localeCompare(a[0]))
                    .map(([year, data]) => {
                      const total = data.realizedGain + data.dividendIncome
                      return (
                        <tr key={year} className="border-b hover:bg-muted/30">
                          <td className="py-1.5 pr-4 font-medium">{year}</td>
                          <td className={`text-right pr-4 ${data.realizedGain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {blurred ? '***' : (data.realizedGain !== 0 ? fmtGain(data.realizedGain) : '—')}
                          </td>
                          <td className="text-right pr-4 text-emerald-600">
                            {blurred ? '***' : (data.dividendIncome > 0 ? fmtGain(data.dividendIncome) : '—')}
                          </td>
                          <td className={`text-right font-medium ${total >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {blurred ? '***' : fmtGain(total)}
                          </td>
                        </tr>
                      )
                    })}
                  <tr className="font-semibold bg-muted/10">
                    <td className="py-1.5 pr-4">合計</td>
                    <td className={`text-right pr-4 ${taxSummary.totalRealizedGain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                      {blurred ? '***' : (taxSummary.totalRealizedGain !== 0 ? fmtGain(taxSummary.totalRealizedGain) : '—')}
                    </td>
                    <td className="text-right pr-4 text-emerald-600">
                      {blurred ? '***' : (taxSummary.totalDividendIncome > 0 ? fmtGain(taxSummary.totalDividendIncome) : '—')}
                    </td>
                    <td className={`text-right ${(taxSummary.totalRealizedGain + taxSummary.totalDividendIncome) >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                      {blurred ? '***' : fmtGain(taxSummary.totalRealizedGain + taxSummary.totalDividendIncome)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Sell detail entries */}
            {taxSummary.entries.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground pt-1">賣出明細</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="text-left py-1 pr-3">日期</th>
                        <th className="text-left pr-3">代號</th>
                        <th className="text-right pr-3">股數</th>
                        <th className="text-right pr-3">均攤成本</th>
                        <th className="text-right pr-3">賣出價</th>
                        <th className="text-right">已實現損益</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...taxSummary.entries].reverse().map((e, i) => (
                        <tr key={i} className="border-b hover:bg-muted/20">
                          <td className="py-1 pr-3 text-muted-foreground">{e.date}</td>
                          <td className="pr-3 font-mono font-semibold">{e.symbol}</td>
                          <td className="text-right pr-3">{e.shares}</td>
                          <td className={`text-right pr-3 ${blurred ? '' : ''}`}>
                            {blurred ? '***' : (e.currency === 'USD' ? `$${e.avgCost.toFixed(2)}` : fmt(e.avgCost, 2))}
                          </td>
                          <td className="text-right pr-3">
                            {e.currency === 'USD' ? `$${e.salePrice.toFixed(2)}` : fmt(e.salePrice, 2)}
                          </td>
                          <td className={`text-right font-medium ${e.realizedGain >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                            {blurred ? '***' : fmtGain(e.realizedGain)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
