import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, RefreshCw, Settings, Eye, EyeOff, Download, Upload, RotateCcw, Trash2, FolderOpen, Pencil, AlertTriangle, PlayCircle, Layers, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts'
import { invoke } from '@tauri-apps/api/core'
import { loadState, saveState, resetState, clearState, isFirstRun, applyTransaction, updateRetirement, reverseTransaction, retroactivelyAdjustSnapshots, editTransaction, updateHoldingPrice, updateExchangeRate, addSnapshot, setSnapshotUnexplained } from '@/lib/store'
import { getTaiwanToday } from '@/lib/dateUtils'
import { totalAssetsTwd, assetsByCurrency, categorySummaries, rebalanceRows, categoryDrillDown, requiredAnnualReturn, totalTargetPct, getCategories, emergencyFundTwd, investableTotalTwd } from '@/lib/calc'
import { INITIAL_STATE } from '@/lib/initialData'
import { DEMO_STATE } from '@/lib/demoData'
import type { AppState, Transaction, TxType, Category, RetirementSettings, UnexplainedChange } from '@/lib/types'
import TransactionDialog from './TransactionDialog'
import RetirementDialog from './RetirementDialog'
import PriceUpdateDialog from './PriceUpdateDialog'
import HoldingsTable from './HoldingsTable'
import HistoryChart from './HistoryChart'
import DbConfigDialog from './DbConfigDialog'
import EditTransactionDialog from './EditTransactionDialog'
import TwrPanel from './TwrPanel'
import RetirementProgressPanel from './RetirementProgressPanel'
import RebalanceAssistant from './RebalanceAssistant'
import ChannelInfoDialog from './ChannelInfoDialog'
import CategorySettingsDialog from './CategorySettingsDialog'
import EmergencyFundDialog from './EmergencyFundDialog'

