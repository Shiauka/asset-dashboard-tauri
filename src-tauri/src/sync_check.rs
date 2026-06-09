// ── 同步不變量驗證器（純函式 + 檔案載入器）────────────────────────────────────
//
// 給定共用資料夾的狀態，檢查「記帳管家 ↔ 儀表板」雙向同步的五大不變量。
// 既是測試用的 oracle，也能對真實資料夾跑健檢（見 examples/sync_check.rs）。
//
// 五大不變量：
//   1. 冪等性        — 再跑一次 sync 不會產生新交易（plan_budget_syncs 回傳空）
//   2. 引用完整      — sync.json 的 id ↔ 看板交易一一對應，無懸空
//   3. 無重複計帳    — 一個 budget id 最多被一筆看板交易引用
//   4. 刪除傳播      — 看板交易引用的 budget id 都還存在（無孤兒）
//   5. 無迴圈        — 一筆交易不會同時帶 synced_from_dashboard 與 budget_tx_id

use std::collections::{HashMap, HashSet};
use std::path::Path;
use serde_json::Value;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncIssue {
    pub invariant: String,   // idempotent / ref_integrity / no_double_count / deletion_propagation / no_loop
    pub severity: String,    // "error" | "warn"
    pub detail: String,
}

impl SyncIssue {
    fn err(inv: &str, detail: String) -> Self {
        SyncIssue { invariant: inv.into(), severity: "error".into(), detail }
    }
    fn warn(inv: &str, detail: String) -> Self {
        SyncIssue { invariant: inv.into(), severity: "warn".into(), detail }
    }
}

pub struct SyncCheckInput<'a> {
    pub budget_txs: &'a [Value],
    /// budget account_id → (dashboard_bank_name, currency)
    pub acc_map: &'a HashMap<String, (String, String)>,
    pub dash_txs: &'a [Value],
    pub budget_to_dashboard: &'a [String],
    pub dashboard_to_budget: &'a [String],
}

/// 純函式：檢查五大不變量，回傳所有發現的問題（空 = 全部通過）。
pub fn check_sync(input: &SyncCheckInput) -> Vec<SyncIssue> {
    let mut issues = Vec::new();

    // ── 1. 冪等性：用既有的規劃函式模擬「再跑一次」，應該產不出新交易 ─────────
    let already: HashSet<String> = input.budget_to_dashboard.iter().cloned().collect();
    let (planned, _) = crate::plan_budget_syncs(input.budget_txs, input.acc_map, &already);
    for tx in &planned {
        let bid = tx["budget_tx_id"].as_str().unwrap_or("?");
        issues.push(SyncIssue::err(
            "idempotent",
            format!("尚有未同步的 budget 交易 id={}（再跑一次 sync 會新增交易）", bid),
        ));
    }

    // ── 2. 引用完整（budget → dashboard 方向）────────────────────────────────
    let sync_set: HashSet<&String> = input.budget_to_dashboard.iter().collect();
    let mut referenced: HashSet<String> = HashSet::new();
    for tx in input.dash_txs {
        for key in ["budget_tx_id", "budget_tx_id_pair"] {
            if let Some(bid) = tx[key].as_str() {
                referenced.insert(bid.to_string());
                if !sync_set.contains(&bid.to_string()) {
                    issues.push(SyncIssue::err(
                        "ref_integrity",
                        format!("看板交易 {}={} 不在 sync.json 的 budget_to_dashboard", key, bid),
                    ));
                }
            }
        }
    }
    for id in input.budget_to_dashboard {
        if !referenced.contains(id) {
            issues.push(SyncIssue::warn(
                "ref_integrity",
                format!("sync.json id={} 沒有對應的看板交易（懸空，該 budget 交易將不會被重新同步）", id),
            ));
        }
    }

    // ── 2'. 引用完整（dashboard → steward 方向）──────────────────────────────
    let buysell_ids: HashSet<String> = input.dash_txs.iter()
        .filter(|t| matches!(t["type"].as_str(), Some("buy") | Some("sell")))
        .filter_map(|t| t["id"].as_str().map(String::from))
        .collect();
    for id in input.dashboard_to_budget {
        if !buysell_ids.contains(id) {
            issues.push(SyncIssue::warn(
                "ref_integrity",
                format!("dashboard_to_budget id={} 找不到對應的 buy/sell 交易", id),
            ));
        }
    }

    // ── 3. 無重複計帳：一個 budget id 最多被一筆看板交易引用 ───────────────────
    let mut ref_count: HashMap<String, usize> = HashMap::new();
    for tx in input.dash_txs {
        for key in ["budget_tx_id", "budget_tx_id_pair"] {
            if let Some(bid) = tx[key].as_str() {
                *ref_count.entry(bid.to_string()).or_default() += 1;
            }
        }
    }
    for (id, n) in &ref_count {
        if *n > 1 {
            issues.push(SyncIssue::err(
                "no_double_count",
                format!("budget id={} 被 {} 筆看板交易引用（重複計帳）", id, n),
            ));
        }
    }

    // ── 4. 刪除傳播：看板交易引用的 budget id 都應還存在 ─────────────────────
    let budget_ids: HashSet<String> = input.budget_txs.iter()
        .filter_map(|t| t["id"].as_str().map(String::from))
        .collect();
    for tx in input.dash_txs {
        for key in ["budget_tx_id", "budget_tx_id_pair"] {
            if let Some(bid) = tx[key].as_str() {
                if !budget_ids.contains(bid) {
                    let did = tx["id"].as_str().unwrap_or("?");
                    issues.push(SyncIssue::err(
                        "deletion_propagation",
                        format!("看板交易 id={} 引用的 budget id={} 已不存在（孤兒，刪除未傳播）", did, bid),
                    ));
                }
            }
        }
    }

    // ── 5. 無迴圈：一筆交易不會同時帶 synced_from_dashboard 與 budget_tx_id ────
    for tx in input.dash_txs {
        let from_dash = tx["synced_from_dashboard"].as_bool() == Some(true);
        let has_budget = tx["budget_tx_id"].is_string();
        if from_dash && has_budget {
            let did = tx["id"].as_str().unwrap_or("?");
            issues.push(SyncIssue::err(
                "no_loop",
                format!("看板交易 id={} 同時帶 synced_from_dashboard 與 budget_tx_id（同步迴圈）", did),
            ));
        }
    }

    issues
}

