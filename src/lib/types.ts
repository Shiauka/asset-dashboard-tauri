export type Currency = 'USD' | 'TWD'
// 分類 id。為了支援使用者自訂新增/刪除分類，型別放寬為 string。
// 預設五桶仍用 'core' | 'aggressive' | 'global' | 'alternative' | 'defensive'，
// 舊資料的 holding.category 直接相容；現金桶 id 恆為 'defensive'（改名只動顯示名、刪除被擋）。
export type Category = string
export type TxType = 'buy' | 'sell' | 'cash_in' | 'cash_out' | 'new_position' | 'new_cash_account' | 'transfer'

// 分類（桶）定義。Step 1 起把五桶從寫死的型別抽成可儲存的資料；
// 之後（step 2）才開放使用者新增／刪除／改名。id 目前仍用既有的五個 union 值，
// 確保舊資料的 holding.category 直接對得上。
export interface CategoryDef {
  id: Category
  name: string
  color: string
  target_pct: number    // 該桶的預設目標 %（供新增持倉預填／日後用）
  is_cash?: boolean      // 此桶收納現金帳戶（預設為 defensive）
  palette?: string[]     // drill-down 子項配色
  order: number          // 顯示順序
}

export interface Holding {
  symbol: string
  name: string
  currency: Currency
  category: Category
  shares: number
  price: number
  target_pct: number  // % of total portfolio (0-100)
}

export interface CashAccount {
  id: string
  bank: string
  currency: Currency
  amount: number
  type: 'bank' | 'savings_insurance'
  target_pct: number
}

export interface Transaction {
  id: string
  date: string
  type: TxType
  symbol?: string
  bank?: string
  shares?: number
  price?: number
  currency: Currency
  amount: number
  commission?: number
  note?: string
  bank_to?: string
  amount_to?: number
  currency_to?: Currency
}

export interface RetirementSettings {
  target_amount_twd: number
  monthly_contribution_wan: number
  expected_annual_return: number   // 0–1 decimal, e.g. 0.07 for 7%
  birth_year: number
  retirement_age: number
  // Derived: target_year = birth_year + retirement_age
  rebalance_threshold_pct?: number   // 再平衡偏離警示門檻 %，未設定預設 5
}

export interface DailySnapshot {
  date: string        // YYYY-MM-DD
  total_twd: number
  bucket_pct?: Partial<Record<Category, number>>  // % of total per bucket
  holdings_twd?: Record<string, number>           // symbol/bank → TWD value
  holdings_shares?: Record<string, number>        // symbol → share count
}

export interface AppState {
  exchange_rate: number
  holdings: Holding[]
  cash_accounts: CashAccount[]
  transactions: Transaction[]
  retirement: RetirementSettings
  snapshots: DailySnapshot[]
  // 分類定義。可選：舊存檔／demo／測試未帶此欄時，一律 fallback 到 DEFAULT_CATEGORIES。
  categories?: CategoryDef[]
}

export interface CategorySummary {
  name: string
  key: Category
  value_twd: number
  target_pct: number
  actual_pct: number
  color: string
}

export interface RebalanceRow {
  symbol: string
  name: string
  currency: Currency
  current_value_twd: number
  target_pct: number
  target_value_twd: number
  delta_twd: number
  delta_usd?: number
  delta_shares?: number
  price?: number
}

export interface DrillItem {
  id: string      // unique key
  symbol: string  // 主顯示名（短）
  name: string    // 說明文字（小字）
  value_twd: number
  color: string
}
