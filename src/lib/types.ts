export type Currency = 'USD' | 'TWD'
export type Category = 'core' | 'aggressive' | 'global' | 'alternative' | 'defensive'
export type TxType = 'buy' | 'sell' | 'cash_in' | 'cash_out' | 'new_position' | 'new_cash_account' | 'transfer'

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
