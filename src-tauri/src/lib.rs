use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub mod sync_check;

// ── Helpers ───────────────────────────────────────────────────────────────────

fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("db-config.json")
}

fn get_taiwan_date() -> String {
    use chrono::Utc;
    Utc::now()
        .with_timezone(&chrono_tz::Asia::Taipei)
        .format("%Y-%m-%d")
        .to_string()
}

fn get_root_dir(app: &AppHandle) -> Option<String> {
    let raw = std::fs::read_to_string(config_path(app)).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&raw).ok()?;
    cfg["rootDir"].as_str().map(|s| s.to_string())
}

// Legacy: YYYY-MM-DD.json (used only for migration detection)
fn is_date_file(name: &str) -> bool {
    if name.len() != 15 || !name.ends_with(".json") {
        return false;
    }
    name[..10].chars().enumerate().all(|(i, c)| {
        if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }
    })
}

// New: YYYY-MM.json
fn is_month_file(name: &str) -> bool {
    if name.len() != 12 || !name.ends_with(".json") {
        return false;
    }
    let s = &name[..7];
    s[..4].chars().all(|c| c.is_ascii_digit())
        && s.chars().nth(4) == Some('-')
        && s[5..7].chars().all(|c| c.is_ascii_digit())
}

fn enrich_snapshot(date: &str, state: &serde_json::Value) -> Option<serde_json::Value> {
    let fx = state["exchange_rate"].as_f64().unwrap_or(1.0);
    let holdings = state["holdings"].as_array()?;
    let cash = state["cash_accounts"].as_array().cloned().unwrap_or_default();

    let h_val = |h: &serde_json::Value| -> f64 {
        let s = h["shares"].as_f64().unwrap_or(0.0);
        let p = h["price"].as_f64().unwrap_or(0.0);
        if h["currency"].as_str() == Some("USD") { s * p * fx } else { s * p }
    };
    let c_val = |c: &serde_json::Value| -> f64 {
        let a = c["amount"].as_f64().unwrap_or(0.0);
        if c["currency"].as_str() == Some("USD") { a * fx } else { a }
    };

    let total: f64 = holdings.iter().map(h_val).sum::<f64>()
        + cash.iter().map(c_val).sum::<f64>();
    if total <= 0.0 {
        return None;
    }

    let mut cats: HashMap<&str, f64> = [
        ("core", 0.0), ("aggressive", 0.0), ("global", 0.0),
        ("alternative", 0.0), ("defensive", 0.0),
    ].into_iter().collect();
    let mut htwd: HashMap<String, f64> = HashMap::new();
    let mut hshr: HashMap<String, f64> = HashMap::new();

    for h in holdings {
        let v = h_val(h);
        let sym = h["symbol"].as_str().unwrap_or("").to_string();
        let cat = h["category"].as_str().unwrap_or("");
        if let Some(cv) = cats.get_mut(cat) { *cv += v; }
        htwd.insert(sym.clone(), v);
        hshr.insert(sym, h["shares"].as_f64().unwrap_or(0.0));
    }
    for c in &cash {
        let v = c_val(c);
        let bank = c["bank"].as_str().unwrap_or("").to_string();
        *cats.entry("defensive").or_insert(0.0) += v;
        htwd.insert(bank, v);
    }

    let bucket_pct: HashMap<&str, f64> =
        cats.iter().map(|(&k, &v)| (k, v / total * 100.0)).collect();

    Some(serde_json::json!({
        "date": date,
        "total_twd": total,
        "bucket_pct": bucket_pct,
        "holdings_twd": htwd,
        "holdings_shares": hshr,
    }))
}

