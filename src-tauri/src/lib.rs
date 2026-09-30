use std::collections::HashMap;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub mod sync_check;
pub mod storage;

use storage::SnapMap;

// 序列化所有會讀取-修改-寫回 snapshots/*.json 的指令，避免多個並發呼叫
// （app 啟動 fetch_prices 回呼、視窗 focus 觸發的 saveToDb、手動存檔按鈕等）
// 互相交錯寫入同一個月檔案，造成檔案截斷錯位或彼此覆蓋（2026-08-19 踩雷根治）。
pub struct SnapshotLock(pub Mutex<()>);

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
    name.len() == 15 && name.ends_with(".json") && storage::is_date_name(&name[..10])
}

// New: YYYY-MM.json
fn is_month_file(name: &str) -> bool {
    storage::is_month_name(name)
}

/// 快照裡不存交易清單與快照陣列（交易另存 transactions.json）
fn lean_state(state: &serde_json::Value) -> serde_json::Value {
    let mut lean = state.clone();
    if let Some(obj) = lean.as_object_mut() {
        obj.remove("transactions");
        obj.remove("snapshots");
    }
    lean
}

// ── 月快照快取：一次操作裡所有月份的修改先在記憶體完成，最後用 Txn 一起寫 ──────────
struct MonthCache {
    root: PathBuf,
    maps: std::collections::BTreeMap<String, SnapMap>,
    dirty: std::collections::BTreeSet<String>,
}

impl MonthCache {
    fn new(root: &std::path::Path) -> Self {
        MonthCache { root: root.to_path_buf(), maps: Default::default(), dirty: Default::default() }
    }

    /// 取得某個月的快照（檔案不存在 → 空的新月份）。正式檔壞掉一律 Err，不改用備份寫回。
    async fn load(&mut self, month_file: &str) -> Result<&mut SnapMap, String> {
        if !self.maps.contains_key(month_file) {
            let m = match storage::read_month(&self.root, month_file).await {
                storage::MonthRead::Missing => SnapMap::new(),
                storage::MonthRead::Loaded(m, None) => m,
                storage::MonthRead::Loaded(_, Some(_)) | storage::MonthRead::Broken(_) => {
                    return Err(format!("snapshots/{} 損毀，為保護資料已停止寫入", month_file));
                }
            };
            self.maps.insert(month_file.to_string(), m);
        }
        Ok(self.maps.get_mut(month_file).unwrap())
    }

    fn mark(&mut self, month_file: &str) {
        self.dirty.insert(month_file.to_string());
    }

    fn into_txn(self, txn: &mut storage::Txn) -> Result<(), String> {
        for f in &self.dirty {
            txn.write_month(f, &self.maps[f])?;
        }
        Ok(())
    }
}

