import { useState, useEffect, useCallback } from 'react'
import { FolderOpen, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invoke } from '@tauri-apps/api/core'

interface DbStatus {
  connected: boolean
  dates?: number
  latest?: string | null
  problems?: string[]
  error?: string
}

interface Props {
  open: boolean
  onClose: () => void
  rootDir: string | null
  // 換資料夾：由主畫面重新從新資料夾載入（不可把舊資料夾的畫面狀態寫進新資料夾）
  onRootDirChange: (dir: string | null) => Promise<void>
  // 載入與存檔一律走主畫面同一套受保護的流程（版本檢查、壞檔保護）
  onReload: () => Promise<void>
  onSaveNow: () => Promise<void>
}

export default function DbConfigDialog({ open, onClose, rootDir, onRootDirChange, onReload, onSaveNow }: Props) {
  const [inputDir, setInputDir] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // 只讀：不同步、不寫任何檔案
  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await invoke<DbStatus>('db_status'))
    } catch (e) {
      setStatus({ connected: false, error: String(e) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setStatusMsg(null)
    setInputDir(rootDir ?? '')
    if (rootDir) void refreshStatus()
    else setStatus(null)
  }, [open, rootDir, refreshStatus])

  const run = async (job: () => Promise<void>) => {
    setBusy(true)
    try { await job() } finally { setBusy(false); await refreshStatus() }
  }

  const handleSaveConfig = () => run(async () => {
    const dir = inputDir.trim()
    setStatusMsg(null)
    if (dir && dir === rootDir) { setStatusMsg('路徑沒有變更'); return }
    if (dir) {
      try {
        const r = await invoke<{ exists: boolean }>('ensure_root_dir', { path: dir, create: false })
        if (!r.exists) {
          if (!confirm(`資料夾不存在：
${dir}

要建立這個新資料夾嗎？（如果你原本的資料在別的位置，請按取消並確認路徑）`)) return
          await invoke('ensure_root_dir', { path: dir, create: true })
        }
      } catch (e) {
        setStatusMsg(String(e))
        return
      }
    }
    try {
      await invoke('set_db_config', { rootDir: dir || null })
    } catch (e) {
      setStatusMsg(`設定儲存失敗：${String(e)}`)
      return
    }
    await onRootDirChange(dir || null)
    setStatusMsg(dir ? '已切換資料夾並重新載入' : '已清除根目錄設定')
  })

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen size={18} />
            資料庫根目錄設定
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>根目錄路徑</Label>
            <p className="text-xs text-muted-foreground">
              資料存在這個資料夾：<code>snapshots\YYYY-MM.json</code>（每日快照）、<code>transactions.json</code>（交易）。
              程式每天會自動備份到 <code>backup\daily\</code>（保留 14 天）。
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="例：D:\我的資產資料"
                value={inputDir}
                onChange={e => setInputDir(e.target.value)}
                className="font-mono text-sm"
              />
              <Button variant="outline" size="sm" onClick={handleSaveConfig} disabled={busy} className="shrink-0">
                {busy ? <Loader2 size={14} className="animate-spin" /> : '儲存'}
              </Button>
            </div>
          </div>

          {status && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${status.connected && !status.problems?.length ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20' : 'border-red-400 bg-red-50 dark:bg-red-950/20'}`}>
              <div className="flex items-center gap-2 font-medium">
                {status.connected && !status.problems?.length
                  ? <CheckCircle2 size={15} className="text-emerald-600" />
                  : <AlertCircle size={15} className="text-red-500" />}
                {status.connected
                  ? (status.dates ? `已連接 · ${status.dates} 天的資料 · 最新：${status.latest}` : '已連接 · 資料夾還沒有資料')
                  : (status.error ?? '無法讀取根目錄')}
              </div>
              {!!status.problems?.length && (
                <ul className="mt-2 list-disc pl-5 text-xs text-red-700 dark:text-red-300">
                  {status.problems.map(p => <li key={p}>{p}</li>)}
                </ul>
              )}
            </div>
          )}

          {statusMsg && <p className="text-xs text-muted-foreground">{statusMsg}</p>}

          {status?.connected && (
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => run(onReload)} disabled={busy} className="flex-1">
                從資料夾重新載入
              </Button>
              <Button variant="outline" size="sm" onClick={() => run(onSaveNow)} disabled={busy} className="flex-1">
                立即存今日資料
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>關閉</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
