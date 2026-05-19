import type { AppState, DailySnapshot, Transaction } from './types'

// 小明 demo: fictional user, monthly contribution 5萬 TWD, target 2,000萬 by 2042
// Investment start: 2023-01, returns: 2023=18%/yr, 2024=24%/yr, 2025=4%/yr, 2026=7%/yr

const snapshots: DailySnapshot[] = [
  { date: '2023-01-31', total_twd: 50000 },
  { date: '2023-02-28', total_twd: 100750 },
  { date: '2023-03-31', total_twd: 152261 },
  { date: '2023-04-30', total_twd: 204545 },
  { date: '2023-05-31', total_twd: 257613 },
  { date: '2023-06-30', total_twd: 311477 },
  { date: '2023-07-31', total_twd: 366149 },
  { date: '2023-08-31', total_twd: 421641 },
  { date: '2023-09-30', total_twd: 477966 },
  { date: '2023-10-31', total_twd: 535135 },
  { date: '2023-11-30', total_twd: 593162 },
  { date: '2023-12-31', total_twd: 652059 },
  { date: '2024-01-31', total_twd: 715100 },
  { date: '2024-02-29', total_twd: 779402 },
  { date: '2024-03-31', total_twd: 844990 },
  { date: '2024-04-30', total_twd: 911890 },
  { date: '2024-05-31', total_twd: 980128 },
  { date: '2024-06-30', total_twd: 1049731 },
  { date: '2024-07-31', total_twd: 1120725 },
  { date: '2024-08-31', total_twd: 1193140 },
  { date: '2024-09-30', total_twd: 1267003 },
  { date: '2024-10-31', total_twd: 1342343 },
  { date: '2024-11-30', total_twd: 1419190 },
  { date: '2024-12-31', total_twd: 1497574 },
  { date: '2025-01-31', total_twd: 1552514 },
  { date: '2025-02-28', total_twd: 1607635 },
  { date: '2025-03-31', total_twd: 1662939 },
  { date: '2025-04-30', total_twd: 1718425 },
  { date: '2025-05-31', total_twd: 1774091 },
  { date: '2025-06-30', total_twd: 1829941 },
  { date: '2025-07-31', total_twd: 1885974 },
  { date: '2025-08-31', total_twd: 1942193 },
  { date: '2025-09-30', total_twd: 1998595 },
  { date: '2025-10-31', total_twd: 2055183 },
  { date: '2025-11-30', total_twd: 2111957 },
  { date: '2025-12-31', total_twd: 2168916 },
  { date: '2026-01-31', total_twd: 2231909 },
  { date: '2026-02-28', total_twd: 2295299 },
  { date: '2026-03-31', total_twd: 2359071 },
  { date: '2026-04-30', total_twd: 2423225 },
  { date: '2026-05-11', total_twd: 2450024 },
]

const transactions: Transaction[] = [
  { id: 'demo-q1-2023',  date: '2023-01-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2023',  date: '2023-04-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2023',  date: '2023-07-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2023',  date: '2023-10-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2024',  date: '2024-01-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2024',  date: '2024-04-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2024',  date: '2024-07-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2024',  date: '2024-10-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2025',  date: '2025-01-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q2-2025',  date: '2025-04-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q3-2025',  date: '2025-07-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q4-2025',  date: '2025-10-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 150000 },
  { id: 'demo-q1-2026',  date: '2026-01-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 100000 },
  { id: 'demo-q2-2026a', date: '2026-04-10', type: 'cash_in', bank: '台幣現金', currency: 'TWD', amount: 50000  },
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