fn month_file_of(date: &str) -> Option<String> {
    if date.len() >= 7 && date.is_char_boundary(7) { Some(format!("{}.json", &date[..7])) } else { None }
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
            // Treated as buy/sell for retroactive snapshot patching (add, not set).
            if let Some(sym) = symbol {
                if let Some(arr) = state["holdings"].as_array_mut() {
                    if let Some(h) = arr.iter_mut().find(|h| h["symbol"].as_str() == Some(sym)) {
                        if let Some(sh) = h["shares"].as_f64() {
                            h["shares"] = serde_json::json!(sh + sign * shares);
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

// Patch every already-saved snapshot whose date is in [tx.date, today) with the same
// delta apply_delta() would apply live. Shared by the manual back-dated-entry command
// (retroactive_update) and the budget→dashboard sync path (sync_budget_into_state).
// Before this existed, a synced transaction back-dated to before "today" (e.g. entered
// into 帳務管家 days after the real transaction date) only patched today's in-memory
// state — already-saved historical snapshots stayed stale, which made TWR double-count
// the flow (the snapshot's cash balance hadn't dropped yet, but cfMap already excluded
// it) and produced a fake NAV spike followed by a fake crash once a later snapshot
// finally synced the real balance.
/// 把一筆日期早於今天的交易回填到 [tx.date, today) 之間所有已存在的快照（只改記憶體快取）。
async fn retro_patch(
    cache: &mut MonthCache,
    tx: &serde_json::Value,
    sign: f64,
    today: &str,
) -> Result<Vec<String>, String> {
    let tx_date = tx["date"].as_str().unwrap_or("").to_string();
    if tx_date.is_empty() || tx_date.as_str() >= today {
        return Ok(Vec::new());
    }
    let (Some(first), Some(last)) = (month_file_of(&tx_date), month_file_of(today)) else {
        return Ok(Vec::new());
    };
    let files = storage::list_month_files(&cache.root.join("snapshots")).await?;
    let mut updated = Vec::new();
    for mf in files.iter().filter(|f| **f >= first && **f <= last) {
        let map = cache.load(mf).await?;
        let mut changed = false;
        for (date, state) in map.iter_mut() {
            if date.as_str() >= tx_date.as_str() && date.as_str() < today {
                apply_delta(state, tx, sign);
                updated.push(date.clone());
                changed = true;
            }
        }
        if changed { cache.mark(mf); }
    }
    Ok(updated)
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

fn note_of(tx: &serde_json::Value) -> serde_json::Value {
    let category  = tx["category"].as_str().unwrap_or("");
    let orig_note = tx["note"].as_str().unwrap_or("");
    compose_note(category, orig_note)
}

fn bank_of(tx: &serde_json::Value, acc_map: &HashMap<String, (String, String)>) -> Option<(String, String)> {
    let aid = tx["account_id"].as_str().unwrap_or("");
    acc_map.get(aid).cloned()
}

/// 在現有看板交易中，找出對應某個 budget tx id 的位置。
/// 同時比對 budget_tx_id（轉帳 expense 側 / 一般交易）與 budget_tx_id_pair（轉帳 income 側）。
#[allow(dead_code)] // 舊的逐項同步規劃；同步已改為 D/S/K 三方比對，保留供既有單元測試
fn find_dash_pos_for_budget(dash_txs: &[serde_json::Value], budget_id: &str) -> Option<usize> {
    dash_txs.iter().position(|tx| {
        tx["budget_tx_id"].as_str() == Some(budget_id)
            || tx["budget_tx_id_pair"].as_str() == Some(budget_id)
    })
}

/// 是否為「結構上可同步」的候選交易，與是否已經同步過無關（income/expense、金額>0、非來自看板本身）。
fn is_syncable(tx: &serde_json::Value) -> bool {
    let id  = tx["id"].as_str().unwrap_or("");
    let ty  = tx["type"].as_str().unwrap_or("");
    let amt = tx["amount"].as_f64().unwrap_or(0.0);
    let from_dash = tx["synced_from_dashboard"].as_bool() == Some(true);
    !from_dash
        && !id.is_empty()
        && amt > 0.0                                   // B：零金額不同步
        && (ty == "income" || ty == "expense")
}

/// 依 transfer_id 把符合 filter 的候選交易分組。
fn group_by_transfer<'a>(
    budget_txs: &'a [serde_json::Value],
    filter: impl Fn(&serde_json::Value) -> bool,
) -> (HashMap<String, Vec<&'a serde_json::Value>>, Vec<&'a serde_json::Value>) {
    let mut transfer_groups: HashMap<String, Vec<&serde_json::Value>> = HashMap::new();
    let mut singles: Vec<&serde_json::Value> = Vec::new();
    for tx in budget_txs {
        if !filter(tx) { continue; }
        let tid = tx["transfer_id"].as_str().unwrap_or("");
        if tid.is_empty() {
            singles.push(tx);
        } else {
            transfer_groups.entry(tid.to_string()).or_default().push(tx);
        }
    }
    (transfer_groups, singles)
}

/// 把一筆 budget 收支轉成看板 cash_in/cash_out 交易（純函式）。
fn build_cash_tx(
    tx: &serde_json::Value,
    bank_currency: &(String, String),
    note: serde_json::Value,
) -> serde_json::Value {
    let id        = tx["id"].as_str().unwrap_or("").to_string();
    let ty        = tx["type"].as_str().unwrap_or("");
    let amt       = tx["amount"].as_f64().unwrap_or(0.0);
    let (bank, currency) = bank_currency.clone();
    let dash_type = if ty == "income" { "cash_in" } else { "cash_out" };
    serde_json::json!({
        "id": format!("budget_{}", id),
        "type": dash_type,
        "date": tx["date"].as_str().unwrap_or(""),
        "bank": bank,
        "currency": currency,                              // D
        "amount": amt,
        "commission": 0,
        "note": note,
        "budget_tx_id": id,
    })
}

/// 把一組轉帳配對（expense 側 + income 側都對應看板銀行）合併成一筆看板 transfer 交易（純函式）。
fn build_transfer_tx(
    exp: &serde_json::Value,
    inc: &serde_json::Value,
    bank: &str,
    bank_to: &str,
    currency: &str,
) -> serde_json::Value {
    let exp_id    = exp["id"].as_str().unwrap_or("").to_string();
    let inc_id    = inc["id"].as_str().unwrap_or("").to_string();
    let amount    = exp["amount"].as_f64().unwrap_or(0.0);
    let amount_to = inc["amount"].as_f64().unwrap_or(amount);
    serde_json::json!({
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
    })
}

/// 針對「單一轉帳群組」決定要不要同步、同步成什麼樣子（A：兩側合併 / 單側 cash_in|out / 都不對應）。
/// 回傳 (涉及的 budget id 清單, 查找既有看板紀錄用的 primary id, 產生的看板交易)。
fn resolve_transfer_group(
    txs: &[&serde_json::Value],
    acc_map: &HashMap<String, (String, String)>,
) -> Option<(Vec<String>, String, serde_json::Value)> {
    let expense = txs.iter().find(|t| t["type"].as_str() == Some("expense")).copied();
    let income  = txs.iter().find(|t| t["type"].as_str() == Some("income")).copied();

    match (expense, income) {
        // A：兩側都對應看板銀行 → 合併成一筆 transfer
        (Some(exp), Some(inc)) if bank_of(exp, acc_map).is_some() && bank_of(inc, acc_map).is_some() => {
            let (bank,    currency) = bank_of(exp, acc_map).unwrap();
            let (bank_to, _)        = bank_of(inc, acc_map).unwrap();
            let exp_id = exp["id"].as_str().unwrap_or("").to_string();
            let inc_id = inc["id"].as_str().unwrap_or("").to_string();
            let want = build_transfer_tx(exp, inc, &bank, &bank_to, &currency);
            Some((vec![exp_id.clone(), inc_id], exp_id, want))
        }
        // 只有 expense 側對應看板 → cash_out
        (Some(exp), _) if bank_of(exp, acc_map).is_some() => {
            let bc = bank_of(exp, acc_map).unwrap();
            let id = exp["id"].as_str().unwrap_or("").to_string();
            let want = build_cash_tx(exp, &bc, note_of(exp));
            Some((vec![id.clone()], id, want))
        }
        // 只有 income 側對應看板 → cash_in
        (_, Some(inc)) if bank_of(inc, acc_map).is_some() => {
            let bc = bank_of(inc, acc_map).unwrap();
            let id = inc["id"].as_str().unwrap_or("").to_string();
            let want = build_cash_tx(inc, &bc, note_of(inc));
            Some((vec![id.clone()], id, want))
        }
        // 兩側都不對應 → 跳過
        _ => None,
    }
}

/// 規劃要新增到看板的交易（尚未同步過的候選交易）。
/// 回傳 (要新增的看板交易, 要記入 synced_ids 的 budget tx id 清單)。
/// acc_map: budget account_id → (dashboard_bank_name, currency)
fn plan_budget_syncs(
    budget_txs: &[serde_json::Value],
    acc_map: &HashMap<String, (String, String)>,
    already_synced: &std::collections::HashSet<String>,
) -> (Vec<serde_json::Value>, Vec<String>) {
    let is_new_candidate = |tx: &serde_json::Value| -> bool {
        is_syncable(tx) && !already_synced.contains(tx["id"].as_str().unwrap_or(""))
    };
    let (transfer_groups, singles) = group_by_transfer(budget_txs, is_new_candidate);

    let mut new_txs: Vec<serde_json::Value> = Vec::new();
    let mut new_ids: Vec<String> = Vec::new();

    // ── 轉帳群組 ────────────────────────────────────────────────────────────
    for (_tid, txs) in &transfer_groups {
        if let Some((ids, _primary, want)) = resolve_transfer_group(txs, acc_map) {
            new_txs.push(want);
            new_ids.extend(ids);
        }
    }

    // ── 非轉帳交易 ──────────────────────────────────────────────────────────
    for tx in &singles {
        if let Some(bc) = bank_of(tx, acc_map) {
            let id = tx["id"].as_str().unwrap_or("").to_string();
            new_txs.push(build_cash_tx(tx, &bc, note_of(tx)));
            new_ids.push(id);
        }
    }

    (new_txs, new_ids)
}

/// 針對「已經同步過、但 budget 端內容已變更」的交易，規劃看板端要更新成什麼樣子。
/// 只處理仍是候選交易（income/expense、金額>0、帳戶仍對應看板銀行）且能在 dash_txs 中
/// 找到既有對應紀錄的情況；回傳 (dash_txs 內要更新的 index, 新的看板交易)。
/// 新增/刪除交由 plan_budget_syncs / 刪除偵測處理，這裡只處理「內容不一樣就換掉」
/// （例如編輯金額、日期、分類/備註、轉帳的對應帳戶）。
/// 內容比對，數字只比「值」：舊版存成整數 2456、重建出來是 2456.0，serde_json 的 == 會判定不同。
/// 以前因此每次開 app 都把一批 6 月交易當成「帳務管家改過」，對所有歷史快照先扣回再加上
/// （兩次分開寫檔，中間被打斷就永久漂移），也是每次開 app 都重寫 6～8 月快照的原因。
fn json_same(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => (x - y).abs() < 1e-9,
            _ => x == y,
        },
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len()
            && x.iter().all(|(k, v)| y.get(k).map_or(false, |w| json_same(v, w))),
        _ => a == b,
    }
}

#[allow(dead_code)] // 舊的逐項同步規劃；同步已改為 D/S/K 三方比對，保留供既有單元測試
fn plan_budget_updates(
    budget_txs: &[serde_json::Value],
    acc_map: &HashMap<String, (String, String)>,
    already_synced: &std::collections::HashSet<String>,
    dash_txs: &[serde_json::Value],
) -> Vec<(usize, serde_json::Value)> {
    let is_existing_candidate = |tx: &serde_json::Value| -> bool {
        is_syncable(tx) && already_synced.contains(tx["id"].as_str().unwrap_or(""))
    };
    let (transfer_groups, singles) = group_by_transfer(budget_txs, is_existing_candidate);

    let mut updates: Vec<(usize, serde_json::Value)> = Vec::new();

    for (_tid, txs) in &transfer_groups {
        if let Some((_ids, primary, want)) = resolve_transfer_group(txs, acc_map) {
            if let Some(pos) = find_dash_pos_for_budget(dash_txs, &primary) {
                if !json_same(&dash_txs[pos], &want) {
                    updates.push((pos, want));
                }
            }
        }
    }

    for tx in &singles {
        if let Some(bc) = bank_of(tx, acc_map) {
            let id = tx["id"].as_str().unwrap_or("").to_string();
            let want = build_cash_tx(tx, &bc, note_of(tx));
            if let Some(pos) = find_dash_pos_for_budget(dash_txs, &id) {
                if !json_same(&dash_txs[pos], &want) {
                    updates.push((pos, want));
                }
            }
        }
    }

    updates
}

// ── Migration: move legacy YYYY-MM-DD.json → snapshots/YYYY-MM.json ──────────

/// 回傳無法轉換的舊檔名（有的話要提示使用者，舊檔原地保留不刪）
async fn migrate_daily_to_monthly(root: &std::path::Path) -> Result<Vec<String>, String> {
    let snap_dir = root.join("snapshots");
    // 已經有 snapshots/（含已經遷移過）就不做；也絕不在這裡建立根目錄
    if tokio::fs::metadata(&snap_dir).await.is_ok() {
        return Ok(Vec::new());
    }
    let mut old_files: Vec<String> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(root).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if is_date_file(&name) { old_files.push(name); }
        }
    }
    if old_files.is_empty() {
        return Ok(Vec::new());
    }
    let mut by_month: std::collections::BTreeMap<String, SnapMap> = Default::default();
    let mut failed = Vec::new();
    for f in &old_files {
        let date = f.trim_end_matches(".json").to_string();
        match storage::read_json::<serde_json::Value>(&root.join(f)).await {
            storage::FileRead::Ok(state) => {
                by_month.entry(format!("{}.json", &date[..7])).or_default().insert(date, state);
            }
            _ => failed.push(f.clone()),
        }
    }
    let mut txn = storage::Txn::default();
    for (mf, map) in &by_month {
        txn.write_month(mf, map)?;
    }
    txn.commit(root).await?;
    // 舊的每日檔原地保留當備份
    Ok(failed)
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
    storage::atomic_write_sync(&path, json).map_err(|e| e.to_string())
}

// ── Shared: budget → dashboard cash-transaction sync ────────────────────────
// 把帳務管家的交易跟 merged["transactions"] 比對，新增/刪除/更新同步到 merged 上
// （含 apply_delta 調整 cash_accounts），歷史快照的回填只改 MonthCache，
// 交易清單與 sync.json 只放進 Txn —— 真正寫檔由呼叫端一次 commit（全部成功或下次重放）。
// 帳務管家不存在（單獨使用看板）時什麼都不做。

struct BudgetData {
    meta: serde_json::Value,
    txs: Vec<serde_json::Value>,
    /// 新格式（budget/ 月份資料夾）時，實際存在的月份（"YYYY-MM"）
    months_present: Option<std::collections::HashSet<String>>,
}

/// 讀帳務管家資料。沒有 budget.json → Ok(None)（單獨使用）。任何一個檔讀不到或壞掉 → Err：
/// 用不完整的資料同步，會把缺的那些交易當成「已刪除」而回沖。
async fn load_budget(root: &std::path::Path) -> Result<Option<BudgetData>, String> {
    if tokio::fs::metadata(root.join("budget.json")).await.is_err() {
        return Ok(None);
    }
    // 帳務管家存檔時持獨占鎖；這裡持共用鎖，保證讀到的是一次完整存檔後的樣子
    let _lock = storage::FileLock::acquire_shared(&root.join(storage::BUDGET_LOCK)).await?;
    if tokio::fs::metadata(root.join(BUDGET_JOURNAL)).await.is_ok() {
        return Err("帳務管家上次的存檔還沒完成（開啟帳務管家會自動補完）".into());
    }
    let data = load_budget_unlocked(root).await?;
    if let Some(d) = &data {
        let mut seen = std::collections::HashSet::new();
        if let Some(dup) = d.txs.iter().filter_map(|t| t["id"].as_str()).find(|id| !seen.insert(*id)) {
            return Err(format!("帳務管家資料裡同一筆交易出現兩次（{}），可能是舊版存檔被中斷；開啟一次帳務管家（v0.1.2 以上）會自動整理，之後就會恢復同步", dup));
        }
    }
    Ok(data)
}

/// 帳務管家存檔中斷時留下的日誌（帳務管家下次開啟會補完）
const BUDGET_JOURNAL: &str = ".budget-journal.json";

async fn load_budget_unlocked(root: &std::path::Path) -> Result<Option<BudgetData>, String> {
    let meta = match storage::read_json::<serde_json::Value>(&root.join("budget.json")).await {
        storage::FileRead::Missing => return Ok(None),
        storage::FileRead::Ok(v) => v,
        storage::FileRead::Broken(e) => return Err(format!("budget.json 損毀：{}", e)),
        storage::FileRead::Unreadable(e) => return Err(format!("budget.json 無法讀取：{}", e)),
    };
    let dir = root.join("budget");
    if tokio::fs::metadata(&dir).await.is_err() {
        let txs = meta["transactions"].as_array().cloned().unwrap_or_default();
        return Ok(Some(BudgetData { meta, txs, months_present: None }));
    }
    let mut txs = Vec::new();
    let mut present = std::collections::HashSet::new();
    for mf in storage::list_month_files(&dir).await? {
        match storage::read_json::<Vec<serde_json::Value>>(&dir.join(&mf)).await {
            storage::FileRead::Ok(v) => {
                present.insert(mf[..7].to_string());
                txs.extend(v);
            }
            storage::FileRead::Missing => return Err(format!("budget/{} 讀取途中消失", mf)),
            storage::FileRead::Broken(e) => return Err(format!("budget/{} 損毀：{}", mf, e)),
            storage::FileRead::Unreadable(e) => return Err(format!("budget/{} 無法讀取：{}", mf, e)),
        }
    }
    Ok(Some(BudgetData { meta, txs, months_present: Some(present) }))
}

fn bank_exists(state: &serde_json::Value, bank: &str) -> bool {
    state["cash_accounts"].as_array()
        .map_or(false, |a| a.iter().any(|c| c["bank"].as_str() == Some(bank)))
}

/// 這筆（看板格式的）交易要動到的帳戶是否都存在於看板
fn tx_banks_exist(state: &serde_json::Value, tx: &serde_json::Value) -> bool {
    tx["bank"].as_str().map_or(true, |b| bank_exists(state, b))
        && tx["bank_to"].as_str().map_or(true, |b| bank_exists(state, b))
}

#[derive(Default)]
struct SyncOutcome {
    changed: bool,
    warnings: Vec<String>,
}

async fn sync_budget_into_state(
    root: &std::path::Path,
    merged: &mut serde_json::Value,
    today: &str,
    cache: &mut MonthCache,
    txn: &mut storage::Txn,
) -> Result<SyncOutcome, String> {
    use std::collections::{BTreeMap, BTreeSet, HashSet};
    let mut out = SyncOutcome::default();
    let Some(budget) = load_budget(root).await? else { return Ok(out) };

    let sync = match storage::read_json::<serde_json::Value>(&root.join("sync.json")).await {
        storage::FileRead::Ok(v) => v,
        _ => serde_json::json!({}),
    };
    // 磁碟上的交易清單：它跟磁碟上的歷史快照永遠在同一筆寫入裡一起存，所以「歷史已經套用過哪些」
    // 以它為準。畫面送來的 state 只決定「今天」的現金（第三輪審查 R1/R2：兩者混用會把歷史扣兩次）。
    let mut disk_txs_present = true;
    let disk_txs: Vec<serde_json::Value> = match storage::read_json::<Vec<serde_json::Value>>(&root.join("transactions.json")).await {
        storage::FileRead::Ok(v) => v,
        storage::FileRead::Missing => { disk_txs_present = false; Vec::new() }
        storage::FileRead::Broken(e) | storage::FileRead::Unreadable(e) => return Err(format!("transactions.json 讀不到：{}", e)),
    };

    // 只同步「今天以前」的交易：分期、定期的未來期數到期那天才進看板現金
    let due: Vec<serde_json::Value> = budget.txs.iter()
        .filter(|t| t["date"].as_str().map_or(false, |d| d <= today))
        .cloned().collect();

    let mut dash_txs: Vec<serde_json::Value> = merged["transactions"].as_array().cloned().unwrap_or_default();
    let current_budget_ids: HashSet<String> = budget.txs.iter()
        .filter_map(|tx| tx["id"].as_str().map(String::from)).collect();

    // 帳務管家一筆交易都讀不到、但看板有已同步的交易 → 幾乎一定是資料沒同步到／被清掉，絕不當成「全部刪除」
    let has_synced = |v: &[serde_json::Value]| v.iter().any(|t| t["budget_tx_id"].is_string());
    if current_budget_ids.is_empty() && (has_synced(&dash_txs) || has_synced(&disk_txs)) {
        return Err("帳務管家的交易資料是空的，但看板有已同步的交易；為避免誤刪，這次不同步".into());
    }

    let acc_map: std::collections::HashMap<String, (String, String)> = budget.meta["accounts"]
        .as_array().cloned().unwrap_or_default()
        .iter().filter_map(|a| {
            let id       = a["id"].as_str()?.to_string();
            let bank     = a["dashboard_bank_name"].as_str()?.to_string();
            let currency = a["currency"].as_str().unwrap_or("TWD").to_string();
            if bank.is_empty() { return None; }
            Some((id, (bank, currency)))
        }).collect();

    // D：帳務管家「應該」在看板上呈現的樣子（以 budget_tx_id 為鍵）
    let (wanted, _) = plan_budget_syncs(&due, &acc_map, &HashSet::new());
    let key = |t: &serde_json::Value| t["budget_tx_id"].as_str().map(String::from);
    let d_map: BTreeMap<String, serde_json::Value> = wanted.into_iter().filter_map(|t| key(&t).map(|k| (k, t))).collect();
    // S：畫面狀態裡已同步的；K：磁碟上已同步的
    let s_map: BTreeMap<String, serde_json::Value> = dash_txs.iter().filter_map(|t| key(t).map(|k| (k, t.clone()))).collect();
    let k_map: BTreeMap<String, serde_json::Value> = disk_txs.iter().filter_map(|t| key(t).map(|k| (k, t.clone()))).collect();

    // 某個鍵在 D 裡沒有 → 要移除；但若是「那個月份的帳務管家檔案不見了」，不是被刪除，不動
    let month_missing = |t: &serde_json::Value| -> bool {
        match (&budget.months_present, t["date"].as_str()) {
            (Some(present), Some(d)) if d.len() >= 7 => !present.contains(&d[..7]),
            _ => false,
        }
    };
    // 某筆交易（被看板用 budget_tx_id / pair 兩個 id 代表）在帳務管家裡還存在嗎
    let still_in_budget = |t: &serde_json::Value| -> bool {
        ["budget_tx_id", "budget_tx_id_pair"].iter()
            .filter_map(|k| t[*k].as_str())
            .any(|id| current_budget_ids.contains(id))
    };

    // sync.json 記錄的已同步清單。v0.7.1 允許在看板刪掉同步來的交易：那種交易在清單裡、但看板上已經沒有，
    // 升級後不能因為「帳務管家還有」就默默加回來（使用者多半是因為跟手動記的重複才刪，加回來＝重複扣款）
    let before: Vec<String> = sync["budget_to_dashboard"].as_array().cloned().unwrap_or_default()
        .iter().filter_map(|v| v.as_str().map(String::from)).collect();
    let before_set: HashSet<&str> = before.iter().map(|s| s.as_str()).collect();
    // 帳務管家的交易 id → 帳戶有沒有對應到看板
    let budget_acc_mapped: std::collections::HashMap<&str, bool> = budget.txs.iter()
        .filter_map(|t| Some((t["id"].as_str()?, acc_map.contains_key(t["account_id"].as_str().unwrap_or("")))))
        .collect();
    // 這筆看板交易背後的帳務管家交易，有沒有哪一邊的帳戶已經取消對應（或帳戶被刪）
    // 規則（祿哥 2026-09-30 定案）：帳務管家還有這筆、但它（或轉帳某一側）的帳戶現在沒對應看板——
    // 不論是取消對應、刪掉帳戶、還是把交易改到沒對應的帳戶——看板一律保留原樣、不改歷史，只提示。
    // 差異由現金對帳警告呈現，交給使用者處理；不用猜測哪一種情況（第六～九輪都栽在猜測上）
    let account_unmapped = |t: &serde_json::Value| -> bool {
        ["budget_tx_id", "budget_tx_id_pair"].iter()
            .filter_map(|k| t[*k].as_str())
            .any(|id| budget_acc_mapped.get(id) == Some(&false))
    };

    // 只算「因為帳戶取消對應而被保留」的轉帳（見下方 R2）；其他情況那筆轉帳會被移除，另一側照常同步
    let referenced_as_pair: HashSet<String> = dash_txs.iter().chain(disk_txs.iter())
        .filter(|t| account_unmapped(t))
        .filter_map(|t| t["budget_tx_id_pair"].as_str().map(String::from)).collect();

    // 看板上任何轉帳的另一側 id：它不在 s/k 的鍵裡不代表被刪過（R1 不可把它當成使用者刪除）
    let any_pair: HashSet<String> = dash_txs.iter().chain(disk_txs.iter())
        .filter_map(|t| t["budget_tx_id_pair"].as_str().map(String::from)).collect();
    let keys: BTreeSet<String> = d_map.keys().chain(s_map.keys()).chain(k_map.keys()).cloned().collect();
    let mut skipped_missing_month = 0usize;
    let mut removed_today = 0usize;
    let mut unmapped: BTreeSet<String> = BTreeSet::new();
    let mut kept_deleted: Vec<String> = Vec::new();
    let mut kept_unmapped = 0usize;
    // 已同步清單裡、這次三方都看不到的 id：帳戶目前沒對應時要原樣留在清單裡（不然重建清單時會掉，
    // 重新對應後 v0.7.1 刪過的交易會被當成新的加回來；第十輪審查）
    let retained_unmapped: Vec<String> = before.iter()
        .filter(|id| !keys.contains(*id) && budget_acc_mapped.get(id.as_str()) == Some(&false))
        .cloned().collect();
    for k in keys {
        let d = d_map.get(&k);
        let s = s_map.get(&k);
        let kd = k_map.get(&k);
        // 轉帳（看板上是一筆、帶 pair）的其中一側帳戶取消對應：D 會變成單邊的一筆，但那筆轉帳真的發生過，
        // 跟單筆交易一樣保留原樣、不回沖（重新對應後照常比對）
        if d.is_some() {
            if let Some(existing) = s.or(kd) {
                if existing["budget_tx_id_pair"].is_string() && still_in_budget(existing) && account_unmapped(existing) {
                    kept_unmapped += 1;
                    continue;
                }
            }
        }
        if d.is_some() && s.is_none() && kd.is_none() && referenced_as_pair.contains(k.as_str()) {
            // 轉帳的一側帳戶取消對應後，另一側變成單獨一筆；但原本那筆轉帳（已含這一側）被保留著，
            // 再加就重複計算 → 不動、也不提示
            continue;
        }
        if d.is_some() && s.is_none() && kd.is_none() && disk_txs_present && before_set.contains(k.as_str()) && !any_pair.contains(k.as_str()) {
            // 同步過、之後在看板被刪掉（v0.7.1 允許）→ 尊重使用者的刪除，不加回來，並留在已同步清單
            kept_deleted.push(k.clone());
            continue;
        }
        if d.is_none() {
            // 帳務管家已經沒有這筆（或已不同步）。檔案不見的月份不動；還存在但變成不同步（例如金額改成 0）照常移除
            let existing = s.or(kd).unwrap();
            if month_missing(existing) && !still_in_budget(existing) {
                skipped_missing_month += 1;
                continue;
            }
            // 早期版本同步進來的 0 元紀錄（例如「本金 0」）：對現金沒有影響，帳務管家也還留著它 → 不動
            let zero = |t: Option<&serde_json::Value>| t.map_or(true, |t| t["amount"].as_f64().unwrap_or(0.0) == 0.0);
            if still_in_budget(existing) && zero(s) && zero(kd) {
                continue;
            }
            // 帳務管家還有這筆，只是帳戶取消對應／被刪：那筆錢真的花過，保留看板上的紀錄與歷史，不回沖
            if still_in_budget(existing) && account_unmapped(existing) {
                kept_unmapped += 1;
                continue;
            }
        }
        if let Some(want) = d {
            if !tx_banks_exist(merged, want) {
                for b in ["bank", "bank_to"] {
                    if let Some(x) = want[b].as_str() { if !bank_exists(merged, x) { unmapped.insert(x.to_string()); } }
                }
                continue; // 對應不到帳戶：這筆整個不動（不標記、不回填），補建帳戶後自動同步
            }
        }
        // 今天：畫面狀態 S → D
        let same_s = match (s, d) { (Some(a), Some(b)) => json_same(a, b), (None, None) => true, _ => false };
        if !same_s {
            if let Some(old) = s {
                apply_delta(merged, old, -1.0);
                dash_txs.retain(|t| key(t).as_deref() != Some(k.as_str()));
                if d.is_none() && !still_in_budget(old) { removed_today += 1; }
            }
            if let Some(new) = d {
                apply_delta(merged, new, 1.0);
                dash_txs.push(new.clone());
            }
            out.changed = true;
        }
        // 歷史：磁碟 K → D
        let same_k = match (kd, d) { (Some(a), Some(b)) => json_same(a, b), (None, None) => true, _ => false };
        if !same_k {
            if let Some(old) = kd { retro_patch(cache, old, -1.0, today).await?; }
            if let Some(new) = d { retro_patch(cache, new, 1.0, today).await?; }
            out.changed = true;
        }
    }
    if skipped_missing_month > 0 {
        out.warnings.push(format!(
            "帳務管家有 {} 筆已同步交易所屬的月份檔案不存在，已略過（沒有刪除）", skipped_missing_month));
    }
    if !kept_deleted.is_empty() {
        out.warnings.push(format!(
            "有 {} 筆帳務管家的交易先前在看板被刪除過，維持不同步（如果要讓它回來，請在帳務管家重新記一筆）", kept_deleted.len()));
    }
    if kept_unmapped > 0 {
        out.warnings.push(format!(
            "帳務管家有 {} 筆已同步的交易，所屬帳戶現在沒有對應看板（取消對應、帳戶被刪，或交易被改到沒對應的帳戶）。看板保留這些紀錄、不改歷史；若兩邊餘額因此不同，請到帳務管家確認帳戶對應", kept_unmapped));
    }
    if removed_today > 0 {
        out.warnings.push(format!(
            "帳務管家那邊刪除了 {} 筆交易，看板已跟著移除（如果不是你刪的，請檢查帳務管家的資料）", removed_today));
    }
    if !unmapped.is_empty() {
        out.warnings.push(format!("帳務管家設定對應的看板帳戶不存在：{}（相關交易尚未同步）",
            unmapped.into_iter().collect::<Vec<_>>().join("、")));
    }

    if out.changed {
        merged["transactions"] = serde_json::json!(dash_txs);
        txn.write_json("transactions.json", &merged["transactions"])?;
    }
    let mut synced_ids: Vec<String> = Vec::new();
    heal_synced_ids(&mut synced_ids, &dash_txs);
    // 使用者刪掉的那幾筆（含轉帳另一側的 id）要留在清單裡，下次才認得出來
    for id in &retained_unmapped { if !synced_ids.contains(id) { synced_ids.push(id.clone()); } }
    for k in &kept_deleted {
        let pair_ids: Vec<String> = d_map.get(k).map(|t| ["budget_tx_id", "budget_tx_id_pair"].iter()
            .filter_map(|f| t[*f].as_str().map(String::from)).collect()).unwrap_or_default();
        for id in pair_ids { if !synced_ids.contains(&id) { synced_ids.push(id); } }
    }
    if before != synced_ids {
        txn.sync_key("budget_to_dashboard", serde_json::json!(synced_ids));
    }
    Ok(out)
}

/// 在副本上跑同步，成功才採用（失敗時 state / 快取 / Txn 都維持原樣，只回報原因）
async fn sync_trial(
    root: &std::path::Path,
    state: &mut serde_json::Value,
    today: &str,
    cache: &mut MonthCache,
    txn: &mut storage::Txn,
) -> SyncOutcome {
    let mut t_state = state.clone();
    let mut t_cache = MonthCache { root: cache.root.clone(), maps: cache.maps.clone(), dirty: cache.dirty.clone() };
    let mut t_txn = storage::Txn::default();
    match sync_budget_into_state(root, &mut t_state, today, &mut t_cache, &mut t_txn).await {
        Ok(o) => {
            *state = t_state;
            *cache = t_cache;
            txn.absorb(t_txn);
            o
        }
        Err(e) => SyncOutcome { changed: false, warnings: vec![format!("帳務管家資料這次沒有同步（其他資料照常儲存）：{}", e)] },
    }
}

/// 月快照的修復來源是某天的每日備份（backup/daily/<日期>/snapshots/...），而目前的交易檔
/// 跟那天備份裡的交易檔不一樣 → 單獨補回快照會跟交易清單不同時間點。
/// 來源是 snapshots/backup/（同一次存檔的上一版）不在此限。
async fn daily_backup_txs_differ(root: &std::path::Path, src: &std::path::Path) -> bool {
    let daily = root.join("backup").join("daily");
    let Ok(rel) = src.strip_prefix(&daily) else { return false };
    let Some(day) = rel.components().next() else { return false };
    let day_dir = daily.join(day.as_os_str());
    let read = |p: std::path::PathBuf| async move {
        match storage::read_json::<serde_json::Value>(&p).await {
            storage::FileRead::Ok(v) => Some(v),
            _ => None,
        }
    };
    match (read(root.join("transactions.json")).await, read(day_dir.join("transactions.json")).await) {
        (Some(now), Some(then)) => !json_same(&now, &then),
        (None, None) => false,
        _ => true,
    }
}

/// 把看板交易上記錄的 budget id 併入已同步清單。sync.json 遺失、或被帳務管家用舊版
/// 蓋回去時，只看它會把已同步的交易再套一次、現金重複計算。
fn heal_synced_ids(synced_ids: &mut Vec<String>, dash_txs: &[serde_json::Value]) {
    let mut seen: std::collections::HashSet<String> = synced_ids.iter().cloned().collect();
    for t in dash_txs {
        for k in ["budget_tx_id", "budget_tx_id_pair"] {
            if let Some(id) = t[k].as_str() {
                if !id.is_empty() && seen.insert(id.to_string()) {
                    synced_ids.push(id.to_string());
                }
            }
        }
    }
}

// ── 現金餘額對帳 ──────────────────────────────────────────────────────────────
// 帳務管家的帳目（期初餘額＋所有收支）加上「看板自己記、沒有鏡射到帳務管家」的現金異動，
// 應該等於看板的現金餘額。對不上代表某次同步漏套／重套，會永久漂移。
// 單獨使用看板（沒有帳務管家）時不檢查。
fn compute_ledger_mismatches(
    budget: &serde_json::Value,
    budget_txs: &[serde_json::Value],
    state: &serde_json::Value,
    today: &str,
) -> Vec<serde_json::Value> {
    use std::collections::{BTreeMap, HashMap, HashSet};
    // 看板帳戶 → 期望餘額（多個帳務管家帳戶可能對到同一個看板帳戶，要加總）
    let mut expected: BTreeMap<String, f64> = BTreeMap::new();
    let mut id_to_bank: HashMap<String, String> = HashMap::new();
    for acc in budget["accounts"].as_array().cloned().unwrap_or_default() {
        let (Some(id), Some(bank)) = (acc["id"].as_str(), acc["dashboard_bank_name"].as_str()) else { continue };
        if bank.is_empty() { continue; }
        *expected.entry(bank.to_string()).or_insert(0.0) += acc["initial_balance"].as_f64().unwrap_or(0.0);
        id_to_bank.insert(id.to_string(), bank.to_string());
    }
    if expected.is_empty() { return Vec::new(); }
    let mut earliest: Option<String> = None;
    let mut mirrored: HashSet<String> = HashSet::new();
    // 帳務管家帳戶的「投資同步起始日」：早於這天的看板買賣已含在期初餘額
    let mut since: HashMap<String, String> = HashMap::new();
    for acc in budget["accounts"].as_array().cloned().unwrap_or_default() {
        if let (Some(bank), Some(s)) = (acc["dashboard_bank_name"].as_str(), acc["investment_sync_since"].as_str()) {
            since.insert(bank.to_string(), s.to_string());
        }
    }
    for t in budget_txs {
        if let Some(d) = t["dashboard_tx_id"].as_str() { mirrored.insert(d.to_string()); }
        let Some(date) = t["date"].as_str() else { continue };
        if earliest.as_deref().map_or(true, |e| date < e) { earliest = Some(date.to_string()); }
        if date > today { continue; } // 未來的分期/週期交易還沒發生
        // 跟同步用同一套規則：看板收不到的（金額 ≤ 0，例如信用卡回饋的負支出）就不算
        let from_dash = t["synced_from_dashboard"].as_bool() == Some(true);
        if !from_dash && t["amount"].as_f64().unwrap_or(0.0) <= 0.0 { continue; }
        let Some(bank) = t["account_id"].as_str().and_then(|a| id_to_bank.get(a)) else { continue };
        let amt = t["amount"].as_f64().unwrap_or(0.0);
        match t["type"].as_str() {
            Some("income") => *expected.get_mut(bank).unwrap() += amt,
            Some("expense") => *expected.get_mut(bank).unwrap() -= amt,
            _ => {}
        }
    }
    // 看板自己記、沒鏡射到帳務管家的現金異動（例如直接在看板記的現金入/出、轉帳）
    let start = earliest.unwrap_or_default();
    for t in state["transactions"].as_array().cloned().unwrap_or_default() {
        if t["budget_tx_id"].is_string() { continue; }
        if t["id"].as_str().map_or(false, |id| mirrored.contains(id)) { continue; }
        let Some(date) = t["date"].as_str() else { continue };
        if date < start.as_str() || date > today { continue; }
        let amt = t["amount"].as_f64().unwrap_or(0.0);
        let fee = t["commission"].as_f64().unwrap_or(0.0);
        let bank = t["bank"].as_str().unwrap_or("");
        // 起始日以前的看板買賣／配息已含在帳務管家的期初餘額；其他現金異動照算
        let invest = matches!(t["type"].as_str(), Some("buy") | Some("sell") | Some("dividend"));
        if invest && since.get(bank).map_or(false, |s| date < s.as_str()) { continue; }
        let delta = match t["type"].as_str() {
            Some("cash_in") | Some("dividend") => amt,
            Some("cash_out") => -amt,
            Some("buy") => -(amt + fee),
            Some("sell") => amt - fee,
            Some("transfer") => {
                if let Some(to) = t["bank_to"].as_str() {
                    if let Some(v) = expected.get_mut(to) {
                        *v += t["amount_to"].as_f64().unwrap_or(amt);
                    }
                }
                -amt
            }
            _ => 0.0,
        };
        if let Some(v) = expected.get_mut(bank) { *v += delta; }
    }
    let mut out = Vec::new();
    for (bank, ledger) in expected {
        let dash = state["cash_accounts"].as_array()
            .and_then(|arr| arr.iter().find(|c| c["bank"].as_str() == Some(bank.as_str())))
            .and_then(|c| c["amount"].as_f64());
        if let Some(dash) = dash {
            if (dash - ledger).abs() > 1.0 {
                out.push(serde_json::json!({
                    "bank": bank,
                    "dashboard": (dash * 100.0).round() / 100.0,
                    "ledger": (ledger * 100.0).round() / 100.0,
                }));
            }
        }
    }
    out
}

async fn ledger_cash_mismatches(root: &std::path::Path, state: &serde_json::Value, today: &str) -> Vec<serde_json::Value> {
    match load_budget(root).await {
        Ok(Some(b)) => compute_ledger_mismatches(&b.meta, &b.txs, state, today),
        _ => Vec::new(),
    }
}

// ── Commands: load / save ─────────────────────────────────────────────────────

fn root_path(app: &AppHandle) -> Option<PathBuf> {
    get_root_dir(app).map(PathBuf::from)
}

fn fail(code: &str, error: String) -> serde_json::Value {
    serde_json::json!({ "ok": false, "code": code, "error": error, "dates": [], "brokenFiles": [], "writeBlocked": code != "EMPTY" })
}

#[tauri::command]
async fn load_snapshots(app: AppHandle, lock: tauri::State<'_, SnapshotLock>) -> Result<serde_json::Value, String> {
    let _guard = lock.0.lock().await;
    load_at(root_path(&app), &get_taiwan_date()).await
}

async fn load_at(root: Option<PathBuf>, today: &str) -> Result<serde_json::Value, String> {
    let today = today.to_string();
    let Some(root) = root else { return Ok(fail("NO_ROOT", "尚未設定根目錄".into())) };
    match tokio::fs::metadata(&root).await {
        Ok(m) if m.is_dir() => {}
        _ => return Ok(fail("ROOT_MISSING", format!(
            "找不到資料夾「{}」。可能是隨身碟沒插、雲端硬碟未同步或資料夾被改名／搬走。為避免資料分岔，已停止讀寫；請接回資料夾後重新開啟，或到「根目錄設定」重新選擇。",
            root.display()))),
    }
    let mut warnings: Vec<String> = Vec::new();

    // 上次未完成的寫入先補完
    let mut broken: Vec<String> = Vec::new();
    match storage::recover_journal(&root).await {
        Ok(true) => warnings.push("上次關閉前有一筆寫入沒完成，已自動補完".into()),
        Ok(false) => {}
        // 補不完就不能再寫任何東西（否則新的寫入會跟那筆沒完成的混在一起）
        Err(e) => broken.push(e),
    }
    storage::cleanup_stale_tmp(&root).await;
    match migrate_daily_to_monthly(&root).await {
        Ok(failed) if !failed.is_empty() => warnings.push(format!(
            "舊版每日檔有 {} 個無法讀取，未轉入（原檔保留）：{}", failed.len(), failed.join("、"))),
        Ok(_) => {}
        Err(e) => warnings.push(format!("舊版資料轉換失敗：{}", e)),
    }

    let snap_dir = root.join("snapshots");
    let mut month_files = match storage::list_month_files(&snap_dir).await {
        Ok(v) => v,
        Err(e) => return Ok(fail("READ_ERROR", format!("無法讀取 snapshots 資料夾：{}", e))),
    };
    // 正式檔被刪掉、但備份裡還有的月份也要找回來（否則整個月默默消失）
    let mut bak_dirs = vec![snap_dir.join("backup")];
    if let Some(d) = storage::repair_daily_dates(&root).await.last() {
        bak_dirs.push(root.join("backup").join("daily").join(d).join("snapshots"));
    }
    for bd in bak_dirs {
        if let Ok(bak) = storage::list_month_files(&bd).await {
            for f in bak {
                if !month_files.contains(&f) { month_files.push(f); }
            }
        }
    }
    month_files.sort();

    let mut cache = MonthCache::new(&root);
    let mut recovered: Vec<String> = Vec::new();
    let mut repair = storage::Txn::default();
    for mf in &month_files {
        match storage::read_month(&root, mf).await {
            storage::MonthRead::Loaded(map, None) => { cache.maps.insert(mf.clone(), map); }
            storage::MonthRead::Loaded(_, Some(src)) if daily_backup_txs_differ(&root, &src).await => {
                // 月快照只能從某天的每日備份補回，但交易檔在那之後又變了：兩者不是同一個時間點，
                // 單獨補回這個月會讓持股／現金跟交易清單對不上。停止寫入，請使用者整組還原那天
                broken.push(format!("snapshots/{}（不見或損毀；只剩每日備份 {} 裡的版本，但那之後還有新的交易，不能單獨補回。請用紅色橫幅上的「從每日備份還原」整組還原）",
                    mf, src.strip_prefix(&root).unwrap_or(&src).display()));
            }
            storage::MonthRead::Loaded(map, Some(src)) => {
                // 正式檔內容損毀：用最近的完整備份修復（損毀的原檔會先搬到 backup/corrupt/ 保留）
                repair.write_month(mf, &map)?;
                recovered.push(format!("{}（來源：{}）", mf,
                    src.strip_prefix(&root).unwrap_or(&src).display()));
                cache.maps.insert(mf.clone(), map);
            }
            storage::MonthRead::Missing => {}
            storage::MonthRead::Broken(e) => broken.push(format!("snapshots/{}（{}）", mf, e)),
        }
    }

    let tx_path = root.join("transactions.json");
    let mut transactions: Option<serde_json::Value> = None;
    match storage::read_json::<serde_json::Value>(&tx_path).await {
        storage::FileRead::Ok(v) => transactions = Some(v),
        storage::FileRead::Missing => {
            // 有快照、但最新快照裡也沒有舊版內嵌的交易資料 → 交易檔是「不見了」，不是「沒有交易」
            let latest_has_legacy_txs = cache.maps.values().flat_map(|m| m.iter())
                .max_by(|a, b| a.0.cmp(b.0))
                .map_or(true, |(_, st)| st.get("transactions").is_some());
            if !latest_has_legacy_txs {
                broken.push("transactions.json（檔案不見了；可從 backup/daily/ 找最近日期的版本放回）".into());
            }
        }
        storage::FileRead::Broken(e) => broken.push(format!("transactions.json（內容損毀：{}）", e)),
        storage::FileRead::Unreadable(e) => broken.push(format!("transactions.json（無法讀取：{}）", e)),
    }

    if broken.is_empty() && !repair.is_empty() {
        if let Err(e) = repair.commit(&root).await {
            broken.push(format!("自動修復失敗：{}", e));
        }
    }

    if month_files.is_empty() {
        // 有交易檔卻沒有任何快照：不是新資料夾，是快照不見了。不可當成空資料夾（存檔會被版本檢查擋住而卡死，
        // 或用本機的舊畫面覆蓋交易檔），改為停止寫入並提供還原
        if tokio::fs::metadata(&tx_path).await.is_ok() {
            let mut v = fail("NO_SNAPSHOTS", "資料夾裡有交易檔（transactions.json），但所有快照（snapshots 資料夾）都不見了。為保護資料已停止儲存；請把 snapshots 資料夾放回來，或用「從每日備份還原」。".into());
            v["dailyBackups"] = serde_json::json!(storage::restorable_daily_backups(&root).await);
            v["hasDailyBackup"] = serde_json::json!(!storage::daily_backup_dates(&root).await.is_empty());
            return Ok(v);
        }
        return Ok(fail("EMPTY", "這個資料夾還沒有資料".into()));
    }

    let write_blocked = !broken.is_empty();
    let mut sync_changed = false;
    let mut merged_opt: Option<(String, serde_json::Value)> = cache.maps.values()
        .flat_map(|m| m.iter()).max_by(|a, b| a.0.cmp(b.0))
        .map(|(d, s)| (d.clone(), s.clone()));

    if !write_blocked {
        if let Err(e) = storage::daily_backup(&root, &today).await {
            warnings.push(format!("今日自動備份：{}", e));
        }
        if let Some((_, merged)) = merged_opt.as_mut() {
            if let Some(t) = &transactions { merged["transactions"] = t.clone(); }
            let mut txn = storage::Txn::default();
            let before = (merged.clone(), cache.maps.clone());
            let o = sync_trial(&root, merged, &today, &mut cache, &mut txn).await;
            warnings.extend(o.warnings);
            if o.changed {
                // 同步改到的現金要立刻落地成今天的快照，不能只留在記憶體
                if let Some(mf) = month_file_of(&today) {
                    let lean = lean_state(merged);
                    match cache.load(&mf).await {
                        Ok(map) => { map.insert(today.clone(), lean); cache.mark(&mf); }
                        Err(e) => warnings.push(e),
                    }
                }
                let dirty_months: Vec<String> = cache.dirty.iter().cloned().collect();
                let mut staged = MonthCache::new(&root);
                for f in &dirty_months { staged.maps.insert(f.clone(), cache.maps[f].clone()); staged.mark(f); }
                staged.into_txn(&mut txn)?;
                match txn.commit(&root).await {
                    Ok(()) => sync_changed = true,
                    Err(e) if e.starts_with("APPLIED:") => { sync_changed = true; warnings.push(e); }
                    Err(e) => {
                        // 沒寫成：畫面維持磁碟上的樣子，不顯示沒存下去的同步結果
                        *merged = before.0;
                        cache.maps = before.1;
                        warnings.push(format!("同步帳務管家資料時寫入失敗：{}", e));
                    }
                }
            }
        }
    }

    // 從快取組出所有日期（含剛才同步回填的結果）
    let mut all_entries: Vec<(String, serde_json::Value)> = cache.maps.values()
        .flat_map(|m| m.iter().map(|(d, s)| (d.clone(), s.clone()))).collect();
    all_entries.sort_by(|a, b| a.0.cmp(&b.0));
    let Some((latest_date, _)) = all_entries.last().cloned() else {
        let mut v = fail("ALL_BROKEN", "所有快照檔都無法讀取".into());
        v["brokenFiles"] = serde_json::json!(broken);
        v["dailyBackups"] = serde_json::json!(storage::restorable_daily_backups(&root).await);
        v["hasDailyBackup"] = serde_json::json!(!storage::daily_backup_dates(&root).await.is_empty());
        return Ok(v);
    };
    let (_, mut merged) = merged_opt.unwrap_or((latest_date.clone(), all_entries.last().unwrap().1.clone()));
    if merged.get("transactions").is_none() {
        if let Some(t) = &transactions { merged["transactions"] = t.clone(); }
    }
    let snaps: Vec<serde_json::Value> = all_entries.iter()
        .filter_map(|(d, s)| enrich_snapshot(d, s)).collect();
    let dates: Vec<String> = all_entries.iter().map(|(d, _)| d.clone()).collect();
    merged["snapshots"] = serde_json::json!(snaps);

    let cash_mismatches = if write_blocked { Vec::new() } else { ledger_cash_mismatches(&root, &merged, &today).await };
    let rev = storage::revision(&root).await;

    Ok(serde_json::json!({
        "ok": true,
        "state": merged,
        "date": latest_date,
        "dates": dates,
        "brokenFiles": broken,
        "recoveredFiles": recovered,
        "warnings": warnings,
        "cashMismatches": cash_mismatches,
        "writeBlocked": write_blocked,
        "syncChanged": sync_changed,
        "rev": rev,
        "hasDailyBackup": !storage::daily_backup_dates(&root).await.is_empty(),
        "dailyBackups": storage::restorable_daily_backups(&root).await,
    }))
}

/// 磁碟上所有快照（走勢圖用）
async fn all_snapshots(root: &std::path::Path) -> Vec<serde_json::Value> {
    let mut entries: Vec<(String, serde_json::Value)> = Vec::new();
    if let Ok(files) = storage::list_month_files(&root.join("snapshots")).await {
        for mf in files {
            if let storage::FileRead::Ok(m) = storage::read_json::<SnapMap>(&root.join("snapshots").join(&mf)).await {
                entries.extend(m.into_iter());
            }
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries.iter().filter_map(|(d, s)| enrich_snapshot(d, s)).collect()
}

/// 設定根目錄前確認資料夾是否存在；create = true 時（使用者已確認）建立它
#[tauri::command]
async fn ensure_root_dir(path: String, create: bool) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(path.trim());
    if tokio::fs::metadata(&p).await.map(|m| m.is_dir()).unwrap_or(false) {
        return Ok(serde_json::json!({ "exists": true }));
    }
    if create {
        tokio::fs::create_dir_all(&p).await.map_err(|e| format!("無法建立資料夾：{}", e))?;
        return Ok(serde_json::json!({ "exists": true, "created": true }));
    }
    Ok(serde_json::json!({ "exists": false }))
}

/// 從每日備份還原（使用者在紅色橫幅按下、確認之後）
#[tauri::command]
async fn restore_daily_backup(app: AppHandle, date: String, lock: tauri::State<'_, SnapshotLock>) -> Result<(), String> {
    let _guard = lock.0.lock().await;
    let root = root_path(&app).ok_or("尚未設定根目錄")?;
    if tokio::fs::metadata(root.join(storage::JOURNAL_FILE)).await.is_ok() {
        storage::recover_journal(&root).await?;
    }
    storage::restore_daily_backup(&root, &date).await
}

/// 只讀：給「根目錄設定」顯示狀態用，不做同步、不寫任何檔案
#[tauri::command]
async fn db_status(app: AppHandle, lock: tauri::State<'_, SnapshotLock>) -> Result<serde_json::Value, String> {
    let _guard = lock.0.lock().await;
    let Some(root) = root_path(&app) else { return Ok(serde_json::json!({ "connected": false, "error": "尚未設定根目錄" })) };
    match tokio::fs::metadata(&root).await {
        Ok(m) if m.is_dir() => {}
        _ => return Ok(serde_json::json!({ "connected": false, "error": format!("找不到資料夾「{}」", root.display()) })),
    }
    let mut dates: Vec<String> = Vec::new();
    for mf in storage::list_month_files(&root.join("snapshots")).await? {
        if let storage::FileRead::Ok(m) = storage::read_json::<SnapMap>(&root.join("snapshots").join(&mf)).await {
            dates.extend(m.keys().cloned());
        }
    }
    dates.sort();
    Ok(serde_json::json!({
        "connected": true,
        "dates": dates.len(),
        "latest": dates.last(),
        "problems": storage::blocking_problems(&root).await,
    }))
}

#[derive(Deserialize)]
struct RetroOp {
    tx: serde_json::Value,
    direction: i32,
}

/// 存今天的快照＋交易清單，並（可選）把過去日期交易回填到歷史快照 —— 全部在同一個 Txn。
#[tauri::command]
async fn save_snapshot(
    app: AppHandle,
    state: serde_json::Value,
    expected_rev: Option<String>,
    retro: Option<Vec<RetroOp>>,
    lock: tauri::State<'_, SnapshotLock>,
) -> Result<serde_json::Value, String> {
    let _guard = lock.0.lock().await;
    let root = root_path(&app).ok_or("尚未設定根目錄")?;
    require_revision_if_has_data(&root, expected_rev.as_deref()).await?;
    save_at(&root, state, expected_rev, retro.unwrap_or_default(), &get_taiwan_date()).await
}

/// 資料夾已經有資料時，存檔一定要帶「讀到時的版本」：沒帶就不知道這個畫面是不是舊的，
/// 存下去可能蓋掉別的視窗剛記的交易（第四輪故障注入：800 步裡 35 筆手動交易因此消失）。
async fn require_revision_if_has_data(root: &std::path::Path, expected: Option<&str>) -> Result<(), String> {
    if expected.is_some() { return Ok(()); }
    let has_data = tokio::fs::metadata(root.join("transactions.json")).await.is_ok()
        || !storage::list_month_files(&root.join("snapshots")).await.unwrap_or_default().is_empty();
    if has_data {
        return Err("CONFLICT: 這個畫面還沒從資料夾載入過最新資料，為避免覆蓋，這次沒有儲存。請重新載入後再操作。".into());
    }
    Ok(())
}

async fn save_at(
    root: &std::path::Path,
    state: serde_json::Value,
    expected_rev: Option<String>,
    retro: Vec<RetroOp>,
    today: &str,
) -> Result<serde_json::Value, String> {
    let root = root.to_path_buf();
    storage::ensure_writable(&root).await?;
    storage::check_revision(&root, expected_rev.as_deref()).await?;
    let date = today.to_string();
    let mut warnings = Vec::new();
    if let Err(e) = storage::daily_backup(&root, &date).await {
        warnings.push(format!("今日自動備份：{}", e));
    }

    // 交易清單防呆：一次少了兩筆以上幾乎一定是用了舊狀態或空狀態（介面一次只刪一筆）
    if let Some(new_txs) = state.get("transactions").and_then(|t| t.as_array()) {
        if let storage::FileRead::Ok(old) = storage::read_json::<Vec<serde_json::Value>>(&root.join("transactions.json")).await {
            if new_txs.len() + 1 < old.len() {
                return Err(format!(
                    "這次存檔的交易清單（{} 筆）比資料夾裡的（{} 筆）少了 {} 筆，為避免誤刪，沒有儲存。請重新載入。",
                    new_txs.len(), old.len(), old.len() - new_txs.len()));
            }
        }
    }

    // 交易日期必須是 YYYY-MM-DD（錯誤的日期會被當成字串比較，套到錯的快照上）
    if let Some(txs) = state.get("transactions").and_then(|t| t.as_array()) {
        if let Some(bad) = txs.iter().filter_map(|t| t["date"].as_str()).find(|d| !storage::is_date_name(d)) {
            return Err(format!("有一筆交易的日期格式不正確（{}），沒有儲存", bad));
        }
    }
    let mut state = state;
    let mut cache = MonthCache::new(&root);
    let mut txn = storage::Txn::default();
    // 1) 帳務管家同步（在副本上跑，失敗不影響這次存檔，只提示）
    let o = if state.get("transactions").is_some() {
        sync_trial(&root, &mut state, &date, &mut cache, &mut txn).await
    } else {
        SyncOutcome::default()
    };
    warnings.extend(o.warnings);
    // 2) 使用者這次操作的歷史回填
    let had_retro = !retro.is_empty();
    for op in retro {
        // 帳務管家同步來的交易，歷史一律由同步（K→D）處理；不接受前端對它的回填，否則會跟同步重複或衝突
        if op.tx["budget_tx_id"].is_string() { continue; }
        let d = op.tx["date"].as_str().unwrap_or("");
        if !storage::is_date_name(d) {
            return Err(format!("交易日期格式不正確（{}），沒有儲存", d));
        }
        let sign = if op.direction == -1 { -1.0 } else { 1.0 };
        retro_patch(&mut cache, &op.tx, sign, &date).await?;
    }
    // 3) 今天的快照＋交易清單 —— 以上全部同一個 Txn
    let mf = month_file_of(&date).ok_or("日期格式錯誤")?;
    let map = cache.load(&mf).await?;
    map.insert(date.clone(), lean_state(&state));
    cache.mark(&mf);
    cache.into_txn(&mut txn)?;
    if let Some(txs) = state.get("transactions") {
        txn.write_json("transactions.json", txs)?;
    }
    if let Err(e) = txn.commit(&root).await {
        if !e.starts_with("APPLIED:") { return Err(e); }
        warnings.push(e);
    }
    let history_changed = had_retro || o.changed;
    let mut resp = serde_json::json!({
        "ok": true, "date": date, "rev": storage::revision(&root).await, "warnings": warnings,
        "changed": o.changed, "state": state,
    });
    if history_changed {
        resp["snapshots"] = serde_json::json!(all_snapshots(&root).await);
    }
    Ok(resp)
}

// 存檔前 / 視窗取得焦點時呼叫：把前端目前的 state 跟帳務管家最新資料重新比對，
// 有變更就在同一個 Txn 裡寫入交易清單、歷史回填、今天的快照，回傳合併後的 state。
#[tauri::command]
async fn refresh_budget_sync(
    app: AppHandle,
    state: serde_json::Value,
    expected_rev: Option<String>,
    lock: tauri::State<'_, SnapshotLock>,
) -> Result<serde_json::Value, String> {
    let _guard = lock.0.lock().await;
    let Some(root) = root_path(&app) else {
        return Ok(serde_json::json!({ "changed": false, "state": state }));
    };
    require_revision_if_has_data(&root, expected_rev.as_deref()).await?;
    refresh_at(&root, state, expected_rev, &get_taiwan_date()).await
}

async fn refresh_at(
    root: &std::path::Path,
    state: serde_json::Value,
    expected_rev: Option<String>,
    today: &str,
) -> Result<serde_json::Value, String> {
    let root = root.to_path_buf();
    let today = today.to_string();
    storage::ensure_writable(&root).await?;
    storage::check_revision(&root, expected_rev.as_deref()).await?;
    let mut merged = state;
    let mut cache = MonthCache::new(&root);
    let mut txn = storage::Txn::default();
    let o = sync_trial(&root, &mut merged, &today, &mut cache, &mut txn).await;
    if o.changed {
        let mf = month_file_of(&today).ok_or("日期格式錯誤")?;
        let map = cache.load(&mf).await?;
        map.insert(today.clone(), lean_state(&merged));
        cache.mark(&mf);
    }
    cache.into_txn(&mut txn)?;
    if let Err(e) = txn.commit(&root).await {
        if !e.starts_with("APPLIED:") { return Err(e); }
    }
    Ok(serde_json::json!({
        "changed": o.changed,
        "state": merged,
        "warnings": o.warnings,
        "rev": storage::revision(&root).await,
    }))
}

// 保留給舊前端相容；新前端改用 save_snapshot 的 retro 參數（同一個 Txn）
#[tauri::command]
async fn retroactive_update(
    app: AppHandle,
    tx: serde_json::Value,
    direction: Option<i32>,
    expected_rev: Option<String>,
    lock: tauri::State<'_, SnapshotLock>,
) -> Result<serde_json::Value, String> {
    let _guard = lock.0.lock().await;
    let root = root_path(&app).ok_or("尚未設定根目錄")?;
    storage::ensure_writable(&root).await?;
    storage::check_revision(&root, expected_rev.as_deref()).await?;
    let sign: f64 = if direction == Some(-1) { -1.0 } else { 1.0 };
    let mut cache = MonthCache::new(&root);
    let updated = retro_patch(&mut cache, &tx, sign, &get_taiwan_date()).await?;
    let mut txn = storage::Txn::default();
    cache.into_txn(&mut txn)?;
    txn.commit(&root).await?;
    Ok(serde_json::json!({ "ok": true, "updated": updated, "rev": storage::revision(&root).await }))
}

#[derive(Serialize, Deserialize)]
pub struct HoldingInput {
    pub symbol: String,
    pub currency: String,
}

async fn yahoo_price(client: &reqwest::Client, symbol: &str) -> Option<f64> {
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?interval=1d&range=1d",
        symbol
    );
    let r = client.get(&url).send().await.ok()?;
    if !r.status().is_success() { return None; }
    let d: serde_json::Value = r.json().await.ok()?;
    let p = d["chart"]["result"][0]["meta"]["regularMarketPrice"].as_f64()?;
    if p > 0.0 { Some(p) } else { None }
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
                let p = yahoo_price(&c, ys).await;
                if p.is_some() {
                    price = p;
                    break;
                }
            }
            (sym, price)
        }));
    }

    let rate_c = client.clone();
    let rate_handle = tokio::spawn(async move { yahoo_price(&rate_c, "TWD=X").await });

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
        // 只允許一個視窗：兩個視窗各自拿舊狀態存檔會互相覆蓋（盲測實測會丟交易）。
        // 第二次開啟時改為把既有視窗叫到前面。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(SnapshotLock(Mutex::new(())))
        .invoke_handler(tauri::generate_handler![
            get_db_config,
            set_db_config,
            load_snapshots,
            db_status,
            ensure_root_dir,
            restore_daily_backup,
            save_snapshot,
            refresh_budget_sync,
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

    // ── plan_budget_updates：已同步交易被編輯後要更新看板端 ──────────────────

    // 21：修改金額 → 應該產生一筆 update
    #[test]
    fn update_detects_amount_change() {
        let budget = vec![tx("e1", "expense", "a1", 800.0)]; // budget 端已改成 800
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "cash_out", "date": "2026-06-09",
            "bank": "富邦 台幣現金", "currency": "TWD", "amount": 500.0,
            "commission": 0, "note": serde_json::Value::Null, "budget_tx_id": "e1",
        })]; // 看板端還停在舊的 500
        let updates = plan_budget_updates(&budget, &map, &synced(&["e1"]), &dash);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].0, 0);
        assert_eq!(updates[0].1["amount"], 800.0);
    }

    // 22：內容完全沒變 → 不產生 update
    #[test]
    fn update_no_change_returns_empty() {
        let budget = vec![tx("e1", "expense", "a1", 500.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "cash_out", "date": "2026-06-09",
            "bank": "富邦 台幣現金", "currency": "TWD", "amount": 500.0,
            "commission": 0, "note": serde_json::Value::Null, "budget_tx_id": "e1",
        })];
        let updates = plan_budget_updates(&budget, &map, &synced(&["e1"]), &dash);
        assert!(updates.is_empty());
    }

    // 23：尚未同步過的交易不歸這個函式管（那是 plan_budget_syncs 的工作）
    #[test]
    fn update_ignores_not_yet_synced() {
        let budget = vec![tx("e1", "expense", "a1", 800.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let updates = plan_budget_updates(&budget, &map, &synced(&[]), &[]);
        assert!(updates.is_empty());
    }

    // 24：改日期 → 也要抓到
    #[test]
    fn update_detects_date_change() {
        let mut t = tx("e1", "expense", "a1", 500.0);
        t["date"] = serde_json::json!("2026-07-01");
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "cash_out", "date": "2026-06-09",
            "bank": "富邦 台幣現金", "currency": "TWD", "amount": 500.0,
            "commission": 0, "note": serde_json::Value::Null, "budget_tx_id": "e1",
        })];
        let updates = plan_budget_updates(&[t], &map, &synced(&["e1"]), &dash);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].1["date"], "2026-07-01");
    }

    // 25：轉帳金額被改 → 合併後的 transfer 也要更新
    #[test]
    fn update_detects_transfer_amount_change() {
        let budget = transfer_pair("e1", "a1", 50000.0, "i1", "a2", 50000.0, "t1"); // 改成 50000
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD"), ("a2", "元大 台幣現金", "TWD")]);
        let dash = vec![serde_json::json!({
            "id": "budget_e1", "type": "transfer", "date": "2026-06-09",
            "bank": "富邦 台幣現金", "bank_to": "元大 台幣現金", "currency": "TWD",
            "amount": 40000.0, "amount_to": 40000.0, "commission": 0,
            "note": serde_json::Value::Null, "budget_tx_id": "e1", "budget_tx_id_pair": "i1",
        })]; // 看板端還停在舊的 40000
        let updates = plan_budget_updates(&budget, &map, &synced(&["e1", "i1"]), &dash);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].1["amount"], 50000.0);
        assert_eq!(updates[0].1["amount_to"], 50000.0);
    }

    // 26：已同步但看板端找不到對應紀錄（不該發生，但要防呆不崩潰/不亂加）
    #[test]
    fn update_missing_dash_entry_returns_nothing() {
        let budget = vec![tx("e1", "expense", "a1", 800.0)];
        let map = acc_map(&[("a1", "富邦 台幣現金", "TWD")]);
        let updates = plan_budget_updates(&budget, &map, &synced(&["e1"]), &[]);
        assert!(updates.is_empty());
    }

    // ── 整合測試：用真正的 load_at / save_at / refresh_at 在暫存資料夾跑 ─────────
    // 每個測試對應 2026-09-30 四位 reviewer 抓到的一個資料流失情境。

    fn fresh_dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir()
            .join(format!("adb_test_{}", std::process::id()))
            .join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn day_state(cash: f64) -> serde_json::Value {
        serde_json::json!({
            "cash_accounts": [{ "bank": "元大 台幣現金", "currency": "TWD", "amount": cash }],
            "holdings": [],
            "exchange_rate": 31.0,
        })
    }

    fn put_month(root: &std::path::Path, month_file: &str, days: &[(&str, f64)]) {
        let dir = root.join("snapshots");
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = serde_json::Map::new();
        for (d, c) in days { m.insert(d.to_string(), day_state(*c)); }
        std::fs::write(dir.join(month_file), serde_json::Value::Object(m).to_string()).unwrap();
    }

    fn read_month_json(root: &std::path::Path, month_file: &str) -> serde_json::Value {
        let raw = std::fs::read_to_string(root.join("snapshots").join(month_file)).unwrap();
        serde_json::from_str(storage::strip_bom(&raw)).unwrap()
    }

    fn cash_on(root: &std::path::Path, month_file: &str, date: &str) -> f64 {
        read_month_json(root, month_file)[date]["cash_accounts"][0]["amount"].as_f64().unwrap()
    }

    fn put_budget(root: &std::path::Path, months: &[(&str, serde_json::Value)]) {
        std::fs::write(root.join("budget.json"), serde_json::json!({ "accounts": [
            { "id": "yt", "dashboard_bank_name": "元大 台幣現金", "currency": "TWD", "initial_balance": 1000.0 }
        ]}).to_string()).unwrap();
        std::fs::create_dir_all(root.join("budget")).unwrap();
        for (m, v) in months {
            std::fs::write(root.join("budget").join(format!("{}.json", m)), v.to_string()).unwrap();
        }
    }

    fn snapshot_of_dir(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
        let mut v = Vec::new();
        for sub in ["", "snapshots"] {
            let d = if sub.is_empty() { root.to_path_buf() } else { root.join(sub) };
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    // 鎖檔（. 開頭）是刻意常駐的，不算資料
                    if e.file_type().unwrap().is_file() && !e.file_name().to_string_lossy().starts_with('.') {
                        v.push((format!("{}/{}", sub, e.file_name().to_string_lossy()), std::fs::read(e.path()).unwrap()));
                    }
                }
            }
        }
        v.sort();
        v
    }

    // ── 回填 ──

    #[tokio::test]
    async fn retro_in_save_patches_history_between_tx_date_and_today() {
        let root = fresh_dir("retro_save");
        put_month(&root, "2026-08.json", &[
            ("2026-08-13", 1000.0), ("2026-08-14", 1000.0), ("2026-08-15", 1000.0),
        ]);
        let tx = serde_json::json!({ "type": "cash_out", "bank": "元大 台幣現金", "amount": 300.0, "date": "2026-08-14" });
        let mut st = day_state(700.0);
        st["transactions"] = serde_json::json!([tx.clone()]);
        save_at(&root, st, None, vec![RetroOp { tx, direction: 1 }], "2026-08-16").await.unwrap();
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-13"), 1000.0);
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-14"), 700.0);
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-15"), 700.0);
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-16"), 700.0);
        assert!(!root.join(storage::JOURNAL_FILE).exists());
    }

    // ── 關卡：正式程式碼不准直接 fs::write ──

    fn prod_lines(src: &str) -> Vec<String> {
        let mut in_tests = false;
        src.lines().filter(|l| {
            if l.starts_with("mod tests {") { in_tests = true; return false; }
            if in_tests { if *l == "}" { in_tests = false; } return false; }
            true
        }).map(String::from).collect()
    }

    #[test]
    fn production_code_never_calls_raw_fs_write() {
        for (name, src) in [("lib.rs", include_str!("lib.rs")), ("storage.rs", include_str!("storage.rs"))] {
            let offenders: Vec<String> = prod_lines(src).into_iter()
                .filter(|l| !l.trim_start().starts_with("//"))
                .filter(|l| l.contains("fs::write("))
                .collect();
            assert!(offenders.is_empty(), "{}：直接 fs::write / 刪檔：{:?}", name, offenders);
        }
    }

    // ── 單獨使用（沒有帳務管家）──

    #[tokio::test]
    async fn standalone_user_load_is_clean_and_changes_nothing() {
        let root = fresh_dir("standalone");
        put_month(&root, "2026-08.json", &[("2026-08-30", 500.0), ("2026-08-31", 500.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let before = snapshot_of_dir(&root);
        let r = load_at(Some(root.clone()), "2026-09-01").await.unwrap();
        assert_eq!(r["ok"], true);
        assert_eq!(r["writeBlocked"], false);
        assert_eq!(r["warnings"].as_array().unwrap().len(), 0, "{:?}", r["warnings"]);
        assert_eq!(r["cashMismatches"].as_array().unwrap().len(), 0);
        assert_eq!(r["dates"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot_of_dir(&root), before, "單獨使用時載入不應改動任何資料檔");
        assert!(root.join("backup").join("daily").join("2026-09-01").join("transactions.json").exists());
    }

    #[tokio::test]
    async fn missing_root_is_reported_and_never_created() {
        let root = fresh_dir("missing_root").join("not_here");
        let r = load_at(Some(root.clone()), "2026-09-01").await.unwrap();
        assert_eq!(r["ok"], false);
        assert_eq!(r["code"], "ROOT_MISSING");
        assert_eq!(r["writeBlocked"], true);
        assert!(!root.exists(), "找不到資料夾時不可自己建一個空的");
        let err = save_at(&root, day_state(1.0), None, vec![], "2026-09-01").await.unwrap_err();
        assert!(err.contains("找不到資料夾"), "{}", err);
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn empty_folder_is_a_new_user_not_an_error() {
        let root = fresh_dir("empty_root");
        let r = load_at(Some(root.clone()), "2026-09-01").await.unwrap();
        assert_eq!(r["code"], "EMPTY");
        assert_eq!(r["writeBlocked"], false);
        let mut st = day_state(10.0);
        st["transactions"] = serde_json::json!([]);
        save_at(&root, st, None, vec![], "2026-09-01").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 10.0);
    }

    // ── 壞檔 ──

    #[tokio::test]
    async fn bom_repaired_file_is_read_not_replaced_by_backup() {
        let root = fresh_dir("bom");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1.0), ("2026-09-02", 2.0), ("2026-09-03", 3.0)]);
        let raw = std::fs::read_to_string(root.join("snapshots/2026-09.json")).unwrap();
        std::fs::write(root.join("snapshots/2026-09.json"), format!("\u{feff}{}", raw)).unwrap();
        std::fs::create_dir_all(root.join("snapshots/backup")).unwrap();
        std::fs::write(root.join("snapshots/backup/2026-09.json"), r#"{"2026-09-01":{}}"#).unwrap();
        let r = load_at(Some(root.clone()), "2026-09-04").await.unwrap();
        assert_eq!(r["recoveredFiles"].as_array().unwrap().len(), 0);
        assert_eq!(r["dates"].as_array().unwrap().len(), 3);
        save_at(&root, day_state(4.0), None, vec![], "2026-09-04").await.unwrap();
        assert_eq!(read_month_json(&root, "2026-09.json").as_object().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn broken_transactions_blocks_every_write_and_is_left_untouched() {
        let root = fresh_dir("broken_tx");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1.0)]);
        std::fs::write(root.join("transactions.json"), "[{\"id\":").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], true);
        assert!(r["brokenFiles"][0].as_str().unwrap().contains("transactions.json"));
        let mut st = day_state(1.0);
        st["transactions"] = serde_json::json!([]);
        assert!(save_at(&root, st.clone(), None, vec![], "2026-09-02").await.is_err());
        assert!(refresh_at(&root, st, None, "2026-09-02").await.is_err());
        assert_eq!(std::fs::read_to_string(root.join("transactions.json")).unwrap(), "[{\"id\":");
    }

    #[tokio::test]
    async fn every_month_broken_is_blocked_not_treated_as_empty() {
        let root = fresh_dir("all_broken");
        std::fs::create_dir_all(root.join("snapshots")).unwrap();
        std::fs::write(root.join("snapshots/2026-09.json"), "").unwrap();
        std::fs::write(root.join("transactions.json"), "[{\"id\":\"a\"}]").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["ok"], false);
        assert_eq!(r["writeBlocked"], true);
        assert_eq!(r["brokenFiles"].as_array().unwrap().len(), 1);
        let mut st = day_state(1.0);
        st["transactions"] = serde_json::json!([]);
        assert!(save_at(&root, st, None, vec![], "2026-09-02").await.is_err());
        assert_eq!(std::fs::read_to_string(root.join("transactions.json")).unwrap(), "[{\"id\":\"a\"}]");
    }

    #[tokio::test]
    async fn corrupt_past_month_is_repaired_from_backup_and_original_kept() {
        let root = fresh_dir("repair_past");
        put_month(&root, "2026-08.json", &[("2026-08-30", 5.0), ("2026-08-31", 6.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        std::fs::create_dir_all(root.join("snapshots/backup")).unwrap();
        std::fs::copy(root.join("snapshots/2026-08.json"), root.join("snapshots/backup/2026-08.json")).unwrap();
        std::fs::write(root.join("snapshots/2026-08.json"), "{\"2026-08-30\":").unwrap();
        put_month(&root, "2026-09.json", &[("2026-09-01", 7.0)]);
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        assert_eq!(r["recoveredFiles"].as_array().unwrap().len(), 1);
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-31"), 6.0, "過去月份的正式檔要被修好");
        let kept: Vec<_> = std::fs::read_dir(root.join("backup/corrupt")).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1, "損毀的原檔要保留");
        assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), "{\"2026-08-30\":");
    }

    #[tokio::test]
    async fn deleted_past_month_comes_back_from_backup() {
        let root = fresh_dir("deleted_past");
        put_month(&root, "2026-08.json", &[("2026-08-31", 6.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        std::fs::create_dir_all(root.join("snapshots/backup")).unwrap();
        std::fs::rename(root.join("snapshots/2026-08.json"), root.join("snapshots/backup/2026-08.json")).unwrap();
        put_month(&root, "2026-09.json", &[("2026-09-01", 7.0)]);
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["dates"].as_array().unwrap().len(), 2);
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-31"), 6.0);
    }

    #[tokio::test]
    async fn corrupt_month_recovers_from_daily_backup_when_no_month_backup() {
        let root = fresh_dir("repair_daily");
        put_month(&root, "2026-08.json", &[("2026-08-31", 6.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let d = root.join("backup/daily/2026-09-01/snapshots");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::copy(root.join("snapshots/2026-08.json"), d.join("2026-08.json")).unwrap();
        // 真的每日備份一定連交易檔一起抄（交易檔跟備份當時相同 → 可以單獨補回快照）
        std::fs::copy(root.join("transactions.json"), root.join("backup/daily/2026-09-01/transactions.json")).unwrap();
        std::fs::write(root.join("snapshots/2026-08.json"), "").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        assert!(r["recoveredFiles"][0].as_str().unwrap().contains("daily"));
        assert_eq!(cash_on(&root, "2026-08.json", "2026-08-31"), 6.0);
    }

    // 檔案暫時讀不到（被鎖、權限）不能改用舊備份再寫回 —— 會丟掉最後的存檔
    #[tokio::test]
    async fn unreadable_month_is_blocked_not_replaced_by_backup() {
        let root = fresh_dir("unreadable");
        std::fs::create_dir_all(root.join("snapshots/backup")).unwrap();
        std::fs::write(root.join("snapshots/backup/2026-09.json"), r#"{"2026-09-01":{}}"#).unwrap();
        std::fs::create_dir_all(root.join("snapshots/2026-09.json")).unwrap(); // 用資料夾模擬讀取 IO 錯誤
        assert!(matches!(storage::read_month(&root, "2026-09.json").await, storage::MonthRead::Broken(_)));
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], true);
    }

    // ── 版本衝突（兩個視窗／兩支程式）──

    #[tokio::test]
    async fn stale_window_cannot_overwrite_newer_data() {
        let root = fresh_dir("conflict");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        let rev = r["rev"].as_str().unwrap().to_string();

        let mut a = day_state(1111.0);
        a["transactions"] = serde_json::json!([{ "id": "A", "type": "cash_in", "amount": 1111.0 }]);
        let ra = save_at(&root, a, Some(rev.clone()), vec![], "2026-09-02").await.unwrap();
        assert_ne!(ra["rev"].as_str().unwrap(), rev);

        let mut b = day_state(2222.0);
        b["transactions"] = serde_json::json!([{ "id": "B", "type": "cash_in", "amount": 2222.0 }]);
        let err = save_at(&root, b, Some(rev), vec![], "2026-09-02").await.unwrap_err();
        assert!(err.starts_with("CONFLICT"), "{}", err);
        let txs: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("transactions.json")).unwrap()).unwrap();
        assert_eq!(txs[0]["id"], "A", "先存的那筆不能被舊視窗蓋掉");
    }

    #[tokio::test]
    async fn save_refuses_to_drop_many_transactions_at_once() {
        let root = fresh_dir("shrink");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1.0)]);
        std::fs::write(root.join("transactions.json"), r#"[{"id":"1"},{"id":"2"},{"id":"3"}]"#).unwrap();
        let mut st = day_state(1.0);
        st["transactions"] = serde_json::json!([]);
        assert!(save_at(&root, st.clone(), None, vec![], "2026-09-02").await.is_err());
        st["transactions"] = serde_json::json!([{"id":"1"},{"id":"2"}]); // 刪一筆 OK
        save_at(&root, st, None, vec![], "2026-09-02").await.unwrap();
    }

    // ── 中途中斷 ──

    #[tokio::test]
    async fn unfinished_journal_is_replayed_on_load_and_replay_is_idempotent() {
        let root = fresh_dir("journal");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let mut m = serde_json::Map::new();
        m.insert("2026-09-01".into(), day_state(900.0));
        let mut txn = storage::Txn::default();
        txn.write_month("2026-09.json", &m).unwrap();
        txn.write_json("transactions.json", &serde_json::json!([{ "id": "x" }])).unwrap();
        let j = serde_json::to_string(&txn).unwrap();
        // 模擬：日誌寫好了、正式檔還沒寫就被強制結束
        std::fs::write(root.join(storage::JOURNAL_FILE), &j).unwrap();
        assert!(save_at(&root, day_state(1.0), None, vec![], "2026-09-02").await.is_err(), "有未完成日誌時不可寫");
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0);
        assert!(!root.join(storage::JOURNAL_FILE).exists());
        // 再重放一次（例如重放途中又被中斷）結果一樣，不會重複扣
        std::fs::write(root.join(storage::JOURNAL_FILE), &j).unwrap();
        load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0);
    }

    // ── 帳務管家同步 ──

    fn synced_dash_tx(id: &str, amount: f64, date: &str) -> serde_json::Value {
        serde_json::json!({ "id": format!("budget_{}", id), "budget_tx_id": id, "type": "cash_out",
            "bank": "元大 台幣現金", "amount": amount, "date": date, "currency": "TWD" })
    }

    #[tokio::test]
    async fn load_sync_persists_cash_history_and_today_in_one_go() {
        let root = fresh_dir("sync_persist");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 300.0, "date": "2026-09-02", "category": "x" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        assert_eq!(r["syncChanged"], true);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 1000.0);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 700.0);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-03"), 700.0, "同步的現金變動要當場落地成今天的快照");
        let sync: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("sync.json")).unwrap()).unwrap();
        assert_eq!(sync["budget_to_dashboard"], serde_json::json!(["b1"]));
        // 再開一次：不重複套用
        let r2 = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        assert_eq!(r2["syncChanged"], false);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-03"), 700.0);
        assert_eq!(r2["cashMismatches"].as_array().unwrap().len(), 0, "{:?}", r2["cashMismatches"]);
    }

    #[tokio::test]
    async fn lost_sync_json_does_not_reapply() {
        let root = fresh_dir("lost_sync_json");
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 35060.0, "date": "2026-09-03", "category": "x" }
        ]))]);
        let mut st = day_state(7852.0);
        st["transactions"] = serde_json::json!([synced_dash_tx("b1", 35060.0, "2026-09-03")]);
        let r = refresh_at(&root, st, None, "2026-09-30").await.unwrap();
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(7852.0), "不可再扣一次");
        assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn broken_budget_month_aborts_sync_and_changes_nothing() {
        let root = fresh_dir("broken_budget_month");
        put_month(&root, "2026-09.json", &[("2026-09-10", 7852.0)]);
        put_budget(&root, &[]);
        std::fs::write(root.join("budget/2026-09.json"), "").unwrap();
        std::fs::write(root.join("sync.json"), r#"{"budget_to_dashboard":["b1"]}"#).unwrap();
        let mut st = day_state(7852.0);
        st["transactions"] = serde_json::json!([synced_dash_tx("b1", 35060.0, "2026-09-03")]);
        std::fs::write(root.join("transactions.json"), st["transactions"].to_string()).unwrap();
        let before = snapshot_of_dir(&root);
        let r = refresh_at(&root, st.clone(), None, "2026-09-30").await.unwrap();
        assert_eq!(r["changed"], false);
        assert!(r["warnings"][0].as_str().unwrap().contains("沒有同步"));
        assert_eq!(snapshot_of_dir(&root), before, "同步失敗時不可動到任何檔案");
        // 看板自己的存檔照常可以做（不可因為帳務管家的問題卡死）
        save_at(&root, st, None, vec![], "2026-09-30").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-30"), 7852.0);
    }

    #[tokio::test]
    async fn empty_budget_folder_never_mass_deletes() {
        let root = fresh_dir("empty_budget");
        put_month(&root, "2026-09.json", &[("2026-09-10", 7852.0)]);
        put_budget(&root, &[]); // budget/ 存在但沒有任何月檔
        let mut st = day_state(7852.0);
        st["transactions"] = serde_json::json!([synced_dash_tx("b1", 35060.0, "2026-09-03")]);
        std::fs::write(root.join("transactions.json"), st["transactions"].to_string()).unwrap();
        let before = snapshot_of_dir(&root);
        let r = refresh_at(&root, st.clone(), None, "2026-09-30").await.unwrap();
        assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 1);
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(7852.0));
        assert_eq!(snapshot_of_dir(&root), before);
        let sv = save_at(&root, st, None, vec![], "2026-09-30").await.unwrap();
        assert_eq!(sv["state"]["transactions"].as_array().unwrap().len(), 1, "存檔也不可刪掉已同步的交易");
    }

    #[tokio::test]
    async fn missing_budget_month_file_is_not_treated_as_deletion() {
        let root = fresh_dir("missing_budget_month");
        put_month(&root, "2026-09.json", &[("2026-09-10", 7852.0)]);
        put_budget(&root, &[("2026-08", serde_json::json!([
            { "id": "a1", "account_id": "yt", "type": "income", "amount": 1.0, "date": "2026-08-01", "category": "x" }
        ]))]);
        let mut st = day_state(7852.0);
        st["transactions"] = serde_json::json!([
            synced_dash_tx("b1", 35060.0, "2026-09-03"),
            serde_json::json!({ "id": "budget_a1", "budget_tx_id": "a1", "type": "cash_in", "bank": "元大 台幣現金", "amount": 1.0, "date": "2026-08-01", "currency": "TWD" }),
        ]);
        let r = refresh_at(&root, st, None, "2026-09-30").await.unwrap();
        assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 2, "9 月檔不見 ≠ 9 月交易被刪");
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(7852.0));
        assert!(r["warnings"][0].as_str().unwrap().contains("月份檔案不存在"));
    }

    #[tokio::test]
    async fn future_installments_wait_until_due() {
        let root = fresh_dir("future");
        put_budget(&root, &[("2026-10", serde_json::json!([
            { "id": "f1", "account_id": "yt", "type": "expense", "amount": 500.0, "date": "2026-10-15", "category": "分期" }
        ]))]);
        let mut st = day_state(1000.0);
        st["transactions"] = serde_json::json!([]);
        let r = refresh_at(&root, st.clone(), None, "2026-09-30").await.unwrap();
        assert_eq!(r["changed"], false);
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(1000.0));
        let r = refresh_at(&root, st, None, "2026-10-15").await.unwrap();
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(500.0));
    }

    #[tokio::test]
    async fn unmapped_bank_is_not_marked_synced() {
        let root = fresh_dir("unmapped");
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        let mut st = serde_json::json!({ "cash_accounts": [], "holdings": [], "transactions": [] });
        let r = refresh_at(&root, st.clone(), None, "2026-09-30").await.unwrap();
        assert_eq!(r["changed"], false);
        assert!(r["warnings"][0].as_str().unwrap().contains("元大 台幣現金"));
        // 補建帳戶後就會同步
        st["cash_accounts"] = serde_json::json!([{ "bank": "元大 台幣現金", "currency": "TWD", "amount": 1000.0 }]);
        let r = refresh_at(&root, st, None, "2026-09-30").await.unwrap();
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
    }


    // 第二輪 N1：上次沒完成的日誌重放失敗 → 停止所有寫入，絕不被新的寫入蓋掉
    #[tokio::test]
    async fn unreplayable_journal_blocks_writes_and_is_never_overwritten() {
        let root = fresh_dir("journal_stuck");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let mut m = serde_json::Map::new();
        m.insert("2026-09-01".into(), day_state(900.0));
        let mut txn = storage::Txn::default();
        txn.write_month("2026-09.json", &m).unwrap();
        txn.write_json("transactions.json", &serde_json::json!([{ "id": "USER_TX" }])).unwrap();
        txn.sync_key("budget_to_dashboard", serde_json::json!(["USER_TX"]));
        let j = serde_json::to_string(&txn).unwrap();
        std::fs::write(root.join(storage::JOURNAL_FILE), &j).unwrap();
        // 讓重放在最後一步失敗：sync.json 暫時讀不到（其他檔案都正常，只有日誌補不完）
        std::fs::create_dir(root.join("sync.json")).unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 1.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], true);
        assert_eq!(std::fs::read_to_string(root.join(storage::JOURNAL_FILE)).unwrap(), j, "日誌不可被覆蓋或刪除");
        // 鎖解除後重新載入：自動補完
        std::fs::remove_dir(root.join("sync.json")).unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        let txs: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("transactions.json")).unwrap()).unwrap();
        assert!(txs.as_array().unwrap().iter().any(|t| t["id"] == "USER_TX"));
    }

    // 第二輪 N2：前端用少了一筆已同步交易的舊 state 存檔 → 那筆要被重新同步回來（現金也一致）
    #[tokio::test]
    async fn stale_state_missing_a_synced_tx_gets_it_back() {
        let root = fresh_dir("stale_resync");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-02", "category": "x" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
        // 舊畫面狀態（同步前）拿去存檔
        let mut stale = day_state(1000.0);
        stale["transactions"] = serde_json::json!([]);
        let sv = save_at(&root, stale, None, vec![], "2026-09-02").await.unwrap();
        assert_eq!(sv["state"]["transactions"].as_array().unwrap().len(), 1, "同步交易要被補回");
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 900.0, "現金也要一致，不可少扣也不可多扣");
        let r2 = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r2["cashMismatches"].as_array().unwrap().len(), 0);
    }

    // 存檔後回傳的歷史必須是磁碟上真正的值（不是前端近似值）
    #[tokio::test]
    async fn save_with_retro_returns_real_history() {
        let root = fresh_dir("retro_history");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let tx = serde_json::json!({ "id": "t", "type": "cash_out", "bank": "元大 台幣現金", "amount": 50.0, "date": "2026-09-01" });
        let mut st = day_state(950.0);
        st["transactions"] = serde_json::json!([tx.clone()]);
        let sv = save_at(&root, st, None, vec![RetroOp { tx, direction: 1 }], "2026-09-03").await.unwrap();
        let snaps = sv["snapshots"].as_array().unwrap();
        assert_eq!(snaps.len(), 3);
    }

    #[tokio::test]
    async fn new_folder_can_be_created_only_on_request() {
        let root = fresh_dir("mk").join("new_folder");
        let r = ensure_root_dir(root.to_string_lossy().to_string(), false).await.unwrap();
        assert_eq!(r["exists"], false);
        assert!(!root.exists());
        ensure_root_dir(root.to_string_lossy().to_string(), true).await.unwrap();
        assert!(root.is_dir());
    }


    // 帳務管家存檔被中斷、同一筆出現兩次 → 不可同步（否則扣兩次）
    #[tokio::test]
    async fn duplicate_budget_ids_skip_sync() {
        let root = fresh_dir("dup_ids");
        put_budget(&root, &[
            ("2026-08", serde_json::json!([{ "id": "b9", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-08-15", "category": "x" }])),
            ("2026-09", serde_json::json!([{ "id": "b9", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-15", "category": "x" }])),
        ]);
        let mut st = day_state(1000.0);
        st["transactions"] = serde_json::json!([]);
        let r = refresh_at(&root, st, None, "2026-09-30").await.unwrap();
        assert_eq!(r["changed"], false);
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(1000.0));
        assert!(r["warnings"][0].as_str().unwrap().contains("出現兩次"));
    }

    #[tokio::test]
    async fn unfinished_budget_save_skips_sync() {
        let root = fresh_dir("budget_journal");
        put_budget(&root, &[("2026-09", serde_json::json!([{ "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-15", "category": "x" }]))]);
        std::fs::write(root.join(".budget-journal.json"), "[]").unwrap();
        let mut st = day_state(1000.0);
        st["transactions"] = serde_json::json!([]);
        let r = refresh_at(&root, st, None, "2026-09-30").await.unwrap();
        assert_eq!(r["changed"], false);
        assert!(r["warnings"][0].as_str().unwrap().contains("還沒完成"));
    }


    // 第三輪 R1：畫面狀態少了一筆「過去日期」的已同步交易 → 今天補回，但歷史只能套一次
    #[tokio::test]
    async fn resync_of_backdated_tx_never_double_patches_history() {
        let root = fresh_dir("r1_backdated");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0);
        let mut stale = day_state(1000.0);
        stale["transactions"] = serde_json::json!([]);
        for _ in 0..2 {
            let sv = save_at(&root, stale.clone(), None, vec![], "2026-09-03").await.unwrap();
            assert_eq!(sv["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
        }
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0, "歷史不可再扣");
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 900.0);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-03"), 900.0);
    }

    // 第三輪 R1 反方向：帳務管家刪掉後，畫面用舊狀態（還有那筆）存兩次 → 歷史只能回沖一次
    #[tokio::test]
    async fn stale_state_with_deleted_tx_reverses_history_once() {
        let root = fresh_dir("r1_deleted");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" },
            { "id": "b2", "account_id": "yt", "type": "income", "amount": 1.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        let old_state = r["state"].clone(); // 901，含 b1、b2
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b2", "account_id": "yt", "type": "income", "amount": 1.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        for _ in 0..2 {
            let sv = save_at(&root, old_state.clone(), None, vec![], "2026-09-03").await.unwrap();
            assert_eq!(sv["state"]["cash_accounts"][0]["amount"].as_f64(), Some(1001.0));
        }
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 1001.0, "只回沖一次");
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 1001.0);
    }


    // 第三輪 R2：交易檔壞了 → 用 app 的「從每日備份還原」整組還原，之後同步不可重複扣款
    #[tokio::test]
    async fn restore_from_daily_backup_keeps_sync_consistent() {
        let root = fresh_dir("r2_restore");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([]))]);
        // 9/02 早上：每日備份（此時還沒有 b1）
        load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        // 之後帳務管家記了 b1、看板同步並存檔
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap(); // 讓 9/02 存檔前後一致
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
        // 交易檔壞掉 → 被擋 → 用備份整組還原
        std::fs::write(root.join("transactions.json"), "").unwrap();
        assert_eq!(load_at(Some(root.clone()), "2026-09-02").await.unwrap()["writeBlocked"], true);
        storage::restore_daily_backup(&root, "2026-09-02").await.unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0), "只扣一次");
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0, "歷史只扣一次");
        assert_eq!(r["cashMismatches"].as_array().unwrap().len(), 0, "{:?}", r["cashMismatches"]);
        assert!(std::fs::read_dir(root.join("backup/corrupt")).unwrap().count() >= 1, "壞掉的原檔要保留");
    }


    // 真實資料回歸：早期同步進來的 0 元紀錄，帳務管家還留著 → 不可被移除、也不可跳「帳務管家刪除了」提示
    #[tokio::test]
    async fn legacy_zero_amount_synced_record_is_left_alone() {
        let root = fresh_dir("zero_legacy");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        let zero = serde_json::json!({ "id": "budget_z", "budget_tx_id": "z", "type": "cash_out",
            "bank": "元大 台幣現金", "amount": 0, "date": "2026-06-03", "currency": "TWD", "note": "轉帳 · 本金" });
        std::fs::write(root.join("transactions.json"), serde_json::json!([zero.clone()]).to_string()).unwrap();
        put_budget(&root, &[("2026-06", serde_json::json!([
            { "id": "z", "account_id": "yt", "type": "expense", "amount": 0, "date": "2026-06-03", "category": "轉帳", "note": "本金" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["syncChanged"], false);
        assert_eq!(r["warnings"].as_array().unwrap().len(), 0, "{:?}", r["warnings"]);
        assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 1);
    }


    // 第四輪審查 A：前端送來「編輯同步交易」的回填，後端不可套用（歷史由同步處理）
    #[tokio::test]
    async fn retro_for_synced_tx_is_ignored() {
        let root = fresh_dir("r4_synced_retro");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        let mut st = r["state"].clone();
        let old = st["transactions"][0].clone();
        let mut edited = old.clone();
        edited["amount"] = serde_json::json!(120.0);
        st["transactions"][0] = edited.clone();
        st["cash_accounts"][0]["amount"] = serde_json::json!(880.0); // 前端 editTransaction 會同時改現金
        save_at(&root, st, None, vec![
            RetroOp { tx: old, direction: -1 }, RetroOp { tx: edited, direction: 1 },
        ], "2026-09-03").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 900.0);
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-03"), 900.0);
    }


    // 第四輪故障注入：沒帶版本號的存檔在資料夾已有資料時要擋下（新資料夾第一次存檔可以）
    #[tokio::test]
    async fn saving_without_revision_is_refused_when_folder_has_data() {
        let root = fresh_dir("norev");
        assert!(require_revision_if_has_data(&root, None).await.is_ok(), "空資料夾第一次存檔可以");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        assert!(require_revision_if_has_data(&root, None).await.unwrap_err().starts_with("CONFLICT"));
        assert!(require_revision_if_has_data(&root, Some("x")).await.is_ok());
    }


    // 第五輪審查：只有交易檔、沒有快照 → 不是新資料夾，停止寫入並提供還原（不可卡死或覆蓋交易檔）
    #[tokio::test]
    async fn transactions_without_snapshots_is_blocked_not_empty() {
        let root = fresh_dir("tx_only");
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-30").await.unwrap();
        assert_eq!(r["code"], "NO_SNAPSHOTS");
        assert_eq!(r["writeBlocked"], true);
    }

    // 升級回歸 R1：v0.7.1 在看板刪掉的同步交易（在已同步清單、但看板沒有）→ 升級後不可默默加回來
    #[tokio::test]
    async fn tx_deleted_in_dashboard_before_upgrade_stays_deleted() {
        let root = fresh_dir("upg_r1");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        std::fs::write(root.join("sync.json"), r#"{"budget_to_dashboard":["b1"]}"#).unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 300.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        for _ in 0..2 {
            let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
            assert_eq!(r["syncChanged"], false);
            assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 0);
            assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 1000.0, "歷史不可被改");
            assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("先前在看板被刪除")), "{:?}", r["warnings"]);
            let sync: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("sync.json")).unwrap()).unwrap();
            assert_eq!(sync["budget_to_dashboard"], serde_json::json!(["b1"]), "要留在清單裡，下次才認得");
        }
    }

    // 升級回歸 R2：帳務管家取消帳戶對應 → 看板保留已同步的紀錄，不回沖歷史
    #[tokio::test]
    async fn unmapping_account_keeps_synced_history() {
        let root = fresh_dir("upg_r2");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0), ("2026-09-02", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        put_budget(&root, &[("2026-09", serde_json::json!([
            { "id": "b1", "account_id": "yt", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }
        ]))]);
        load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0);
        std::fs::write(root.join("budget.json"), serde_json::json!({ "accounts": [
            { "id": "yt", "dashboard_bank_name": "", "currency": "TWD", "initial_balance": 1000.0 }
        ]}).to_string()).unwrap();
        let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
        assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 1);
        assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-01"), 900.0, "不可回沖");
        assert_eq!(cash_on(&root, "2026-09.json", "2026-09-02"), 900.0);
        assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("取消對應")), "{:?}", r["warnings"]);
    }

    // 升級回歸 O3：月快照只剩每日備份、但交易檔在備份之後又變了 → 不可單獨補回，停止寫入並提供整組還原
    #[tokio::test]
    async fn snapshots_from_daily_backup_with_newer_transactions_blocks() {
        let root = fresh_dir("upg_o3");
        put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0)]);
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        load_at(Some(root.clone()), "2026-09-02").await.unwrap(); // 今早的每日備份
        std::fs::write(root.join("transactions.json"), r#"[{"id":"t","type":"cash_out","bank":"元大 台幣現金","amount":50.0,"date":"2026-09-02"}]"#).unwrap();
        std::fs::remove_dir_all(root.join("snapshots")).unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], true, "{:?}", r);
        assert!(r["dailyBackups"].as_array().unwrap().len() >= 1);
        assert!(!root.join("snapshots/2026-09.json").exists(), "不可單獨寫回");
        // 對照：交易檔跟備份相同時照常自動修復
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
        assert_eq!(r["writeBlocked"], false);
        assert!(root.join("snapshots/2026-09.json").exists());
    }

    #[test]
    fn heal_synced_ids_recovers_from_lost_sync_json() {
        let mut ids: Vec<String> = vec![];
        let dash = vec![
            serde_json::json!({ "budget_tx_id": "a" }),
            serde_json::json!({ "budget_tx_id": "b", "budget_tx_id_pair": "c" }),
            serde_json::json!({ "type": "buy" }),
        ];
        heal_synced_ids(&mut ids, &dash);
        ids.sort();
        assert_eq!(ids, vec!["a", "b", "c"]);
        heal_synced_ids(&mut ids, &dash);
        assert_eq!(ids.len(), 3);
    }

    // ── 現金對帳 ──

    #[test]
    fn ledger_check_flags_drift_and_handles_real_world_shapes() {
        let budget = serde_json::json!({ "accounts": [
            { "id": "yt", "dashboard_bank_name": "元大 台幣現金", "initial_balance": 2912.0 },
            { "id": "yt2", "dashboard_bank_name": "元大 台幣現金", "initial_balance": 88.0 }, // 兩個帳戶對到同一個
            { "id": "cc", "initial_balance": 100.0 }
        ]});
        let txs = vec![
            serde_json::json!({ "account_id": "yt", "type": "income",  "amount": 40000.0, "date": "2026-08-11" }),
            serde_json::json!({ "account_id": "yt", "type": "expense", "amount": 35060.0, "date": "2026-09-03" }),
            serde_json::json!({ "account_id": "yt", "type": "expense", "amount": 999.0,   "date": "2026-10-03" }),
        ];
        // 看板自己記、沒鏡射到帳務管家的現金入 500
        let own = serde_json::json!([{ "id": "m1", "type": "cash_in", "bank": "元大 台幣現金", "amount": 500.0, "date": "2026-09-05" }]);
        let drifted = serde_json::json!({ "cash_accounts": [{ "bank": "元大 台幣現金", "amount": -32148.0 }], "transactions": own });
        let got = compute_ledger_mismatches(&budget, &txs, &drifted, "2026-09-30");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["ledger"].as_f64(), Some(8440.0)); // 2912+88+40000-35060+500
        let ok = serde_json::json!({ "cash_accounts": [{ "bank": "元大 台幣現金", "amount": 8440.0 }], "transactions": own });
        assert!(compute_ledger_mismatches(&budget, &txs, &ok, "2026-09-30").is_empty());
    }

    #[tokio::test]
    async fn ledger_check_supports_old_budget_format() {
        let root = fresh_dir("ledger_old");
        std::fs::write(root.join("budget.json"), serde_json::json!({
            "accounts": [{ "id": "yt", "dashboard_bank_name": "元大 台幣現金", "initial_balance": 1000.0 }],
            "transactions": [{ "id": "t", "account_id": "yt", "type": "expense", "amount": 300.0, "date": "2026-09-01" }]
        }).to_string()).unwrap();
        let st = serde_json::json!({ "cash_accounts": [{ "bank": "元大 台幣現金", "amount": 700.0 }], "transactions": [] });
        assert!(ledger_cash_mismatches(&root, &st, "2026-09-30").await.is_empty());
    }

    #[test]
    fn plan_budget_updates_ignores_integer_vs_float_amounts() {
        let mut acc_map = HashMap::new();
        acc_map.insert("fb".to_string(), ("富邦 台幣現金".to_string(), "TWD".to_string()));
        let budget = vec![serde_json::json!({ "id": "x1", "account_id": "fb", "type": "expense",
            "amount": 2456, "date": "2026-06-02", "category": "轉帳", "note": "國泰信用卡", "currency": "TWD" })];
        let want = build_cash_tx(&budget[0], &acc_map["fb"], note_of(&budget[0]));
        // 舊版存檔：數字是整數
        let mut stored: serde_json::Value = serde_json::from_str(&want.to_string().replace("2456.0", "2456")).unwrap();
        stored["amount"] = serde_json::json!(2456);
        let synced: std::collections::HashSet<String> = ["x1".to_string()].into_iter().collect();
        assert!(plan_budget_updates(&budget, &acc_map, &synced, &[stored]).is_empty());
        assert!(json_same(&serde_json::json!({"a": [1, 2.5]}), &serde_json::json!({"a": [1.0, 2.5]})));
        assert!(!json_same(&serde_json::json!({"a": 1}), &serde_json::json!({"a": 2})));
    }
    // 第六輪審查的重現情境（兩個帳戶 A/B）
    mod round6 {
        use super::super::*;
        fn fresh(name: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join("asset_dashboard_round6").join(name);
            let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d
        }
        fn st(a: f64, b: f64) -> serde_json::Value {
            serde_json::json!({ "cash_accounts": [
                { "bank": "A", "currency": "TWD", "amount": a },
                { "bank": "B", "currency": "TWD", "amount": b }], "holdings": [], "exchange_rate": 31.0 })
        }
        fn put_month(root: &std::path::Path, mf: &str, days: &[(&str, f64, f64)]) {
            std::fs::create_dir_all(root.join("snapshots")).unwrap();
            let mut m = serde_json::Map::new();
            for (d, a, b) in days { m.insert(d.to_string(), st(*a, *b)); }
            std::fs::write(root.join("snapshots").join(mf), serde_json::Value::Object(m).to_string()).unwrap();
        }
        fn put_budget(root: &std::path::Path, a_bank: &str, b_bank: &str, txs: serde_json::Value) {
            std::fs::write(root.join("budget.json"), serde_json::json!({ "accounts": [
                { "id": "ya", "dashboard_bank_name": a_bank, "currency": "TWD", "initial_balance": 1000.0 },
                { "id": "yb", "dashboard_bank_name": b_bank, "currency": "TWD", "initial_balance": 1000.0 }]}).to_string()).unwrap();
            std::fs::create_dir_all(root.join("budget")).unwrap();
            std::fs::write(root.join("budget").join("2026-09.json"), txs.to_string()).unwrap();
        }
        fn cash(root: &std::path::Path, mf: &str, d: &str) -> (f64, f64) {
            let v: serde_json::Value = serde_json::from_str(storage::strip_bom(&std::fs::read_to_string(root.join("snapshots").join(mf)).unwrap())).unwrap();
            (v[d]["cash_accounts"][0]["amount"].as_f64().unwrap(), v[d]["cash_accounts"][1]["amount"].as_f64().unwrap())
        }
        fn blamed_user(r: &serde_json::Value) -> bool {
            r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap_or("").contains("先前在看板被刪除"))
        }

        // S1：月初還原到本月第一次存檔以前的備份，不可被「還原前」較新的每日備份補回月檔、也不可永遠卡住
        #[tokio::test]
        async fn s1_restore_across_month_boundary() {
            let root = fresh("s1");
            put_month(&root, "2026-09.json", &[("2026-09-29", 1000.0, 0.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            load_at(Some(root.clone()), "2026-09-30").await.unwrap();
            let mut s = st(950.0, 0.0);
            s["transactions"] = serde_json::json!([{ "id": "t1", "type": "cash_out", "bank": "A", "currency": "TWD", "amount": 50.0, "date": "2026-10-01" }]);
            let rev = storage::revision(&root).await;
            save_at(&root, s, Some(rev), vec![], "2026-10-01").await.unwrap();
            load_at(Some(root.clone()), "2026-10-02").await.unwrap();
            assert!(storage::daily_backup_dates(&root).await.contains(&"2026-10-02".to_string()));
            storage::restore_daily_backup(&root, "2026-09-30").await.unwrap();
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-10-02").await.unwrap();
                assert_eq!(r["writeBlocked"], false, "{:?}", r["brokenFiles"]);
                assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 0);
                assert!(!root.join("snapshots/2026-10.json").exists(), "還原掉的 10 月不可被偷偷補回");
            }
            // 還原前的那份仍可以手動選來還原（等於復原）
            assert!(storage::restorable_daily_backups(&root).await.contains(&"2026-10-02".to_string()));
        }

        // S2：早上備份時 sync.json 壞掉、稍晚被補進備份 → 還原後 b1 仍要同步回來，只扣一次
        #[tokio::test]
        async fn s2_late_filled_sync_json_does_not_block_resync() {
            let root = fresh("s2");
            put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0, 0.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            put_budget(&root, "A", "B", serde_json::json!([
                { "id": "b1", "account_id": "ya", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }]));
            std::fs::write(root.join("sync.json"), "{\"budget_to").unwrap();
            let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
            let rev = r["rev"].as_str().map(String::from);
            let mut s = r["state"].clone(); s.as_object_mut().unwrap().remove("snapshots");
            let _ = save_at(&root, s, rev, vec![], "2026-09-02").await;
            assert!(!root.join("backup/daily/2026-09-02/sync.json").exists(), "sync.json 不可晚補");
            storage::restore_daily_backup(&root, "2026-09-02").await.unwrap();
            let r = load_at(Some(root.clone()), "2026-09-02").await.unwrap();
            assert!(!blamed_user(&r), "{:?}", r["warnings"]);
            assert_eq!(r["state"]["cash_accounts"][0]["amount"].as_f64(), Some(900.0));
            assert_eq!(cash(&root, "2026-09.json", "2026-09-01").0, 900.0, "只扣一次");
        }

        // 第七輪：早上還不存在、之後才出現的檔案不算「沒備份到」（那天仍可還原、不會一直報錯）
        #[tokio::test]
        async fn file_created_after_morning_backup_is_not_a_gap() {
            for which in ["snapshots/2026-10.json", "sync.json"] {
                let root = fresh(&format!("late_{}", which.replace('/', "_")));
                put_month(&root, "2026-09.json", &[("2026-09-30", 1.0, 1.0)]);
                std::fs::write(root.join("transactions.json"), "[]").unwrap();
                std::fs::create_dir_all(root.join("budget")).unwrap();
                std::fs::write(root.join("budget/2026-09.json"), "").unwrap();
                assert!(storage::daily_backup(&root, "2026-10-01").await.is_err(), "帳務管家月檔壞掉 → 早上的備份不完整");
                std::fs::write(root.join("budget/2026-09.json"), "[]").unwrap();
                std::fs::write(root.join(which), "{}").unwrap();
                assert!(storage::daily_backup(&root, "2026-10-01").await.is_ok(), "{}：只補早上缺的，之後才出現的不算", which);
                assert_eq!(storage::restorable_daily_backups(&root).await, vec!["2026-10-01".to_string()], "{}", which);
                assert!(!root.join("backup/daily/2026-10-01").join(which).exists(), "不可晚補看板的檔案");
                assert!(root.join("backup/daily/2026-10-01/budget/2026-09.json").exists(), "早上缺的帳務管家檔要補上");
            }
        }

        // 第七輪：備份資料夾裡的還原標記檔不可被「清半成品」刪掉
        #[tokio::test]
        async fn restore_marker_survives_next_daily_backup() {
            let root = fresh("marker_keep");
            put_month(&root, "2026-09.json", &[("2026-09-29", 1.0, 1.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            storage::daily_backup(&root, "2026-09-30").await.unwrap();
            storage::daily_backup(&root, "2026-10-01").await.unwrap();
            storage::restore_daily_backup(&root, "2026-09-30").await.unwrap();
            storage::daily_backup(&root, "2026-10-02").await.unwrap();
            assert!(root.join(storage::RESTORE_MARKER).is_file());
            assert_eq!(storage::repair_daily_dates(&root).await, vec!["2026-09-30".to_string(), "2026-10-02".to_string()]);
        }

        // 轉帳一側取消對應：不錯怪使用者、不重複計算；重新對應後正確
        #[tokio::test]
        async fn transfer_unmap_one_side() {
            for side in ["expense", "income"] {
                let root = fresh(&format!("tr_{}", side));
                put_month(&root, "2026-09.json", &[("2026-09-01", 1000.0, 1000.0), ("2026-09-02", 1000.0, 1000.0)]);
                std::fs::write(root.join("transactions.json"), "[]").unwrap();
                let txs = serde_json::json!([
                    { "id": "e1", "account_id": "ya", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "t", "transfer_id": "T" },
                    { "id": "i1", "account_id": "yb", "type": "income", "amount": 100.0, "date": "2026-09-01", "category": "t", "transfer_id": "T" }]);
                put_budget(&root, "A", "B", txs.clone());
                load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                assert_eq!(cash(&root, "2026-09.json", "2026-09-02"), (900.0, 1100.0));
                if side == "expense" { put_budget(&root, "", "B", txs.clone()); } else { put_budget(&root, "A", "", txs.clone()); }
                for _ in 0..2 {
                    let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                    assert!(!blamed_user(&r), "{} {:?}", side, r["warnings"]);
                }
                assert_eq!(cash(&root, "2026-09.json", "2026-09-02"), (900.0, 1100.0), "{} 側取消對應：保留、不回沖、不重複", side);
                put_budget(&root, "A", "B", txs.clone());
                load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                assert_eq!(cash(&root, "2026-09.json", "2026-09-02"), (900.0, 1100.0), "{} 重新對應後", side);
            }
        }
    }
    // 第八輪審查的重現情境（ya→A、yb→B、yc 從未對應看板）
    mod round8 {
        use super::super::*;
        fn fresh(name: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join("asset_dashboard_round8").join(name);
            let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d
        }
        fn st(a: f64, b: f64) -> serde_json::Value {
            serde_json::json!({ "cash_accounts": [
                { "bank": "A", "currency": "TWD", "amount": a },
                { "bank": "B", "currency": "TWD", "amount": b }], "holdings": [], "exchange_rate": 31.0 })
        }
        fn put_month(root: &std::path::Path, days: &[(&str, f64, f64)]) {
            std::fs::create_dir_all(root.join("snapshots")).unwrap();
            let mut m = serde_json::Map::new();
            for (d, a, b) in days { m.insert(d.to_string(), st(*a, *b)); }
            std::fs::write(root.join("snapshots/2026-09.json"), serde_json::Value::Object(m).to_string()).unwrap();
        }
        // ya→A, yb→B, yc 是帳務管家自己的帳戶（例如現金錢包），從來沒對應看板
        fn put_budget(root: &std::path::Path, a: &str, b: &str, txs: serde_json::Value) {
            std::fs::write(root.join("budget.json"), serde_json::json!({ "accounts": [
                { "id": "ya", "dashboard_bank_name": a, "currency": "TWD", "initial_balance": 1000.0 },
                { "id": "yb", "dashboard_bank_name": b, "currency": "TWD", "initial_balance": 1000.0 },
                { "id": "yc", "currency": "TWD", "initial_balance": 0.0 }]}).to_string()).unwrap();
            std::fs::create_dir_all(root.join("budget")).unwrap();
            std::fs::write(root.join("budget/2026-09.json"), txs.to_string()).unwrap();
        }
        fn cash(root: &std::path::Path, d: &str) -> (f64, f64) {
            let v: serde_json::Value = serde_json::from_str(storage::strip_bom(&std::fs::read_to_string(root.join("snapshots/2026-09.json")).unwrap())).unwrap();
            (v[d]["cash_accounts"][0]["amount"].as_f64().unwrap(), v[d]["cash_accounts"][1]["amount"].as_f64().unwrap())
        }
        fn tr(e_acc: &str, i_acc: &str, amt: f64) -> serde_json::Value {
            serde_json::json!([
                { "id": "e1", "account_id": e_acc, "type": "expense", "amount": amt, "date": "2026-09-01", "category": "t", "transfer_id": "T" },
                { "id": "i1", "account_id": i_acc, "type": "income", "amount": amt, "date": "2026-09-01", "category": "t", "transfer_id": "T" }])
        }
        async fn setup(name: &str) -> std::path::PathBuf {
            let root = fresh(name);
            put_month(&root, &[("2026-09-01", 1000.0, 1000.0), ("2026-09-02", 1000.0, 1000.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            put_budget(&root, "A", "B", tr("ya", "yb", 100.0));
            load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            assert_eq!(cash(&root, "2026-09-02"), (900.0, 1100.0));
            root
        }

        #[tokio::test]
        async fn both_mapped_amount_change_updates() {
            let root = setup("both_amt").await;
            put_budget(&root, "A", "B", tr("ya", "yb", 300.0));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("both_amt warnings={} mism={}", r["warnings"], r["cashMismatches"]);
            assert_eq!(cash(&root, "2026-09-02"), (700.0, 1300.0));
        }

        // 帳務管家把轉帳的轉入帳戶從 B 改成一個本來就沒對應看板的帳戶 yc（帳戶對應完全沒動）
        #[tokio::test]
        async fn transfer_moved_to_unmapped_account_income_side() {
            let root = setup("moved_in").await;
            put_budget(&root, "A", "B", tr("ya", "yc", 100.0));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("moved_in cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            assert_eq!(cash(&root, "2026-09-02"), (900.0, 1100.0), "規則：一律保留、不改歷史");
            assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap_or("").contains("沒有對應看板")), "{:?}", r["warnings"]);
        }
        #[tokio::test]
        async fn transfer_moved_to_unmapped_account_expense_side() {
            let root = setup("moved_out").await;
            put_budget(&root, "A", "B", tr("yc", "yb", 100.0));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("moved_out cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            assert_eq!(cash(&root, "2026-09-02"), (900.0, 1100.0), "規則：一律保留、不改歷史");
            assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap_or("").contains("沒有對應看板")), "{:?}", r["warnings"]);
        }

        // 單筆支出從 A 改到沒對應的帳戶（對照組：v0.7.1 也是保留，非本輪造成）
        #[tokio::test]
        async fn single_moved_to_unmapped_account() {
            let root = fresh("single_moved");
            put_month(&root, &[("2026-09-01", 1000.0, 1000.0), ("2026-09-02", 1000.0, 1000.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            put_budget(&root, "A", "B", serde_json::json!([{ "id": "s1", "account_id": "ya", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }]));
            load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            put_budget(&root, "A", "B", serde_json::json!([{ "id": "s1", "account_id": "yc", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }]));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("single_moved cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            assert_eq!(cash(&root, "2026-09-02"), (900.0, 1000.0), "規則：一律保留、不改歷史");
            assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap_or("").contains("沒有對應看板")), "{:?}", r["warnings"]);
        }

        // 轉入帳戶取消對應期間，轉出側（仍對應）改金額；之後重新對應
        #[tokio::test]
        async fn unmapped_period_edit_then_remap() {
            let root = setup("edit_remap").await;
            put_budget(&root, "A", "", tr("ya", "yb", 300.0));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("edit_while_unmapped cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            put_budget(&root, "A", "B", tr("ya", "yb", 300.0));
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                println!("after_remap cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            }
            assert_eq!(cash(&root, "2026-09-02"), (700.0, 1300.0));
        }

        // 轉出側取消對應期間，轉入側改金額；之後重新對應
        #[tokio::test]
        async fn unmapped_expense_side_edit_then_remap() {
            let root = setup("edit_remap_e").await;
            put_budget(&root, "", "B", tr("ya", "yb", 300.0));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("edit_while_unmapped_e cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            put_budget(&root, "A", "B", tr("ya", "yb", 300.0));
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                println!("after_remap_e cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            }
            assert_eq!(cash(&root, "2026-09-02"), (700.0, 1300.0));
        }

        // 重新對應到「不同的」看板帳戶（B 取消 → 改對應 A）
        #[tokio::test]
        async fn remap_to_other_bank() {
            let root = setup("remap_other").await;
            put_budget(&root, "A", "", tr("ya", "yb", 100.0));
            load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            put_budget(&root, "A", "A", tr("ya", "yb", 100.0));
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                println!("remap_other cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            }
            assert_eq!(cash(&root, "2026-09-02"), (1000.0, 1000.0));
        }

        // 第九輪：兩個帳務管家帳戶對應同一個看板銀行，取消其中一個 → 保留、不改歷史、要提示
        #[tokio::test]
        async fn shared_bank_unmap_one_keeps_history() {
            let root = fresh("shared_bank");
            put_month(&root, &[("2026-09-01", 1000.0, 1000.0), ("2026-09-02", 1000.0, 1000.0)]);
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            let acc = |d_bank: &str| serde_json::json!({ "accounts": [
                { "id": "ya", "dashboard_bank_name": "A", "currency": "TWD", "initial_balance": 1000.0 },
                { "id": "yb", "dashboard_bank_name": "B", "currency": "TWD", "initial_balance": 1000.0 },
                { "id": "yd", "dashboard_bank_name": d_bank, "currency": "TWD", "initial_balance": 0.0 }]});
            std::fs::create_dir_all(root.join("budget")).unwrap();
            std::fs::write(root.join("budget/2026-09.json"), serde_json::json!([
                { "id": "d1", "account_id": "yd", "type": "expense", "amount": 100.0, "date": "2026-09-01", "category": "x" }]).to_string()).unwrap();
            std::fs::write(root.join("budget.json"), acc("B").to_string()).unwrap();
            load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            assert_eq!(cash(&root, "2026-09-02"), (1000.0, 900.0));
            std::fs::write(root.join("budget.json"), acc("").to_string()).unwrap();
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                assert_eq!(r["state"]["transactions"].as_array().unwrap().len(), 1);
                assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap_or("").contains("沒有對應看板")), "{:?}", r["warnings"]);
            }
            assert_eq!(cash(&root, "2026-09-02"), (1000.0, 900.0), "不可回沖");
        }

        // 第十輪：v0.7.1 刪過的同步交易，在「取消對應期間有寫入 → 重新對應」後不可復活
        #[tokio::test]
        async fn deleted_in_v071_survives_unmap_write_remap() {
            for variant in ["save", "other_change"] {
                let root = fresh(&format!("kd_{}", variant));
                put_month(&root, &[("2026-09-01", 1000.0, 1000.0), ("2026-09-02", 1000.0, 1000.0)]);
                std::fs::write(root.join("transactions.json"), "[]").unwrap();
                std::fs::write(root.join("sync.json"), r#"{"budget_to_dashboard":["b1"]}"#).unwrap();
                let b1 = serde_json::json!({ "id": "b1", "account_id": "ya", "type": "expense", "amount": 300.0, "date": "2026-09-01", "category": "x" });
                let n1 = serde_json::json!({ "id": "n1", "account_id": "yb", "type": "expense", "amount": 10.0, "date": "2026-09-02", "category": "x" });
                put_budget(&root, "A", "B", serde_json::json!([b1.clone()]));
                load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                if variant == "save" {
                    put_budget(&root, "", "B", serde_json::json!([b1.clone()]));
                    let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                    let rev = r["rev"].as_str().map(String::from);
                    save_at(&root, r["state"].clone(), rev, vec![], "2026-09-03").await.unwrap();
                    put_budget(&root, "A", "B", serde_json::json!([b1.clone()]));
                } else {
                    put_budget(&root, "", "B", serde_json::json!([b1.clone(), n1.clone()]));
                    let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                    assert_eq!(r["syncChanged"], true);
                    put_budget(&root, "A", "B", serde_json::json!([b1.clone(), n1.clone()]));
                }
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                assert!(!r["state"]["transactions"].as_array().unwrap().iter().any(|t| t["budget_tx_id"] == "b1"), "{} b1 不可復活", variant);
                assert_eq!(cash(&root, "2026-09-01").0, 1000.0, "{} 歷史不可再扣", variant);
            }
        }

        // 取消對應後帳戶被刪（steward deleteAccount 只刪帳戶、不刪交易）
        #[tokio::test]
        async fn unmapped_then_account_deleted() {
            let root = setup("deleted_acc").await;
            std::fs::write(root.join("budget.json"), serde_json::json!({ "accounts": [
                { "id": "ya", "dashboard_bank_name": "A", "currency": "TWD", "initial_balance": 1000.0 }]}).to_string()).unwrap();
            for _ in 0..2 {
                let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
                println!("deleted_acc cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            }
            assert_eq!(cash(&root, "2026-09-02"), (900.0, 1100.0));
        }

        // 取消對應期間，帳務管家整筆轉帳刪除
        #[tokio::test]
        async fn unmapped_then_transfer_deleted_in_budget() {
            let root = setup("del_budget").await;
            put_budget(&root, "A", "", serde_json::json!([{ "id": "x", "account_id": "ya", "type": "expense", "amount": 1.0, "date": "2026-09-02", "category": "x" }]));
            let r = load_at(Some(root.clone()), "2026-09-03").await.unwrap();
            println!("del_budget cash={:?} warnings={} mism={}", cash(&root, "2026-09-02"), r["warnings"], r["cashMismatches"]);
            assert_eq!(cash(&root, "2026-09-02"), (999.0, 1000.0), "整筆轉帳被刪 → 兩側都回沖，只剩 x");
        }

        // 標記檔讀不到（被鎖）的那一刻 → 不可把缺交易檔的那天判成完整
        #[cfg(windows)]
        #[tokio::test]
        async fn locked_marker_must_not_mark_day_complete() {
            use std::os::windows::fs::OpenOptionsExt;
            let root = fresh("locked_marker");
            std::fs::create_dir_all(root.join("snapshots")).unwrap();
            std::fs::write(root.join("snapshots/2026-09.json"), serde_json::json!({"2026-09-30": st(1.0,1.0)}).to_string()).unwrap();
            std::fs::write(root.join("transactions.json"), "[").unwrap();
            assert!(storage::daily_backup(&root, "2026-10-01").await.is_err());
            assert!(storage::restorable_daily_backups(&root).await.is_empty());
            let marker = root.join("backup/daily/2026-10-01").join(storage::INCOMPLETE_MARKER);
            println!("marker content = {:?}", std::fs::read_to_string(&marker).unwrap());
            let f = std::fs::OpenOptions::new().read(true).share_mode(0).open(&marker).unwrap();
            let h = std::thread::spawn(move || { std::thread::sleep(std::time::Duration::from_millis(150)); drop(f); });
            let r = storage::daily_backup(&root, "2026-10-01").await;
            h.join().unwrap();
            println!("locked fill -> {:?}; marker exists={} restorable={:?}", r, marker.exists(), storage::restorable_daily_backups(&root).await);
            assert!(marker.exists(), "標記讀不到不可當成「沒有缺檔」");
        }

        // 第九輪：還原時標記檔被鎖 → 不可把缺交易檔的備份當成完整而清空交易清單
        #[cfg(windows)]
        #[tokio::test]
        async fn restore_with_locked_marker() {
            use std::os::windows::fs::OpenOptionsExt;
            let root = fresh("restore_locked");
            std::fs::create_dir_all(root.join("snapshots")).unwrap();
            std::fs::write(root.join("snapshots/2026-09.json"), serde_json::json!({"2026-09-30": st(1.0,1.0)}).to_string()).unwrap();
            std::fs::write(root.join("transactions.json"), "[").unwrap();
            assert!(storage::daily_backup(&root, "2026-10-01").await.is_err());
            std::fs::write(root.join("transactions.json"), r#"[{"id":"keep","type":"cash_in","bank":"A","amount":1,"date":"2026-09-30"}]"#).unwrap();
            let marker = root.join("backup/daily/2026-10-01").join(storage::INCOMPLETE_MARKER);
            let f = std::fs::OpenOptions::new().read(true).share_mode(0).open(&marker).unwrap();
            let r = storage::restore_daily_backup(&root, "2026-10-01").await;
            drop(f);
            assert!(r.is_err(), "缺交易檔的備份不可在標記被鎖時被還原");
            assert!(root.join("transactions.json").exists());
        }

        // 被中斷留下的 .restore.json 暫存檔（在 backup/daily/ 底下）
        #[tokio::test]
        async fn restore_marker_tmp_is_eventually_cleaned() {
            let root = fresh("tmp_left");
            std::fs::create_dir_all(root.join("snapshots")).unwrap();
            std::fs::write(root.join("snapshots/2026-09.json"), serde_json::json!({"2026-09-29": st(1.0,1.0)}).to_string()).unwrap();
            std::fs::write(root.join("transactions.json"), "[]").unwrap();
            load_at(Some(root.clone()), "2026-09-30").await.unwrap();
            let tmp = root.join("backup/daily/..restore.json.999-0.tmp");
            std::fs::write(&tmp, "{").unwrap();
            let f = std::fs::OpenOptions::new().write(true).open(&tmp).unwrap();
            f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600)).unwrap(); drop(f);
            load_at(Some(root.clone()), "2026-10-01").await.unwrap();
            load_at(Some(root.clone()), "2026-10-02").await.unwrap();
            println!("tmp still exists = {}", tmp.exists());
            assert!(!tmp.exists(), "超過 10 分鐘的暫存檔應被清掉");
        }
    }
}
