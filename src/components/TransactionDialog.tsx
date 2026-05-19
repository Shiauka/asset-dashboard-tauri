'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Holding, CashAccount, Transaction, TxType, Currency, Category } from '@/lib/types'
import { CATEGORY_META } from '@/lib/calc'
import { getTaiwanToday } from '@/lib/dateUtils'

interface Props {
  open: boolean
  onClose: () => void
  onSubmit: (tx: Transaction & { category?: Category; holdingName?: string; accountType?: 'bank' | 'savings_insurance' }) => void
  holdings: Holding[]
  cashAccounts: CashAccount[]
}

const CATEGORY_KEYS = Object.keys(CATEGORY_META) as Category[]

const TYPE_LABELS: Record<TxType, string> = {
  buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出',
  new_position: '建立股票部位', new_cash_account: '建立現金帳戶', transfer: '帳戶轉帳',
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

function AccountSelect({
  accounts, value, onChange, placeholder = '選擇帳戶',
}: { accounts: CashAccount[]; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {accounts.map(c => (
          <SelectItem key={c.id} value={c.bank}>
            <span className="font-medium">{c.bank.split(' ')[0]}</span>
            {c.bank.includes(' ') && (
              <span className="text-xs ml-1 text-muted-foreground">{c.bank.split(' ').slice(1).join(' ')}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type MainType = 'buy' | 'sell' | 'cash_in' | 'cash_out'
const MAIN_TYPES: MainType[] = ['buy', 'sell', 'cash_in', 'cash_out']
const MAIN_LABELS: Record<MainType, string> = { buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出' }

export default function TransactionDialog({ open, onClose, onSubmit, holdings, cashAccounts }: Props) {
  const [txType, setTxType] = useState<TxType>('buy')

  const [date, setDate] = useState(getTaiwanToday)
  const [note, setNote] = useState('')

  // 股票買賣
  const [symbol, setSymbol] = useState('')
  const [shares, setShares] = useState('')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [commission, setCommission] = useState('')
  const [currency, setCurrency] = useState<Currency>('USD')
  const [cashBank, setCashBank] = useState('')

  // 現金入出
  const [bank, setBank] = useState('')
  const [cashAmount, setCashAmount] = useState('')
  const [cashCurrency, setCashCurrency] = useState<Currency>('TWD')

  // 建立股票部位
  const [newSymbol, setNewSymbol] = useState('')
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<Category>('core')
  const [newCurrency, setNewCurrency] = useState<Currency>('USD')
  const [newShares, setNewShares] = useState('')
  const [newPrice, setNewPrice] = useState('')
  const [newTargetPct, setNewTargetPct] = useState('')

  // 建立現金帳戶
  const [newBankName, setNewBankName] = useState('')
  const [newBankCurrency, setNewBankCurrency] = useState<Currency>('TWD')
  const [newBankAmount, setNewBankAmount] = useState('')
  const [newBankType, setNewBankType] = useState<'bank' | 'savings_insurance'>('bank')

  // 帳戶轉帳
  const [transferFrom, setTransferFrom] = useState('')
  const [transferTo, setTransferTo] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [transferAmountTo, setTransferAmountTo] = useState('')

  const isStockTx = txType === 'buy' || txType === 'sell'
  const isCashTx = txType === 'cash_in' || txType === 'cash_out'
  const isNewPos = txType === 'new_position'
  const isNewCash = txType === 'new_cash_account'
  const isTransfer = txType === 'transfer'
  const isCreate = isNewPos || isNewCash

  const fromAccount = cashAccounts.find(c => c.bank === transferFrom)
  const toAccount = cashAccounts.find(c => c.bank === transferTo)
  const fromCurrency = fromAccount?.currency ?? 'TWD'
  const toCurrency = toAccount?.currency ?? 'TWD'
  const isCrossCurrency = !!transferFrom && !!transferTo && fromCurrency !== toCurrency

  const matchingAccounts = cashAccounts.filter(c => c.currency === currency)

  const recalc = (s: string, p: string) => {
    const sN = parseFloat(s), pN = parseFloat(p)
    if (!isNaN(sN) && !isNaN(pN)) setAmount((sN * pN).toFixed(2))
  }

  const selectHolding = (sym: string) => {
    setSymbol(sym)
    const h = holdings.find(h => h.symbol === sym)
    if (h) { setCurrency(h.currency); setPrice(String(h.price)); setCashBank('') }
  }

  const reset = () => {
    setSymbol(''); setShares(''); setPrice(''); setAmount(''); setCommission(''); setCashBank('')
    setBank(''); setCashAmount('')
    setNewSymbol(''); setNewName(''); setNewShares(''); setNewPrice(''); setNewTargetPct('')
    setNewBankName(''); setNewBankAmount('')
    setTransferFrom(''); setTransferTo(''); setTransferAmount(''); setTransferAmountTo('')
    setNote('')
  }

  const handleSubmit = () => {
    if (isStockTx) {
      const tx: Transaction & { category?: Category } = {
        id: `${Date.now()}`,
        date, type: txType, currency,
        symbol: symbol.toUpperCase(),
        shares: parseFloat(shares) || undefined,
        price: parseFloat(price) || undefined,
        amount: parseFloat(amount) || (parseFloat(shares) * parseFloat(price)) || 0,
        commission: parseFloat(commission) || undefined,
        bank: cashBank && cashBank !== '__none' ? cashBank : undefined,
        note: note || undefined,
      }
      onSubmit(tx)
    }

    if (isCashTx) {
      const tx: Transaction = {
        id: `${Date.now()}`,
        date, type: txType, currency: cashCurrency,
        bank, amount: parseFloat(cashAmount) || 0,
        note: note || undefined,
      }
      onSubmit(tx)
    }

    if (isNewPos) {
      const tx: Transaction & { category: Category; holdingName: string; target_pct?: number } = {
        id: `${Date.now()}`,
        date, type: 'new_position', currency: newCurrency,
        symbol: newSymbol.toUpperCase(),
        holdingName: newName || newSymbol.toUpperCase(),
        category: newCategory,
        shares: parseFloat(newShares) || 0,
        price: parseFloat(newPrice) || 0,
        amount: (parseFloat(newShares) || 0) * (parseFloat(newPrice) || 0),
        target_pct: parseFloat(newTargetPct) || 0,
        note: note || undefined,
      }
      onSubmit(tx)
    }

    if (isNewCash) {
      const tx: Transaction & { accountType: 'bank' | 'savings_insurance' } = {
        id: `${Date.now()}`,
        date, type: 'new_cash_account', currency: newBankCurrency,
        bank: newBankName,
        amount: parseFloat(newBankAmount) || 0,
        accountType: newBankType,
        note: note || undefined,
      }
      onSubmit(tx)
    }

    if (isTransfer) {
      const tx: Transaction = {
        id: `${Date.now()}`,
        date, type: 'transfer',
        currency: fromCurrency,
        bank: transferFrom,
        bank_to: transferTo,
        amount: parseFloat(transferAmount) || 0,
        amount_to: isCrossCurrency ? (parseFloat(transferAmountTo) || 0) : undefined,
        currency_to: isCrossCurrency ? toCurrency : undefined,
        commission: parseFloat(commission) || undefined,
        note: note || undefined,
      }
      onSubmit(tx)
    }

    reset()
    onClose()
  }

  const canSubmit =
    (isStockTx && !!symbol) ||
    (isCashTx && !!bank && !!cashAmount) ||
    (isNewPos && !!newSymbol) ||
    (isNewCash && !!newBankName) ||
    (isTransfer && !!transferFrom && !!transferTo && transferFrom !== transferTo && !!transferAmount && (!isCrossCurrency || !!transferAmountTo))

  // Active button style uses explicit slate-800 to avoid CSS-var resolution issues in Tailwind v4
  const activeBtn = 'bg-slate-800 text-white border-slate-800'
  const inactiveBtn = 'border-input bg-background hover:bg-muted text-foreground'

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新增交易</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">

          {/* 一般交易類型 */}
          <div className="grid grid-cols-4 gap-1.5">
            {MAIN_TYPES.map(t => (
              <button
                key={t}
                onClick={() => { setTxType(t); reset() }}
                className={`rounded-md py-2 text-sm font-medium border transition-colors ${
                  txType === t ? activeBtn : inactiveBtn
                }`}
              >
                {MAIN_LABELS[t]}
              </button>
            ))}
          </div>

          {/* 建立部位 / 轉帳 */}
          <div className="grid grid-cols-3 gap-1.5">
            <button
              onClick={() => { setTxType('new_position'); reset() }}
              className={`rounded-md py-2 text-sm font-medium border transition-colors ${
                isNewPos
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'border-dashed border-emerald-500 text-emerald-700 hover:bg-emerald-50'
              }`}
            >
              + 建立股票
            </button>
            <button
              onClick={() => { setTxType('transfer'); reset() }}
              className={`rounded-md py-2 text-sm font-medium border transition-colors ${
                isTransfer
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'border-dashed border-amber-400 text-amber-700 hover:bg-amber-50'
              }`}
            >
              帳戶轉帳
            </button>
            <button
              onClick={() => { setTxType('new_cash_account'); reset() }}
              className={`rounded-md py-2 text-sm font-medium border transition-colors ${
                isNewCash
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'border-dashed border-indigo-400 text-indigo-600 hover:bg-indigo-50'
              }`}
            >
              + 建立現金
            </button>
          </div>

          {/* 日期 */}
          <Row label="日期">
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </Row>

          {/* ── 買入 / 賣出 ── */}
          {isStockTx && (
            <>
              <Row label="標的">
                <Select value={symbol} onValueChange={selectHolding}>
                  <SelectTrigger><SelectValue placeholder="選擇持倉" /></SelectTrigger>
                  <SelectContent>
                    {holdings.filter(h => h.shares > 0 || txType === 'buy').map(h => (
                      <SelectItem key={h.symbol} value={h.symbol}>
                        <span className="font-mono font-medium">{h.symbol}</span>
                        <span className="text-muted-foreground text-xs ml-2">{h.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>

              <Row label="股數">
                <Input type="number" step="0.0001" placeholder="0" value={shares}
                  onChange={e => { setShares(e.target.value); recalc(e.target.value, price) }} />
              </Row>

              <Row label="成交價">
                <div className="flex gap-2">
                  <Input type="number" step="0.01" placeholder="0" value={price}
                    onChange={e => { setPrice(e.target.value); recalc(shares, e.target.value) }} />
                  <Select value={currency} onValueChange={v => { setCurrency(v as Currency); setCashBank('') }}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="TWD">TWD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Row>

              <Row label="總金額">
                <Input type="number" step="0.01" placeholder="自動計算" value={amount}
                  onChange={e => setAmount(e.target.value)} />
              </Row>

              <Row label="手續費" sublabel="選填">
                <Input type="number" step="0.01" placeholder="0" value={commission}
                  onChange={e => setCommission(e.target.value)} />
              </Row>

              <Row label={txType === 'buy' ? '扣款帳戶' : '入帳帳戶'} sublabel="選填">
                <Select value={cashBank} onValueChange={setCashBank}>
                  <SelectTrigger><SelectValue placeholder="不連動現金帳戶" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">不連動</SelectItem>
                    {matchingAccounts.map(c => (
                      <SelectItem key={c.id} value={c.bank}>
                        <span className="font-medium">{c.bank.split(' ')[0]}</span>
                        {c.bank.includes(' ') && (
                          <span className="text-xs ml-1 text-muted-foreground">{c.bank.split(' ').slice(1).join(' ')}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            </>
          )}

          {/* ── 現金入出 ── */}
          {isCashTx && (
            <>
              <Row label="帳戶">
                <AccountSelect
                  accounts={cashAccounts}
                  value={bank}
                  onChange={v => { setBank(v); const a = cashAccounts.find(c => c.bank === v); if (a) setCashCurrency(a.currency) }}
                />
              </Row>
              <Row label="金額">
                <div className="flex gap-2">
                  <Input type="number" step="0.01" placeholder="0" value={cashAmount}
                    onChange={e => setCashAmount(e.target.value)} />
                  <Select value={cashCurrency} onValueChange={v => setCashCurrency(v as Currency)}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="TWD">TWD</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Row>
            </>
          )}

          {/* ── 建立股票部位 ── */}
          {isNewPos && (
            <>
              <Row label="股票代號">
                <Input placeholder="如 NVDA、2330、VTI…" value={newSymbol}
                  onChange={e => setNewSymbol(e.target.value.toUpperCase())}
                  className="uppercase font-mono" />
              </Row>
              <Row label="名稱" sublabel="選填">
                <Input placeholder="顯示名稱（空白則同代號）" value={newName}
                  onChange={e => setNewName(e.target.value)} />
              </Row>
              <Row label="資產桶">
                <Select value={newCategory} onValueChange={v => setNewCategory(v as Category)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORY_KEYS.map(k => (
                      <SelectItem key={k} value={k}>
                        <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                          style={{ background: CATEGORY_META[k].color }} />
                        {CATEGORY_META[k].name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row label="幣別">
                <Select value={newCurrency} onValueChange={v => setNewCurrency(v as Currency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD 美元</SelectItem>
                    <SelectItem value="TWD">TWD 台幣</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="初始股數" sublabel="選填">
                <Input type="number" step="0.0001" placeholder="0" value={newShares}
                  onChange={e => setNewShares(e.target.value)} />
              </Row>
              <Row label="初始現價" sublabel="選填">
                <Input type="number" step="0.01" placeholder="0" value={newPrice}
                  onChange={e => setNewPrice(e.target.value)} />
              </Row>
              <Row label="目標%" sublabel="選填 0-100">
                <Input type="number" step="0.5" min="0" max="100" placeholder="0" value={newTargetPct}
                  onChange={e => setNewTargetPct(e.target.value)} />
              </Row>
            </>
          )}

          {/* ── 建立現金帳戶 ── */}
          {isNewCash && (
            <>
              <Row label="帳戶名稱">
                <Input
                  placeholder="如 台幣帳戶、美金帳戶"
                  value={newBankName}
                  onChange={e => setNewBankName(e.target.value)}
                />
              </Row>
              <Row label="幣別">
                <Select value={newBankCurrency} onValueChange={v => setNewBankCurrency(v as Currency)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TWD">TWD 台幣</SelectItem>
                    <SelectItem value="USD">USD 美元</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="帳戶類型">
                <Select value={newBankType} onValueChange={v => setNewBankType(v as 'bank' | 'savings_insurance')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">現金帳戶</SelectItem>
                    <SelectItem value="savings_insurance">儲蓄險</SelectItem>
                  </SelectContent>
                </Select>
              </Row>
              <Row label="初始金額" sublabel="選填">
                <Input type="number" step="0.01" placeholder="0" value={newBankAmount}
                  onChange={e => setNewBankAmount(e.target.value)} />
              </Row>
            </>
          )}

          {/* ── 帳戶轉帳 ── */}
          {isTransfer && (
            <>
              <Row label="轉出帳戶">
                <AccountSelect
                  accounts={cashAccounts}
                  value={transferFrom}
                  onChange={v => { setTransferFrom(v); setTransferAmountTo('') }}
                  placeholder="選擇來源帳戶"
                />
              </Row>
              <Row label="轉入帳戶">
                <AccountSelect
                  accounts={cashAccounts.filter(c => c.bank !== transferFrom)}
                  value={transferTo}
                  onChange={v => { setTransferTo(v); setTransferAmountTo('') }}
                  placeholder="選擇目標帳戶"
                />
              </Row>
              <Row label="轉出金額">
                <div className="flex gap-2 items-center">
                  <Input type="number" step="0.01" placeholder="0" value={transferAmount}
                    onChange={e => setTransferAmount(e.target.value)} />
                  <span className="text-sm text-muted-foreground w-10">{fromCurrency}</span>
                </div>
              </Row>
              {isCrossCurrency && (
                <Row label="到帳金額">
                  <div className="flex gap-2 items-center">
                    <Input type="number" step="0.01" placeholder="0" value={transferAmountTo}
                      onChange={e => setTransferAmountTo(e.target.value)} />
                    <span className="text-sm text-muted-foreground w-10">{toCurrency}</span>
                  </div>
                </Row>
              )}
              {isCrossCurrency && transferAmount && transferAmountTo && (
                <Row label="隱含匯率">
                  <span className="text-sm text-muted-foreground">
                    1 {toCurrency} = {(parseFloat(transferAmount) / parseFloat(transferAmountTo)).toFixed(4)} {fromCurrency}
                  </span>
                </Row>
              )}
              <Row label="手續費" sublabel="選填">
                <Input type="number" step="0.01" placeholder="0" value={commission}
                  onChange={e => setCommission(e.target.value)} />
              </Row>
            </>
          )}

          {/* 備註 */}
          <Row label="備註" sublabel="選填">
            <Input placeholder="" value={note} onChange={e => setNote(e.target.value)} />
          </Row>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>確認</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