// ── 餘額對帳（方向二：帳務管家連結帳戶 vs 儀表板快照）─────────────────────────
//
// 帳務管家的 bank/cash 帳戶餘額 = initial_balance + Σ income − Σ expense（含同步進來的
// 投資/轉帳交易）。它應該對得上儀表板快照裡同名現金帳戶的金額。對不上 → 多半是
// 重複計帳（如歷史 buy/sell 被建成交易，雙計了 initial_balance）。設 warn：使用者也
// 可能在儀表板手動調整現金餘額而合理地產生差異。

pub struct BalanceInput<'a> {
    /// budget.json 的 accounts（原始，需含 initial_balance / type / dashboard_bank_name）
    pub accounts: &'a [Value],
    pub budget_txs: &'a [Value],
    /// dashboard_bank_name → 最新快照現金金額
    pub snapshot_cash: &'a HashMap<String, f64>,
}

pub fn check_account_balances(input: &BalanceInput) -> Vec<SyncIssue> {
    let mut issues = Vec::new();
    for acc in input.accounts {
        let bank_name = match acc["dashboard_bank_name"].as_str() {
            Some(b) if !b.is_empty() => b,
            _ => continue,
        };
        // 只對帳現金帳戶；securities 走 current_value、負債帳戶語義不同
        let ty = acc["type"].as_str().unwrap_or("");
        if ty != "bank" && ty != "cash" { continue; }

        let aid = acc["id"].as_str().unwrap_or("");
        let mut bal = acc["initial_balance"].as_f64().unwrap_or(0.0);
        for tx in input.budget_txs {
            if tx["account_id"].as_str() != Some(aid) { continue; }
            let amt = tx["amount"].as_f64().unwrap_or(0.0);
            match tx["type"].as_str() {
                Some("income")  => bal += amt,
                Some("expense") => bal -= amt,
                _ => {}
            }
        }

        let snap = match input.snapshot_cash.get(bank_name) {
            Some(v) => *v,
            None => continue, // 快照沒這個銀行 → 無法對帳
        };
        let diff = (bal - snap).abs();
        if diff > 1.0 {
            issues.push(SyncIssue::warn(
                "balance_reconcile",
                format!("帳戶「{}」帳務管家餘額 {:.2} 與儀表板快照 {:.2} 不一致（差 {:.2}，可能重複計帳）",
                    bank_name, bal, snap, diff),
            ));
        }
    }
    issues
}

