use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
        "cash_in" => {
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
                let deleted_ids: Vec<String> = synced_ids.iter()
                    .filter(|id| !current_budget_ids.contains(*id))
                    .cloned()
                    .collect();

                for del_id in &deleted_ids {
                    if let Some(pos) = dash_txs.iter().position(|tx| {
                        tx["budget_tx_id"].as_str() == Some(del_id.as_str())
                    }) {
                        let removed = dash_txs.remove(pos);
                        // 反向還原現金帳戶金額
                        apply_delta(&mut merged, &removed, -1.0);
                        changed = true;
                    }
                    synced_ids.retain(|id| id != del_id);
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

                // 每筆收支都 sync，包含兩方都在 acc_map 的「內部轉帳」（如富邦→元大）。
                // 內部轉帳也要 sync 兩側，否則各銀行餘額無法反映帳戶間的資金移動。
                // synced_ids 負責防止重複套用。
                let new_cash_txs: Vec<serde_json::Value> = budget_transactions
                    .into_iter().filter(|tx| {
                        let id  = tx["id"].as_str().unwrap_or("");
                        let ty  = tx["type"].as_str().unwrap_or("");
                        let aid = tx["account_id"].as_str().unwrap_or("");
                        let from_dash = tx["synced_from_dashboard"].as_bool() == Some(true);
                        !from_dash
                        && !id.is_empty()
                        && !already_synced.contains(id)
                        && (ty == "income" || ty == "expense")
                        && acc_map.contains_key(aid)
                    }).collect();

                for tx in &new_cash_txs {
                    let id       = tx["id"].as_str().unwrap_or("").to_string();
                    let ty       = tx["type"].as_str().unwrap_or("");
                    let aid      = tx["account_id"].as_str().unwrap_or("");
                    let amt      = tx["amount"].as_f64().unwrap_or(0.0);
                    let date     = tx["date"].as_str().unwrap_or("").to_string();
                    let (bank, currency) = acc_map.get(aid).cloned().unwrap_or_default();
                    let dash_type = if ty == "income" { "cash_in" } else { "cash_out" };

                    // 備註 = 分類 + 原始備註（若有）
                    let category = tx["category"].as_str().unwrap_or("").to_string();
                    let orig_note = tx["note"].as_str().unwrap_or("").to_string();
                    let note = match (category.is_empty(), orig_note.is_empty()) {
                        (false, false) => format!("{} · {}", category, orig_note),
                        (false, true)  => category,
                        (true,  false) => orig_note,
                        (true,  true)  => String::new(),
                    };

                    let new_tx = serde_json::json!({
                        "id": format!("budget_{}", id),
                        "type": dash_type,
                        "date": date,
                        "bank": bank,
                        "currency": currency,
                        "amount": amt,
                        "commission": 0,
                        "note": if note.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(note) },
                        "budget_tx_id": id,
                    });

                    apply_delta(&mut merged, &new_tx, 1.0);
                    dash_txs.push(new_tx);
                    synced_ids.push(id);
                    changed = true;
                }

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
            let ys = if cur == "TWD" { format!("{}.TW", sym) } else { sym.clone() };
            let url = format!(
                "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
                ys
            );
            let price: Option<f64> = async {
                let r = c.get(&url).send().await.ok()?;
                if !r.status().is_success() { return None; }
                let d: serde_json::Value = r.json().await.ok()?;
                let p = d["chart"]["result"][0]["meta"]["regularMarketPrice"].as_f64()?;
                if p > 0.0 { Some(p) } else { None }
            }
            .await;
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
