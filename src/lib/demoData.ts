import type { AppState, DailySnapshot, Transaction } from './types'

// 小明 demo: 2023-01 起投，季末存入 15萬（2026 改 10萬/5萬），目標 2,000萬 by 2042
// TWR 公式 HPR=(vEnd-cf)/vStart，cf 必須與 snapshot 同日才能正確扣除現金流
// → transaction 日期統一移至各季最後一天（與 snapshot 同日）
// 年化報酬率：2023≈+14%，2024≈+22%，2025≈+8%，2026 YTD≈+5%
// 月報酬率：2023=1.172%，2024=1.672%，2025=0.643%，2026=1.172%

const snapshots: DailySnapshot[] = [
  // 2023 — 年化 +14%（11 個 HPR 月，首月作基準）
  { date: '2023-01-31', total_twd: 150000 },
  { date: '2023-02-28', total_twd: 151800 },
  { date: '2023-03-31', total_twd: 153500 },
  { date: '2023-04-30', total_twd: 305300 },
  { date: '2023-05-31', total_twd: 308900 },
  { date: '2023-06-30', total_twd: 312500 },
  { date: '2023-07-31', total_twd: 466200 },
  { date: '2023-08-31', total_twd: 471600 },
  { date: '2023-09-30', total_twd: 477200 },
  { date: '2023-10-31', total_twd: 632800 },
  { date: '2023-11-30', total_twd: 640200 },
  { date: '2023-12-31', total_twd: 647700 },
  // 2024 — 年化 +22%
  { date: '2024-01-31', total_twd: 808500 },
  { date: '2024-02-29', total_twd: 822000 },
  { date: '2024-03-31', total_twd: 835800 },
  { date: '2024-04-30', total_twd: 999700 },
  { date: '2024-05-31', total_twd: 1016500 },
  { date: '2024-06-30', total_twd: 1033500 },
  { date: '2024-07-31', total_twd: 1200800 },
  { date: '2024-08-31', total_twd: 1220800 },
  { date: '2024-09-30', total_twd: 1241300 },
  { date: '2024-10-31', total_twd: 1412000 },
  { date: '2024-11-30', total_twd: 1435600 },
  { date: '2024-12-31', total_twd: 1459700 },
  // 2025 — 年化 +8%
  { date: '2025-01-31', total_twd: 1619000 },
  { date: '2025-02-28', total_twd: 1629400 },
  { date: '2025-03-31', total_twd: 1639900 },
  { date: '2025-04-30', total_twd: 1800500 },
  { date: '2025-05-31', total_twd: 1812000 },
  { date: '2025-06-30', total_twd: 1823700 },
  { date: '2025-07-31', total_twd: 1985400 },
  { date: '2025-08-31', total_twd: 1998200 },
  { date: '2025-09-30', total_twd: 2011100 },
  { date: '2025-10-31', total_twd: 2174000 },
  { date: '2025-11-30', total_twd: 2188000 },
  { date: '2025-12-31', total_twd: 2202100 },
  // 2026 — 年化 +14%（YTD ~+5%）
  { date: '2026-01-31', total_twd: 2327900 },
  { date: '2026-02-28', total_twd: 2355100 },
  { date: '2026-03-31', total_twd: 2382700 },
  { date: '2026-04-30', total_twd: 2460600 },
  { date: '2026-05-11', total_twd: 2470900 },
]

// transaction 日期與 snapshot 同日，HPR=(vEnd-cf)/vStart 才能正確扣除現金流
const transactions: Transaction[] = [
  { id: 'demo-q1-2023',  date: '2023-01-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2023',  date: '2023-04-30', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2023',  date: '2023-07-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2023',  date: '2023-10-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2024',  date: '2024-01-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2024',  date: '2024-04-30', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2024',  date: '2024-07-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2024',  date: '2024-10-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2025',  date: '2025-01-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2025',  date: '2025-04-30', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2025',  date: '2025-07-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2025',  date: '2025-10-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2026',  date: '2026-01-31', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 100000 },
  { id: 'demo-q2-2026a', date: '2026-04-30', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 50000  },
]

export const DEMO_STATE: AppState = {
  exchange_rate: 32.5,
  holdings: [
    { symbol: '0050',   name: '元大台50',  currency: 'TWD', category: 'core',        shares: 2000,  price: 205.50,  target_pct: 15  },
    { symbol: 'VOO',    name: '標普500',   currency: 'USD', category: 'core',        shares: 30,    price: 542.00,  target_pct: 20  },
    { symbol: '00631L', name: '台50正2',   currency: 'TWD', category: 'aggressive',  shares: 4000,  price: 62.00,   target_pct: 15  },
    { symbol: 'QQQ',    name: '納斯達克',  currency: 'USD', category: 'aggressive',  shares: 18,    price: 465.00,  target_pct: 15  },
    { symbol: 'VEA',    name: '非美成熟',  currency: 'USD', category: 'global',      shares: 120,   price: 51.50,   target_pct: 7.5 },
    { symbol: 'VWO',    name: '新興市場',  currency: 'USD', category: 'global',      shares: 140,   price: 44.80,   target_pct: 7.5 },
    { symbol: 'IAU',    name: '黃金',      currency: 'USD', category: 'alternative', shares: 50,    price: 56.80,   target_pct: 2   },
    { symbol: 'IBIT',   name: '比特幣',    currency: 'USD', category: 'alternative', shares: 25,    price: 53.20,   target_pct: 3   },
    { symbol: 'SGOV',   name: '短期美債',  currency: 'USD', category: 'defensive',   shares: 80,    price: 100.55,  target_pct: 7.5 },
  ],
  cash_accounts: [
    { id: 'twd-cash', bank: '台幣現金', currency: 'TWD', amount: 185000, type: 'bank', target_pct: 7.5 },
    { id: 'usd-cash', bank: '美金現金', currency: 'USD', amount: 124,    type: 'bank', target_pct: 0   },
  ],
  transactions,
  snapshots,
  retirement: {
    birth_year: 1990,
    retirement_age: 52,           // target year 2042
    target_amount_twd: 20000000,  // 2000萬
    monthly_contribution_wan: 5,  // 5萬/月 = 60萬/年
    expected_annual_return: 0.07,
  },
}
