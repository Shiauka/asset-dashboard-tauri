//! 資料持久化層：所有對使用者資料夾的讀寫都必須經過這裡。
//!
//! 原則（2026-09-30 資料流失事件後訂定，改這個檔案前先讀完）：
//! 1. 寫檔一律原子寫入（暫存檔 → fsync → rename），不准直接 fs::write。
//! 2. 一次操作要改多個檔案時，先把「每個檔案的完整新內容」寫進日誌（.journal.json），
//!    再逐一寫入，最後刪日誌。中途被打斷，下次載入會把日誌重放完 —— 不會出現改一半。
//! 3. 讀不懂的檔案（解析失敗）絕不覆蓋、絕不刪除：先搬到 backup/corrupt/ 保留。
//! 4. 讀取時的 IO 錯誤（被鎖住、權限）跟「內容壞掉」分開：IO 錯誤一律中止，不改用備份。
//! 5. 資料夾有任何壞檔時，所有寫入指令都拒絕執行（不只靠前端擋）。

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

pub type SnapMap = Map<String, Value>;

pub const JOURNAL_FILE: &str = ".journal.json";
pub const DAILY_BACKUP_KEEP: usize = 14;
/// 當天備份缺檔的標記（同一天再跑會重做）
pub const INCOMPLETE_MARKER: &str = "_INCOMPLETE.txt";

// ── 檔名判斷 ────────────────────────────────────────────────────────────────

/// YYYY-MM.json（只接受 ASCII，非 ASCII 檔名不會 panic）
pub fn is_month_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 12
        && name.ends_with(".json")
        && b[..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
}

/// YYYY-MM-DD（備份資料夾名稱）
pub fn is_date_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

// ── 讀取 ────────────────────────────────────────────────────────────────────

pub enum FileRead<T> {
    Missing,
    Ok(T),
    /// 讀到內容但解析失敗（0 bytes、半截、格式錯）
    Broken(String),
    /// 讀取本身失敗（被鎖住、權限、離線雲端檔）—— 內容可能是好的，不可當成壞檔處理
    Unreadable(String),
}

pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

pub async fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> FileRead<T> {
    match tokio::fs::read(path).await {
        Ok(bytes) => match std::str::from_utf8(&bytes) {
            Ok(s) => match serde_json::from_str::<T>(strip_bom(s)) {
                Ok(v) => FileRead::Ok(v),
                Err(e) => FileRead::Broken(format!("{}（{} bytes）", e, bytes.len())),
            },
            Err(e) => FileRead::Broken(format!("不是 UTF-8：{}", e)),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileRead::Missing,
        Err(e) => FileRead::Unreadable(e.to_string()),
    }
}

pub async fn parses_as_json(path: &Path) -> bool {
    matches!(read_json::<Value>(path).await, FileRead::Ok(_))
}

pub enum MonthRead {
    Missing,
    /// source = Some(備份路徑) 表示正式檔壞掉/不見，資料是從備份讀回來的
    Loaded(SnapMap, Option<PathBuf>),
    Broken(String),
}

/// 讀月快照。正式檔內容壞掉（或被刪掉）時依序找：snapshots/backup/ → backup/daily/ 最新日期。
/// 讀取 IO 錯誤一律回 Broken，不改用備份（檔案可能是好的只是暫時被鎖，改用舊備份再寫回會丟資料）。
pub async fn read_month(root: &Path, month_file: &str) -> MonthRead {
    let main = root.join("snapshots").join(month_file);
    let main_err = match read_json::<SnapMap>(&main).await {
        FileRead::Ok(m) => return MonthRead::Loaded(m, None),
        FileRead::Unreadable(e) => return MonthRead::Broken(format!("無法讀取：{}", e)),
        FileRead::Broken(e) => Some(e),
        FileRead::Missing => None,
    };
    for cand in month_backup_candidates(root, month_file).await {
        if let FileRead::Ok(m) = read_json::<SnapMap>(&cand).await {
            return MonthRead::Loaded(m, Some(cand));
        }
    }
    match main_err {
        None => MonthRead::Missing,
        Some(e) => MonthRead::Broken(e),
    }
}

async fn month_backup_candidates(root: &Path, month_file: &str) -> Vec<PathBuf> {
    let mut v = vec![root.join("snapshots").join("backup").join(month_file)];
    for d in repair_daily_dates(root).await.into_iter().rev() {
        v.push(root.join("backup").join("daily").join(d).join("snapshots").join(month_file));
    }
    v
}

/// 從每日備份還原後，比還原日期新的那幾份每日備份是「還原前」的資料，不能再拿來自動修復月快照
/// （否則會把還原掉的月份偷偷補回來，或讓載入永遠被擋住）。還原時把它們記在這個檔案裡。
pub const RESTORE_MARKER: &str = "backup/daily/.restore.json";

/// 可以拿來自動修復月快照的每日備份日期（排除還原前留下、比還原日期新的那幾份）
pub async fn repair_daily_dates(root: &Path) -> Vec<String> {
    let stale: Vec<String> = match read_json::<Value>(&root.join(RESTORE_MARKER)).await {
        FileRead::Ok(v) => v["stale"].as_array().cloned().unwrap_or_default()
            .iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        _ => Vec::new(),
    };
    daily_backup_dates(root).await.into_iter().filter(|d| !stale.contains(d)).collect()
}

pub async fn daily_backup_dates(root: &Path) -> Vec<String> {
    let mut days = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(root.join("backup").join("daily")).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if is_date_name(&name) { days.push(name); }
        }
    }
    days.sort();
    days
}

