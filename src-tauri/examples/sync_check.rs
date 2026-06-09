// 對真實共用資料夾跑同步健檢。
//
// 用法：
//   cargo run --example sync_check -- "E:\資產配置\Test"
//
// 印出五大不變量的檢查結果；有 error 等級問題時 exit code = 2。

use std::path::PathBuf;

fn main() {
    let dir = match std::env::args().nth(1) {
        Some(d) => d,
        None => {
            eprintln!("用法: cargo run --example sync_check -- <共用資料夾路徑>");
            std::process::exit(1);
        }
    };

    match asset_dashboard_lib::sync_check::load_and_check(&PathBuf::from(&dir)) {
        Ok(issues) => {
            if issues.is_empty() {
                println!("✅ 同步狀態正常，五大不變量全部通過");
                return;
            }
            let errors = issues.iter().filter(|i| i.severity == "error").count();
            let warns  = issues.iter().filter(|i| i.severity == "warn").count();
            println!("發現 {} 個問題（error: {}, warn: {}）：\n", issues.len(), errors, warns);
            for it in &issues {
                let mark = if it.severity == "error" { "❌" } else { "⚠️ " };
                println!("  {} [{}] {}", mark, it.invariant, it.detail);
            }
            if errors > 0 {
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("讀取失敗: {}", e);
            std::process::exit(1);
        }
    }
}
