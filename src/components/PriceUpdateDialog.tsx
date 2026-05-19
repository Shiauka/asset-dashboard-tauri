import { useState } from 'react'
import { Globe, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { invoke } from '@tauri-apps/api/core'
import type { AppState } from '@/lib/types'
import { updateHoldingPrice, updateExchangeRate, addSnapshot } from '@/lib/store'
import { totalAssetsTwd } from '@/lib/calc'

interface Props {
  open: boolean
  onClose: () => void
  state: AppState
  onUpdate: (s: AppState) => void
}

export default function PriceUpdateDialog({ open, onClose, state, onUpdate }: Props) {
  const [fx, setFx] = useState(String(state.exchange_rate))
  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(state.holdings.map(h => [h.symbol, String(h.price)]))
  )
  const [fetching, setFetching] = useState(false)
  const [fetchStatus, setFetchStatus] = useState<string | null>(null)

  const handleOpen = () => {
    setFx(String(state.exchange_rate))
    setPrices(Object.fromEntries(state.holdings.map(h => [h.symbol, String(h.price)])))
    setFetchStatus(null)
  }

  const handleAutoFetch = async () => {
    setFetching(true)
    setFetchStatus(null)
    try {
      const data = await invoke<{
        prices: Record<string, number | null>
        exchange_rate: number | null
        errors: string[]
      }>('fetch_prices', {
        holdings: state.holdings.map(h => ({ symbol: h.symbol, currency: h.currency })),
      })

      const newPrices = { ...prices }
      let updated = 0
      for (const [symbol, price] of Object.entries(data.prices)) {
        if (price !== null) {
          newPrices[symbol] = String(price)
          updated++
        }
      }
      setPrices(newPrices)

      if (data.exchange_rate !== null) setFx(String(data.exchange_rate))

      const fxStatus = data.exchange_rate !== null ? '台銀匯率 ✓' : '台銀匯率取得失敗'
      const failList = data.errors.length > 0 ? `，${data.errors.join('、')} 失敗` : ''
      setFetchStatus(`已更新 ${updated}/${state.holdings.length} 個股價，${fxStatus}${failList}`)
    } catch {
      setFetchStatus('自動抓取失敗，請手動輸入')
    } finally {
      setFetching(false)
    }
  }

  const handleSave = () => {
    let next = state
    const fxN = parseFloat(fx)
    if (!isNaN(fxN) && fxN > 0) next = updateExchangeRate(next, fxN)

    for (const [symbol, priceStr] of Object.entries(prices)) {
      const p = parseFloat(priceStr)
      if (!isNaN(p) && p > 0) next = updateHoldingPrice(next, symbol, p)
    }

    const total = totalAssetsTwd(next)
    next = addSnapshot(next, total)
    onUpdate(next)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (v) handleOpen(); else onClose() }}>
      <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>更新報價</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center gap-3 pb-2 border-b">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleAutoFetch}
              disabled={fetching}
            >
              {fetching
                ? <Loader2 size={14} className="mr-1.5 animate-spin" />
                : <Globe size={14} className="mr-1.5" />}
              {fetching ? '抓取中…' : '自動抓取市價'}
            </Button>
          </div>
          {fetchStatus && (
            <p className={`text-xs ${fetchStatus.includes('失敗') ? 'text-red-500' : 'text-emerald-600'}`}>
              {fetchStatus}
            </p>
          )}
          <div className="flex items-center gap-3 pb-2 border-b">
            <span className="text-sm font-medium w-24 shrink-0">1 USD =</span>
            <Input type="number" step="0.01" className="h-8 text-sm" value={fx}
              onChange={e => setFx(e.target.value)} />
            <span className="text-sm text-muted-foreground shrink-0">TWD</span>
          </div>

          <p className="text-xs text-muted-foreground">持倉現價（點擊欄位修改）</p>
          <div className="space-y-2">
            {state.holdings.map(h => (
              <div key={h.symbol} className="flex items-center gap-3">
                <span className="font-mono text-sm font-semibold w-16 shrink-0">{h.symbol}</span>
                <span className="text-xs text-muted-foreground flex-1 truncate">{h.name}</span>
                <Input
                  type="number" step="0.01" className="h-8 text-sm w-28 text-right"
                  value={prices[h.symbol] ?? ''}
                  onChange={e => setPrices(p => ({ ...p, [h.symbol]: e.target.value }))}
                />
                <span className="text-xs text-muted-foreground w-8 shrink-0">{h.currency}</span>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleSave}>儲存並記錄快照</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
