import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Plus, RefreshCw, Settings, Eye, EyeOff, Download, Upload, RotateCcw, Trash2, FolderOpen, Pencil, AlertTriangle, PlayCircle, Layers } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ReferenceLine,
} from 'recharts'
import { invoke } from '@tauri-apps/api/core'
import { loadState, saveState, resetState, clearState, applyTransaction, updateRetirement, reverseTransaction, retroactivelyAdjustSnapshots, editTransaction, updateHoldingPrice, updateExchangeRate, addSnapshot } from '@/lib/store'
import { getTaiwanToday } from '@/lib/dateUtils'
import { totalAssetsTwd, assetsByCurrency, categorySummaries, rebalanceRows, categoryDrillDown, requiredAnnualReturn, totalTargetPct, getCategories } from '@/lib/calc'
import { INITIAL_STATE } from '@/lib/initialData'
import { DEMO_STATE } from '@/lib/demoData'
import type { AppState, Transaction, TxType, Category, RetirementSettings } from '@/lib/types'
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

const fmt = (n: number, digits = 0) =>
  new Intl.NumberFormat('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)
const fmtWan = (twd: number) => `${fmt(twd / 10000, 1)} 萬`

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
  const [dbRootDir, setDbRootDir] = useState<string | null>(null)
  const [rebalanceCcy, setRebalanceCcy] = useState<'all' | 'TWD' | 'USD'>('all')
  const importRef = useRef<HTMLInputElement>(null)
  const resetMenuRef = useRef<HTMLDivElement>(null)
  const [showResetMenu, setShowResetMenu] = useState(false)

  const commit = useCallback((next: AppState) => {
    setState(next)
    saveState(next)
  }, [])

  const handleRootDirChange = useCallback((dir: string | null) => {
    setDbRootDir(dir)
    if (dir) localStorage.setItem('asset_dashboard_rootDir', dir)
    else localStorage.removeItem('asset_dashboard_rootDir')
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const isDemo = params.has('demo')
    const initTab = params.get('tab')
    if (initTab) setActiveTab(initTab)

    async function init() {
      if (isDemo) {
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
          invoke('set_db_config', { rootDir }).catch(() => {})
        }
      } else {
        localStorage.setItem('asset_dashboard_rootDir', rootDir)
      }

      setDbRootDir(rootDir)

      if (rootDir) {
        try {
          const body = await invoke<{ ok?: boolean; state?: AppState; date?: string }>('load_snapshots')
          if (body.ok && body.state) {
            const merged: AppState = {
              ...INITIAL_STATE,
              ...body.state,
              snapshots: body.state.snapshots ?? [],
              cash_accounts: (body.state.cash_accounts ?? []).map(c => ({ ...c, target_pct: c.target_pct ?? 0 })),
            }

            // 立刻用當下 cash_accounts（已含 budget sync）重建今日快照，
            // 避免舊快照 + 新 cash_out 交易造成 TWR 假性暴增
            const mergedWithSnap = addSnapshot(merged, totalAssetsTwd(merged))
            commit(mergedWithSnap)

            // 股價 + 匯率在背景更新，完成後再刷新
            invoke<{ prices: Record<string, number | null>; exchange_rate: number | null }>('fetch_prices', {
              holdings: merged.holdings.map(h => ({ symbol: h.symbol, currency: h.currency })),
            }).then(pricesData => {
              let next = mergedWithSnap
              if (pricesData.exchange_rate !== null && pricesData.exchange_rate > 0)
                next = updateExchangeRate(next, pricesData.exchange_rate)
              for (const [sym, price] of Object.entries(pricesData.prices))
                if (price !== null && price > 0) next = updateHoldingPrice(next, sym, price)
              next = addSnapshot(next, totalAssetsTwd(next))
              commit(next)
              if (rootDir) invoke('save_snapshot', { state: next }).catch(() => {})
            }).catch(() => {})

            return
          }
        } catch {}
      }

      setState(loadState())
    }
    init()
  }, [commit])

  const saveToDb = useCallback((next: AppState): Promise<void> => {
    if (!dbRootDir) return Promise.resolve()
    return invoke('save_snapshot', { state: next }).then(() => {}).catch(() => {})
  }, [dbRootDir])

  const reloadDbSnapshots = useCallback(async (base: AppState): Promise<AppState> => {
    if (!dbRootDir) return base
    try {
      const body = await invoke<{ ok?: boolean; state?: AppState }>('load_snapshots')
      if (body.ok && body.state?.snapshots) {
        return { ...base, snapshots: body.state.snapshots }
      }
    } catch {}
    return base
  }, [dbRootDir])

  const retroactiveDbUpdate = useCallback((tx: Transaction, direction: 1 | -1 = 1): Promise<void> => {
    if (!dbRootDir || tx.date >= getTaiwanToday()) return Promise.resolve()
    return invoke('retroactive_update', { tx, direction }).then(() => {}).catch(() => {})
  }, [dbRootDir])

  const handleTransaction = useCallback(async (tx: Transaction) => {
    if (!state) return
    let next = applyTransaction(state, tx)
    next = retroactivelyAdjustSnapshots(next, tx)
    next = addSnapshot(next, totalAssetsTwd(next))
    commit(next)
    await saveToDb(next)
    await retroactiveDbUpdate(tx, 1)
    if (tx.date < getTaiwanToday()) {
      const reloaded = await reloadDbSnapshots(next)
      commit(reloaded)
    }
  }, [state, commit, saveToDb, retroactiveDbUpdate, reloadDbSnapshots])

  const handleResetToDefault = () => {
    setShowResetMenu(false)
    if (!confirm('確定回到預設範例？目前所有資料將被覆蓋。')) return
    setState(resetState())
  }

  const handleClearAll = () => {
    setShowResetMenu(false)
    if (!confirm('確定清空所有資料？此操作無法復原。')) return
    setState(clearState())
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
    if (!state) return
    const tx = state.transactions.find(t => t.id === id)
    if (!tx) return
    const typeLabel: Record<string, string> = {
      buy: '買入', sell: '賣出', cash_in: '現金入', cash_out: '現金出',
      new_position: '建立股票', new_cash_account: '建立現金', transfer: '帳戶轉帳',
    }
    if (!confirm(`確定刪除這筆「${typeLabel[tx.type]}」紀錄並還原其對持倉的影響？`)) return
    let next = reverseTransaction(state, id)
    next = retroactivelyAdjustSnapshots(next, tx, -1)
    next = addSnapshot(next, totalAssetsTwd(next))
    commit(next)
    await saveToDb(next)
    await retroactiveDbUpdate(tx, -1)
    if (tx.date < getTaiwanToday()) {
      const reloaded = await reloadDbSnapshots(next)
      commit(reloaded)
    }
  }, [state, commit, saveToDb, retroactiveDbUpdate, reloadDbSnapshots])

  const handleEditSubmit = useCallback(async (id: string, updates: Partial<Transaction>) => {
    if (!state) return
    const result = editTransaction(state, id, updates)
    if (!result) return
    const { next, oldTx, newTx } = result
    let final = retroactivelyAdjustSnapshots(next, oldTx, -1)
    final = retroactivelyAdjustSnapshots(final, newTx, 1)
    final = addSnapshot(final, totalAssetsTwd(final))
    commit(final)
    await saveToDb(final)
    await retroactiveDbUpdate(oldTx, -1)
    await retroactiveDbUpdate(newTx, 1)
    if (oldTx.date < getTaiwanToday() || newTx.date < getTaiwanToday()) {
      const reloaded = await reloadDbSnapshots(final)
      commit(reloaded)
    }
  }, [state, commit, saveToDb, retroactiveDbUpdate, reloadDbSnapshots])

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
    commit(updateRetirement(state, settings))
  }

  const handleThresholdChange = (pct: number) => {
    if (!state) return
    commit(updateRetirement(state, { rebalance_threshold_pct: pct }))
  }

  const handleExport = async () => {
    if (!state) return
    if (!dbRootDir) { alert('請先在「根目錄設定」中指定資料庫路徑'); return }
    try {
      const body = await invoke<{ ok?: boolean; date?: string; error?: string }>('save_snapshot', { state })
      if (body.ok) alert(`已儲存今日資料至 ${body.date}.json`)
      else alert(body.error ?? '儲存失敗')
    } catch (e) {
      alert(String(e))
    }
  }

  const handleImport = async () => {
    if (!dbRootDir) { alert('請先在「根目錄設定」中指定資料庫路徑'); return }
    if (!confirm('確定要從根目錄載入最新資料？目前未儲存的異動將遺失。')) return
    try {
      const body = await invoke<{ ok?: boolean; state?: AppState; date?: string; error?: string }>('load_snapshots')
      if (!body.ok || !body.state) { alert(body.error ?? '載入失敗'); return }
      const merged: AppState = {
        ...INITIAL_STATE,
        ...body.state,
        snapshots: body.state.snapshots ?? [],
        cash_accounts: (body.state.cash_accounts ?? []).map(c => ({ ...c, target_pct: c.target_pct ?? 0 })),
      }
      commit(merged)
      alert(`已載入 ${body.date} 的資料`)
    } catch (e) {
      alert(String(e))
    }
  }

  const handlePriceUpdate = useCallback((next: AppState) => {
    commit(next)
    void saveToDb(next)
  }, [commit, saveToDb])

  // All per-state derivations in one memo — recomputed only when `state` changes,
  // not on every unrelated re-render (tab switch, blur toggle, dialog open). Must sit
  // above the early return to satisfy the rules of hooks.
  const derived = useMemo(() => {
    if (!state) return null
    const devThreshold = state.retirement.rebalance_threshold_pct ?? 5
    const total = totalAssetsTwd(state)
    const byCurrency = assetsByCurrency(state)
    const cats = categorySummaries(state)
    // 總覽只顯示「有市值或有設目標」的桶；純空桶（剛新增、還沒放東西）不顯示，與持倉桶視圖一致。
    const visibleCats = cats.filter(c => c.value_twd > 0 || c.target_pct > 0)
    const { birth_year, retirement_age, target_amount_twd, monthly_contribution_wan } = state.retirement
    const target_year = birth_year + retirement_age
    const yearsLeft = target_year - new Date().getFullYear()
    return {
      total,
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
  } = derived!
  const { retirement_age, target_amount_twd } = state.retirement
  const drillCatMeta = drillCat ? cats.find(c => c.key === drillCat) ?? null : null

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 space-y-6">
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
                            ({total > 0 ? ((item.value_twd / total) * 100).toFixed(1) : 0}%)
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
                      <p className="text-sm text-muted-foreground mt-0.5">以目前總資產 <A>{fmtWan(total)}</A> 為基準計算</p>
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
                          const actualPct = total > 0 ? (r.current_value_twd / total) * 100 : 0
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
          <HoldingsTable state={state} onUpdate={commit} blurred={blurred} />
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
                        }
                        const typeColor: Record<TxType, string> = {
                          buy: 'text-emerald-600', sell: 'text-red-500',
                          cash_in: 'text-blue-500', cash_out: 'text-orange-500',
                          new_position: 'text-purple-600', new_cash_account: 'text-indigo-600',
                          transfer: 'text-amber-600',
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
      <CategorySettingsDialog
        open={categoryOpen}
        onClose={() => setCategoryOpen(false)}
        state={state}
        onUpdate={commit}
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
        currentState={state}
        rootDir={dbRootDir}
        onRootDirChange={handleRootDirChange}
        onLoad={(s, _date) => commit(s)}
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
