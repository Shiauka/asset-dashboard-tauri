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

fn is_date_file(name: &str) -> bool {
    if name.len() != 15 || !name.ends_with(".json") {
        return false;
    }
    name[..10].chars().enumerate().all(|(i, c)| {
        if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() }
    })
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
        _ => {}
    }
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

    let date_files: Vec<String> = match tokio::fs::read_dir(&root_dir).await {
        Ok(mut rd) => {
            let mut v = Vec::new();
            while let Ok(Some(entry)) = rd.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_date_file(&name) {
                    v.push(name);
                }
            }
            v.sort();
            v
        }
        Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string(), "dates": [] }),
    };

    if date_files.is_empty() {
        return serde_json::json!({ "ok": false, "error": "根目錄中沒有資料", "dates": [] });
    }

    let latest = date_files.last().unwrap().clone();
    let state: serde_json::Value =
        match tokio::fs::read_to_string(PathBuf::from(&root_dir).join(&latest)).await {
            Ok(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Null),
            Err(e) => return serde_json::json!({ "ok": false, "error": e.to_string(), "dates": [] }),
        };

    let mut snaps: Vec<serde_json::Value> = Vec::new();
    for f in &date_files {
        let path = PathBuf::from(&root_dir).join(f);
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(fs) = serde_json::from_str::<serde_json::Value>(&raw) {
                let date = f.trim_end_matches(".json");
                if let Some(snap) = enrich_snapshot(date, &fs) {
                    snaps.push(snap);
                }
            }
        }
    }

    let dates: Vec<String> = date_files
        .iter()
        .map(|f| f.trim_end_matches(".json").to_string())
        .collect();
    let mut merged = state;
    merged["snapshots"] = serde_json::json!(snaps);

    serde_json::json!({
        "ok": true,
        "state": merged,
        "date": latest.trim_end_matches(".json"),
        "dates": dates,
    })
}

#[tauri::command]
async fn save_snapshot(app: AppHandle, state: serde_json::Value) -> Result<serde_json::Value, String> {
    let root_dir = get_root_dir(&app).ok_or("尚未設定根目錄")?;
    let date = get_taiwan_date();
    let dir = PathBuf::from(&root_dir);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.json", date));
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    tokio::fs::write(&path, json).await.map_err(|e| e.to_string())?;
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

    let affected: Vec<String> = {
        let mut rd = tokio::fs::read_dir(&root_dir).await.map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if is_date_file(&name) {
                let d = name.trim_end_matches(".json").to_string();
                if d >= tx_date && d < today {
                    v.push(name);
                }
            }
        }
        v.sort();
        v
    };

    let mut updated: Vec<String> = Vec::new();
    for f in &affected {
        let path = PathBuf::from(&root_dir).join(f);
        if let Ok(raw) = tokio::fs::read_to_string(&path).await {
            if let Ok(mut fs) = serde_json::from_str::<serde_json::Value>(&raw) {
                apply_delta(&mut fs, &tx, sign);
                if let Ok(json) = serde_json::to_string_pretty(&fs) {
                    let _ = tokio::fs::write(&path, json).await;
                    updated.push(f.trim_end_matches(".json").to_string());
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
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
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