pub async fn list_month_files(dir: &Path) -> Result<Vec<String>, String> {
    let mut v = Vec::new();
    match tokio::fs::read_dir(dir).await {
        Ok(mut rd) => {
            while let Ok(Some(e)) = rd.next_entry().await {
                let name = e.file_name().to_string_lossy().to_string();
                if is_month_name(&name) { v.push(name); }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    v.sort();
    Ok(v)
}

// ── 原子寫入 ────────────────────────────────────────────────────────────────

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn tmp_path_for(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{}.{}-{}.tmp", name, std::process::id(), seq))
}

/// 目標檔被防毒 / OneDrive / 另一支程式暫時鎖住時 rename 會失敗；退避重試約 3 秒
const RENAME_BACKOFF_MS: [u64; 10] = [10, 20, 40, 80, 160, 250, 400, 500, 700, 900];

pub async fn atomic_write(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let tmp = tmp_path_for(path);
    let result = async {
        let mut f = tokio::fs::File::create(&tmp).await?;
        f.write_all(contents.as_ref()).await?;
        f.sync_all().await?;
        drop(f);
        let mut last_err = None;
        for ms in RENAME_BACKOFF_MS {
            match tokio::fs::rename(&tmp, path).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = Some(e);
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                }
            }
        }
        Err(last_err.unwrap())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    result
}

pub fn atomic_write_sync(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = tmp_path_for(path);
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_ref())?;
        f.sync_all()?;
        drop(f);
        let mut last_err = None;
        for ms in RENAME_BACKOFF_MS {
            match std::fs::rename(&tmp, path) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(ms));
                }
            }
        }
        Err(last_err.unwrap())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// 把讀不懂的檔案搬到 <root>/backup/corrupt/，絕不刪除。回傳搬去的位置。
pub async fn preserve_corrupt(root: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    if tokio::fs::metadata(path).await.is_err() {
        return Ok(None);
    }
    let dir = root.join("backup").join("corrupt");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
    let dest = dir.join(format!("{}.{}", name, stamp));
    tokio::fs::copy(path, &dest).await.map_err(|e| format!("保留損毀檔 {} 失敗：{}", path.display(), e))?;
    Ok(Some(dest))
}

// ── 日誌式多檔寫入 ──────────────────────────────────────────────────────────

/// 一組要「全部完成」的寫入。路徑相對於根目錄（用 / 分隔）。
#[derive(Default, serde::Serialize, serde::Deserialize)]
pub struct Txn {
    ops: Vec<Op>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "op")]
enum Op {
    /// 整份覆寫一個檔案；month = true 代表月快照（覆蓋前把上一版存到 snapshots/backup/）
    Write { path: String, content: String, month: bool },
    /// 只換 sync.json 裡的一個 key（sync.json 另一個 key 屬於帳務管家）
    SyncKey { key: String, value: Value },
    /// 移除一個檔案（先複製一份到 backup/corrupt/ 保留）
    Remove { path: String },
}

impl Txn {
    pub fn is_empty(&self) -> bool { self.ops.is_empty() }

    pub fn write_json(&mut self, rel: &str, v: &Value) -> Result<(), String> {
        let content = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
        self.ops.retain(|o| !matches!(o, Op::Write { path, .. } if path == rel));
        self.ops.push(Op::Write { path: rel.to_string(), content, month: false });
        Ok(())
    }

    pub fn write_month(&mut self, month_file: &str, map: &SnapMap) -> Result<(), String> {
        let rel = format!("snapshots/{}", month_file);
        let content = serde_json::to_string_pretty(&Value::Object(map.clone())).map_err(|e| e.to_string())?;
        self.ops.retain(|o| !matches!(o, Op::Write { path, .. } if *path == rel));
        self.ops.push(Op::Write { path: rel, content, month: true });
        Ok(())
    }

    /// 併入另一個 Txn（同一路徑以後來的為準）
    pub fn absorb(&mut self, other: Txn) {
        for op in other.ops {
            match &op {
                Op::Write { path, .. } => {
                    let p = path.clone();
                    self.ops.retain(|o| !matches!(o, Op::Write { path: q, .. } if *q == p));
                }
                Op::SyncKey { key, .. } => {
                    let k = key.clone();
                    self.ops.retain(|o| !matches!(o, Op::SyncKey { key: q, .. } if *q == k));
                }
                Op::Remove { .. } => {}
            }
            self.ops.push(op);
        }
    }

    pub fn remove(&mut self, rel: &str) {
        self.ops.push(Op::Remove { path: rel.to_string() });
    }

    pub fn sync_key(&mut self, key: &str, value: Value) {
        self.ops.retain(|o| !matches!(o, Op::SyncKey { key: k, .. } if k == key));
        self.ops.push(Op::SyncKey { key: key.to_string(), value });
    }

    /// 先寫日誌、再逐一套用、最後刪日誌。任何一步失敗就回 Err（日誌留著，下次載入會重放）。
    ///
    /// 回傳 Err 時訊息以 "APPLIED:" 開頭代表資料其實已全部寫入、只是日誌清不掉（下次載入會清）。
    pub async fn commit(self, root: &Path) -> Result<(), String> {
        if self.ops.is_empty() {
            return Ok(());
        }
        let journal = root.join(JOURNAL_FILE);
        // 已經有未完成的日誌：絕不能蓋掉它（裡面可能還有沒寫完的內容）
        if tokio::fs::metadata(&journal).await.is_ok() {
            return Err("有一筆上次沒完成的寫入，請關閉並重新開啟程式讓它自動補完".into());
        }
        let j = serde_json::to_string(&self).map_err(|e| e.to_string())?;
        atomic_write(&journal, j).await.map_err(|e| format!("寫入日誌失敗，這次沒有儲存：{}", e))?;
        if let Err(e) = self.apply(root).await {
            return Err(format!("寫入沒有完成（{}）。已記錄下來，重新開啟程式會自動補完。", e));
        }
        remove_with_retry(&journal).await
            .map_err(|e| format!("APPLIED: 資料已寫入，但暫存的寫入紀錄無法清除（{}），請關閉並重新開啟程式", e))
    }

