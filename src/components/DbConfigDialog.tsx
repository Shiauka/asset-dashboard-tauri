import { useState, useEffect } from 'react'
import { FolderOpen, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { invoke } from '@tauri-apps/api/core'
import type { AppState } from '@/lib/types'
import { INITIAL_STATE } from '@/lib/initialData'

interface DbStatus {
  connected: boolean
  dates: string[]
  latest: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  currentState: AppState
  rootDir: string | null
  onRootDirChange: (dir: string | null) => void
  onLoad: (state: AppState, date: string) => void
}

export default function DbConfigDialog({ open, onClose, currentState, rootDir, onRootDirChange, onLoad }: Props) {
  const [inputDir, setInputDir] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [status, setStatus] = useState<DbStatus | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (rootDir) {
      setInputDir(rootDir)
      refreshStatus(rootDir)
      return
    }
    invoke<{ rootDir?: string }>('get_db_config')
      .then(d => {
        const dir = d.rootDir ?? localStorage.getItem('asset_dashboard_rootDir') ?? ''
        setInputDir(dir)
        if (dir) refreshStatus(dir)
      })
      .catch(() => {})
  }, [open, rootDir])

  async function refreshStatus(dir?: string) {
    try {
      const body = await invoke<{ ok: boolean; dates: string[]; date: string; error?: string }>('load_snapshots')
      if (!body.ok) {
        if (dir || inputDir) {
          setStatus({ connected: false, dates: [], latest: null })
          setStatusMsg(body.error ?? '無法連接根目錄')
        }
        return
      }
      setStatus({ connected: true, dates: body.dates, latest: body.date })
      setStatusMsg(null)
    } catch (e) {
      if (dir || inputDir) {
        setStatus({ connected: false, dates: [], latest: null })
        setStatusMsg(String(e))
      }
    }
  }

  const handleSaveConfig = async () => {
    const dir = inputDir.trim()
    setSaving(true)
    setStatusMsg(null)
    try {
      await invoke('set_db_config', { rootDir: dir || null })
      onRootDirChange(dir || null)
      if (dir) {
        await refreshStatus(dir)
        setStatusMsg('根目錄已儲存')
      } else {
        setStatus(null)
        setStatusMsg('已清除根目錄設定')
      }
    } catch {
      setStatusMsg('儲存失敗')
    } finally {
      setSaving(false)
    }
  }

  const handleLoad = async () => {
    if (!confirm('確定要從根目錄載入最新資料？目前未儲存的異動將遺失。')) return
    setLoading(true)
    setStatusMsg(null)
    try {
      const body = await invoke<{ ok: boolean; state?: AppState; date?: string; error?: string }>('load_snapshots')
      if (!body.ok || !body.state) {
        setStatusMsg(body.error ?? '載入失敗')
        return
      }
      const merged = {
        ...INITIAL_STATE,
        ...body.state,
        snapshots: body.state.snapshots ?? [],
        cash_accounts: (body.state.cash_accounts ?? []).map((c) => ({
          ...c,
          target_pct: c.target_pct ?? 0,
        })),
      }
      onLoad(merged, body.date!)
      setStatusMsg(`已載入 ${body.date} 的資料`)
      await refreshStatus()
    } catch (e) {
      setStatusMsg(String(e))
    } finally {
      setLoading(false)
    }
  }

  const handleSaveNow = async () => {
    setWriting(true)
    setStatusMsg(null)
    try {
      const body = await invoke<{ ok: boolean; date?: string; error?: string }>('save_snapshot', { state: currentState })
      if (!body.ok) {
        setStatusMsg(body.error ?? '儲存失敗')
        return
      }
      setStatusMsg(`已儲存至 ${body.date}.json`)
      await refreshStatus()
    } catch (e) {
      setStatusMsg(String(e))
    } finally {
      setWriting(false)
    }
  }

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
              每次更新報價時，會自動將當日資料（台灣時間）存成該目錄下的 <code>YYYY-MM-DD.json</code>
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="例：C:\Users\eric7\Documents\asset-db"
                value={inputDir}
                onChange={e => setInputDir(e.target.value)}
                className="font-mono text-sm"
              />
              <Button variant="outline" size="sm" onClick={handleSaveConfig} disabled={saving} className="shrink-0">
                {saving ? <Loader2 size={14} className="animate-spin" /> : '儲存'}
              </Button>
            </div>
          </div>

          {status && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${status.connected ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20' : 'border-red-400 bg-red-50 dark:bg-red-950/20'}`}>
              <div className="flex items-center gap-2 font-medium">
                {status.connected
                  ? <CheckCircle2 size={15} className="text-emerald-600" />
                  : <AlertCircle size={15} className="text-red-500" />}
                {status.connected
                  ? `已連接 · 找到 ${status.dates.length} 個日期 · 最新：${status.latest}`
                  : '無法讀取根目錄'}
              </div>
              {status.connected && status.dates.length > 0 && (
                <div className="mt-2 text-xs text-muted-foreground">
                  {status.dates.slice(-5).join(' · ')}
                  {status.dates.length > 5 && ` … 共 ${status.dates.length} 天`}
                </div>
              )}
            </div>
          )}

          {statusMsg && (
            <p className="text-xs text-muted-foreground">{statusMsg}</p>
          )}

          {status?.connected && (
            <div className="flex gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={handleLoad} disabled={loading} className="flex-1">
                {loading ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
                載入最新資料（{status.latest}）
              </Button>
              <Button variant="outline" size="sm" onClick={handleSaveNow} disabled={writing} className="flex-1">
                {writing ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
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
