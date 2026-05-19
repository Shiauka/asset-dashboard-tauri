import { invoke } from '@tauri-apps/api/core'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const openUrl = (url: string) => invoke('open_url', { url }).catch(() => {})

const KEYWORDS = [
  '財務自由', '資產配置', '指數投資', '退休規劃', '個人理財', '投資紀律',
]

export default function ChannelInfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>頻道資訊</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-4 py-2">
          <img
            src="/channel_cover.png"
            alt="頻道封面"
            className="w-20 h-20 rounded-xl object-cover flex-shrink-0 shadow"
          />
          <div>
            <p className="text-base font-bold leading-snug">一個工程師的財務自白</p>
            <p className="text-sm text-muted-foreground mt-0.5">祿哥 · Finance Series</p>
            <p className="text-xs text-muted-foreground mt-1">每週二、五更新</p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground leading-relaxed border-t pt-3">
          用工程師的系統化思維管理個人財務。從五桶框架出發，分享 ETF 選擇邏輯、資產配置實作、再平衡紀律與退休規劃，目標是靠長期持有、不投機，達成財務自由。
        </p>

        <div className="flex flex-wrap gap-1.5 pt-1">
          {KEYWORDS.map(k => (
            <Badge key={k} variant="secondary" className="text-xs">{k}</Badge>
          ))}
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <Button
            className="flex-1"
            onClick={() => openUrl('https://www.youtube.com/@luge.finance')}
          >
            YouTube 頻道
          </Button>
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => openUrl('https://shiauka.github.io/')}
          >
            個人網站
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
