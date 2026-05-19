'use client'

import { useMemo, useState } from 'react'
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, ReferenceDot,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { AppState } from '@/lib/types'
import { computeTWR, requiredAnnualReturn, totalAssetsTwd } from '@/lib/calc'

const fmt = (n: number, d = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)
const fmtWan = (twd: number) => `${fmt(Math.round(twd / 10000))} 萬`
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`

// Future value: annual compounding with annual PMT
function fv(pv: number, rate: number, years: number, pmt: number): number {
  if (Math.abs(rate) < 1e-9) return pv + pmt * years
  const g = Math.pow(1 + rate, years)
  return pv * g + pmt * (g - 1) / rate
}

// Future value: monthly compounding with monthly PMT
function fvMonthly(pv: number, annualRate: number, months: number, monthlyPmt: number): number {
  const r = Math.pow(1 + annualRate, 1 / 12) - 1
  if (Math.abs(r) < 1e-9) return pv + monthlyPmt * months
  const g = Math.pow(1 + r, months)
  return pv * g + monthlyPmt * (g - 1) / r
}

interface ChartPoint {
  year: number
  actual?: number     // 萬 TWD, historical snapshots
  projected?: number  // 萬 TWD, future projection at expected return
}

export default function RetirementProgressPanel({ state, blurred }: { state: AppState; blurred: boolean }) {
  const [milestoneView, setMilestoneView] = useState<'yearly' | 'monthly'>('yearly')

  const B = ({ children }: { children: React.ReactNode }) =>
    blurred ? <span className="blur-sm select-none">{children}</span> : <>{children}</>

  const computed = useMemo(() => {
    const total = totalAssetsTwd(state)
    const { target_amount_twd, monthly_contribution_wan, expected_annual_return, birth_year, retirement_age } = state.retirement
    const monthlyContrib = monthly_contribution_wan * 10000
    const annualContrib  = monthlyContrib * 12
    const target_year    = birth_year + retirement_age

    const today       = new Date()
    const currentYear = today.getFullYear()
    const yearsLeft   = target_year - currentYear

    const projRate = expected_annual_return

    // TWR from actual portfolio history (for comparison display)
    const twr = computeTWR(state.snapshots ?? [], state.transactions, state.exchange_rate)
    const actualReturn = twr?.annualized ?? null

    // Required annual return to hit target by retirement year
    const reqReturn = yearsLeft > 0
      ? requiredAnnualReturn(total, target_amount_twd, yearsLeft, annualContrib)
      : null

    // Find the year when growth curve crosses the target (intersection = freedom date)
    let freedomYear: number | null = null
    for (let y = 0; y <= 80; y++) {
      if (fv(total, projRate, y, annualContrib) >= target_amount_twd) {
        freedomYear = currentYear + y
        break
      }
    }

    const yearsAheadBehind = freedomYear != null ? target_year - freedomYear : null

    // Latest snapshot value per year
    const snapsByYear: Record<number, number> = {}
    for (const snap of [...(state.snapshots ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
      snapsByYear[parseInt(snap.date.slice(0, 4))] = snap.total_twd
    }

    // Chart range: earliest snapshot year → max(target_year+2, freedomYear+2)
    const firstYear = Math.min(...Object.keys(snapsByYear).map(Number), currentYear)
    const lastYear  = Math.max(
      target_year + 2,
      freedomYear != null ? freedomYear + 2 : target_year + 2,
    )
    const targetWan = Math.round(target_amount_twd / 10000)

    const chartData: ChartPoint[] = []
    for (let year = firstYear; year <= lastYear; year++) {
      const point: ChartPoint = { year }
      if (snapsByYear[year] != null) {
        point.actual = Math.round(snapsByYear[year] / 10000)
      } else if (year === currentYear) {
        point.actual = Math.round(total / 10000)
      }
      if (year >= currentYear) {
        const n = year - currentYear
        point.projected = Math.round(fv(total, projRate, n, annualContrib) / 10000)
      }
      chartData.push(point)
    }

    // Freedom year intersection point for the chart dot
    const freedomWan = freedomYear != null
      ? Math.round(fv(total, projRate, freedomYear - currentYear, annualContrib) / 10000)
      : null

    // Milestone rows: current year → max(target_year+2, freedomYear+1)
    const milestoneEnd = Math.max(target_year + 2, freedomYear != null ? freedomYear + 1 : target_year + 2)
    const milestones = chartData.filter(p => p.year >= currentYear && p.year <= milestoneEnd && p.projected != null)

    // Monthly milestones: next 24 months
    const baseYear  = today.getFullYear()
    const baseMonth = today.getMonth() + 1
    const monthlyMilestones = Array.from({ length: 24 }, (_, i) => {
      const m = i + 1
      const absMonth = baseMonth + m - 1
      const y = baseYear + Math.floor(absMonth / 12) + (absMonth % 12 === 0 ? -1 : 0)
      const mo = ((absMonth - 1) % 12) + 1
      const label = `${y}-${String(mo).padStart(2, '0')}`
      const projected = Math.round(fvMonthly(total, projRate, m, monthlyContrib) / 10000)
      return { month: label, projected }
    })

    return {
      total, target_amount_twd, target_year, birth_year, retirement_age,
      monthly_contribution_wan, annualContrib,
      projRate, actualReturn, reqReturn,
      freedomYear, yearsAheadBehind, freedomWan,
      chartData, milestones, monthlyMilestones, targetWan,
      progress: (total / target_amount_twd) * 100,
      yearsLeft,
    }
  }, [state])

  const {
    total, target_amount_twd, target_year, retirement_age,
    monthly_contribution_wan, annualContrib,
    projRate, actualReturn, reqReturn,
    freedomYear, yearsAheadBehind, freedomWan,
    chartData, milestones, monthlyMilestones, targetWan,
    progress, yearsLeft,
  } = computed

  return (
    <div className="space-y-4">

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">目前進度</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{progress.toFixed(1)}%</p>
            <div className="mt-1.5 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full transition-all"
                style={{ width: `${Math.min(progress, 100)}%` }} />
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              目標 <B>{fmtWan(target_amount_twd)}</B>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">預計財務自由年份</CardTitle>
          </CardHeader>
          <CardContent>
            {freedomYear != null ? (
              <>
                <p className="text-2xl font-bold">{freedomYear} 年</p>
                {yearsAheadBehind != null && (
                  <Badge
                    variant={yearsAheadBehind >= 0 ? 'default' : 'destructive'}
                    className="mt-1.5 text-xs"
                  >
                    {yearsAheadBehind > 0
                      ? `退休前 ${yearsAheadBehind} 年達成`
                      : yearsAheadBehind === 0
                        ? '剛好退休年達成'
                        : `落後退休年 ${Math.abs(yearsAheadBehind)} 年`}
                  </Badge>
                )}
              </>
            ) : (
              <p className="text-2xl font-bold text-muted-foreground">無法達成</p>
            )}
            <p className="text-xs text-muted-foreground mt-1">退休目標 {target_year} 年（{retirement_age} 歲）</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">預期 vs 歷史年化</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{(projRate * 100).toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground mt-1">
              {actualReturn != null ? (
                <span className={actualReturn >= projRate ? 'text-emerald-600' : 'text-amber-500'}>
                  歷史 TWR {fmtPct(actualReturn)}
                </span>
              ) : (
                <span>歷史資料累積中</span>
              )}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">距目標缺口</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              <B>{fmtWan(target_amount_twd - total)}</B>
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              剩 {yearsLeft} 年 · 月存 <B>{monthly_contribution_wan} 萬</B>
              {reqReturn != null && (
                <span className={`ml-1 font-medium ${reqReturn > 0.15 ? 'text-red-500' : reqReturn > 0.08 ? 'text-amber-500' : 'text-emerald-600'}`}>
                  · 需 {(reqReturn * 100).toFixed(1)}%
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Trajectory chart ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">退休軌跡圖</CardTitle>
          <p className="text-xs text-muted-foreground">
            藍線：歷史實際資產｜綠虛線：成長曲線（預期 {(projRate * 100).toFixed(1)}% 年化）｜紅橫線：財務自由目標金額｜灰縱線：退休目標年
            {freedomYear != null && <span className="ml-1 font-medium text-emerald-600">· 兩線交叉 = {freedomYear} 年達成財務自由</span>}
          </p>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={chartData} margin={{ left: 8, right: 16, top: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis
                tickFormatter={v => `${fmt(Number(v))}萬`}
                tick={{ fontSize: 11 }}
                width={64}
              />
              <Tooltip
                formatter={(v: unknown, name: unknown) => {
                  const labels: Record<string, string> = { actual: '實際資產', projected: '成長曲線' }
                  const key = String(name)
                  const val = blurred ? '***' : `${fmt(Number(v))} 萬`
                  return [val, labels[key] ?? key]
                }}
                labelFormatter={v => `${v} 年`}
              />
              <Legend
                formatter={v =>
                  ({ actual: '歷史實際', projected: `成長曲線（${(projRate * 100).toFixed(1)}%）` } as Record<string, string>)[v] ?? v
                }
              />
              {/* Financial freedom target line */}
              <ReferenceLine
                y={targetWan}
                stroke="#ef4444"
                strokeDasharray="6 3"
                label={{ value: `財務自由目標 ${fmt(targetWan)}萬`, fontSize: 10, fill: '#ef4444', position: 'insideTopLeft' }}
              />
              {/* Retirement age reference line */}
              <ReferenceLine
                x={target_year}
                stroke="#94a3b8"
                strokeDasharray="4 4"
                label={{ value: `退休 ${target_year}`, fontSize: 10, fill: '#94a3b8', position: 'insideTopRight' }}
              />
              {/* Historical actual */}
              <Line
                type="monotone"
                dataKey="actual"
                stroke="#3b82f6"
                strokeWidth={2.5}
                dot={false}
                connectNulls={false}
              />
              {/* Projected growth curve */}
              <Line
                type="monotone"
                dataKey="projected"
                stroke="#10b981"
                strokeWidth={2}
                strokeDasharray="8 4"
                dot={false}
                connectNulls={false}
              />
              {/* Intersection dot */}
              {freedomYear != null && freedomWan != null && (
                <ReferenceDot
                  x={freedomYear}
                  y={freedomWan}
                  r={7}
                  fill="#10b981"
                  stroke="#fff"
                  strokeWidth={2}
                  label={{ value: `${freedomYear}`, fontSize: 10, fill: '#10b981', position: 'insideTopRight' }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* ── Milestone table ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {milestoneView === 'yearly' ? '年度里程碑' : '月度里程碑（未來 24 個月）'}
            </CardTitle>
            <div className="flex rounded-md border overflow-hidden text-xs">
              <button
                onClick={() => setMilestoneView('yearly')}
                className={`px-3 py-1 transition-colors ${milestoneView === 'yearly' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              >
                年度
              </button>
              <button
                onClick={() => setMilestoneView('monthly')}
                className={`px-3 py-1 transition-colors ${milestoneView === 'monthly' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              >
                月度
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {milestoneView === 'yearly' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-1.5 pr-4">年份</th>
                    <th className="text-right pr-4">預測資產</th>
                    <th className="text-right">與目標缺口</th>
                  </tr>
                </thead>
                <tbody>
                  {milestones.map(p => {
                    const gap = (p.projected ?? 0) - targetWan
                    const isFreedomYear  = p.year === freedomYear
                    const isRetirementYear = p.year === target_year
                    return (
                      <tr
                        key={p.year}
                        className={`border-b hover:bg-muted/30 ${isRetirementYear ? 'bg-blue-50 dark:bg-blue-950/20 font-medium' : ''}`}
                      >
                        <td className="py-1.5 pr-4">
                          {p.year}
                          {isRetirementYear && (
                            <Badge variant="outline" className="ml-2 text-xs">退休目標</Badge>
                          )}
                          {isFreedomYear && !isRetirementYear && (
                            <Badge className="ml-2 text-xs bg-emerald-600">財務自由</Badge>
                          )}
                          {isFreedomYear && isRetirementYear && (
                            <Badge className="ml-2 text-xs bg-emerald-600">財務自由</Badge>
                          )}
                        </td>
                        <td className="text-right pr-4">
                          <B>{fmt(p.projected ?? 0)} 萬</B>
                        </td>
                        <td className={`text-right font-medium ${gap >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                          <B>{gap >= 0 ? '+' : ''}{fmt(gap)} 萬</B>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-1.5 pr-4">月份</th>
                    <th className="text-right pr-4">預測資產</th>
                    <th className="text-right">與目標缺口</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyMilestones.map(m => {
                    const gap = m.projected - targetWan
                    return (
                      <tr key={m.month} className="border-b hover:bg-muted/30">
                        <td className="py-1.5 pr-4 font-medium">{m.month}</td>
                        <td className="text-right pr-4"><B>{fmt(m.projected)} 萬</B></td>
                        <td className={`text-right font-medium ${gap >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                          <B>{gap >= 0 ? '+' : ''}{fmt(gap)} 萬</B>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground px-1">
        成長曲線以預期年化報酬 {(projRate * 100).toFixed(1)}% + 月存 {monthly_contribution_wan} 萬（年存 {Math.round(annualContrib / 10000)} 萬）計算。
        月度里程碑採月複利計算。本預測為估算值，非投資建議。
      </p>
    </div>
  )
}