// ── 檔案載入器：讀共用資料夾並執行檢查 ───────────────────────────────────────

fn read_json(path: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(path).ok()?;
    // 去掉 UTF-8 BOM（手動用 PowerShell/編輯器存檔可能留下），否則 serde 解析失敗
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    serde_json::from_str(raw).ok()
}

/// 讀整個共用資料夾，組裝 SyncCheckInput 並執行 check_sync。
pub fn load_and_check(root: &Path) -> Result<Vec<SyncIssue>, String> {
    // budget.json → accounts → acc_map
    let budget = read_json(&root.join("budget.json"))
        .ok_or_else(|| format!("讀不到 {}", root.join("budget.json").display()))?;
    let acc_map: HashMap<String, (String, String)> = budget["accounts"]
        .as_array().cloned().unwrap_or_default()
        .iter().filter_map(|a| {
            let id   = a["id"].as_str()?.to_string();
            let bank = a["dashboard_bank_name"].as_str()?.to_string();
            let cur  = a["currency"].as_str().unwrap_or("TWD").to_string();
            if bank.is_empty() { return None; }
            Some((id, (bank, cur)))
        }).collect();

    // budget/*.json（所有月份）→ budget_txs；fallback 舊 budget.json transactions
    let mut budget_txs: Vec<Value> = Vec::new();
    let budget_dir = root.join("budget");
    if budget_dir.is_dir() {
        let mut months: Vec<String> = std::fs::read_dir(&budget_dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| crate::is_month_file(n))
            .collect();
        months.sort();
        for m in months {
            if let Some(Value::Array(arr)) = read_json(&budget_dir.join(&m)) {
                budget_txs.extend(arr);
            }
        }
    } else if let Some(arr) = budget["transactions"].as_array() {
        budget_txs = arr.clone();
    }

    // transactions.json → dash_txs
    let dash_txs: Vec<Value> = match read_json(&root.join("transactions.json")) {
        Some(Value::Array(arr)) => arr,
        _ => Vec::new(),
    };

    // sync.json → 兩個 id 清單
    let sync = read_json(&root.join("sync.json")).unwrap_or_else(|| serde_json::json!({}));
    let to_list = |key: &str| -> Vec<String> {
        sync[key].as_array().cloned().unwrap_or_default()
            .iter().filter_map(|v| v.as_str().map(String::from)).collect()
    };
    let budget_to_dashboard = to_list("budget_to_dashboard");
    let dashboard_to_budget = to_list("dashboard_to_budget");

    let mut issues = check_sync(&SyncCheckInput {
        budget_txs: &budget_txs,
        acc_map: &acc_map,
        dash_txs: &dash_txs,
        budget_to_dashboard: &budget_to_dashboard,
        dashboard_to_budget: &dashboard_to_budget,
    });

    // 餘額對帳：讀最新快照的現金帳戶金額
    let snapshot_cash = load_latest_snapshot_cash(root);
    let accounts = budget["accounts"].as_array().cloned().unwrap_or_default();
    issues.extend(check_account_balances(&BalanceInput {
        accounts: &accounts,
        budget_txs: &budget_txs,
        snapshot_cash: &snapshot_cash,
    }));

    Ok(issues)
}