fn apply_delta(state: &mut serde_json::Value, tx: &serde_json::Value, sign: f64) {
    let ty = tx["type"].as_str().unwrap_or("");
    let symbol = tx["symbol"].as_str();
    let bank = tx["bank"].as_str();
    let shares = tx["shares"].as_f64().unwrap_or(0.0);
    let amount = tx["amount"].as_f64().unwrap_or(0.0);
    let comm = tx["commission"].as_f64().unwrap_or(0.0);

    match ty {
        "sell" => {
            if let Some(sym) = symbol {
                if let Some(arr) = state["holdings"].as_array_mut() {
                    if let Some(h) = arr.iter_mut().find(|h| h["symbol"].as_str() == Some(sym)) {
                        if let Some(sh) = h["shares"].as_f64() {
                            h["shares"] = serde_json::json!(sh - sign * shares);
                        }
                    }
                }
            }
            if let Some(bk) = bank {
                if bk != "__none" {
                    if let Some(arr) = state["cash_accounts"].as_array_mut() {
                        if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk)) {
                            if let Some(a) = c["amount"].as_f64() {
                                c["amount"] = serde_json::json!(a + sign * (amount - comm));
                            }
                        }
                    }
                }
            }
        }
        "buy" => {
            if let Some(sym) = symbol {
                if let Some(arr) = state["holdings"].as_array_mut() {
                    if let Some(h) = arr.iter_mut().find(|h| h["symbol"].as_str() == Some(sym)) {
                        if let Some(sh) = h["shares"].as_f64() {
                            h["shares"] = serde_json::json!(sh + sign * shares);
                        }
                    }
                }
            }
            if let Some(bk) = bank {
                if bk != "__none" {
                    if let Some(arr) = state["cash_accounts"].as_array_mut() {
                        if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk)) {
                            if let Some(a) = c["amount"].as_f64() {
                                c["amount"] = serde_json::json!(a - sign * (amount + comm));
                            }
                        }
                    }
                }
            }
        }
        "cash_in" | "dividend" => {
            if let Some(bk) = bank {
                if let Some(arr) = state["cash_accounts"].as_array_mut() {
                    if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk)) {
                        if let Some(a) = c["amount"].as_f64() {
                            c["amount"] = serde_json::json!(a + sign * amount);
                        }
                    }
                }
            }
        }
        "cash_out" => {
            if let Some(bk) = bank {
                if let Some(arr) = state["cash_accounts"].as_array_mut() {
                    if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk)) {
                        if let Some(a) = c["amount"].as_f64() {
                            c["amount"] = serde_json::json!(a - sign * amount);
                        }
                    }
                }
            }
        }
        // Mirror the frontend retroactivelyAdjustSnapshots so back-dated transfers /
        // new positions don't desync the on-disk history (which reload then trusts).
        "transfer" => {
            let amount_to = tx["amount_to"].as_f64().unwrap_or(amount);
            if let Some(bk) = bank {
                if let Some(arr) = state["cash_accounts"].as_array_mut() {
                    if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk)) {
                        if let Some(a) = c["amount"].as_f64() {
                            c["amount"] = serde_json::json!(a - sign * amount);
                        }
                    }
                }
            }
            if let Some(bk_to) = tx["bank_to"].as_str() {
                if let Some(arr) = state["cash_accounts"].as_array_mut() {
                    if let Some(c) = arr.iter_mut().find(|c| c["bank"].as_str() == Some(bk_to)) {
                        if let Some(a) = c["amount"].as_f64() {
                            c["amount"] = serde_json::json!(a + sign * amount_to);
                        }
                    }
                }
            }
        }
        "new_position" => {
            // apply (sign>0): set the holding's shares to the position size;
            // reverse (sign<0): clear it back to 0. Matches the TS path's set-not-add.
            if let Some(sym) = symbol {
                if let Some(arr) = state["holdings"].as_array_mut() {
                    if let Some(h) = arr.iter_mut().find(|h| h["symbol"].as_str() == Some(sym)) {
                        h["shares"] = serde_json::json!(if sign > 0.0 { shares } else { 0.0 });
                    }
                }
            }
        }
        _ => {}
    }
}

// ── Budget → Dashboard sync planning (pure, no IO) ──────────────────────────
//
// 把「記帳管家交易 → 儀表板交易」的決策邏輯抽成純函式，方便單元測試。
// 處理四件事：
//   A. 內部轉帳（兩側帳戶都對應看板銀行）合併成「一筆」transfer，而非兩筆 cash_in/out
//   B. 金額為 0 的交易不同步（房貸寬限期本金=0 等雜訊）
//   C. transfer 記錄同時記 budget_tx_id（expense 側）與 budget_tx_id_pair（income 側），
//      讓刪除偵測查任一邊都找得到
//   D. 產出的交易一律帶 currency 欄位

/// 組合備註：分類 + 原始備註。兩者皆空回傳 Null。
fn compose_note(category: &str, orig: &str) -> serde_json::Value {
    match (category.is_empty(), orig.is_empty()) {
        (false, false) => serde_json::Value::String(format!("{} · {}", category, orig)),
        (false, true)  => serde_json::Value::String(category.to_string()),
        (true,  false) => serde_json::Value::String(orig.to_string()),
        (true,  true)  => serde_json::Value::Null,
    }
}

/// 在現有看板交易中，找出對應某個 budget tx id 的位置。
/// 同時比對 budget_tx_id（轉帳 expense 側 / 一般交易）與 budget_tx_id_pair（轉帳 income 側）。
fn find_dash_pos_for_budget(dash_txs: &[serde_json::Value], budget_id: &str) -> Option<usize> {
    dash_txs.iter().position(|tx| {
        tx["budget_tx_id"].as_str() == Some(budget_id)
            || tx["budget_tx_id_pair"].as_str() == Some(budget_id)
    })
}

