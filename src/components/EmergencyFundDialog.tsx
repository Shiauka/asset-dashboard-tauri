'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ShieldCheck, AlertTriangle } from 'lucide-react'
import type { AppState, EmergencyFund } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  state: AppState
  onSave: (ef: EmergencyFund) => void
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

export default function EmergencyFundDialog({ open, onClose, state, onSave }: Props) {
  const current = state.emergency_fund
  const [amountWan, setAmountWan] = useState('')
  const [ids, setIds] = useState<string[]>([])

  useEffect(() => {
    if (open) {
      setAmountWan(current?.target_twd ? String(current.target_twd / 10000) : '')
      setIds(current?.account_ids ?? [])
    }
  }, [open, current])

  const fx = state.exchange_rate
  const accTwd = (id: string) => {
    const c = state.cash_accounts.find(a => a.id === id)
    if (!c) return 0
    return c.currency === 'USD' ? c.amount * fx : c.amount
  }

  const target = (parseFloat(amountWan) || 0) * 10000
  const source = ids.reduce((s, id) => s + accTwd(id), 0)
  const funded = target > 0 ? Math.min(target, source) : 0
  const shortfall = Math.max(0, target - source)
  const valid = target >= 0 && !Number.isNaN(target)

  const toggle = (id: string) =>
    setIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-emerald-600" />
            緊急備用金
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground leading-relaxed">
            這是一筆<b>釘住的絕對金額</b>，不參與配置比例計算——其他資產的目標 % 加總仍然是 100%，
            只是分母改成「可配置資產」（總資產 − 已到位的備用金）。
            總資產卡片仍然顯示完整淨值，績效（TWR）也照算，不受影響。
          </p>

          <div className="grid grid-cols-3 gap-2 items-center">
            <Label className="text-right">備用金金額</Label>
            <div className="col-span-2 flex items-center gap-2">
              <Input
                value={amountWan}
                onChange={e => setAmountWan(e.target.value)}
                placeholder="100"
                inputMode="decimal"
              />
              <span className="text-sm text-muted-foreground whitespace-nowrap">萬 TWD</span>
            </div>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">
              認列帳戶（這筆錢實際放在哪，決定「到位/缺口」怎麼算）
            </Label>
            <div className="mt-2 space-y-1 rounded-lg border p-2">
              {state.cash_accounts.length === 0 && (
                <div className="text-xs text-muted-foreground px-1 py-2">尚未建立任何現金帳戶</div>
              )}
              {state.cash_accounts.map(c => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted cursor-pointer text-sm"
                >
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    className="accent-emerald-600"
                  />
                  <span className="flex-1">{c.bank}</span>
                  {c.type === 'savings_insurance' && (
                    <span className="text-[10px] text-amber-600 border border-amber-300 rounded px-1">
                      儲蓄險・不建議
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {fmt(accTwd(c.id))}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {target > 0 && (
            <div className="rounded-lg bg-muted p-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">認列帳戶合計</span>
                <span className="font-medium tabular-nums">{fmt(source)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">目前到位</span>
                <span className="font-medium tabular-nums">
                  {fmt(funded)} / {fmt(target)}
                </span>
              </div>
              {shortfall > 0 ? (
                <div className="border-t pt-1.5 mt-1.5 flex items-center gap-1.5 text-amber-600">
                  <AlertTriangle size={14} />
                  <span className="text-xs">
                    缺口 {fmt(shortfall)}——認列帳戶的錢不夠，只會扣掉實際有的 {fmt(funded)}
                  </span>
                </div>
              ) : (
                <div className="border-t pt-1.5 mt-1.5 flex items-center gap-1.5 text-emerald-600">
                  <ShieldCheck size={14} />
                  <span className="text-xs">已足額</span>
                </div>
              )}
            </div>
          )}

          {target > 0 && ids.length === 0 && (
            <div className="flex items-center gap-1.5 text-xs text-amber-600">
              <AlertTriangle size={14} />
              沒有勾選任何認列帳戶，備用金會被視為 0（不會扣任何錢）
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={!valid}
            onClick={() => {
              onSave({ target_twd: Math.max(0, target), account_ids: ids })
              onClose()
            }}
          >
            儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