/// 讀 snapshots/ 最新月份檔最新日期的 cash_accounts → bank_name → amount。
fn load_latest_snapshot_cash(root: &Path) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let snap_dir = root.join("snapshots");
    let Ok(rd) = std::fs::read_dir(&snap_dir) else { return out };
    let mut months: Vec<String> = rd.filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| crate::is_month_file(n))
        .collect();
    months.sort();
    let Some(last) = months.last() else { return out };
    let Some(Value::Object(map)) = read_json(&snap_dir.join(last)) else { return out };
    // 取最新日期那筆 state
    let Some((_, state)) = map.into_iter().max_by(|a, b| a.0.cmp(&b.0)) else { return out };
    if let Some(cash) = state["cash_accounts"].as_array() {
        for c in cash {
            if let (Some(bank), Some(amt)) = (c["bank"].as_str(), c["amount"].as_f64()) {
                out.insert(bank.to_string(), amt);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc_map(entries: &[(&str, &str, &str)]) -> HashMap<String, (String, String)> {
        entries.iter()
            .map(|(id, bank, cur)| (id.to_string(), (bank.to_string(), cur.to_string())))
            .collect()
    }

    fn budget_tx(id: &str, ty: &str, aid: &str, amount: f64) -> Value {
        serde_json::json!({
            "id": id, "type": ty, "account_id": aid, "amount": amount,
            "date": "2026-06-09", "category": "", "note": "",
        })
    }

    fn count(issues: &[SyncIssue], invariant: &str) -> usize {
        issues.iter().filter(|i| i.invariant == invariant).count()
    }

    // 乾淨狀態：一筆 expense 已正確同步 → 零問題
    #[test]
    fn clean_state_no_issues() {
        let budget = vec![budget_tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "cash_out", "bank": "富邦 台幣現金",
            "currency": "TWD", "amount": 500.0, "budget_tx_id": "e1",
        })];
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &budget, acc_map: &map, dash_txs: &dash,
            budget_to_dashboard: &["e1".into()], dashboard_to_budget: &[],
        });
        assert!(issues.is_empty(), "預期零問題，實得：{:?}", issues);
    }

    // 不變量 1：有未同步交易 → idempotent 報錯
    #[test]
    fn detects_unsynced_candidate() {
        let budget = vec![budget_tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &budget, acc_map: &map, dash_txs: &[],
            budget_to_dashboard: &[], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "idempotent") >= 1);
    }

    // 不變量 2：看板交易的 budget_tx_id 不在 sync.json → ref_integrity 報錯
    #[test]
    fn detects_missing_in_sync_json() {
        let budget = vec![budget_tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "cash_out", "bank": "富邦 台幣現金",
            "currency": "TWD", "amount": 500.0, "budget_tx_id": "e1",
        })];
        // sync.json 故意是空的
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &budget, acc_map: &map, dash_txs: &dash,
            budget_to_dashboard: &[], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "ref_integrity") >= 1);
    }

    // 不變量 2：sync.json 有懸空 id → warn
    #[test]
    fn detects_dangling_sync_id() {
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &[], acc_map: &acc_map(&[]), dash_txs: &[],
            budget_to_dashboard: &["ghost".into()], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "ref_integrity") >= 1);
    }

    // 不變量 3：同一 budget id 被兩筆看板交易引用 → no_double_count 報錯
    #[test]
    fn detects_double_count() {
        let budget = vec![budget_tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![
            serde_json::json!({ "id": "budget_e1",  "type": "cash_out", "budget_tx_id": "e1" }),
            serde_json::json!({ "id": "budget_e1b", "type": "cash_out", "budget_tx_id": "e1" }),
        ];
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &budget, acc_map: &map, dash_txs: &dash,
            budget_to_dashboard: &["e1".into()], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "no_double_count") >= 1);
    }

    // 不變量 4：看板引用已不存在的 budget id → deletion_propagation 報錯
    #[test]
    fn detects_orphan_dash_tx() {
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_gone", "type": "cash_out", "budget_tx_id": "gone",
        })];
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &[], acc_map: &map, dash_txs: &dash,
            budget_to_dashboard: &["gone".into()], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "deletion_propagation") >= 1);
    }

    // 不變量 5：同時帶 synced_from_dashboard 與 budget_tx_id → no_loop 報錯
    #[test]
    fn detects_sync_loop() {
        let dash = vec![serde_json::json!({
            "id": "x", "type": "cash_out",
            "synced_from_dashboard": true, "budget_tx_id": "e1",
        })];
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &[], acc_map: &acc_map(&[]), dash_txs: &dash,
            budget_to_dashboard: &["e1".into()], dashboard_to_budget: &[],
        });
        assert!(count(&issues, "no_loop") >= 1);
    }

    // 轉帳合併後的乾淨狀態：用 pair 欄位也算引用，零問題
    #[test]
    fn clean_transfer_pair_no_issues() {
        let budget = vec![
            { let mut t = budget_tx("e1", "expense", "a1", 40000.0); t["transfer_id"] = serde_json::json!("t1"); t },
            { let mut t = budget_tx("i1", "income",  "a2", 40000.0); t["transfer_id"] = serde_json::json!("t1"); t },
        ];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "元大 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "transfer", "bank": "富邦 台幣現金", "bank_to": "元大 台幣現金",
            "currency": "TWD", "amount": 40000.0, "amount_to": 40000.0,
            "budget_tx_id": "e1", "budget_tx_id_pair": "i1",
        })];
        let issues = check_sync(&SyncCheckInput {
            budget_txs: &budget, acc_map: &map, dash_txs: &dash,
            budget_to_dashboard: &["e1".into(), "i1".into()], dashboard_to_budget: &[],
        });
        assert!(issues.is_empty(), "預期零問題，實得：{:?}", issues);
    }

    // ── 餘額對帳（方向二）─────────────────────────────────────────────────────
    fn snap_cash(entries: &[(&str, f64)]) -> HashMap<String, f64> {
        entries.iter().map(|(b, a)| (b.to_string(), *a)).collect()
    }

    // 餘額對得上 → 零問題
    #[test]
    fn balance_matches_no_issue() {
        let accounts = vec![serde_json::json!({
            "id": "fb", "type": "bank", "currency": "TWD",
            "initial_balance": 1000.0, "dashboard_bank_name": "富邦 台幣現金",
        })];
        // initial 1000 - expense 300 = 700，快照也是 700
        let txs = vec![budget_tx("e1", "expense", "fb", 300.0)];
        let issues = check_account_balances(&BalanceInput {
            accounts: &accounts, budget_txs: &txs,
            snapshot_cash: &snap_cash(&[("富邦 台幣現金", 700.0)]),
        });
        assert!(issues.is_empty(), "預期零問題，實得：{:?}", issues);
    }

    // 多計一筆 expense（如歷史 buy 被重複建）→ 帳務管家餘額偏低 → balance_reconcile 報警
    #[test]
    fn balance_mismatch_flags_double_count() {
        let accounts = vec![serde_json::json!({
            "id": "fb", "type": "bank", "currency": "TWD",
            "initial_balance": 1000.0, "dashboard_bank_name": "富邦 台幣現金",
        })];
        // 多了一筆雙計的投資買入 200 → 帳務管家 800，但快照仍是 1000
        let txs = vec![budget_tx("dash_bank_x", "expense", "fb", 200.0)];
        let issues = check_account_balances(&BalanceInput {
            accounts: &accounts, budget_txs: &txs,
            snapshot_cash: &snap_cash(&[("富邦 台幣現金", 1000.0)]),
        });
        assert_eq!(count(&issues, "balance_reconcile"), 1);
    }

    // 1 元以內的浮點差不報
    #[test]
    fn balance_within_tolerance_no_issue() {
        let accounts = vec![serde_json::json!({
            "id": "fb", "type": "bank", "currency": "TWD",
            "initial_balance": 1152574.56, "dashboard_bank_name": "富邦 台幣現金",
        })];
        let issues = check_account_balances(&BalanceInput {
            accounts: &accounts, budget_txs: &[],
            snapshot_cash: &snap_cash(&[("富邦 台幣現金", 1152573.70)]),
        });
        assert!(issues.is_empty());
    }

    // securities 帳戶不對帳（current_value 邏輯不同）
    #[test]
    fn balance_skips_securities_account() {
        let accounts = vec![serde_json::json!({
            "id": "sec", "type": "securities", "currency": "USD",
            "initial_balance": 0.0, "dashboard_bank_name": "嘉信證卷",
        })];
        let issues = check_account_balances(&BalanceInput {
            accounts: &accounts, budget_txs: &[],
            snapshot_cash: &snap_cash(&[("嘉信證卷", 99999.0)]),
        });
        assert!(issues.is_empty());
    }

    // 快照沒有對應銀行 → 跳過不報（無法對帳）
    #[test]
    fn balance_no_snapshot_entry_skipped() {
        let accounts = vec![serde_json::json!({
            "id": "fb", "type": "bank", "currency": "TWD",
            "initial_balance": 1000.0, "dashboard_bank_name": "富邦 台幣現金",
        })];
        let issues = check_account_balances(&BalanceInput {
            accounts: &accounts, budget_txs: &[], snapshot_cash: &snap_cash(&[]),
        });
        assert!(issues.is_empty());
    }
}