    async fn apply(&self, root: &Path) -> Result<(), String> {
        for op in &self.ops {
            match op {
                Op::Write { path, content, month } => {
                    let full = root.join(path);
                    if let Some(dir) = full.parent() {
                        tokio::fs::create_dir_all(dir).await.map_err(|e| e.to_string())?;
                    }
                    match read_json::<Value>(&full).await {
                        FileRead::Ok(_) => {
                            if *month {
                                // 上一版（完整可解析的）存到 snapshots/backup/
                                let bak = root.join("snapshots").join("backup")
                                    .join(full.file_name().unwrap_or_default());
                                if let Some(d) = bak.parent() {
                                    tokio::fs::create_dir_all(d).await.map_err(|e| e.to_string())?;
                                }
                                let raw = tokio::fs::read(&full).await.map_err(|e| e.to_string())?;
                                // 重放日誌時正式檔可能已經是新內容，不要拿新內容蓋掉上一版備份
                                if raw != content.as_bytes() {
                                    atomic_write(&bak, raw).await
                                        .map_err(|e| format!("備份 {} 失敗：{}", bak.display(), e))?;
                                }
                            }
                        }
                        FileRead::Broken(_) => {
                            preserve_corrupt(root, &full).await?;
                        }
                        FileRead::Unreadable(e) => {
                            return Err(format!("無法讀取 {}，不覆寫：{}", full.display(), e));
                        }
                        FileRead::Missing => {}
                    }
                    atomic_write(&full, content).await
                        .map_err(|e| format!("寫入 {} 失敗：{}", full.display(), e))?;
                }
                Op::SyncKey { key, value } => {
                    update_sync_key(root, key, value.clone()).await?;
                }
                Op::Remove { path } => {
                    let full = root.join(path);
                    if tokio::fs::metadata(&full).await.is_ok() {
                        preserve_corrupt(root, &full).await?;
                        remove_with_retry(&full).await.map_err(|e| format!("移除 {} 失敗：{}", full.display(), e))?;
                    }
                }
            }
        }
        Ok(())
    }
}

async fn remove_with_retry(path: &Path) -> std::io::Result<()> {
    let mut last = None;
    for ms in RENAME_BACKOFF_MS {
        match tokio::fs::remove_file(path).await {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => { last = Some(e); tokio::time::sleep(std::time::Duration::from_millis(ms)).await; }
        }
    }
    Err(last.unwrap())
}

/// 載入時呼叫：有未完成的日誌就把它重放完。回傳是否有重放。
pub async fn recover_journal(root: &Path) -> Result<bool, String> {
    let journal = root.join(JOURNAL_FILE);
    match read_json::<Txn>(&journal).await {
        FileRead::Missing => Ok(false),
        FileRead::Ok(txn) => {
            txn.apply(root).await
                .map_err(|e| format!("上次沒完成的寫入無法補完（{}）。為保護資料已停止儲存；請確認檔案沒有被其他程式（例如雲端硬碟、防毒）佔用後重新開啟", e))?;
            remove_with_retry(&journal).await.map_err(|e| format!("無法清除寫入紀錄：{}", e))?;
            Ok(true)
        }
        FileRead::Broken(e) => {
            // 日誌是原子寫入的，理論上不會半截；真的壞了就保留起來、不套用
            preserve_corrupt(root, &journal).await?;
            tokio::fs::remove_file(&journal).await.map_err(|e| e.to_string())?;
            Err(format!("上次未完成的寫入日誌損毀，已保留在 backup/corrupt/：{}", e))
        }
        FileRead::Unreadable(e) => Err(format!("無法讀取寫入日誌：{}", e)),
    }
}

/// sync.json 由看板與帳務管家兩支程式共用，各自負責一個 key。寫入前一刻重新讀最新版、
/// 只換自己的 key。損毀時先保留原檔，再以只含我方 key 的內容重建（對方的 key 帳務管家
/// 會用自己的去重邏輯補回來）。
pub async fn update_sync_key(root: &Path, key: &str, value: Value) -> Result<(), String> {
    let _lock = FileLock::acquire(&root.join(SYNC_LOCK)).await?;
    let path = root.join("sync.json");
    let mut obj = match read_json::<Value>(&path).await {
        FileRead::Ok(v) if v.is_object() => v,
        FileRead::Ok(_) | FileRead::Missing => serde_json::json!({}),
        FileRead::Broken(_) => {
            preserve_corrupt(root, &path).await?;
            serde_json::json!({})
        }
        FileRead::Unreadable(e) => return Err(format!("無法讀取 sync.json：{}", e)),
    };
    obj[key] = value;
    let j = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
    atomic_write(&path, j).await.map_err(|e| e.to_string())
}


/// 跨程式的檔案鎖（看板與帳務管家共用同一個鎖檔名）。用作業系統的檔案鎖（LockFileEx）：
/// 程式被強制結束時系統會自動釋放，不會留下殘留鎖，也沒有「判斷失效→接手」的搶鎖空窗。
/// 鎖檔本身永遠不刪。第二輪故障注入：舊的「建立新檔當鎖」做法會殘留、會搶錯、會 0.4% 失敗。
pub struct FileLock(std::fs::File);

pub const SYNC_LOCK: &str = ".sync.json.lock";
/// 帳務管家存檔時持有獨占鎖；看板讀帳務管家資料時持有共用鎖（不會讀到存到一半的內容）
pub const BUDGET_LOCK: &str = ".budget.lock";

impl FileLock {
    pub async fn acquire(path: &Path) -> Result<FileLock, String> { Self::acquire_mode(path, false).await }
    pub async fn acquire_shared(path: &Path) -> Result<FileLock, String> { Self::acquire_mode(path, true).await }