/// 規劃要新增到看板的交易。
/// 回傳 (要新增的看板交易, 要記入 synced_ids 的 budget tx id 清單)。
/// acc_map: budget account_id → (dashboard_bank_name, currency)
fn plan_budget_syncs(
    budget_txs: &[serde_json::Value],
    acc_map: &HashMap<String, (String, String)>,
    already_synced: &std::collections::HashSet<String>,
) -> (Vec<serde_json::Value>, Vec<String>) {
    // 是否為「可同步」的候選交易（共同條件）
    let is_candidate = |tx: &serde_json::Value| -> bool {
        let id  = tx["id"].as_str().unwrap_or("");
        let ty  = tx["type"].as_str().unwrap_or("");
        let amt = tx["amount"].as_f64().unwrap_or(0.0);
        let from_dash = tx["synced_from_dashboard"].as_bool() == Some(true);
        !from_dash
            && !id.is_empty()
            && !already_synced.contains(id)
            && amt > 0.0                                   // B：零金額不同步
            && (ty == "income" || ty == "expense")
    };

    // 依 transfer_id 分組（只看候選交易）
    let mut transfer_groups: HashMap<String, Vec<&serde_json::Value>> = HashMap::new();
    let mut singles: Vec<&serde_json::Value> = Vec::new();
    for tx in budget_txs {
        if !is_candidate(tx) { continue; }
        let tid = tx["transfer_id"].as_str().unwrap_or("");
        if tid.is_empty() {
            singles.push(tx);
        } else {
            transfer_groups.entry(tid.to_string()).or_default().push(tx);
        }
    }

    let mut new_txs: Vec<serde_json::Value> = Vec::new();
    let mut new_ids: Vec<String> = Vec::new();

    let bank_of  = |tx: &serde_json::Value| -> Option<(String, String)> {
        let aid = tx["account_id"].as_str().unwrap_or("");
        acc_map.get(aid).cloned()
    };
    let note_of = |tx: &serde_json::Value| -> serde_json::Value {
        let category  = tx["category"].as_str().unwrap_or("");
        let orig_note = tx["note"].as_str().unwrap_or("");
        compose_note(category, orig_note)
    };

    // ── 轉帳群組 ────────────────────────────────────────────────────────────
    for (_tid, txs) in &transfer_groups {
        let expense = txs.iter().find(|t| t["type"].as_str() == Some("expense"));
        let income  = txs.iter().find(|t| t["type"].as_str() == Some("income"));

        match (expense, income) {
            // A：兩側都對應看板銀行 → 合併成一筆 transfer
            (Some(exp), Some(inc)) if bank_of(exp).is_some() && bank_of(inc).is_some() => {
                let (bank,    currency) = bank_of(exp).unwrap();
                let (bank_to, _)        = bank_of(inc).unwrap();
                let exp_id = exp["id"].as_str().unwrap_or("").to_string();
                let inc_id = inc["id"].as_str().unwrap_or("").to_string();
                let amount    = exp["amount"].as_f64().unwrap_or(0.0);
                let amount_to = inc["amount"].as_f64().unwrap_or(amount);
                new_txs.push(serde_json::json!({
                    "id": format!("budget_{}", exp_id),
                    "type": "transfer",
                    "date": exp["date"].as_str().unwrap_or(""),
                    "bank": bank,
                    "bank_to": bank_to,
                    "currency": currency,                  // D
                    "amount": amount,
                    "amount_to": amount_to,                // 跨幣別轉帳兩側金額不同
                    "commission": 0,
                    "note": note_of(exp),
                    "budget_tx_id": exp_id,                // C：expense 側
                    "budget_tx_id_pair": inc_id,           // C：income 側
                }));
                new_ids.push(exp_id);
                new_ids.push(inc_id);                      // 兩個 id 都標記已同步
            }
            // 只有 expense 側對應看板 → cash_out
            (Some(exp), _) if bank_of(exp).is_some() => {
                push_cash_tx(&mut new_txs, &mut new_ids, exp, &bank_of(exp).unwrap(), note_of(exp));
            }
            // 只有 income 側對應看板 → cash_in
            (_, Some(inc)) if bank_of(inc).is_some() => {
                push_cash_tx(&mut new_txs, &mut new_ids, inc, &bank_of(inc).unwrap(), note_of(inc));
            }
            // 兩側都不對應 → 跳過
            _ => {}
        }
    }

    // ── 非轉帳交易 ──────────────────────────────────────────────────────────
    for tx in &singles {
        if let Some(bc) = bank_of(tx) {
            push_cash_tx(&mut new_txs, &mut new_ids, tx, &bc, note_of(tx));
        }
    }

    (new_txs, new_ids)
}

/// 把一筆 budget 收支轉成看板 cash_in/cash_out 並推入結果集。
fn push_cash_tx(
    new_txs: &mut Vec<serde_json::Value>,
    new_ids: &mut Vec<String>,
    tx: &serde_json::Value,
    bank_currency: &(String, String),
    note: serde_json::Value,
) {
    let id        = tx["id"].as_str().unwrap_or("").to_string();
    let ty        = tx["type"].as_str().unwrap_or("");
    let amt       = tx["amount"].as_f64().unwrap_or(0.0);
    let (bank, currency) = bank_currency.clone();
    let dash_type = if ty == "income" { "cash_in" } else { "cash_out" };
    new_txs.push(serde_json::json!({
        "id": format!("budget_{}", id),
        "type": dash_type,
        "date": tx["date"].as_str().unwrap_or(""),
        "bank": bank,
        "currency": currency,                              // D
        "amount": amt,
        "commission": 0,
        "note": note,
        "budget_tx_id": id,
    }));
    new_ids.push(id);
}

