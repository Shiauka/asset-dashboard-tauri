'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Transaction, Holding, CashAccount } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  transaction: Transaction | null
  onSubmit: (id: string, updates: Partial<Transaction>) => void
  holdings: Holding[]
  cashAccounts: CashAccount[]
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

const TYPE_LABELS: Record<string, string> = {
  buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出',
  new_position: '建立股票', new_cash_account: '建立現金',
}
const TYPE_COLORS: Record<string, string> = {
  buy: 'text-emerald-600', sell: 'text-red-500',
  cash_in: 'text-blue-500', cash_out: 'text-orange-500',
  new_position: 'text-purple-600', new_cash_account: 'text-indigo-600',
}

export default function EditTransactionDialog({ open, onClose, transaction: tx, onSubmit, holdings, cashAccounts }: Props) {
  const [date, setDate] = useState('')
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [commission, setCommission] = useState('')
  const [bank, setBank] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!tx) return
    setDate(tx.date)
    setShares(tx.shares !== undefined ? String(tx.shares) : '')
    setPrice(tx.price !== undefined ? String(tx.price) : '')
    setAmount(String(tx.amount))
    setCommission(tx.commission !== undefined ? String(tx.commission) : '')
    setBank(tx.bank ?? '')
    setNote(tx.note ?? '')
  }, [tx])

  if (!tx) return null

  const isStockTx = tx.type === 'buy' || tx.type === 'sell'
  const isCashTx = tx.type === 'cash_in' || tx.type === 'cash_out'
  const isNewPos = tx.type === 'new_position'

  const matchingAccounts = cashAccounts.filter(c => c.currency === tx.currency)

  const recalc = (s: string, p: string) => {
    const sN = parseFloat(s), pN = parseFloat(p)
    if (!isNaN(sN) && !isNaN(pN)) setAmount((sN * pN).toFixed(2))
  }

  const handleSubmit = () => {
    const updates: Partial<Transaction> = {
      date,
      amount: parseFloat(amount) || tx.amount,
      note: note || undefined,
    }
    if (isStockTx || isNewPos) {
      updates.shares = parseFloat(shares) || tx.shares
      updates.price = parseFloat(price) || tx.price
    }
    if (isStockTx) {
      updates.commission = parseFloat(commission) || undefined
      updates.bank = bank && bank !== '__none' ? bank : undefined
    }
    onSubmit(tx.id, updates)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            編輯交易
            <span className={`text-sm font-medium ${TYPE_COLORS[tx.type] ?? ''}`}>
              {TYPE_LABELS[tx.type] ?? tx.type}
            </span>
            {(tx.symbol || tx.bank) && (
              <span className="text-sm text-muted-foreground font-mono">
                {tx.symbol || tx.bank}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Row label="日期">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </Row>

          {(isStockTx || isNewPos) && (
            <>
              <Row label="股數">
                <Input type="number" step="0.0001" value={shares}
                  onChange={e => { setShares(e.target.value); recalc(e.target.value, price) }} />
              </Row>
              <Row label="成交價">
                <div className="flex gap-2 items-center">
                  <Input type="number" step="0.01" value={price}
                    onChange={e => { setPrice(e.target.value); recalc(shares, e.target.value) }} />
                  <span className="text-sm text-muted-foreground w-10 shrink-0">{tx.currency}</span>
                </div>
              </Row>
            </>
          )}

          <Row label="金額">
            <div className="flex gap-2 items-center">
              <Input type="number" step="0.01" value={amount}
                onChange={e => setAmount(e.target.value)} />
              <span className="text-sm text-muted-foreground w-10 shrink-0">{tx.currency}</span>
            </div>
          </Row>

          {isStockTx && (
            <>
              <Row label="手續費" sublabel="選填">
                <div className="flex gap-2 items-center">
                  <Input type="number" step="0.01" placeholder="0" value={commission}
                    onChange={e => setCommission(e.target.value)} />
                  <span className="text-sm text-muted-foreground w-10 shrink-0">{tx.currency}</span>
                </div>
              </Row>

              <Row label={tx.type === 'buy' ? '扣款帳戶' : '入帳帳戶'} sublabel="選填">
                <Select value={bank || '__none'} onValueChange={setBank}>
                  <SelectTrigger>
                    <SelectValue placeholder="不連動現金帳戶" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">不連動</SelectItem>
                    {matchingAccounts.map(c => (
                      <SelectItem key={c.id} value={c.bank}>
                        <span className="font-medium">{c.bank.split(' ')[0]}</span>
                        {c.bank.includes(' ') && (
                          <span className="text-xs ml-1 text-muted-foreground">
                            {c.bank.split(' ').slice(1).join(' ')}
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            </>
          )}

          {isCashTx && (
            <Row label="帳戶">
              <span className="text-sm font-medium px-2">{tx.bank}</span>
            </Row>
          )}

          <Row label="備註" sublabel="選填">
            <Input placeholder="" value={note} onChange={e => setNote(e.target.value)} />
          </Row>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSubmit}>確認修改</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
