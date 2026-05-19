'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { RetirementSettings } from '@/lib/types'
import { requiredAnnualReturn } from '@/lib/calc'

interface Props {
  open: boolean
  onClose: () => void
  current: RetirementSettings
  currentTotal: number
  onSave: (s: RetirementSettings) => void
}

function Row({ label, sublabel, children }: { label: string; sublabel?: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 items-center">
      <Label className="text-right leading-tight">
        {label}
        {sublabel && <span className="block text-xs font-normal text-muted-foreground">{sublabel}</span>}
      </Label>
      <div className="col-span-2">{children}</div>
    </div>
  )
}

export default function RetirementDialog({ open, onClose, current, currentTotal, onSave }: Props) {
  const [birthYear,      setBirthYear]      = useState(String(current.birth_year))
  const [retirementAge,  setRetirementAge]  = useState(String(current.retirement_age))
  const [amountWan,      setAmountWan]      = useState(String(current.target_amount_twd / 10000))
  const [monthlyWan,     setMonthlyWan]     = useState(String(current.monthly_contribution_wan))
  const [expectedReturn, setExpectedReturn] = useState(String(+(current.expected_annual_return * 100).toFixed(2)))

  useEffect(() => {
    if (open) {
      setBirthYear(String(current.birth_year))
      setRetirementAge(String(current.retirement_age))
      setAmountWan(String(current.target_amount_twd / 10000))
      setMonthlyWan(String(current.monthly_contribution_wan))
      setExpectedReturn(String(+(current.expected_annual_return * 100).toFixed(2)))
    }
  }, [open, current])

  const currentYear = new Date().getFullYear()
  const bYear  = parseInt(birthYear)
  const rAge   = parseInt(retirementAge)
  const a      = parseFloat(amountWan)
  const mc     = parseFloat(monthlyWan) || 0
  const er     = parseFloat(expectedReturn)

  const targetYear     = bYear + rAge
  const currentAge     = currentYear - bYear
  const yearsLeft      = targetYear - currentYear
  const fvTarget       = a * 10000
  const monthlyPmt     = mc * 10000
  const annualPmt      = monthlyPmt * 12
  const expectedDecimal = er / 100

  const canSave = !isNaN(bYear) && bYear >= 1920 && bYear <= currentYear
    && !isNaN(rAge) && rAge >= 30 && rAge <= 99
    && !isNaN(a) && a > 0
    && !isNaN(er) && er > 0

  const reqReturn = canSave && yearsLeft > 0 && currentTotal > 0
    ? requiredAnnualReturn(currentTotal, fvTarget, yearsLeft, annualPmt)
    : null

  const handleSave = () => {
    if (!canSave) return
    onSave({
      birth_year:             bYear,
      retirement_age:         rAge,
      target_amount_twd:      fvTarget,
      monthly_contribution_wan: mc,
      expected_annual_return: expectedDecimal,
    })
    onClose()
  }

  const fmt = (n: number) => new Intl.NumberFormat('zh-TW').format(Math.round(n))

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>退休軌跡設定</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Read-only: current total assets */}
          <div className="rounded-lg bg-muted/50 px-3 py-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">目前的總資產</span>
            <span className="font-semibold">{fmt(currentTotal)} TWD</span>
          </div>

          <Row label="出生年份">
            <Input type="number" min={1920} max={currentYear} step={1} placeholder="如 1990"
              value={birthYear} onChange={e => setBirthYear(e.target.value)} />
          </Row>

          <Row label="預計退休年齡" sublabel="歲">
            <div className="flex items-center gap-2">
              <Input type="number" min={30} max={99} step={1} placeholder="如 55"
                value={retirementAge} onChange={e => setRetirementAge(e.target.value)} />
              <span className="text-sm text-muted-foreground whitespace-nowrap">歲</span>
            </div>
          </Row>

          <Row label="目標金額" sublabel="萬 TWD">
            <div className="flex items-center gap-2">
              <Input type="number" min={1} step={100} placeholder="如 2000"
                value={amountWan} onChange={e => setAmountWan(e.target.value)} />
              <span className="text-sm text-muted-foreground whitespace-nowrap">萬</span>
            </div>
          </Row>

          <Row label="每月投入" sublabel="萬 TWD，選填">
            <div className="flex items-center gap-2">
              <Input type="number" min={0} step={0.5} placeholder="如 5"
                value={monthlyWan} onChange={e => setMonthlyWan(e.target.value)} />
              <span className="text-sm text-muted-foreground whitespace-nowrap">萬</span>
            </div>
          </Row>

          <Row label="預期年化報酬" sublabel="%">
            <div className="flex items-center gap-2">
              <Input type="number" min={0} max={30} step={0.5} placeholder="如 7"
                value={expectedReturn} onChange={e => setExpectedReturn(e.target.value)} />
              <span className="text-sm text-muted-foreground whitespace-nowrap">%</span>
            </div>
          </Row>

          {canSave && (
            <div className="rounded-lg bg-muted p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">目前年齡</span>
                <span className="font-medium">{currentAge} 歲</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">退休目標年份</span>
                <span className="font-medium">{targetYear} 年（距今 {yearsLeft} 年）</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">目標金額</span>
                <span className="font-medium">{fmt(fvTarget)} TWD</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">月存 / 年存</span>
                <span className="font-medium">{fmt(monthlyPmt)} / {fmt(annualPmt)}</span>
              </div>
              {reqReturn !== null && yearsLeft > 0 && (
                <div className="border-t pt-1.5 mt-1.5 flex justify-between items-center">
                  <span className="text-muted-foreground">達標需年化報酬</span>
                  <span className={`text-lg font-bold ${reqReturn > 0.15 ? 'text-red-500' : reqReturn > 0.08 ? 'text-amber-500' : 'text-emerald-600'}`}>
                    {(reqReturn * 100).toFixed(1)}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={!canSave}>儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
