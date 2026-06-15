'use client'

import { ChevronUp, ChevronDown, Trash2, Plus, Wallet } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AppState } from '@/lib/types'
import { getCategories } from '@/lib/calc'
import { addCategory, updateCategory, deleteCategory, moveCategory, canDeleteCategory } from '@/lib/store'

interface Props {
  open: boolean
  onClose: () => void
  state: AppState
  onUpdate: (s: AppState) => void
}

export default function CategorySettingsDialog({ open, onClose, state, onUpdate }: Props) {
  const cats = getCategories(state)

  const handleDelete = (id: string, name: string) => {
    const { ok, reason } = canDeleteCategory(state, id)
    if (!ok) { alert(reason); return }
    if (!confirm(`確定刪除桶「${name}」？`)) return
    onUpdate(deleteCategory(state, id))
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>資產桶設定</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          自訂你的資產桶。用不到的桶可以刪掉，畫面就不會有空桶。現金桶用來收納現金帳戶，不可刪除；只用到的桶才會顯示。
        </p>

        <div className="space-y-1.5 max-h-[52vh] overflow-y-auto pr-1">
          {/* 表頭 */}
          <div className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
            <span className="w-10 text-center">排序</span>
            <span className="w-7 text-center">色</span>
            <span className="flex-1">名稱</span>
            <span className="w-7" />
          </div>

          {cats.map((c, idx) => {
            const { ok: deletable, reason } = canDeleteCategory(state, c.id)
            return (
              <div key={c.id} className="flex items-center gap-2 rounded-md border px-1 py-1.5">
                {/* 排序 */}
                <div className="w-10 flex items-center justify-center gap-0.5">
                  <button
                    className="text-muted-foreground/50 hover:text-foreground disabled:opacity-20 disabled:hover:text-muted-foreground/50"
                    disabled={idx === 0}
                    onClick={() => onUpdate(moveCategory(state, c.id, -1))}
                    title="上移"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    className="text-muted-foreground/50 hover:text-foreground disabled:opacity-20 disabled:hover:text-muted-foreground/50"
                    disabled={idx === cats.length - 1}
                    onClick={() => onUpdate(moveCategory(state, c.id, 1))}
                    title="下移"
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>

                {/* 顏色 */}
                <input
                  type="color"
                  value={c.color}
                  onChange={e => onUpdate(updateCategory(state, c.id, { color: e.target.value }))}
                  className="w-7 h-7 rounded cursor-pointer border-0 bg-transparent p-0"
                  title="桶顏色"
                />

                {/* 名稱 */}
                <div className="flex-1 flex items-center gap-1.5 min-w-0">
                  <Input
                    key={`name-${c.id}`}
                    defaultValue={c.name}
                    onBlur={e => {
                      const v = e.target.value.trim()
                      if (v && v !== c.name) onUpdate(updateCategory(state, c.id, { name: v }))
                    }}
                    className="h-7 text-sm"
                  />
                  {c.is_cash && (
                    <span className="flex items-center gap-0.5 shrink-0 text-[10px] text-muted-foreground border rounded px-1 py-0.5">
                      <Wallet size={10} /> 現金桶
                    </span>
                  )}
                </div>

                {/* 刪除 */}
                <button
                  className="w-7 flex justify-center text-muted-foreground/40 hover:text-red-500 disabled:opacity-20 disabled:hover:text-muted-foreground/40"
                  disabled={!deletable}
                  onClick={() => handleDelete(c.id, c.name)}
                  title={deletable ? '刪除桶' : reason}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>

        <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => onUpdate(addCategory(state))}>
          <Plus size={14} /> 新增桶
        </Button>

        <DialogFooter>
          <Button onClick={onClose}>完成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
