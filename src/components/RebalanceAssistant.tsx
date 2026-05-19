'use client'

import { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { AppState } from '@/lib/types'
import { computeNewMoneyAllocation, totalAssetsTwd } from '@/lib/calc'

const fmt = (n: number, d = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)

export default function RebalanceAssistant({ state, blurred }: { state: AppState; blurred: boolean }) {
  const [amount, setAmount]     = useState('')
  const [currency, setCurrency] = useState<'TWD' | 'USD'>('TWD')
  const [submitted, setSubmitted] = useState(false)

  const B = ({ children }: { children: React.ReactNode }) =>
    blurred ? <span className="blur-sm select-none">{children}</span> : <>{children}</>

  const newMoneyTwd = useMemo(() => {
    const n = parseFloat(amount)
    if (!isFinite(n) || n <= 0) return 0
    return currency === 'USD' ? n * state.exchange_rate : n
  }, [amount, currency, state.exchange_rate])

  const result = useMemo(() => {
    if (!submitted || newMoneyTwd <= 0) return null
    return computeNewMoneyAllocation(state, newMoneyTwd)
  }, [submitted, newMoneyTwd, state])

  const handleCalculate = () => {
    if (newMoneyTwd > 0) setSubmitted(true)
  }

  const handleReset = () => {
    setSubmitted(false)
    setAmount('')
  }

  const total = totalAssetsTwd(state)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">新資金分配助手</CardTitle>
        <p className="text-xs text-muted-foreground">
          輸入本次要投入的金額，自動計算補足各桶缺口的最佳分配——只買不賣，以大桶偏離為優先：整體桶位已達標則跳過桶內個股，優先補足偏離最大的欠配桶。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* ── Input row ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={currency} onValueChange={v => { setCurrency(v as 'TWD' | 'USD'); setSubmitted(false) }}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="TWD">TWD</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
            </SelectContent>
          </Select>

          <Input
            type="number"
            min={0}
            placeholder={currency === 'TWD' ? '例：500000' : '例：10000'}
            value={amount}
            onChange={e => { setAmount(e.target.value); setSubmitted(false) }}
            onKeyDown={e => e.key === 'Enter' && handleCalculate()}
            className="w-48"
          />

          {currency === 'USD' && amount && parseFloat(amount) > 0 && (
            <span className="text-xs text-muted-foreground">
              ≈ {fmt(parseFloat(amount) * state.exchange_rate)} TWD
            </span>
          )}

          <Button onClick={handleCalculate} disabled={newMoneyTwd <= 0}>計算分配</Button>
          {submitted && <Button variant="ghost" size="sm" onClick={handleReset}>重設</Button>}
        </div>

        {/* ── Result ── */}
        {result && (
          <div className="space-y-3">
            {/* Summary */}
            <div className="flex items-center gap-3 flex-wrap text-sm">
              <span className="text-muted-foreground">投入</span>
              <span className="font-semibold text-emerald-600">
                <B>
                  {currency === 'USD'
                    ? `$${fmt(parseFloat(amount), 0)} USD`
                    : `${fmt(newMoneyTwd)} TWD`}
                </B>
              </span>
              <span className="text-muted-foreground">→ 投入後總資產</span>
              <span className="font-semibold"><B>{fmt(result.new_total_twd / 10000, 1)} 萬 TWD</B></span>
              {result.unallocated_twd > 0 && (
                <Badge variant="outline" className="text-amber-600 border-amber-400">
                  餘 {fmt(result.unallocated_twd / 10000, 1)} 萬 → 建議放防禦桶
                </Badge>
              )}
            </div>

            {/* Allocation table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground text-xs">
                    <th className="text-left py-2 pr-4">標的</th>
                    <th className="text-right pr-4">目前持倉</th>
                    <th className="text-right pr-4">目標%</th>
                    <th className="text-right pr-4">建議投入 (TWD)</th>
                    <th className="text-right pr-4">建議股數</th>
                    <th className="text-right pr-4">投入後比例</th>
                    <th className="text-center pl-2">狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map(r => {
                    const newValue    = r.current_value_twd + r.buy_amount_twd
                    const newPct      = result.new_total_twd > 0 ? (newValue / result.new_total_twd) * 100 : 0
                    const pctDelta    = newPct - r.target_pct
                    const pctColor    = Math.abs(pctDelta) < 0.5
                      ? 'text-emerald-600'
                      : Math.abs(pctDelta) < 2 ? 'text-amber-500' : 'text-red-500'

                    return (
                      <tr key={r.symbol} className={`border-b hover:bg-muted/30 ${r.is_overweight ? 'opacity-40' : ''}`}>
                        <td className="py-2 pr-4 font-medium">
                          {r.symbol}
                          <span className="text-xs text-muted-foreground ml-1">{r.name}</span>
                        </td>
                        <td className="text-right pr-4 text-muted-foreground text-xs">
                          <B>{fmt(r.current_value_twd / 10000, 1)} 萬</B>
                        </td>
                        <td className="text-right pr-4 text-muted-foreground">
                          {r.target_pct > 0 ? `${r.target_pct}%` : '—'}
                        </td>
                        <td className="text-right pr-4 font-semibold text-emerald-600">
                          {r.buy_amount_twd > 0
                            ? <B>+{fmt(r.buy_amount_twd / 10000, 2)} 萬</B>
                            : <span className="text-muted-foreground font-normal">—</span>}
                        </td>
                        <td className="text-right pr-4 font-mono text-sm">
                          {r.buy_shares != null && r.buy_amount_twd > 0 ? (
                            <B>
                              {r.currency === 'TWD'
                                ? `${fmt(r.buy_shares)} 股`
                                : `${r.buy_shares >= 1
                                    ? fmt(r.buy_shares)
                                    : r.buy_shares.toFixed(4)} 股`}
                            </B>
                          ) : r.is_defensive && r.buy_amount_twd > 0 ? (
                            <span className="text-xs text-muted-foreground">存入現金/SGOV</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className={`text-right pr-4 text-xs font-medium ${pctColor}`}>
                          {newPct.toFixed(1)}%
                          <span className="text-muted-foreground font-normal ml-1">
                            ({pctDelta >= 0 ? '+' : ''}{pctDelta.toFixed(1)}%)
                          </span>
                        </td>
                        <td className="text-center pl-2">
                          {r.is_overweight ? (
                            <Badge variant="secondary" className="text-xs">超配跳過</Badge>
                          ) : r.buy_amount_twd > 0 ? (
                            <Badge className="text-xs bg-emerald-600">買入</Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">平衡</Badge>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>

                {/* Total row */}
                <tfoot>
                  <tr className="border-t-2 font-semibold text-sm">
                    <td className="py-2 pr-4" colSpan={3}>合計投入</td>
                    <td className="text-right pr-4 text-emerald-600">
                      <B>+{fmt((newMoneyTwd - result.unallocated_twd) / 10000, 2)} 萬</B>
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Note */}
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <p>· 台股以整張（1,000 股）為單位，美股以整股為單位。</p>
              <p>· 防禦桶建議：優先補 SGOV（USD），再補台幣活存。</p>
              <p>· 目前持倉比例以即時報價計算，每日開盤後略有變動。</p>
              {result.unallocated_twd > 0 && (
                <p className="text-amber-600">
                  · 各桶已接近平衡，餘 <B>{fmt(result.unallocated_twd / 10000, 1)} 萬</B> 建議放入防禦桶（SGOV 或台幣現金）。
                </p>
              )}
            </div>
          </div>
        )}

        {/* Empty state hint */}
        {!submitted && (
          <p className="text-xs text-muted-foreground pt-1">
            目前總資產 <B>{fmt(total / 10000, 1)} 萬 TWD</B>｜輸入金額後按「計算分配」
          </p>
        )}
      </CardContent>
    </Card>
  )
}