// ── Migration: move legacy YYYY-MM-DD.json → snapshots/YYYY-MM.json ──────────

async fn migrate_daily_to_monthly(root_dir: &PathBuf, snap_dir: &PathBuf) {
    // If snapshots/ already exists, migration already done
    if snap_dir.exists() {
        return;
    }

    let mut old_files: Vec<String> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(root_dir).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if is_date_file(&name) {
                old_files.push(name);
            }
        }
    }

    if old_files.is_empty() {
        // No old files — just create the dir so future saves work
        let _ = tokio::fs::create_dir_all(snap_dir).await;
        return;
    }

    if tokio::fs::create_dir_all(snap_dir).await.is_err() {
        return;
    }

    // Group by month
    let mut by_month: std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>> =
        std::collections::BTreeMap::new();

    for f in &old_files {
        let date = f.trim_end_matches(".json").to_string();
        let month = date[..7].to_string();
        let path = root_dir.join(f);
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) {
                by_month.entry(month).or_default().insert(date, state);
            }
        }
    }

    // Write monthly files
    for (month, map) in &by_month {
        let month_file = snap_dir.join(format!("{}.json", month));
        if let Ok(json) = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone())) {
            let _ = tokio::fs::write(&month_file, json).await;
        }
    }
    // Old daily files are left in place as backup — user can delete manually
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_db_config(app: AppHandle) -> serde_json::Value {
    std::fs::read_to_string(config_path(&app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({ "rootDir": null }))
}

#[tauri::command]
fn set_db_config(app: AppHandle, root_dir: Option<String>) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({ "rootDir": root_dir }))
        .map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_snapshots(app: AppHandle) -> serde_json::Value {
    let root_dir = match get_root_dir(&app) {
        Some(d) => d,
        None => return serde_json::json!({ "ok": false, "error": "尚未設定根目錄", "dates": [] }),
    };
    let dir = PathBuf::from(&root_dir);
    let snap_dir = dir.join("snapshots");

    // Auto-migrate legacy daily files on first run
    migrate_daily_to_monthly(&dir, &snap_dir).await;

    // Scan snapshots/ for YYYY-MM.json
    let month_files: Vec<String> = match tokio::fs::read_dir(&snap_dir).await {
        Ok(mut rd) => {
            let mut v = Vec::new();
            while let Ok(Some(entry)) = rd.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_month_file(&name) {
                    v.push(name);
                }
            }
            v.sort();
            v
        }
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string(), "dates": [] }),
    };

    if month_files.is_empty() {
        return serde_json::json!({ "ok": false, "error": "根目錄中沒有資料", "dates": [] });
    }

    // Collect all (date, state) pairs across all monthly files, sorted
    let mut all_entries: Vec<(String, serde_json::Value)> = Vec::new();
    for mf in &month_files {
        let path = snap_dir.join(mf);
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw) {
                for (date, state) in map {
                    all_entries.push((date, state));
                }
            }
        }
    }
    all_entries.sort_by(|a, b| a.0.cmp(&b.0));

    if all_entries.is_empty() {
        return serde_json::json!({ "ok": false, "error": "根目錄中沒有資料", "dates": [] });
    }

    let (latest_date, latest_state) = all_entries.last().unwrap().clone();

    // Build snapshots array from all entries
    let mut snaps: Vec<serde_json::Value> = Vec::new();
    for (date, state) in &all_entries {
        if let Some(snap) = enrich_snapshot(date, state) {
            snaps.push(snap);
        }
    }

    let dates: Vec<String> = all_entries.iter().map(|(d, _)| d.clone()).collect();
    let mut merged = latest_state;
    merged["snapshots"] = serde_json::json!(snaps);

    // Load transactions from dedicated file
    let tx_path = PathBuf::from(&root_dir).join("transactions.json");
    if let Ok(raw) = tokio::fs::read_to_string(&tx_path).await {
        if let Ok(txs) = serde_json::from_str::<serde_json::Value>(&raw) {
            merged["transactions"] = txs;
        }
    }

    // ── Optional: sync cash transactions from budget tracker ──────────────────
    let budget_path = PathBuf::from(&root_dir).join("budget.json");
    let sync_path   = PathBuf::from(&root_dir).join("sync.json");
    if budget_path.exists() {
        if let (Ok(b_raw), Ok(s_raw_or_default)) = (
            tokio::fs::read_to_string(&budget_path).await,
            tokio::fs::read_to_string(&sync_path).await
                .or_else(|_| Ok::<String, std::io::Error>("{}".to_string())),
        ) {
            if let (Ok(budget), Ok(sync)) = (
                serde_json::from_str::<serde_json::Value>(&b_raw),
                serde_json::from_str::<serde_json::Value>(&s_raw_or_default),
            ) {
                // 讀取所有 budget 交易：優先 budget/ 月份資料夾，fallback 舊格式 budget.json
                let budget_tx_dir = PathBuf::from(&root_dir).join("budget");
                let budget_transactions: Vec<serde_json::Value> = if budget_tx_dir.exists() {
                    let mut all = Vec::new();
                    if let Ok(mut rd) = tokio::fs::read_dir(&budget_tx_dir).await {
                        let mut mfs: Vec<String> = Vec::new();
                        while let Ok(Some(e)) = rd.next_entry().await {
                            let name = e.file_name().to_string_lossy().to_string();
                            if is_month_file(&name) { mfs.push(name); }
                        }
                        for mf in mfs {
                            if let Ok(raw) = tokio::fs::read_to_string(budget_tx_dir.join(&mf)).await {
                                if let Ok(txs) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
                                    all.extend(txs);
                                }
                            }
                        }
                    }
                    all
                } else {
                    // 舊格式 fallback
                    budget["transactions"].as_array().cloned().unwrap_or_default()
                };
                // 共用工作集：提前取出，刪除和新增都會修改
                let mut dash_txs: Vec<serde_json::Value> = merged["transactions"]
                    .as_array().cloned().unwrap_or_default();
                let mut synced_ids: Vec<String> = sync["budget_to_dashboard"]
                    .as_array().cloned().unwrap_or_default()
                    .iter().filter_map(|v| v.as_str().map(String::from)).collect();
                let mut changed = false;

                // budget 目前存在的所有 transaction id
                let current_budget_ids: std::collections::HashSet<String> = budget_transactions
                    .iter()
                    .filter_map(|tx| tx["id"].as_str().map(String::from))
                    .collect();

                // ── 1. 刪除偵測：已 sync 但 budget 中已不存在 → 從看板移除 ─────────
                // 用 find_dash_pos_for_budget 同時比對 budget_tx_id 與 budget_tx_id_pair，
                // 因此刪掉轉帳任一側都能找到那筆合併的 transfer 並一起清掉兩個 id。
                let deleted_ids: Vec<String> = synced_ids.iter()
                    .filter(|id| !current_budget_ids.contains(*id))
                    .cloned()
                    .collect();

                for del_id in &deleted_ids {
                    if let Some(pos) = find_dash_pos_for_budget(&dash_txs, del_id) {
                        let removed = dash_txs.remove(pos);
                        // 反向還原現金帳戶金額
                        apply_delta(&mut merged, &removed, -1.0);
                        // 同時把這筆看板交易引用的兩個 budget id 都移出 synced
                        let main_id = removed["budget_tx_id"].as_str().map(String::from);
                        let pair_id = removed["budget_tx_id_pair"].as_str().map(String::from);
                        synced_ids.retain(|id| {
                            Some(id) != main_id.as_ref() && Some(id) != pair_id.as_ref()
                        });
                        changed = true;
                    } else {
                        synced_ids.retain(|id| id != del_id);
                    }
                }

                // ── 2. 新增：尚未 sync 的 budget 交易 → 加到看板 ─────────────────
                let already_synced: std::collections::HashSet<String> =
                    synced_ids.iter().cloned().collect();

                // Map: budget account_id → (dashboard_bank_name, currency)
                let acc_map: std::collections::HashMap<String, (String, String)> = budget["accounts"]
                    .as_array().cloned().unwrap_or_default()
                    .iter().filter_map(|a| {
                        let id       = a["id"].as_str()?.to_string();
                        let bank     = a["dashboard_bank_name"].as_str()?.to_string();
                        let currency = a["currency"].as_str().unwrap_or("TWD").to_string();
                        if bank.is_empty() { return None; }
                        Some((id, (bank, currency)))
                    }).collect();

                // 純函式規劃：轉帳合併(A)、零金額過濾(B)、配對記錄(C)、currency 必帶(D)
                let (new_txs, new_ids) =
                    plan_budget_syncs(&budget_transactions, &acc_map, &already_synced);
                for new_tx in new_txs {
                    apply_delta(&mut merged, &new_tx, 1.0);
                    dash_txs.push(new_tx);
                    changed = true;
                }
                synced_ids.extend(new_ids);

                // ── 3. 有變更才寫檔 ───────────────────────────────────────────
                if changed {
                    merged["transactions"] = serde_json::json!(dash_txs);
                    if let Ok(j) = serde_json::to_string_pretty(&merged["transactions"]) {
                        let _ = tokio::fs::write(&tx_path, j).await;
                    }
                    let mut merged_sync = sync.clone();
                    merged_sync["budget_to_dashboard"] = serde_json::json!(synced_ids);
                    if let Ok(j) = serde_json::to_string_pretty(&merged_sync) {
                        let _ = tokio::fs::write(&sync_path, j).await;
                    }
                }
            }
        }
    }
    // ── End budget sync ───────────────────────────────────────────────────────

    serde_json::json!({
        "ok": true,
        "state": merged,
        "date": latest_date,
        "dates": dates,
    })
}