const fmt = (n: number, digits = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
const fmtWan = (twd: number) => `${fmt(twd / 10000, 1)} 萬`

type RetroOp = { tx: Transaction; direction: 1 | -1 }

// YYYY-MM-DD 且是真的日期（擋掉「202608-12-30」這類輸入）
const isValidDate = (d: string | undefined) => {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d
}

const EMPTY_FOLDER_NOTICE = '這個資料夾還沒有資料，目前畫面上的資料不會自動寫入。'


// 從資料夾讀回來的 state：補齊欄位；資料夾裡的資料永遠不是示範資料
const toAppState = (s: AppState): AppState => ({
  ...INITIAL_STATE,
  ...s,
  is_sample: false,
  snapshots: s.snapshots ?? [],
  cash_accounts: (s.cash_accounts ?? []).map(c => ({ ...c, target_pct: c.target_pct ?? 0 })),
})

export default function Dashboard() {
  const [state, setState] = useState<AppState | null>(null)
  const [txOpen, setTxOpen] = useState(false)
  const [retirementOpen, setRetirementOpen] = useState(false)
  const [priceOpen, setPriceOpen] = useState(false)
  const [drillCat, setDrillCat] = useState<Category | null>(null)
  const [blurred, setBlurred] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')
  const [txMonthFilter, setTxMonthFilter] = useState('')
  const [editingTx, setEditingTx] = useState<Transaction | null>(null)
  const [dbOpen, setDbOpen] = useState(false)
  const [channelOpen, setChannelOpen] = useState(false)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  const [dbRootDir, setDbRootDir] = useState<string | null>(null)
  const rootDirRef = useRef<string | null>(null)
  // ── 資料保護（2026-09-30 資料流失事件後重寫）──────────────────────────────
  // writeBlock：資料夾有問題（壞檔、找不到、被其他視窗改過…）的原因。非 null 時：
  //   所有會改資料的操作都直接擋下並說明（不再「畫面看起來存了其實沒存」），紅色橫幅不能關。
  // notices：一般提醒，可關閉。
  // revRef：讀到的資料版本；每次存檔帶上，資料夾被別人改過就拒絕，不會互相覆蓋。
  // diskQueue：所有讀寫依序執行，避免兩次存檔拿到同一個版本號。
  const [writeBlock, setWriteBlock] = useState<string | null>(null)
  const writeBlockRef = useRef<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const revRef = useRef<string | null>(null)
  const diskQueue = useRef<Promise<unknown>>(Promise.resolve())
  const dirtyRef = useRef(false)
  const saveTimer = useRef<number | null>(null)
  // 連到一個還沒有資料的資料夾：要使用者按「儲存」確認後才寫入（不能自動把畫面資料灌進去）
  const emptyFolderRef = useRef(false)
  const [busy, setBusyState] = useState(false)
  const busyRef = useRef(false)
  const setBusy = (b: boolean) => { busyRef.current = b; setBusyState(b) }
  const [dailyBackups, setDailyBackups] = useState<string[]>([])
  const [restoreDate, setRestoreDate] = useState<string>('')
  const scheduleSaveRef = useRef<(() => void) | null>(null)
  const [rebalanceCcy, setRebalanceCcy] = useState<'all' | 'TWD' | 'USD'>('all')
  const importRef = useRef<HTMLInputElement>(null)
  const resetMenuRef = useRef<HTMLDivElement>(null)
  const [showResetMenu, setShowResetMenu] = useState(false)

  const stateRef = useRef<AppState | null>(null)
  const commit = useCallback((next: AppState) => {
    stateRef.current = next
    setState(next)
    saveState(next)
  }, [])

  const block = useCallback((reason: string | null) => {
    writeBlockRef.current = reason
    setWriteBlock(reason)
  }, [])
  const notify = useCallback((msg: string) => setNotices(n => (n.includes(msg) ? n : [...n, msg])), [])
  const blockedAlert = () => alert(`目前無法儲存，這個操作沒有執行：\n\n${writeBlockRef.current}`)

  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const p = diskQueue.current.then(job, job)
    diskQueue.current = p.catch(() => {})
    return p
  }, [])

  const handleDiskError = useCallback((e: unknown) => {
    const msg = String(e)
    if (msg.startsWith('CONFLICT'))
      block('資料夾裡的資料已被其他視窗或程式修改過，為避免互相覆蓋已停止儲存。請按工具列的「從根目錄載入」取得最新資料（這個視窗裡尚未儲存的變更會被捨棄）。')
    else if (msg.includes('為保護資料已停止寫入') || msg.includes('找不到資料夾'))
      block(msg)
    else
      notify(`儲存失敗：${msg}`)
  }, [block, notify])

  type LoadBody = {
    ok?: boolean; code?: string; error?: string; state?: AppState; date?: string
    brokenFiles?: string[]; recoveredFiles?: string[]; warnings?: string[]
    cashMismatches?: { bank: string; dashboard: number; ledger: number }[]
    writeBlocked?: boolean; versionBlocked?: string | null; rev?: string; hasDailyBackup?: boolean; dailyBackups?: string[]
  }

  // 讀根目錄：設定寫入保護、提醒、版本；回傳載入的 state（沒有可用資料時為 null）
  const loadFromDisk = useCallback(async (): Promise<{ loaded: AppState | null; body: LoadBody }> => {
    const body = await enqueue(() => invoke<LoadBody>('load_snapshots'))
    revRef.current = body.rev ?? null
    emptyFolderRef.current = body.code === 'EMPTY'
    // 被較新版用過的資料夾：只能看，也不提供「從每日備份還原」（那也是寫入）
    setDailyBackups(body.versionBlocked ? [] : body.dailyBackups ?? [])
    setRestoreDate(body.versionBlocked ? '' : (body.dailyBackups ?? []).slice(-1)[0] ?? '')
    if (body.versionBlocked)
      block(body.versionBlocked)
    else if (body.brokenFiles?.length)
      block(`以下資料檔損毀或讀不到，為保護資料已停止所有儲存：${body.brokenFiles.join('、')}。\n處理方式：先確認檔案沒有被其他程式（雲端硬碟同步、防毒）佔用後按「重新載入」；若檔案真的壞了，${body.hasDailyBackup
        ? '按下方「從每日備份還原」（交易與快照會整組回到那一天，現在的檔案會先保留在 backup\\corrupt\\）'
        : '請從你自己的備份（例如雲端硬碟的「版本記錄」、外接硬碟）把整個資料夾還原到同一個時間點——交易檔與快照檔要是同一時間的，只換其中一個會讓資料對不上（這個資料夾還沒有自動備份）'}。`)
    else if (body.writeBlocked)
      block(body.error ?? '資料夾目前無法使用，已停止儲存。')
    else
      block(null)
    const msgs: string[] = []
    if (body.recoveredFiles?.length)
      msgs.push(`以下快照檔損毀，已自動用備份修復（損毀的原檔保存在 backup\\corrupt\\）：${body.recoveredFiles.join('、')}。備份可能少了最後一次存檔的內容，最近幾天的餘額或股數可能不對。${(body.dailyBackups ?? []).length
        ? '如果數字不對，可以用紅色橫幅或根目錄設定的「從每日備份還原」，把交易與快照整組回到那一天。' : ''}`)
    if (body.code === 'EMPTY')
      msgs.push(`${EMPTY_FOLDER_NOTICE}要把目前畫面上的資料存進去，請按工具列的「存至根目錄」（下載圖示）；選錯資料夾的話到根目錄設定換回來即可。`)
    for (const w of body.warnings ?? []) msgs.push(w)
    if (body.cashMismatches?.length)
      msgs.push(`現金餘額與帳務管家的帳目不一致：${body.cashMismatches.map(m => `${m.bank}（看板 ${m.dashboard.toLocaleString()}／帳目 ${m.ledger.toLocaleString()}）`).join('；')}。請核對兩邊的紀錄。`)
    setNotices(msgs)
    dirtyRef.current = false
    return { loaded: body.ok && body.state ? toAppState(body.state) : null, body }
  }, [enqueue, block])

  type SaveResult = { ok: boolean; date?: string; rev?: string; warnings?: string[]; changed?: boolean; state?: AppState; snapshots?: AppState['snapshots']; todayUnexplained?: UnexplainedChange[] | null }
  type Change = (s: AppState) => { next: AppState; retro: RetroOp[] }

  // 寫進資料夾（只在這裡呼叫 save_snapshot）：
  // - 在佇列裡「輪到時」才取最新的畫面狀態、再套用這次的變更（不會拿點擊當下的舊狀態蓋掉前一次存的結果）
  // - 後端在同一筆寫入裡做：帳務管家同步、過去日期的歷史回填、今天的快照、交易清單
  // - 沒有根目錄 / 示範資料 / 還沒確認要存進的新資料夾 → 只存本機
  // 回傳存下的 state；失敗回 null（原因已顯示）。
  const persist = useCallback((change: Change | null, background = false): Promise<AppState | null> => enqueue(async () => {
    const base = stateRef.current
    if (!base) return null
    const { next, retro } = change ? change(base) : { next: base, retro: [] as RetroOp[] }
    if (!rootDirRef.current || next.is_sample || emptyFolderRef.current) {
      if (change) commit(next)
      dirtyRef.current = false
      return next
    }
    if (writeBlockRef.current) {
      // 無法寫入時，背景更新（報價）至少讓畫面看得到；使用者操作則照常擋下
      if (background && change && stateRef.current === base) commit(next)
      return null
    }
    try {
      const r = await invoke<SaveResult>('save_snapshot', { state: next, expectedRev: revRef.current, retro })
      if (r.rev) revRef.current = r.rev
      r.warnings?.forEach(notify)
      let saved = r.state ? toAppState(r.state) : next
      if (r.snapshots) saved = { ...saved, snapshots: r.snapshots }
      if (r.date) saved = setSnapshotUnexplained(saved, r.date, r.todayUnexplained ?? undefined)
      // 使用者操作：存下的就是畫面（操作期間畫面鎖住，不會有別的變更）。
      // 背景存檔：存檔期間畫面若被改過，就不覆蓋（那次修改會自己再存一次）。
      if (stateRef.current === base || (change && !background)) {
        commit(saved)
        dirtyRef.current = false
      } else if (change && background) {
        // 背景更新（報價）存檔期間畫面被編輯過：把同樣的變更套到現在的畫面上，稍後一起存，不蓋掉編輯
        commit(change(stateRef.current!).next)
        dirtyRef.current = true
        scheduleSaveRef.current?.()
      }
      return saved
    } catch (e) {
      handleDiskError(e)
      return null
    }
  }), [enqueue, commit, notify, handleDiskError])

  // 背景存檔（切回視窗、編輯後、報價更新後）
  const backgroundSave = useCallback(async () => { await persist(null) }, [persist])

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => { saveTimer.current = null; void backgroundSave() }, 800)
  }, [backgroundSave])
  scheduleSaveRef.current = scheduleSave

  const storesToFolder = () => !!rootDirRef.current && !stateRef.current?.is_sample && !emptyFolderRef.current

  // 一般編輯（持倉表、目標比例、分類、備用金、退休設定、報價…）：套用後自動存檔
  const editState = useCallback((next: AppState) => {
    if (busyRef.current) return // 交易存檔中（畫面鎖住），不接受其他修改
    if (rootDirRef.current && writeBlockRef.current) { blockedAlert(); return }
    commit(next)
    if (storesToFolder()) dirtyRef.current = true
    scheduleSave()
  }, [commit, scheduleSave])

  // 會動到交易的操作：鎖住畫面 → 存成功才更新畫面；存不進去就不改畫面並說明
  const commitAfterSave = useCallback(async (change: Change) => {
    if (rootDirRef.current && writeBlockRef.current) { blockedAlert(); return }
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    setBusy(true)
    try {
      const saved = await persist(change)
      if (!saved) alert(`這筆變更沒有儲存：\n\n${writeBlockRef.current ?? '請看畫面上方的訊息。'}`)
    } finally {
      setBusy(false)
    }
  }, [persist])

  const refreshPrices = useCallback((base: AppState) => {
    invoke<{ prices: Record<string, number | null>; exchange_rate: number | null }>('fetch_prices', {
      holdings: base.holdings.map(h => ({ symbol: h.symbol, currency: h.currency })),
    }).then(pricesData => {
      // 排進佇列：等進行中的存檔完成後，套在「那時」最新的 state 上，再存檔
      void persist(cur => {
        let next = cur
        if (pricesData.exchange_rate !== null && pricesData.exchange_rate > 0)
          next = updateExchangeRate(next, pricesData.exchange_rate)
        for (const [sym, price] of Object.entries(pricesData.prices))
          if (price !== null && price > 0) next = updateHoldingPrice(next, sym, price)
        return { next: addSnapshot(next, totalAssetsTwd(next)), retro: [] }
      }, true)
    }).catch(() => {})
  }, [commit, backgroundSave])

  // 換根目錄：一律重新從新資料夾載入，不能把舊資料夾的畫面狀態寫進新資料夾
  const handleRootDirChange = useCallback(async (dir: string | null) => {
    if (dir === rootDirRef.current) return
    // 舊資料夾排隊中的存檔先做完（寫進舊資料夾），再切換
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; await backgroundSave() }
    await diskQueue.current
    setDbRootDir(dir)
    rootDirRef.current = dir
    revRef.current = null
    emptyFolderRef.current = false
    if (dir) localStorage.setItem('asset_dashboard_rootDir', dir)
    else localStorage.removeItem('asset_dashboard_rootDir')
    if (!dir) { block(null); setNotices([]); return }
    try {
      const { loaded } = await loadFromDisk()
      if (loaded) commit(addSnapshot(loaded, totalAssetsTwd(loaded)))
    } catch (e) {
      block(`無法讀取資料夾：${String(e)}`)
    }
  }, [loadFromDisk, block, commit, backgroundSave])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const isDemo = params.has('demo')
    const initTab = params.get('tab')
    if (initTab) setActiveTab(initTab)

    async function init() {
      if (isDemo) {
        stateRef.current = DEMO_STATE
        setState(DEMO_STATE)
        return
      }

      let rootDir: string | null = null
      try {
        const d = await invoke<{ rootDir?: string }>('get_db_config')
        rootDir = d.rootDir ?? null
      } catch {}

      if (!rootDir) {
        const cached = localStorage.getItem('asset_dashboard_rootDir')
        if (cached) {
          rootDir = cached
          try { await invoke('set_db_config', { rootDir }) } catch {}
        }
      } else {
        localStorage.setItem('asset_dashboard_rootDir', rootDir)
      }

      setDbRootDir(rootDir)
      rootDirRef.current = rootDir

      if (rootDir) {
        try {
          const { loaded } = await loadFromDisk()
          if (loaded) {
            const withSnap = addSnapshot(loaded, totalAssetsTwd(loaded))
            commit(withSnap)
            refreshPrices(withSnap)
            return
          }
          // EMPTY（新資料夾）→ 沿用本機資料、等使用者按儲存；其他狀況已經設了寫入保護與說明
        } catch (e) {
          block(`無法讀取資料夾：${String(e)}`)
        }
      }

      const local = isFirstRun() ? { ...loadState(), is_sample: true } : loadState()
      stateRef.current = local
      setState(local)
      // 示範資料已經有自己的說明橫幅，不再同時顯示「空資料夾要按存至根目錄」（兩條說法互相矛盾）
      if (local.is_sample) setNotices(ns => ns.filter(n => !n.startsWith(EMPTY_FOLDER_NOTICE)))
      if (rootDir) refreshPrices(local)
    }
    init()
  }, [commit, loadFromDisk, refreshPrices, block])

  useEffect(() => {
    if (!busy) return
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    window.addEventListener('keydown', stop, true)
    window.addEventListener('keypress', stop, true)
    return () => { window.removeEventListener('keydown', stop, true); window.removeEventListener('keypress', stop, true) }
  }, [busy])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let unlistenFocus: (() => void) | undefined
    let unlistenClose: (() => void) | undefined
    let disposed = false
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return
      const w = getCurrentWindow()
      w.onFocusChanged(({ payload: focused }) => {
        if (focused) onFocus()
      }).then(fn => { unlistenFocus = fn })
      // 關閉前把還沒存的編輯存完；存不進去要讓使用者知道再決定
      w.onCloseRequested(async ev => {
        ev.preventDefault()
        if (saveTimer.current) {
          clearTimeout(saveTimer.current)
          saveTimer.current = null
          await backgroundSave()
        }
        await diskQueue.current
        if (storesToFolder() && dirtyRef.current &&
          !confirm(`有變更還沒存進資料夾：\n\n${writeBlockRef.current ?? '存檔失敗，請看畫面上方的訊息。'}\n\n仍要關閉嗎？（這些變更只保留在本機，下次開啟會被資料夾的資料取代）`))
          return
        await w.destroy()
      }).then(fn => { unlistenClose = fn })
    }).catch(() => {})
    // 兩個視窗互相點選時，Tauri 的焦點事件不一定會來；瀏覽器層的 focus 也一起聽（1.5 秒內只觸發一次）
    let last = 0
    function onFocus() {
      const now = Date.now()
      if (now - last < 1500) return
      last = now
      if (rootDirRef.current && stateRef.current && !writeBlockRef.current) void backgroundSave()
    }
    window.addEventListener('focus', onFocus)
    const onVis = () => { if (document.visibilityState === 'visible') onFocus() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      disposed = true; unlistenFocus?.(); unlistenClose?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [backgroundSave])

  const handleTransaction = useCallback(async (tx: Transaction) => {
    if (!isValidDate(tx.date)) { alert(`日期格式不正確：「${tx.date}」。請輸入像 2026-09-30 這樣的日期。`); return }
    await commitAfterSave(base => {
      let next = applyTransaction(base, tx)
      next = retroactivelyAdjustSnapshots(next, tx)
      next = addSnapshot(next, totalAssetsTwd(next))
      return { next, retro: tx.date < getTaiwanToday() ? [{ tx, direction: 1 }] : [] }
    })
  }, [commitAfterSave])

  const handleResetToDefault = () => {
    setShowResetMenu(false)
    if (rootDirRef.current) {
      alert('已連接資料夾時無法回到範例，以免資料夾裡的資料被範例覆蓋。\n如果真的要重來，請先到「根目錄設定」清除資料夾設定。')
      return
    }
    if (!confirm('確定回到預設範例？目前本機的資料將被覆蓋。')) return
    const s = { ...resetState(), is_sample: true }
    commit(s)
  }

  const handleClearAll = () => {
    setShowResetMenu(false)
    if (rootDirRef.current && !state?.is_sample && !emptyFolderRef.current) {
      alert('已連接資料夾時無法清空，以免資料夾裡的資料被清掉。\n如果真的要重來，請先到「根目錄設定」清除資料夾設定。')
      return
    }
    if (!confirm(emptyFolderRef.current && rootDirRef.current
      ? `確定清空並開始記錄自己的資料？\n之後的記錄會寫進目前連接的資料夾：\n${rootDirRef.current}`
      : '確定清空所有資料？此操作無法復原。')) return
    commit(clearState())
    // 清空後就是使用者自己的（空白）資料：連到的是還沒有資料的資料夾時，之後的記錄直接寫進去
    if (emptyFolderRef.current) {
      emptyFolderRef.current = false
      setNotices(ns => ns.filter(n => !n.startsWith(EMPTY_FOLDER_NOTICE)))
      void persist(null)
    }
  }

  useEffect(() => {
    if (!showResetMenu) return
    const handler = (e: MouseEvent) => {
      if (resetMenuRef.current && !resetMenuRef.current.contains(e.target as Node))
        setShowResetMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showResetMenu])

  const handleDeleteTransaction = useCallback(async (id: string) => {
    const tx = stateRef.current?.transactions.find(t => t.id === id)
    if (!tx) return
    // 來自帳務管家的交易以帳務管家為準（在這裡刪，下次同步又會回來）
    if ((tx as Transaction & { budget_tx_id?: string }).budget_tx_id) {
      alert('這筆是從帳務管家同步過來的交易，請到帳務管家刪除或修改，儀表板會自動跟著更新。')
      return
    }
    const typeLabel: Record<string, string> = {
      buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出',
      new_position: '建立股票', new_cash_account: '建立現金', transfer: '帳戶轉帳',
    }
    const detail = [tx.date, tx.symbol, tx.shares ? `${tx.shares} 股` : '', tx.bank,
      tx.amount ? `金額 ${tx.amount.toLocaleString()}` : ''].filter(Boolean).join('　')
    if (!confirm(`確定刪除這筆「${typeLabel[tx.type] ?? tx.type}」紀錄並還原其對持倉的影響？

${detail}`)) return
    await commitAfterSave(base => {
      const cur = base.transactions.find(t => t.id === id)
      if (!cur) return { next: base, retro: [] }
      let next = reverseTransaction(base, id)
      next = retroactivelyAdjustSnapshots(next, cur, -1)
      next = addSnapshot(next, totalAssetsTwd(next))
      return { next, retro: cur.date < getTaiwanToday() ? [{ tx: cur, direction: -1 }] : [] }
    })
  }, [commitAfterSave])

  const handleEditSubmit = useCallback(async (id: string, updates: Partial<Transaction>) => {
    const cur = stateRef.current?.transactions.find(t => t.id === id) as (Transaction & { budget_tx_id?: string }) | undefined
    if (cur?.budget_tx_id) {
      alert('這筆是從帳務管家同步過來的交易，請到帳務管家修改，儀表板會自動跟著更新。')
      return
    }
    if (updates.date !== undefined && !isValidDate(updates.date)) {
      alert(`日期格式不正確：「${updates.date}」。請輸入像 2026-09-30 這樣的日期。`); return
    }
    if (cur && (cur.type === 'new_cash_account' || cur.type === 'new_position')) {
      const changed = (Object.keys(updates) as (keyof Transaction)[])
        .some(k => {
          if (k === 'note' || updates[k] === undefined) return false
          const a = updates[k], b = cur[k]
          return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-9 : a !== b
        })
      if (changed) {
        alert('「建立現金」「建立股票」的紀錄只能修改備註。\n\n要調整金額或股數，請另外記一筆買進／賣出或現金存入／提出；直接改這筆會把之後所有交易對它的影響蓋掉。')
        return
      }
      // 只改備註：不動持倉與歷史
      await commitAfterSave(base => {
        const result = editTransaction(base, id, { note: updates.note })
        return { next: result ? result.next : base, retro: [] }
      })
      return
    }
    await commitAfterSave(base => {
      const result = editTransaction(base, id, updates)
      if (!result) return { next: base, retro: [] }
      const { next, oldTx, newTx } = result
      let final = retroactivelyAdjustSnapshots(next, oldTx, -1)
      final = retroactivelyAdjustSnapshots(final, newTx, 1)
      final = addSnapshot(final, totalAssetsTwd(final))
      const today = getTaiwanToday()
      const retro: RetroOp[] = []
      if (oldTx.date < today) retro.push({ tx: oldTx, direction: -1 })
      if (newTx.date < today) retro.push({ tx: newTx, direction: 1 })
      return { next: final, retro }
    })
  }, [commitAfterSave])

  const handleTabChange = useCallback((newTab: string) => {
    if (activeTab === 'holdings' && newTab !== 'holdings' && state) {
      const pct = totalTargetPct(state)
      const diff = Math.abs(pct - 100)
      if (diff > 0.1) {
        const msg = pct > 100
          ? `目標%加總為 ${pct.toFixed(1)}%，已超過 100%，建議調整後再離開。`
          : `目標%加總為 ${pct.toFixed(1)}%，尚未達到 100%（差 ${(100 - pct).toFixed(1)}%），建議調整後再離開。`
        alert(`⚠️ ${msg}`)
      }
    }
    setActiveTab(newTab)
  }, [activeTab, state])

  const handleRetirementSave = (settings: RetirementSettings) => {
    if (!state) return
    editState(updateRetirement(state, settings))
  }

  const handleThresholdChange = (pct: number) => {
    if (!state) return
    editState(updateRetirement(state, { rebalance_threshold_pct: pct }))
  }

  // 手動儲存：也是「確認要把畫面資料存進新資料夾／存成正式資料」的唯一入口
  const handleExport = async () => {
    const cur = stateRef.current
    if (!cur) return
    if (!rootDirRef.current) { alert('請先在「根目錄設定」中指定資料庫路徑'); return }
    if (writeBlockRef.current) { blockedAlert(); return }
    if (cur.is_sample && !confirm('目前畫面是示範資料。確定要把它存成你在這個資料夾裡的正式資料嗎？')) return
    if (emptyFolderRef.current && !cur.is_sample &&
      !confirm(`要把目前畫面上的資料存進這個資料夾嗎？\n${rootDirRef.current}`)) return
    emptyFolderRef.current = false
    setNotices(ns => ns.filter(n => !n.startsWith(EMPTY_FOLDER_NOTICE)))
    setBusy(true)
    try {
      const saved = await persist(s => ({ next: { ...s, is_sample: false }, retro: [] }))
      if (saved) alert(`已儲存今日資料（${getTaiwanToday()}）`)
      else alert(`沒有儲存：\n\n${writeBlockRef.current ?? '請看畫面上方的訊息。'}`)
    } finally {
      setBusy(false)
    }
  }

  const reloadFromDisk = async () => {
    try {
      const { loaded, body } = await loadFromDisk()
      if (!loaded) { alert(body.error ?? '載入失敗'); return }
      commit(addSnapshot(loaded, totalAssetsTwd(loaded)))
      alert(`已載入 ${body.date} 的資料`)
    } catch (e) {
      alert(String(e))
    }
  }

  const handleRestoreBackup = async () => {
    const date = restoreDate || dailyBackups[dailyBackups.length - 1]
    if (!date) return
    if (!confirm(`要把儀表板的交易與快照整組還原到 ${date} 的每日備份嗎？\n\n` +
      `· 這份備份是 ${date} 當天第一次開啟儀表板時做的：從那時起在儀表板做的變更（包含 ${date} 當天）都會消失（帳務管家的記帳不受影響，會重新同步過來；帳務管家裡對應的買賣扣款也會自動跟著調整）\n` +
      `· 現在的檔案（含損毀的）會先保留在 backup\\corrupt\\`)) return
    try {
      await enqueue(() => invoke('restore_daily_backup', { date }))
    } catch (e) {
      alert(`還原失敗：${String(e)}`)
      return
    }
    await reloadFromDisk()
  }

  const handleImport = async () => {
    if (!rootDirRef.current) { alert('請先在「根目錄設定」中指定資料庫路徑'); return }
    if (!confirm('確定要從根目錄載入最新資料？目前未儲存的異動將遺失。')) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await reloadFromDisk()
  }

  const handlePriceUpdate = useCallback((next: AppState) => {
    editState(next)
  }, [editState])

  // All per-state derivations in one memo — recomputed only when `state` changes,
  // not on every unrelated re-render (tab switch, blur toggle, dialog open). Must sit
  // above the early return to satisfy the rules of hooks.
  const derived = useMemo(() => {
    if (!state) return null
    const devThreshold = state.retirement.rebalance_threshold_pct ?? 5
    const total = totalAssetsTwd(state)
    // 緊急備用金是釘住的絕對金額，不參與配置比例；investable 才是各項比例的分母
    const reserve = emergencyFundTwd(state)
    const investable = investableTotalTwd(state)
    const reserveTarget = state.emergency_fund?.target_twd ?? 0
    const byCurrency = assetsByCurrency(state)
    const cats = categorySummaries(state)
    // 總覽只顯示「有市值或有設目標」的桶；純空桶（剛新增、還沒放東西）不顯示，與持倉桶視圖一致。
    const visibleCats = cats.filter(c => c.value_twd > 0 || c.target_pct > 0)
    const { birth_year, retirement_age, target_amount_twd, monthly_contribution_wan } = state.retirement
    const target_year = birth_year + retirement_age
    const yearsLeft = target_year - new Date().getFullYear()
    return {
      total,
      reserve,
      investable,
      reserveTarget,
      reserveShortfall: Math.max(0, reserveTarget - reserve),
      totalUsd: total / state.exchange_rate,
      byCurrency,
      cats,
      visibleCats,
      rebalance: rebalanceRows(state),
      devThreshold,
      deviatingBuckets: cats.filter(
        c => c.target_pct > 0 && Math.abs(c.actual_pct - c.target_pct) >= devThreshold,
      ),
      target_year,
      progress: total / target_amount_twd,
      remaining: target_amount_twd - total,
      yearsLeft,
      reqReturn: requiredAnnualReturn(total, target_amount_twd, yearsLeft, monthly_contribution_wan * 10000 * 12),
      barData: visibleCats.map(c => ({ name: c.name, 實際: parseFloat(c.actual_pct.toFixed(2)), 目標: c.target_pct })),
    }
  }, [state])

  // categoryDrillDown is the only drill cost; cats.find for the meta is trivial (≤5 items).
  const drillItems = useMemo(
    () => (state && drillCat ? categoryDrillDown(state, drillCat) : []),
    [state, drillCat],
  )

  // Stable component identity across renders (only changes when `blurred` toggles),
  // so its subtree isn't unmounted/remounted on every render.
  const A = useCallback(
    ({ children }: { children: React.ReactNode }) =>
      blurred ? <span className="blur-sm select-none">{children}</span> : <>{children}</>,
    [blurred],
  )

  if (!state) return <div className="flex items-center justify-center h-screen text-muted-foreground">載入中…</div>

  const {
    total, totalUsd, byCurrency, cats, visibleCats, rebalance, deviatingBuckets, devThreshold,
    target_year, progress, remaining, yearsLeft, reqReturn, barData,
    reserve, investable, reserveTarget, reserveShortfall,
  } = derived!
  const { retirement_age, target_amount_twd } = state.retirement
  const drillCatMeta = drillCat ? cats.find(c => c.key === drillCat) ?? null : null

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 space-y-6">
      {busy && <div className="fixed inset-0 z-[100] cursor-wait" aria-busy="true" title="儲存中…" />}
      {writeBlock && (
        <div role="alert" className="rounded-md border-2 border-red-600 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-800 dark:text-red-200 whitespace-pre-line">
          <p className="font-semibold">⛔ 已停止儲存，目前的新增或修改都不會存進資料夾</p>
          <p className="mt-1">{writeBlock}</p>
          {dbRootDir && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void reloadFromDisk()}>
                處理好了，從資料夾重新載入
              </Button>
              {dailyBackups.length > 0 && (
                <span className="flex items-center gap-1">
                  <select className="h-8 rounded border border-red-400 bg-transparent px-1 text-sm"
                    value={restoreDate} onChange={e => setRestoreDate(e.target.value)} aria-label="選擇要還原的備份日期">
                    {[...dailyBackups].reverse().map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <Button size="sm" variant="outline" onClick={() => void handleRestoreBackup()}>
                    從這天的每日備份還原
                  </Button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {notices.map((n, i) => (
        <div key={i} role="status" className="flex items-start gap-3 rounded-md border border-amber-500 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          <span className="flex-1">⚠️ {n}</span>
          <button className="shrink-0 underline" onClick={() => setNotices(ns => ns.filter((_, j) => j !== i))}>知道了</button>
        </div>
      ))}
      {!dbRootDir && !state.is_sample && (
        <div role="status" className="rounded-md border border-amber-500 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          尚未設定資料夾：目前的資料只存在這台電腦的程式暫存裡，清除瀏覽資料或重灌就會不見。請按工具列的資料夾圖示設定一個資料夾（例如雲端硬碟裡的資料夾）。
        </div>
      )}
      {state.is_sample && (
        <div role="status" className="rounded-md border border-sky-500 bg-sky-50 dark:bg-sky-950/30 px-4 py-3 text-sm text-sky-900 dark:text-sky-200">
          目前顯示的是<strong>示範資料</strong>，不是你的資產，也不會自動寫入資料夾。要開始記錄自己的資料，請按右上角「重設 → 清空所有資料」。
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">資產管理儀表板</h1>
            <span className="rounded-full bg-muted text-muted-foreground text-xs font-medium px-2 py-0.5 leading-none">
              v{__APP_VERSION__}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            1 USD = <A>{fmt(state.exchange_rate, 2)}</A> TWD · 本機儲存 · 隱私優先
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button size="sm" onClick={() => setTxOpen(true)}>
            <Plus size={14} className="mr-1" />新增交易
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPriceOpen(true)}>
            <RefreshCw size={14} className="mr-1" />更新報價
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRetirementOpen(true)}>
            <Settings size={14} className="mr-1" />目標設定
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCategoryOpen(true)} title="資產桶設定（新增／刪除／改名／排序）">
            <Layers size={14} className="mr-1" />資產桶設定
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEmergencyOpen(true)}
            title="緊急備用金（釘住的金額，不參與配置比例）"
            className={reserveTarget > 0 ? (reserveShortfall > 0 ? 'text-amber-600 border-amber-400' : 'text-emerald-600 border-emerald-400') : ''}>
            <ShieldCheck size={14} className="mr-1" />緊急備用金
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDbOpen(true)}
            title={dbRootDir ? `根目錄：${dbRootDir}` : '根目錄設定（未設定）'}
            className={dbRootDir ? 'text-emerald-600 border-emerald-400' : ''}>
            <FolderOpen size={14} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setChannelOpen(true)} title="頻道資訊">
            <PlayCircle size={14} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setBlurred(b => !b)} title={blurred ? '顯示金額' : '隱藏金額'}>
            {blurred ? <Eye size={14} /> : <EyeOff size={14} />}
          </Button>
          <Button size="sm" variant="outline" onClick={handleExport} title="存至根目錄（今日）">
            <Download size={14} />
          </Button>
          <Button size="sm" variant="outline" onClick={handleImport} title="從根目錄載入最新">
            <Upload size={14} />
          </Button>
          <div className="relative" ref={resetMenuRef}>
            <Button size="sm" variant="ghost" onClick={() => setShowResetMenu(v => !v)} title="重設">
              <RotateCcw size={14} />
            </Button>
            {showResetMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[152px] rounded-md border bg-popover shadow-md py-1">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                  onClick={handleResetToDefault}
                >
                  <RotateCcw size={13} />
                  回到預設範例
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left text-destructive"
                  onClick={handleClearAll}
                >
                  <Trash2 size={13} />
                  清空所有資料
                </button>
              </div>
            )}
          </div>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={() => {}} />
        </div>
      </div>

      {/* Deviation alert banner */}
      {deviatingBuckets.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
          <AlertTriangle size={16} className="text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              再平衡提醒：{deviatingBuckets.length} 個桶子偏離目標超過 {devThreshold}%
            </p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
              {deviatingBuckets.map(c => {
                const delta = c.actual_pct - c.target_pct
                const isOver = delta > 0
                return (
                  <span key={c.key} className="text-xs">
                    <span className="font-medium" style={{ color: c.color }}>{c.name}</span>
                    <span className={`ml-1 font-semibold ${isOver ? 'text-red-600' : 'text-emerald-700'}`}>
                      {isOver ? '+' : ''}{delta.toFixed(1)}%
                    </span>
                    <span className="text-amber-700 dark:text-amber-400 ml-1">
                      ({isOver ? '超配' : '不足'})
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="flex-shrink-0 border-amber-400 text-amber-800 hover:bg-amber-100 dark:text-amber-300 text-xs h-7 px-2"
            onClick={() => handleTabChange('rebalance')}
          >
            前往再平衡
          </Button>
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">總資產 台幣(美金)</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold"><A>{fmtWan(total)} <span className="text-lg text-muted-foreground">(${fmt(totalUsd)})</span></A></p>
            <p className="text-xs text-muted-foreground mt-1">
              <A>台幣資產 {fmtWan(byCurrency.twd)} · 美元資產 ${fmt(byCurrency.usd)}</A>
            </p>
            {reserveTarget > 0 && (
              <p className="text-xs mt-1 flex items-center gap-1">
                <ShieldCheck size={12} className={reserveShortfall > 0 ? 'text-amber-500' : 'text-emerald-600'} />
                <span className="text-muted-foreground">
                  其中緊急備用金 <A>{fmtWan(reserve)}</A>（不參與配置）
                  {reserveShortfall > 0 && <span className="text-amber-600">・缺口 <A>{fmtWan(reserveShortfall)}</A></span>}
                </span>
              </p>
            )}
            {reserveTarget > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                可配置資產 <A>{fmtWan(investable)}</A>
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm text-muted-foreground">目標進度（{retirement_age} 歲 {target_year}）</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{(progress * 100).toFixed(1)}%</p>
            <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.min(progress * 100, 100)}%` }} />
            </div>
            <p className={`text-xs mt-1 font-medium ${reqReturn > 0.15 ? 'text-red-500' : reqReturn > 0.08 ? 'text-amber-500' : 'text-emerald-600'}`}>
              需年化報酬 {(reqReturn * 100).toFixed(1)}%
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm text-muted-foreground">距目標 / 剩 {yearsLeft} 年</CardTitle></CardHeader>
          <CardContent>
            <p className="text-2xl font-bold"><A>{fmtWan(remaining)}</A></p>
            <p className="text-xs text-muted-foreground">目標 <A>{fmtWan(target_amount_twd)}</A></p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="overview">資產分布</TabsTrigger>
          <TabsTrigger value="trend">資產走勢</TabsTrigger>
          <TabsTrigger value="performance">績效分析</TabsTrigger>
          <TabsTrigger value="retirement">退休規劃</TabsTrigger>
          <TabsTrigger value="rebalance">再平衡分析</TabsTrigger>
          <TabsTrigger value="holdings">持倉明細</TabsTrigger>
          <TabsTrigger value="history">交易紀錄</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: 資產分布 ── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base">
                  {drillCat ? (
                    <span style={{ color: drillCatMeta?.color }}>{drillCatMeta?.name} — 個股明細</span>
                  ) : '當前資產分布（點入查看個股）'}
                </CardTitle>
                {drillCat && (
                  <Button size="sm" variant="ghost" onClick={() => setDrillCat(null)}>← 返回</Button>
                )}
              </CardHeader>
              <CardContent>
                {!drillCat ? (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={visibleCats} dataKey="value_twd" nameKey="name" cx="50%" cy="50%"
                        outerRadius={105} cursor="pointer"
                        onClick={(_, idx) => setDrillCat(visibleCats[idx].key)}
                        label={({ name, payload }: { name?: string; payload?: { actual_pct: number } }) =>
                          `${name ?? ''} ${payload?.actual_pct?.toFixed(1) ?? ''}%`}
                        labelLine>
                        {visibleCats.map(c => <Cell key={c.key} fill={c.color} stroke="none" />)}
                      </Pie>
                      <Tooltip formatter={(v) => [blurred ? '***' : `${fmtWan(Number(v))}`, '市值']} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie data={drillItems} dataKey="value_twd" nameKey="id" cx="50%" cy="50%" outerRadius={100}>
                        {drillItems.map(item => <Cell key={item.id} fill={item.color} stroke="none" />)}
                      </Pie>
                      <Tooltip
                        formatter={(v) => [blurred ? '***' : `${fmtWan(Number(v))}`, '市值']}
                        labelFormatter={(id) => {
                          const item = drillItems.find(d => d.id === id)
                          return item ? `${item.symbol}${item.name ? ` ${item.name}` : ''}` : String(id)
                        }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}

                {!drillCat && <p className="text-xs text-center text-muted-foreground mt-1">點擊任一區塊查看個股</p>}

                {drillCat && (
                  <div className="mt-3 space-y-1">
                    {drillItems.map(item => (
                      <div key={item.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                        <div className="flex items-center gap-2">
                          <span className="w-3 h-3 rounded-full inline-block flex-shrink-0" style={{ background: item.color }} />
                          <span className="font-medium">{item.symbol}</span>
                          <span className="text-muted-foreground text-xs">{item.name}</span>
                        </div>
                        <div className="text-right">
                          <A><span className="font-medium">{fmtWan(item.value_twd)}</span></A>
                          <span className="text-xs text-muted-foreground ml-1">
                            ({investable > 0 ? ((item.value_twd / investable) * 100).toFixed(1) : 0}%)
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">目標 vs 實際比例 (%)</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 10, right: 30 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 55]} tickFormatter={v => `${v}%`} />
                    <YAxis type="category" dataKey="name" width={65} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v) => `${Number(v).toFixed(1)}%`} />
                    <Bar dataKey="目標" fill="#94a3b8" radius={[0, 3, 3, 0]} />
                    <Bar dataKey="實際" fill="#60a5fa" radius={[0, 3, 3, 0]}>
                      {barData.map((_, i) => <Cell key={i} fill={visibleCats[i].color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex items-center gap-4 mt-1 px-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-sm bg-slate-400" />
                    目標
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-3 h-3 rounded-sm bg-blue-400" />
                    實際
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-4">
                  {visibleCats.map(c => (
                    <button key={c.key} onClick={() => setDrillCat(c.key)}
                      className="text-left rounded-lg border p-3 hover:shadow-md transition-shadow cursor-pointer"
                      style={{ borderLeftWidth: 4, borderLeftColor: c.color }}>
                      <p className="text-xs font-medium" style={{ color: c.color }}>{c.name}</p>
                      <p className="text-base font-bold"><A>{fmtWan(c.value_twd)}</A></p>
                      <div className="flex gap-1 mt-1">
                        <Badge variant="outline" className="text-xs px-1" style={{ borderColor: c.color, color: c.color }}>
                          {c.actual_pct.toFixed(1)}%
                        </Badge>
                        <Badge variant="secondary" className="text-xs px-1">目標 {c.target_pct}%</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Tab 2: 資產走勢 ── */}
        <TabsContent value="trend">
          <Card>
            <CardHeader><CardTitle className="text-base">資產走勢</CardTitle></CardHeader>
            <CardContent>
              <HistoryChart
                snapshots={state.snapshots ?? []}
                blurred={blurred}
                holdings={state.holdings}
                cashAccounts={state.cash_accounts}
                categories={getCategories(state)}
              />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: 績效分析 ── */}
        <TabsContent value="performance">
          <TwrPanel state={state} blurred={blurred} />
        </TabsContent>

        {/* ── Tab 4: 退休規劃 ── */}
        <TabsContent value="retirement">
          <RetirementProgressPanel state={state} blurred={blurred} />
        </TabsContent>

        {/* ── Tab 5: 再平衡 ── */}
        <TabsContent value="rebalance" className="space-y-4">
          <RebalanceAssistant state={state} blurred={blurred} onThresholdChange={handleThresholdChange} />
          {(() => {
            const fx = state.exchange_rate
            const isTWD = rebalanceCcy === 'TWD'
            const isUSD = rebalanceCcy === 'USD'
            const isAll = rebalanceCcy === 'all'

            const rebalanceFiltered = isAll
              ? rebalance
              : rebalance.filter(r => r.currency === rebalanceCcy)

            const barDelta = (r: typeof rebalance[number]) =>
              isUSD && r.delta_usd !== undefined
                ? Math.round(r.delta_usd)
                : parseFloat((r.delta_twd / 10000).toFixed(1))

            const barTickFmt = isUSD
              ? (v: number) => `$${fmt(v)}`
              : (v: number) => `${v}萬`

            const barTipFmt = (v: number) =>
              blurred ? '***' : isUSD ? `$${fmt(Number(v))} USD` : `${Number(v)} 萬 TWD`

            const fmtCurrentValue = (r: typeof rebalance[number]) => {
              if (isUSD) return `$${fmt(r.current_value_twd / fx, 2)}`
              if (isTWD) return fmt(r.current_value_twd, 0)
              return fmtWan(r.current_value_twd)
            }
            const fmtTargetValue = (r: typeof rebalance[number]) => {
              if (isUSD) return `$${fmt(r.target_value_twd / fx, 2)}`
              if (isTWD) return fmt(r.target_value_twd, 0)
              return fmtWan(r.target_value_twd)
            }
            const fmtDelta = (r: typeof rebalance[number]) => {
              const sign = r.delta_twd >= 0 ? '+' : ''
              if (isUSD && r.delta_usd !== undefined)
                return `${sign}$${fmt(r.delta_usd, 2)}`
              if (isTWD)
                return `${sign}${fmt(r.delta_twd, 0)}`
              return `${sign}${fmt(r.delta_twd / 10000, 1)} 萬`
            }
            const fmtShares = (r: typeof rebalance[number]) => {
              if (r.delta_shares === undefined || r.target_pct === 0) return '—'
              const sign = r.delta_shares >= 0 ? '+' : ''
              if (isTWD || isUSD || r.currency === 'TWD') {
                const intShares = Math.floor(Math.abs(r.delta_shares))
                return `${sign}${fmt(intShares)} 股`
              }
              return `${sign}${fmt(r.delta_shares, 2)} 股`
            }

            const valueLabel = isUSD ? '現值 (USD)' : isTWD ? '現值 (TWD)' : '現值'
            const deltaLabel = isUSD ? '缺口 (USD)' : isTWD ? '缺口 (TWD)' : '缺口'
            const sharesLabel = '可買/賣 (股)'

            return (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <CardTitle className="text-base">再平衡缺口分析</CardTitle>
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {reserveTarget > 0
                          ? <>以可配置資產 <A>{fmtWan(investable)}</A> 為基準計算（總資產 <A>{fmtWan(total)}</A> 已扣除緊急備用金 <A>{fmtWan(reserve)}</A>）</>
                          : <>以目前總資產 <A>{fmtWan(total)}</A> 為基準計算</>}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      {(['all', 'TWD', 'USD'] as const).map(v => (
                        <Button
                          key={v}
                          variant={rebalanceCcy === v ? 'default' : 'outline'}
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => setRebalanceCcy(v)}
                        >
                          {v === 'all' ? '全部' : v === 'TWD' ? '台幣帳戶' : '美金帳戶'}
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={rebalanceFiltered.length <= 4 ? 200 : 320}>
                    <BarChart
                      data={rebalanceFiltered.map(r => ({ name: r.symbol, delta: barDelta(r) }))}
                      layout="vertical" margin={{ left: 20, right: 30 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                      <XAxis type="number" tickFormatter={barTickFmt} />
                      <YAxis type="category" dataKey="name" width={55} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={(v) => [barTipFmt(Number(v)), '缺口']} />
                      <ReferenceLine x={0} stroke="#64748b" />
                      <Bar dataKey="delta" radius={[0, 3, 3, 0]}>
                        {rebalanceFiltered.map((r, i) => <Cell key={i} fill={r.delta_twd >= 0 ? '#10b981' : '#ef4444'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>

                  <div className="overflow-x-auto mt-4">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground text-xs">
                          <th className="text-left py-2 pr-4">標的</th>
                          <th className="text-right pr-4">{valueLabel}</th>
                          <th className="text-right pr-4">目標%</th>
                          <th className="text-right pr-4">偏移%</th>
                          <th className="text-right pr-4">目標值</th>
                          <th className="text-right pr-4">{deltaLabel}</th>
                          <th className="text-right">{isAll ? '股數/金額' : sharesLabel}</th>
                          <th className="text-center pl-4">動作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rebalanceFiltered.map(r => {
                          const isPos = r.delta_twd >= 0
                          const actualPct = investable > 0 ? (r.current_value_twd / investable) * 100 : 0
                          const offsetPct = actualPct - r.target_pct
                          const offsetLabel = r.target_pct > 0
                            ? `${offsetPct >= 0 ? '+' : ''}${offsetPct.toFixed(1)}%`
                            : '—'
                          const offsetColor = r.target_pct > 0
                            ? offsetPct > 0.5 ? 'text-red-500' : offsetPct < -0.5 ? 'text-emerald-600' : 'text-muted-foreground'
                            : 'text-muted-foreground'
                          return (
                            <tr key={r.symbol} className="border-b hover:bg-muted/50">
                              <td className="py-2 pr-4 font-medium">
                                {r.symbol}
                                <span className="text-xs text-muted-foreground ml-1">{r.name}</span>
                              </td>
                              <td className="text-right pr-4"><A>{fmtCurrentValue(r)}</A></td>
                              <td className="text-right pr-4">{r.target_pct > 0 ? `${r.target_pct}%` : '—'}</td>
                              <td className={`text-right pr-4 text-xs font-medium ${offsetColor}`}>{offsetLabel}</td>
                              <td className="text-right pr-4">{r.target_pct > 0 ? <A>{fmtTargetValue(r)}</A> : '—'}</td>
                              <td className={`text-right pr-4 font-medium ${isPos ? 'text-emerald-600' : 'text-red-500'}`}>
                                {r.target_pct > 0 ? <A>{fmtDelta(r)}</A> : '—'}
                              </td>
                              <td className={`text-right text-xs font-semibold ${isPos ? 'text-emerald-600' : 'text-red-500'}`}>
                                {r.target_pct > 0 ? <A>{fmtShares(r)}</A> : '—'}
                              </td>
                              <td className="text-center pl-4">
                                {r.target_pct > 0 && (
                                  <Badge variant={isPos ? 'default' : 'destructive'} className="text-xs">
                                    {isPos ? '買入' : '賣出'}
                                  </Badge>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )
          })()}
        </TabsContent>

        {/* ── Tab 6: 持倉明細 ── */}
        <TabsContent value="holdings">
          <HoldingsTable state={state} onUpdate={editState} blurred={blurred} />
        </TabsContent>

        {/* ── Tab 7: 交易紀錄 ── */}
        <TabsContent value="history">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">交易紀錄</CardTitle>
              {state.transactions.length > 0 && (() => {
                // Single pass: month → count, instead of filtering all transactions per month.
                const counts = new Map<string, number>()
                for (const t of state.transactions) {
                  const m = t.date.slice(0, 7)
                  counts.set(m, (counts.get(m) ?? 0) + 1)
                }
                const months = [...counts.keys()].sort((a, b) => b.localeCompare(a))
                return (
                  <select
                    value={txMonthFilter}
                    onChange={e => setTxMonthFilter(e.target.value)}
                    className="text-sm border border-input rounded-md px-2 py-1 bg-background"
                  >
                    <option value="">全部（{state.transactions.length} 筆）</option>
                    {months.map(m => (
                      <option key={m} value={m}>{m}（{counts.get(m)} 筆）</option>
                    ))}
                  </select>
                )
              })()}
            </CardHeader>
            <CardContent>
              {state.transactions.length === 0 ? (
                <p className="text-muted-foreground text-sm py-8 text-center">尚無交易紀錄</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-xs">
                        <th className="text-left py-2 pr-3">日期</th>
                        <th className="text-left pr-3">類型</th>
                        <th className="text-left pr-3">標的/帳戶</th>
                        <th className="text-right pr-3">股數</th>
                        <th className="text-right pr-3">價格</th>
                        <th className="text-right pr-3">金額</th>
                        <th className="text-right pr-3">手續費</th>
                        <th className="text-left pr-3">備註</th>
                        <th className="w-6" />
                      </tr>
                    </thead>
                    <tbody>
                      {[...state.transactions]
                        .filter(tx => !txMonthFilter || tx.date.startsWith(txMonthFilter))
                        .sort((a, b) => {
                          const d = b.date.localeCompare(a.date)
                          return d !== 0 ? d : b.id.localeCompare(a.id)
                        })
                        .map(tx => {
                        const typeLabel: Record<TxType, string> = {
                          buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出',
                          new_position: '建立股票', new_cash_account: '建立現金', transfer: '帳戶轉帳',
                          dividend: '股息收入',
                        }
                        const typeColor: Record<TxType, string> = {
                          buy: 'text-emerald-600', sell: 'text-red-500',
                          cash_in: 'text-blue-500', cash_out: 'text-orange-500',
                          new_position: 'text-purple-600', new_cash_account: 'text-indigo-600',
                          transfer: 'text-amber-600', dividend: 'text-teal-600',
                        }
                        return (
                          <tr key={tx.id} className="border-b hover:bg-muted/30">
                            <td className="py-1.5 pr-3 text-muted-foreground">{tx.date}</td>
                            <td className={`pr-3 font-medium ${typeColor[tx.type]}`}>{typeLabel[tx.type]}</td>
                            <td className="pr-3 font-mono text-xs">
                              {tx.type === 'transfer'
                                ? `${tx.bank} → ${tx.bank_to}`
                                : (tx.symbol || tx.bank || '—')}
                            </td>
                            <td className="text-right pr-3"><A>{tx.shares !== undefined ? fmt(tx.shares, 2) : '—'}</A></td>
                            <td className="text-right pr-3"><A>{tx.price !== undefined ? `${tx.currency === 'USD' ? '$' : ''}${fmt(tx.price, 2)}` : '—'}</A></td>
                            <td className="text-right pr-3 font-medium">
                              <A>{tx.currency === 'USD' ? `$${fmt(tx.amount, 2)}` : `${fmt(tx.amount)} TWD`}</A>
                            </td>
                            <td className="text-right pr-3 text-muted-foreground text-xs">
                              <A>{tx.commission ? `${tx.currency === 'USD' ? '$' : ''}${fmt(tx.commission, 2)}` : '—'}</A>
                            </td>
                            <td className="pr-3 text-muted-foreground text-xs">{tx.note || '—'}</td>
                            <td className="text-center">
                              <div className="flex items-center gap-1 justify-center">
                                <button onClick={() => setEditingTx(tx)}
                                  className="text-muted-foreground/40 hover:text-blue-500 transition-colors" title="編輯">
                                  <Pencil size={13} />
                                </button>
                                <button onClick={() => handleDeleteTransaction(tx.id)}
                                  className="text-muted-foreground/40 hover:text-red-500 transition-colors" title="刪除">
                                  <Trash2 size={13} />
                                </button>
                              </div>
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
        </TabsContent>
      </Tabs>

      <ChannelInfoDialog open={channelOpen} onClose={() => setChannelOpen(false)} />
      <EmergencyFundDialog
        open={emergencyOpen}
        onClose={() => setEmergencyOpen(false)}
        state={state}
        onSave={ef => editState({ ...state, emergency_fund: ef })}
      />
      <CategorySettingsDialog
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        state={state}
        onUpdate={editState}
      />
      <TransactionDialog
        open={txOpen}
        onClose={() => setTxOpen(false)}
        onSubmit={handleTransaction}
        holdings={state.holdings}
        cashAccounts={state.cash_accounts}
        categories={getCategories(state)}
      />
      <RetirementDialog
        open={retirementOpen}
        onClose={() => setRetirementOpen(false)}
        current={state.retirement}
        currentTotal={total}
        onSave={handleRetirementSave}
      />
      <PriceUpdateDialog
        open={priceOpen}
        onClose={() => setPriceOpen(false)}
        state={state}
        onUpdate={handlePriceUpdate}
      />
      <DbConfigDialog
        open={dbOpen}
        onClose={() => setDbOpen(false)}
        rootDir={dbRootDir}
        onRootDirChange={handleRootDirChange}
        onReload={handleImport}
        onSaveNow={handleExport}
      />
      <EditTransactionDialog
        open={!!editingTx}
        onClose={() => setEditingTx(null)}
        transaction={editingTx}
        onSubmit={handleEditSubmit}
        holdings={state.holdings}
        cashAccounts={state.cash_accounts}
      />
    </div>
  )
}
