# 效能基準（Performance Baseline）

計算層（`src/lib/calc.ts`）熱路徑的微基準，作為**日後改動的回歸比較點**。
若某次修改讓某個函式明顯變慢，跑一次 `--compare` 就能看出來。

## 測試數據條件（固定、可重現）

定義於 `src/lib/perf.bench.ts`，刻意放大到遠超一般使用者：

| 項目 | 數量 |
|------|------|
| 持倉 holdings | 60 |
| 現金帳戶 cash_accounts | 10 |
| 交易 transactions | 3000（buy/sell/cash_in/cash_out 循環） |
| 每日快照 snapshots | 1825（≈ 5 年） |
| 資產桶 categories | 5（預設） |

資料用固定公式生成（無亂數、無 `Date.now()`），所以每次跑的輸入完全相同，
數字差異只反映程式碼變動或機器差異。

## 基準數字（2026-06-15，開發機）

> 絕對時間會因機器而異；比較時請在**同一台機器**上跑改動前後。

| 函式 | 約略每次耗時 | ops/sec |
|------|------------|---------|
| `totalAssetsTwd` | ~0.0003 ms | 3,670,000 |
| `categoryDrillDown` | ~0.0015 ms | 655,000 |
| `categorySummaries` | ~0.0038 ms | 265,000 |
| `rebalanceRows` | ~0.0081 ms | 124,000 |
| `computeNewMoneyAllocation` | ~0.017 ms | 58,000 |
| `computeTWR` | **~23.7 ms** | 42 |

`computeTWR` 是最重的一支（隨「快照數 × 現金流筆數」成長）；其餘都在 0.02 ms 以下，
即使資料量再大，分頁切換也不會卡。`computeTWR` 在 5 年每日快照下約 24 ms，屬一次性
計算（切到績效分頁時算一次、且有單筆 memo cache），可接受；若日後它明顯變慢，
是優先要看的對象。

## 怎麼用

```bash
# 跑基準、看當前數字
npm run bench

# 重新存基準（換機器、或確定要更新比較點時）
npm run bench:save        # 寫到 bench/baseline.json

# 改動後和基準比較（同一台機器）
npx vitest bench --run --compare bench/baseline.json
```

`bench/baseline.json` 已納入版本控制，作為比較點。**只有在確定要更新基準時**
才重存它（例如刻意的效能優化後，或換了固定的測試機器）。