#[tauri::command]
async fn save_snapshot(app: AppHandle, state: serde_json::Value) -> Result<serde_json::Value, String> {
    let root_dir = get_root_dir(&app).ok_or("尚未設定根目錄")?;
    let date = get_taiwan_date();
    let dir = PathBuf::from(&root_dir);
    let snap_dir = dir.join("snapshots");
    tokio::fs::create_dir_all(&snap_dir).await.map_err(|e| e.to_string())?;

    // Save transactions to dedicated file
    if let Some(txs) = state.get("transactions") {
        let tx_json = serde_json::to_string_pretty(txs).map_err(|e| e.to_string())?;
        tokio::fs::write(dir.join("transactions.json"), tx_json).await.map_err(|e| e.to_string())?;
    }

    // Lean state: strip transactions and snapshots
    let mut lean = state.clone();
    if let Some(obj) = lean.as_object_mut() {
        obj.remove("transactions");
        obj.remove("snapshots");
    }

    // Write into YYYY-MM.json (create or update)
    let month_key = &date[..7];
    let month_file = snap_dir.join(format!("{}.json", month_key));
    let mut month_map: serde_json::Map<String, serde_json::Value> =
        tokio::fs::read_to_string(&month_file).await
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
    month_map.insert(date.clone(), lean);

    let json = serde_json::to_string_pretty(&serde_json::Value::Object(month_map))
        .map_err(|e| e.to_string())?;
    tokio::fs::write(&month_file, json).await.map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "ok": true, "date": date }))
}