    async fn acquire_mode(path: &Path, shared: bool) -> Result<FileLock, String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let opened = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path);
            match opened {
                Ok(f) => {
                    let r = if shared { f.try_lock_shared() } else { f.try_lock() };
                    match r {
                        Ok(()) => return Ok(FileLock(f)),
                        Err(std::fs::TryLockError::WouldBlock) => {}
                        Err(std::fs::TryLockError::Error(e)) => return Err(format!("無法鎖定 {}：{}", path.display(), e)),
                    }
                }
                // 防毒／雲端同步短暫佔用：重試
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {}
                Err(e) => return Err(format!("無法開啟鎖檔 {}：{}", path.display(), e)),
            }
            if std::time::Instant::now() > deadline {
                return Err("資料正被另一支程式使用中（超過 30 秒），請稍後再試".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

// ── 健康檢查（所有寫入指令的前置條件）───────────────────────────────────────

/// 回傳資料夾裡有問題、必須先處理才能寫入的檔案清單（空 = 可以寫）。
/// 「檔案內容可以解析」的快取（以路徑＋大小＋修改時間為鍵），避免每次存檔都重讀所有月份檔
fn parse_cache() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, u128)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<PathBuf, (u64, u128)>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

async fn check_parses<T: serde::de::DeserializeOwned>(path: &Path) -> FileRead<()> {
    let key = match tokio::fs::metadata(path).await {
        Ok(m) => (m.len(), m.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return FileRead::Missing,
        Err(e) => return FileRead::Unreadable(e.to_string()),
    };
    if parse_cache().lock().unwrap().get(path) == Some(&key) {
        return FileRead::Ok(());
    }
    match read_json::<T>(path).await {
        FileRead::Ok(_) => {
            parse_cache().lock().unwrap().insert(path.to_path_buf(), key);
            FileRead::Ok(())
        }
        FileRead::Missing => FileRead::Missing,
        FileRead::Broken(e) => FileRead::Broken(e),
        FileRead::Unreadable(e) => FileRead::Unreadable(e),
    }
}

pub async fn blocking_problems(root: &Path) -> Vec<String> {
    let mut v = Vec::new();
    match tokio::fs::metadata(root).await {
        Ok(m) if m.is_dir() => {}
        _ => {
            v.push(format!("找不到資料夾 {}", root.display()));
            return v;
        }
    }
    if tokio::fs::metadata(root.join(JOURNAL_FILE)).await.is_ok() {
        v.push("有一筆上次沒完成的寫入（請關閉並重新開啟程式讓它自動補完）".into());
    }
    match list_month_files(&root.join("snapshots")).await {
        Ok(files) => {
            for f in files {
                match check_parses::<SnapMap>(&root.join("snapshots").join(&f)).await {
                    FileRead::Ok(_) => {}
                    FileRead::Missing => {}
                    FileRead::Broken(e) => v.push(format!("snapshots/{}（內容損毀：{}）", f, e)),
                    FileRead::Unreadable(e) => v.push(format!("snapshots/{}（無法讀取：{}）", f, e)),
                }
            }
        }
        Err(e) => v.push(format!("snapshots 資料夾無法讀取：{}", e)),
    }
    match check_parses::<Value>(&root.join("transactions.json")).await {
        FileRead::Ok(_) | FileRead::Missing => {}
        FileRead::Broken(e) => v.push(format!("transactions.json（內容損毀：{}）", e)),
        FileRead::Unreadable(e) => v.push(format!("transactions.json（無法讀取：{}）", e)),
    }
    v
}

pub async fn ensure_writable(root: &Path) -> Result<(), String> {
    let p = blocking_problems(root).await;
    if p.is_empty() {
        Ok(())
    } else {
        Err(format!("資料夾有問題，為保護資料已停止寫入：{}", p.join("；")))
    }
}

// ── 版本（偵測其他視窗 / 程式同時修改）───────────────────────────────────────

fn fnv64(h: &mut u64, bytes: &[u8]) {
    for b in bytes {
        *h ^= *b as u64;
        *h = h.wrapping_mul(0x100000001b3);
    }
}

/// 交易檔＋所有月快照的內容雜湊。存檔時前端要帶上「讀到時的版本」，不一致就拒絕，
/// 避免兩個視窗（或舊版程式）拿各自的舊狀態互相覆蓋。
pub async fn revision(root: &Path) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut files = vec![root.join("transactions.json")];
    if let Ok(ms) = list_month_files(&root.join("snapshots")).await {
        for m in ms { files.push(root.join("snapshots").join(m)); }
    }
    // 用大小＋修改時間（每次寫入都是新檔替換，時間一定會變），不必每次讀完整內容
    for f in files {
        fnv64(&mut h, f.to_string_lossy().as_bytes());
        match tokio::fs::metadata(&f).await {
            Ok(m) => {
                fnv64(&mut h, &m.len().to_le_bytes());
                let t = m.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_nanos());
                fnv64(&mut h, &t.to_le_bytes());
            }
            Err(_) => fnv64(&mut h, b"<none>"),
        }
    }
    format!("{:016x}", h)
}

pub async fn check_revision(root: &Path, expected: Option<&str>) -> Result<(), String> {
    if let Some(exp) = expected {
        let cur = revision(root).await;
        if cur != exp {
            return Err("CONFLICT: 資料已被其他視窗或程式修改過。為避免覆蓋，這次沒有儲存，請重新載入後再操作。".into());
        }
    }
    Ok(())
}

// ── 每日備份 ────────────────────────────────────────────────────────────────