#[tauri::command]
async fn retroactive_update(
    app: AppHandle,
    tx: serde_json::Value,
    direction: Option<i32>,
) -> Result<serde_json::Value, String> {
    let root_dir = get_root_dir(&app).ok_or("尚未設定根目錄")?;
    let sign: f64 = if direction == Some(-1) { -1.0 } else { 1.0 };
    let today = get_taiwan_date();
    let tx_date = tx["date"].as_str().unwrap_or("").to_string();
    let snap_dir = PathBuf::from(&root_dir).join("snapshots");

    let tx_month = &tx_date[..7.min(tx_date.len())];
    let today_month = &today[..7];

    // Find affected month files
    let month_files: Vec<String> = {
        let mut rd = tokio::fs::read_dir(&snap_dir).await.map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_month_file(&name) {
                let m = name.trim_end_matches(".json");
                if m >= tx_month && m <= today_month {
                    v.push(name);
                }
            }
        }
        v.sort();
        v
    };

    let mut updated: Vec<String> = Vec::new();
    for mf in &month_files {
        let path = snap_dir.join(mf);
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw) {
                let mut changed = false;
                for (date, state) in map.iter_mut() {
                    if date >= &tx_date && date.as_str() < today.as_str() {
                        apply_delta(state, &tx, sign);
                        updated.push(date.clone());
                        changed = true;
                    }
                }
                if changed {
                    if let Ok(json) = serde_json::to_string_pretty(&serde_json::Value::Object(map)) {
                        let _ = tokio::fs::write(&path, json).await;
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({ "ok": true, "updated": updated }))
}

#[derive(Serialize, Deserialize)]
pub struct HoldingInput {
    pub symbol: String,
    pub currency: String,
}

#[tauri::command]
async fn fetch_prices(holdings: Vec<HoldingInput>) -> serde_json::Value {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut handles = Vec::new();
    for h in &holdings {
        let c = client.clone();
        let sym = h.symbol.clone();
        let cur = h.currency.clone();
        handles.push(tokio::spawn(async move {
            // 決定 Yahoo 查詢符號：
            // - 已含後綴（如 00679B.TWO）→ 直接用
            // - 台幣標的 → 先試上市 .TW，抓不到再試上櫃 .TWO（債券 ETF 多在上櫃）
            // - 其餘 → 原樣
            let candidates: Vec<String> = if sym.contains('.') {
                vec![sym.clone()]
            } else if cur == "TWD" {
                vec![format!("{}.TW", sym), format!("{}.TWO", sym)]
            } else {
                vec![sym.clone()]
            };
            let mut price: Option<f64> = None;
            for ys in &candidates {
                let url = format!(
                    "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
                    ys
                );
                let p: Option<f64> = async {
                    let r = c.get(&url).send().await.ok()?;
                    if !r.status().is_success() { return None; }
                    let d: serde_json::Value = r.json().await.ok()?;
                    let pp = d["chart"]["result"][0]["meta"]["regularMarketPrice"].as_f64()?;
                    if pp > 0.0 { Some(pp) } else { None }
                }
                .await;
                if p.is_some() {
                    price = p;
                    break;
                }
            }
            (sym, price)
        }));
    }

    let rate_c = client.clone();
    let rate_handle = tokio::spawn(async move {
        let html = rate_c
            .get("https://rate.bot.com.tw/xrt?Lang=zh-TW")
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;

        let usd_tr = html.split("<tr").find(|b| b.contains("(USD)"))?.to_string();

        let mut nums: Vec<f64> = Vec::new();
        let mut pos = 0usize;
        loop {
            let rest = &usd_tr[pos..];
            let Some(td_off) = rest.find("<td") else { break };
            let from_td = &rest[td_off..];
            let Some(gt) = from_td.find('>') else { break };
            let cs = pos + td_off + gt + 1;
            if cs >= usd_tr.len() { break; }
            let Some(end_td) = usd_tr[cs..].find("</td>") else { break };
            let content = usd_tr[cs..cs + end_td].trim();
            if let Ok(v) = content.parse::<f64>() {
                if v > 0.0 { nums.push(v); }
            }
            pos = cs + end_td + 5;
        }
        nums.get(2).copied()
    });

    let mut prices: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut errors: Vec<String> = Vec::new();

    for handle in handles {
        if let Ok((sym, price)) = handle.await {
            prices.insert(
                sym.clone(),
                price.map(|p| serde_json::json!(p)).unwrap_or(serde_json::Value::Null),
            );
            if price.is_none() {
                errors.push(sym);
            }
        }
    }

    let exchange_rate = rate_handle.await.unwrap_or(None);

    serde_json::json!({
        "prices": prices,
        "exchange_rate": exchange_rate,
        "errors": errors,
    })
}

// ── Open external URL ─────────────────────────────────────────────────────────

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000) 避免 cmd.exe 閃出黑色主控台視窗
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── App setup ─────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_db_config,
            set_db_config,
            load_snapshots,
            save_snapshot,
            retroactive_update,
            fetch_prices,
            open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Tests: budget → dashboard sync planning ─────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn acc_map(entries: &[(&str, &str, &str)]) -> HashMap<String, (String, String)> {
        entries.iter()
            .map(|(id, bank, cur)| (id.to_string(), (bank.to_string(), cur.to_string())))
            .collect()
    }

    fn synced(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    // 一筆 budget 收支交易
    fn tx(id: &str, ty: &str, aid: &str, amount: f64) -> serde_json::Value {
        serde_json::json!({
            "id": id, "type": ty, "account_id": aid, "amount": amount,
            "date": "2026-06-09", "category": "", "note": "",
        })
    }

    // 1
    #[test]
    fn sync_empty_budget_returns_empty() {
        let (txs, ids) = plan_budget_syncs(&[], &acc_map(&[]), &synced(&[]));
        assert!(txs.is_empty());
        assert!(ids.is_empty());
    }

    // 2
    #[test]
    fn sync_expense_in_acc_map_becomes_cash_out() {
        let budget = vec![tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, ids) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0]["type"], "cash_out");
        assert_eq!(txs[0]["bank"], "富邦 台幣現金");
        assert_eq!(txs[0]["currency"], "TWD");
        assert_eq!(txs[0]["amount"], 500.0);
        assert_eq!(txs[0]["id"], "budget_e1");
        assert_eq!(txs[0]["budget_tx_id"], "e1");
        assert_eq!(ids, vec!["e1".to_string()]);
    }

    // 3
    #[test]
    fn sync_income_in_acc_map_becomes_cash_in() {
        let budget = vec![tx("i1", "income", "a1", 800.0)];
        let map = acc_map(&[("a1", "中信 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0]["type"], "cash_in");
    }

    // 4（修 B）
    #[test]
    fn sync_zero_amount_expense_skipped() {
        let budget = vec![tx("e0", "expense", "a1", 0.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, ids) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert!(txs.is_empty());
        assert!(ids.is_empty());
    }

    // 5
    #[test]
    fn sync_account_not_in_acc_map_skipped() {
        let budget = vec![tx("e1", "expense", "unknown", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert!(txs.is_empty());
    }

    // 6
    #[test]
    fn sync_synced_from_dashboard_skipped() {
        let mut t = tx("e1", "expense", "a1", 500.0);
        t["synced_from_dashboard"] = serde_json::json!(true);
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&[t], &map, &synced(&[]));
        assert!(txs.is_empty());
    }

    // 7
    #[test]
    fn sync_already_synced_id_skipped() {
        let budget = vec![tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&["e1"]));
        assert!(txs.is_empty());
    }

    // 轉帳配對輔助
    fn transfer_pair(exp_id: &str, exp_aid: &str, exp_amt: f64,
                     inc_id: &str, inc_aid: &str, inc_amt: f64,
                     tid: &str) -> Vec<serde_json::Value> {
        let mut e = tx(exp_id, "expense", exp_aid, exp_amt);
        let mut i = tx(inc_id, "income",  inc_aid, inc_amt);
        e["transfer_id"] = serde_json::json!(tid);
        i["transfer_id"] = serde_json::json!(tid);
        vec![e, i]
    }

    // 8（修 A）
    #[test]
    fn sync_transfer_both_in_acc_map_becomes_one_transfer() {
        let budget = transfer_pair("e1", "a1", 40000.0, "i1", "a2", 40000.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "元大 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0]["type"], "transfer");
        assert_eq!(txs[0]["bank"], "富邦 台幣現金");
        assert_eq!(txs[0]["bank_to"], "元大 台幣現金");
        assert_eq!(txs[0]["budget_tx_id"], "e1");
        assert_eq!(txs[0]["budget_tx_id_pair"], "i1");
        assert_eq!(txs[0]["amount"], 40000.0);
        assert_eq!(txs[0]["amount_to"], 40000.0);
    }

    // 9
    #[test]
    fn sync_transfer_produces_both_ids_in_synced() {
        let budget = transfer_pair("e1", "a1", 40000.0, "i1", "a2", 40000.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "元大 台幣現金", "TWD")]);
        let (_, ids) = plan_budget_syncs(&budget, &map, &synced(&[]));
        let set: HashSet<&String> = ids.iter().collect();
        assert!(set.contains(&"e1".to_string()));
        assert!(set.contains(&"i1".to_string()));
        assert_eq!(ids.len(), 2);
    }

    // 10
    #[test]
    fn sync_transfer_only_expense_side_becomes_cash_out() {
        let budget = transfer_pair("e1", "a1", 5000.0, "i1", "loan", 5000.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]); // a2/loan 不在
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0]["type"], "cash_out");
        assert_eq!(txs[0]["bank"], "富邦 台幣現金");
    }

    // 11
    #[test]
    fn sync_transfer_only_income_side_becomes_cash_in() {
        let budget = transfer_pair("e1", "loan", 5000.0, "i1", "a1", 5000.0, "t1");
        let map = acc_map(&[("a1", "中信 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs.len(), 1);
        assert_eq!(txs[0]["type"], "cash_in");
    }

    // 12
    #[test]
    fn sync_transfer_neither_side_skipped() {
        let budget = transfer_pair("e1", "x", 5000.0, "i1", "y", 5000.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, ids) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert!(txs.is_empty());
        assert!(ids.is_empty());
    }

    // 13
    #[test]
    fn sync_transfer_cross_currency_has_amount_to() {
        let budget = transfer_pair("e1", "a1", 40000.0, "i1", "a2", 1200.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "嘉信 美元現金", "USD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert_eq!(txs[0]["amount"], 40000.0);
        assert_eq!(txs[0]["amount_to"], 1200.0);
        assert_eq!(txs[0]["currency"], "TWD"); // expense 側幣別
    }

    // 14（修 D）
    #[test]
    fn sync_currency_always_in_output() {
        let budget = vec![tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "USD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert!(txs[0].get("currency").is_some());
        assert_eq!(txs[0]["currency"], "USD");
    }

    // 15
    #[test]
    fn sync_note_composed_from_category_and_note() {
        let mut t = tx("e1", "expense", "a1", 100.0);
        t["category"] = serde_json::json!("餐飲");
        t["note"] = serde_json::json!("7-11");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&[t], &map, &synced(&[]));
        assert_eq!(txs[0]["note"], "餐飲 · 7-11");
    }

    // 16
    #[test]
    fn sync_note_category_only() {
        let mut t = tx("e1", "expense", "a1", 100.0);
        t["category"] = serde_json::json!("餐飲");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&[t], &map, &synced(&[]));
        assert_eq!(txs[0]["note"], "餐飲");
    }

    // 17
    #[test]
    fn sync_note_empty_is_null() {
        let budget = vec![tx("e1", "expense", "a1", 100.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&[]));
        assert!(txs[0]["note"].is_null());
    }

    // 18
    #[test]
    fn sync_transfer_both_already_synced_skipped() {
        let budget = transfer_pair("e1", "a1", 40000.0, "i1", "a2", 40000.0, "t1");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "元大 台幣現金", "TWD")]);
        let (txs, _) = plan_budget_syncs(&budget, &map, &synced(&["e1", "i1"]));
        assert!(txs.is_empty());
    }

    // 19（修 C 前置）
    #[test]
    fn find_dash_pos_by_main_id() {
        let dash = vec![
            serde_json::json!({ "budget_tx_id": "other" }),
            serde_json::json!({ "budget_tx_id": "e1", "budget_tx_id_pair": "i1" }),
        ];
        assert_eq!(find_dash_pos_for_budget(&dash, "e1"), Some(1));
    }

    // 20（修 C）
    #[test]
    fn find_dash_pos_by_pair_id() {
        let dash = vec![
            serde_json::json!({ "budget_tx_id": "other" }),
            serde_json::json!({ "budget_tx_id": "e1", "budget_tx_id_pair": "i1" }),
        ];
        // 用 income 側 id 也要找得到那筆 transfer
        assert_eq!(find_dash_pos_for_budget(&dash, "i1"), Some(1));
        assert_eq!(find_dash_pos_for_budget(&dash, "nope"), None);
    }
}