/// 每天第一次載入/存檔時，把資料檔（只限已知的資料檔、而且內容可解析的）複製到
/// <root>/backup/daily/YYYY-MM-DD/。保留最近 14 天；只有當天備份完整、資料夾沒有壞檔時
/// 才刪舊的，避免「壞資料連存 14 天把好備份全部擠掉」。
pub async fn daily_backup(root: &Path, today: &str) -> Result<(), String> {
    let base = root.join("backup").join("daily");
    let dest = base.join(today);
    let marker = dest.join(INCOMPLETE_MARKER);
    if tokio::fs::metadata(&dest).await.is_ok() {
        if tokio::fs::metadata(&marker).await.is_err() {
            return Ok(());
        }
        // 今天稍早的備份缺了檔（當時被鎖住或損毀）→ 只補缺的，已經有的不重拍
        // （重拍會把當天稍早的好版本換成現在的內容，「回到今天早上」這條退路就沒了）
        return fill_missing_backup(root, &dest).await;
    }
    // 之前被中斷留下的半成品（任何日期的 .partial、淘汰到一半的 .deleting-*）一律清掉
    if let Ok(mut rd) = tokio::fs::read_dir(&base).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            // 只清資料夾（.restore.json 這類標記檔要留著）
            let is_dir = e.file_type().await.map_or(false, |t| t.is_dir());
            if name.starts_with('.') && is_dir { let _ = tokio::fs::remove_dir_all(e.path()).await; }
        }
    }
    let staging = base.join(format!(".{}.partial", today));
    tokio::fs::create_dir_all(&staging).await.map_err(|e| e.to_string())?;
    // 帳務管家的檔案要在它沒有存到一半時才抄（持共用鎖；還有沒補完的存檔日誌就當成這次抄不到）
    let _budget_lock = if tokio::fs::metadata(root.join("budget.json")).await.is_ok() {
        Some(FileLock::acquire_shared(&root.join(BUDGET_LOCK)).await?)
    } else { None };
    let budget_mid_save = tokio::fs::metadata(root.join(".budget-journal.json")).await.is_ok();

    let mut skipped: Vec<String> = Vec::new();
    let mut copied = 0usize;
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for name in ["transactions.json", "sync.json", "budget.json"] {
        plan.push((root.join(name), staging.join(name)));
    }
    for sub in ["snapshots", "budget"] {
        if let Ok(files) = list_month_files(&root.join(sub)).await {
            for f in files {
                plan.push((root.join(sub).join(&f), staging.join(sub).join(&f)));
            }
        }
    }
    for (src, dst) in plan {
        let is_budget = src.starts_with(root.join("budget")) || src == root.join("budget.json");
        if is_budget && budget_mid_save {
            skipped.push(format!("{}（帳務管家存檔還沒完成）", src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/")));
            continue;
        }
        match read_json::<Value>(&src).await {
            FileRead::Missing => {}
            FileRead::Ok(_) => {
                if let Some(d) = dst.parent() {
                    tokio::fs::create_dir_all(d).await.map_err(|e| e.to_string())?;
                }
                tokio::fs::copy(&src, &dst).await.map_err(|e| e.to_string())?;
                copied += 1;
            }
            FileRead::Broken(_) => {
                skipped.push(format!("{}（損毀）", src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/")));
            }
            FileRead::Unreadable(_) => {
                skipped.push(format!("{}（暫時讀不到，可能被其他程式佔用）", src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/")));
            }
        }
    }
    if copied == 0 {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Ok(());
    }
    if !skipped.is_empty() {
        let _ = atomic_write(&staging.join(INCOMPLETE_MARKER), skipped.join("\n")).await;
    }
    let mut renamed = false;
    for ms in RENAME_BACKOFF_MS {
        if tokio::fs::rename(&staging, &dest).await.is_ok() {
            renamed = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    }
    if !renamed {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err("備份資料夾改名失敗".into());
    }

    if skipped.is_empty() {
        prune_daily_backups(root).await;
        Ok(())
    } else {
        Err(format!("以下檔案損毀，沒有放進今天的備份（舊備份已保留不刪）：{}", skipped.join("、")))
    }
}

fn backup_plan(root: &Path, into: &Path, files: &[(String, String)]) -> Vec<(PathBuf, PathBuf)> {
    files.iter().map(|(sub, f)| {
        if sub.is_empty() { (root.join(f), into.join(f)) } else { (root.join(sub).join(f), into.join(sub).join(f)) }
    }).collect()
}

async fn backup_file_list(root: &Path) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = ["transactions.json", "sync.json", "budget.json"]
        .iter().map(|n| (String::new(), n.to_string())).collect();
    for sub in ["snapshots", "budget"] {
        if let Ok(files) = list_month_files(&root.join(sub)).await {
            for f in files { v.push((sub.to_string(), f)); }
        }
    }
    v
}

/// 只保留最近 DAILY_BACKUP_KEEP 天（呼叫端確認資料夾沒有問題時才呼叫）
async fn prune_daily_backups(root: &Path) {
    let base = root.join("backup").join("daily");
    let mut days = daily_backup_dates(root).await;
    while days.len() > DAILY_BACKUP_KEEP {
        let old = days.remove(0);
        // 先改名成隱藏名稱再刪：刪到一半被中斷，也不會留下看起來完整的半套日期資料夾
        let doomed = base.join(format!(".deleting-{}", old));
        if tokio::fs::rename(base.join(&old), &doomed).await.is_ok() {
            let _ = tokio::fs::remove_dir_all(&doomed).await;
        }
    }
}

async fn fill_missing_backup(root: &Path, dest: &Path) -> Result<(), String> {
    let mut still: Vec<String> = Vec::new();
    let _budget_lock = if tokio::fs::metadata(root.join("budget.json")).await.is_ok() {
        Some(FileLock::acquire_shared(&root.join(BUDGET_LOCK)).await?)
    } else { None };
    let budget_mid_save = tokio::fs::metadata(root.join(".budget-journal.json")).await.is_ok();
    // 只補早上「有這個檔、但沒抄到」的（記在不完整標記裡）；早上根本還沒有、之後才出現的檔案
    // 不算缺漏，否則那天會一直被判成不完整、甚至不能還原
    // 標記讀不到（被鎖）時不可當成「沒有缺檔」—— 會把缺交易檔的那天判成完整，還原時清空交易（第八輪審查 🟠）
    let marker_text = match tokio::fs::read_to_string(dest.join(INCOMPLETE_MARKER)).await {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("今天備份的缺檔清單暫時讀不到：{}", e)),
    };
    let listed: Vec<String> = marker_text
        .lines().map(|l| l.split('（').next().unwrap_or("").trim().replace('\\', "/"))
        .filter(|l| !l.is_empty()).collect();
    for (src, dst) in backup_plan(root, dest, &backup_file_list(root).await) {
        if tokio::fs::metadata(&dst).await.is_ok() { continue; }
        let rel = src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/");
        if !listed.contains(&rel) { continue; }
        let is_budget = src.starts_with(root.join("budget")) || src == root.join("budget.json");
        if tokio::fs::metadata(&src).await.is_err() { continue; }
        // sync.json 也不晚補：它的已同步清單要跟同一份備份的交易檔是同一個時間點，晚補的清單會讓還原後
        // 「備份之後才同步進來的交易」被誤當成使用者刪過而永遠不回來
        let is_dashboard_data = src == root.join("transactions.json") || src == root.join("sync.json")
            || src.starts_with(root.join("snapshots"));
        if is_dashboard_data {
            // 看板自己的交易／快照不晚補（晚補的內容跟當天早上的其他檔案不是同一時間點，還原時會對不上）
            still.push(src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/"));
            continue;
        }
        if is_budget && budget_mid_save {
            still.push(rel.clone());
            continue;
        }
        match read_json::<Value>(&src).await {
            FileRead::Missing => {}
            FileRead::Ok(_) => {
                if let Some(d) = dst.parent() { tokio::fs::create_dir_all(d).await.map_err(|e| e.to_string())?; }
                let tmp = tmp_path_for(&dst);
                tokio::fs::copy(&src, &tmp).await.map_err(|e| e.to_string())?;
                tokio::fs::rename(&tmp, &dst).await.map_err(|e| e.to_string())?;
            }
            _ => still.push(src.strip_prefix(root).unwrap_or(&src).to_string_lossy().replace('\\', "/")),
        }
    }
    let marker = dest.join(INCOMPLETE_MARKER);
    if still.is_empty() {
        remove_with_retry(&marker).await.map_err(|e| e.to_string())?;
        prune_daily_backups(root).await;
        Ok(())
    } else {
        let _ = atomic_write(&marker, still.join("\n")).await;
        Err(format!("以下檔案還是無法備份（舊備份已保留不刪）：{}", still.join("、")))
    }
}

/// 從某天的每日備份還原看板自己的資料（交易清單＋全部月快照）——整組一起還原，不可只換單一檔案：
/// 交易清單與快照必須是同一個時間點的，否則同步會把備份之後的交易重複套用（第三輪審查 R2）。
/// 帳務管家的檔案不動。現在的版本（含損毀的）都先保留到 backup/corrupt/。
pub async fn restore_daily_backup(root: &Path, date: &str) -> Result<(), String> {
    if !is_date_name(date) { return Err("日期格式錯誤".into()); }
    let src = root.join("backup").join("daily").join(date);
    if !dashboard_files_complete(&src).await {
        return Err(format!("{} 的備份缺少儀表板自己的檔案，請選別的日期", date));
    }
    let mut txn = Txn::default();
    match read_json::<Value>(&src.join("transactions.json")).await {
        FileRead::Ok(v) => txn.write_json("transactions.json", &v)?,
        FileRead::Missing => txn.remove("transactions.json"),
        _ => return Err(format!("{} 的備份裡交易檔讀不到", date)),
    }
    let backup_months = list_month_files(&src.join("snapshots")).await?;
    for m in &backup_months {
        match read_json::<SnapMap>(&src.join("snapshots").join(m)).await {
            FileRead::Ok(map) => txn.write_month(m, &map)?,
            _ => return Err(format!("{} 的備份裡 {} 讀不到", date, m)),
        }
    }
    for m in list_month_files(&root.join("snapshots")).await? {
        if !backup_months.contains(&m) { txn.remove(&format!("snapshots/{}", m)); }
    }
    // 已同步清單也要回到同一個時間點：備份之後才同步進來的帳務管家交易，還原後要能重新同步，
    // 不能被當成「使用者在看板刪過」而永遠不回來
    let restored_ids: Vec<Value> = match read_json::<Value>(&src.join("sync.json")).await {
        FileRead::Ok(v) => v["budget_to_dashboard"].as_array().cloned().unwrap_or_default(),
        _ => {
            let txs = match read_json::<Vec<Value>>(&src.join("transactions.json")).await { FileRead::Ok(v) => v, _ => Vec::new() };
            let mut ids: Vec<Value> = Vec::new();
            for t in &txs {
                for k in ["budget_tx_id", "budget_tx_id_pair"] {
                    if let Some(id) = t[k].as_str() { let v = Value::from(id); if !ids.contains(&v) { ids.push(v); } }
                }
            }
            ids
        }
    };
    txn.sync_key("budget_to_dashboard", Value::Array(restored_ids));
    let stale: Vec<String> = daily_backup_dates(root).await.into_iter().filter(|d| d.as_str() > date).collect();
    txn.write_json(RESTORE_MARKER, &serde_json::json!({ "to": date, "stale": stale }))?;
    // snapshots/backup/ 的上一版跟還原前的狀態對不上，一起移走，避免之後被誤用來修復
    for m in list_month_files(&root.join("snapshots").join("backup")).await.unwrap_or_default() {
        txn.remove(&format!("snapshots/backup/{}", m));
    }
    txn.commit(root).await
}

/// 這份每日備份裡「看板自己的檔案」（交易清單、月快照）是否完整；帳務管家的檔案缺了不影響看板還原
async fn dashboard_files_complete(dir: &Path) -> bool {
    match tokio::fs::read_to_string(dir.join(INCOMPLETE_MARKER)).await {
        // 標記檔不存在＝完整；讀不到（被鎖）不能當成完整，否則還原時會把缺的交易檔當成「沒有交易」清掉（第九輪審查）
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
        Ok(m) => !m.lines().any(|l| l.starts_with("transactions.json") || l.starts_with("snapshots")),
    }
}

/// 可以用來還原看板資料的每日備份日期（由舊到新）
pub async fn restorable_daily_backups(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for d in daily_backup_dates(root).await {
        if dashboard_files_complete(&root.join("backup").join("daily").join(&d)).await { out.push(d); }
    }
    out
}

/// 清掉被強制結束時留下、超過 10 分鐘的暫存檔
pub async fn cleanup_stale_tmp(root: &Path) {
    let mut dirs = vec![root.to_path_buf(), root.join("snapshots"), root.join("snapshots").join("backup"),
        root.join("backup").join("daily")];
    for d in daily_backup_dates(root).await {
        let b = root.join("backup").join("daily").join(d);
        dirs.push(b.join("snapshots"));
        dirs.push(b.join("budget"));
        dirs.push(b);
    }
    for dir in dirs {
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let name = e.file_name().to_string_lossy().to_string();
            if !(name.starts_with('.') && name.ends_with(".tmp")) { continue; }
            let old = e.metadata().await.ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.elapsed().ok())
                .map_or(false, |d| d.as_secs() > 600);
            if old { let _ = tokio::fs::remove_file(e.path()).await; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("adb_storage_{}", std::process::id())).join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // 已經有沒完成的日誌時，新的寫入必須拒絕，絕不能蓋掉它
    #[tokio::test]
    async fn commit_never_overwrites_an_unfinished_journal() {
        let d = fresh("journal_guard");
        std::fs::write(d.join(JOURNAL_FILE), "PENDING").unwrap();
        let mut t = Txn::default();
        t.write_json("transactions.json", &serde_json::json!([])).unwrap();
        assert!(t.commit(&d).await.is_err());
        assert_eq!(std::fs::read_to_string(d.join(JOURNAL_FILE)).unwrap(), "PENDING");
        assert!(!d.join("transactions.json").exists());
    }


    // 第二輪故障注入：檔案暫時被鎖住時的當天備份缺檔，之後同一天要能補齊
    #[tokio::test]
    async fn incomplete_daily_backup_never_mixes_dashboard_files_from_different_times() {
        // 第四輪審查：看板自己的交易檔晚補，會跟當天早上的快照不是同一時間點，還原時重複套用
        let root = fresh("daily_redo");
        seed(&root);
        std::fs::write(root.join("transactions.json"), "").unwrap();
        assert!(daily_backup(&root, "2026-09-30").await.is_err());
        let d = root.join("backup/daily/2026-09-30");
        assert!(d.join(INCOMPLETE_MARKER).exists());
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        assert!(daily_backup(&root, "2026-09-30").await.is_err(), "交易檔不晚補");
        assert!(!d.join("transactions.json").exists());
        assert!(d.join(INCOMPLETE_MARKER).exists());
        assert!(restorable_daily_backups(&root).await.is_empty(), "這天不能拿來還原看板");
        assert!(restore_daily_backup(&root, "2026-09-30").await.is_err());
        // 隔天的備份完整、可還原
        daily_backup(&root, "2026-10-01").await.unwrap();
        assert_eq!(restorable_daily_backups(&root).await, vec!["2026-10-01".to_string()]);
    }

    // 第四輪審查 C：只有帳務管家的檔案缺了，看板照樣可以用這天的備份還原
    #[tokio::test]
    async fn restore_allowed_when_only_budget_files_are_missing_from_backup() {
        let root = fresh("restore_budget_missing");
        seed(&root);
        std::fs::write(root.join("budget/2026-09.json"), "").unwrap();
        assert!(daily_backup(&root, "2026-09-30").await.is_err());
        assert_eq!(restorable_daily_backups(&root).await, vec!["2026-09-30".to_string()]);
        restore_daily_backup(&root, "2026-09-30").await.unwrap();
    }

    #[tokio::test]
    async fn exclusive_lock_blocks_shared_until_released() {
        let d = fresh("os_lock");
        let p = d.join(BUDGET_LOCK);
        let l = FileLock::acquire(&p).await.unwrap();
        let p2 = p.clone();
        let t0 = std::time::Instant::now();
        let h = tokio::spawn(async move { let _s = FileLock::acquire_shared(&p2).await.unwrap(); t0.elapsed() });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        drop(l);
        assert!(h.await.unwrap() >= std::time::Duration::from_millis(250));
    }

    // 第三輪 R3：當天備份缺檔時再跑，只補缺的，早上的好版本不可被換成現在的內容
    #[tokio::test]
    async fn incomplete_backup_fill_keeps_morning_copies() {
        let root = fresh("daily_fill");
        seed(&root);
        std::fs::write(root.join("transactions.json"), "[\"MORNING\"]").unwrap();
        std::fs::write(root.join("budget/2026-09.json"), "").unwrap(); // 帳務管家的檔壞了（不擋看板寫入）
        assert!(daily_backup(&root, "2026-09-30").await.is_err());
        std::fs::write(root.join("transactions.json"), "[\"AFTERNOON\"]").unwrap();
        assert!(daily_backup(&root, "2026-09-30").await.is_err());
        let d = root.join("backup/daily/2026-09-30");
        assert_eq!(std::fs::read_to_string(d.join("transactions.json")).unwrap(), "[\"MORNING\"]");
        std::fs::write(root.join("budget/2026-09.json"), "[]").unwrap();
        daily_backup(&root, "2026-09-30").await.unwrap();
        assert!(d.join("budget/2026-09.json").exists());
        assert!(!d.join(INCOMPLETE_MARKER).exists());
        assert_eq!(std::fs::read_to_string(d.join("transactions.json")).unwrap(), "[\"MORNING\"]");
    }

    // 第三輪故障注入：帳務管家存到一半（日誌還在）時的每日備份，不可把混雜的帳本當成完整備份
    #[tokio::test]
    async fn daily_backup_skips_budget_files_while_budget_save_is_unfinished() {
        let root = fresh("daily_budget_mid");
        seed(&root);
        std::fs::write(root.join("budget.json"), "{}").unwrap();
        std::fs::write(root.join(".budget-journal.json"), "[]").unwrap();
        assert!(daily_backup(&root, "2026-09-30").await.is_err());
        let d = root.join("backup/daily/2026-09-30");
        assert!(d.join(INCOMPLETE_MARKER).exists());
        assert!(!d.join("budget/2026-09.json").exists());
        assert!(d.join("transactions.json").exists());
        std::fs::remove_file(root.join(".budget-journal.json")).unwrap();
        daily_backup(&root, "2026-09-30").await.unwrap();
        assert!(d.join("budget/2026-09.json").exists());
        assert!(!d.join(INCOMPLETE_MARKER).exists());
    }
    #[test]
    fn month_name_check_never_panics_on_non_ascii() {
        assert!(is_month_name("2026-09.json"));
        assert!(!is_month_name("abc備d.json"));
        assert!(!is_month_name("2026-9.json"));
        assert!(!is_month_name(".2026-09.json.1-2.tmp"));
    }

    #[tokio::test]
    async fn bom_files_parse() {
        let d = fresh("bom");
        std::fs::write(d.join("a.json"), "\u{feff}{\"x\":1}").unwrap();
        assert!(matches!(read_json::<Value>(&d.join("a.json")).await, FileRead::Ok(_)));
    }

    // 兩支程式（這裡用兩個並發 task）同時改 sync.json 的不同 key：鎖讓讀-改-寫不交錯，誰都不會被蓋掉
    #[tokio::test]
    async fn concurrent_sync_key_updates_never_lose_the_other_key() {
        let d = fresh("sync_lock");
        let (r1, r2) = (d.clone(), d.clone());
        let a = tokio::spawn(async move {
            for i in 0..200 { update_sync_key(&r1, "budget_to_dashboard", serde_json::json!(i)).await.unwrap(); }
        });
        let b = tokio::spawn(async move {
            for i in 0..200 { update_sync_key(&r2, "dashboard_to_budget", serde_json::json!(i)).await.unwrap(); }
        });
        a.await.unwrap();
        b.await.unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join("sync.json")).unwrap()).unwrap();
        assert_eq!(v["budget_to_dashboard"], 199);
        assert_eq!(v["dashboard_to_budget"], 199);
    }

    #[tokio::test]
    async fn stale_lock_from_killed_process_is_taken_over() {
        let d = fresh("stale_lock");
        let lock = d.join(".sync.json.lock");
        std::fs::write(&lock, "").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options().write(true).open(&lock).unwrap().set_modified(old).unwrap();
        update_sync_key(&d, "k", serde_json::json!(1)).await.unwrap();
    }

    #[tokio::test]
    async fn broken_sync_json_is_preserved_before_rebuild() {
        let d = fresh("sync_broken");
        std::fs::write(d.join("sync.json"), "{\"budget_to").unwrap();
        update_sync_key(&d, "budget_to_dashboard", serde_json::json!(["a"])).await.unwrap();
        let kept: Vec<_> = std::fs::read_dir(d.join("backup/corrupt")).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1);
    }

    fn seed(root: &Path) {
        std::fs::create_dir_all(root.join("snapshots")).unwrap();
        std::fs::create_dir_all(root.join("budget")).unwrap();
        std::fs::write(root.join("transactions.json"), "[]").unwrap();
        std::fs::write(root.join("snapshots/2026-09.json"), "{}").unwrap();
        std::fs::write(root.join("budget/2026-09.json"), "[]").unwrap();
        std::fs::write(root.join("unrelated.json"), "{}").unwrap();
    }

    #[tokio::test]
    async fn daily_backup_rotates_and_only_copies_known_files() {
        let root = fresh("daily_rotate");
        seed(&root);
        for d in 1..=20 { daily_backup(&root, &format!("2026-09-{:02}", d)).await.unwrap(); }
        let days = daily_backup_dates(&root).await;
        assert_eq!(days.len(), DAILY_BACKUP_KEEP);
        assert_eq!(days[0], "2026-09-07");
        let d = root.join("backup/daily/2026-09-20");
        assert!(d.join("transactions.json").exists());
        assert!(d.join("snapshots/2026-09.json").exists());
        assert!(d.join("budget/2026-09.json").exists());
        assert!(!d.join("unrelated.json").exists());
        assert!(!d.join("backup").exists());
    }

    // 壞掉的檔不放進備份，也不淘汰舊備份（否則壞資料連存 14 天就沒有好版本了）
    #[tokio::test]
    async fn daily_backup_never_rotates_out_good_copies_while_something_is_broken() {
        let root = fresh("daily_broken");
        seed(&root);
        for d in 1..=14 { daily_backup(&root, &format!("2026-09-{:02}", d)).await.unwrap(); }
        std::fs::write(root.join("transactions.json"), "").unwrap();
        for d in 15..=30 {
            assert!(daily_backup(&root, &format!("2026-09-{:02}", d)).await.is_err());
        }
        assert!(root.join("backup/daily/2026-09-01/transactions.json").exists(), "最舊的好備份還在");
        assert!(!root.join("backup/daily/2026-09-30/transactions.json").exists(), "壞檔沒被備份");
    }

    #[tokio::test]
    async fn daily_backup_cleans_leftovers_from_interrupted_runs() {
        let root = fresh("daily_leftover");
        seed(&root);
        std::fs::create_dir_all(root.join("backup/daily/.2026-09-01.partial/snapshots")).unwrap();
        std::fs::create_dir_all(root.join("backup/daily/.deleting-2026-08-01")).unwrap();
        daily_backup(&root, "2026-09-02").await.unwrap();
        let names: Vec<String> = std::fs::read_dir(root.join("backup/daily")).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["2026-09-02".to_string()]);
    }

    #[tokio::test]
    async fn txn_month_write_keeps_previous_version_and_preserves_corrupt() {
        let root = fresh("txn_month");
        std::fs::create_dir_all(root.join("snapshots")).unwrap();
        let mut m = SnapMap::new();
        m.insert("2026-09-01".into(), serde_json::json!(1));
        let mut t = Txn::default(); t.write_month("2026-09.json", &m).unwrap(); t.commit(&root).await.unwrap();
        m.insert("2026-09-02".into(), serde_json::json!(2));
        let mut t = Txn::default(); t.write_month("2026-09.json", &m).unwrap(); t.commit(&root).await.unwrap();
        let bak: SnapMap = serde_json::from_str(&std::fs::read_to_string(root.join("snapshots/backup/2026-09.json")).unwrap()).unwrap();
        assert_eq!(bak.len(), 1);
        std::fs::write(root.join("snapshots/2026-09.json"), "garbage").unwrap();
        let mut t = Txn::default(); t.write_month("2026-09.json", &m).unwrap(); t.commit(&root).await.unwrap();
        let kept: Vec<_> = std::fs::read_dir(root.join("backup/corrupt")).unwrap().flatten().collect();
        assert_eq!(std::fs::read_to_string(kept[0].path()).unwrap(), "garbage");
        let bak: SnapMap = serde_json::from_str(&std::fs::read_to_string(root.join("snapshots/backup/2026-09.json")).unwrap()).unwrap();
        assert_eq!(bak.len(), 1, "壞檔不可蓋掉好的備份");
    }
}
