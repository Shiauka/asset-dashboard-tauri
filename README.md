# 資產管理儀表板

個人投資組合追蹤桌面應用程式，以五桶資產配置框架為核心設計。資料完全存放在本機，不經過任何雲端服務。

> 這是[一個工程師的財務自白](https://www.youtube.com/@shiauka)播客系列的配套工具，EP17 有完整示範。

---

## 下載安裝

前往 [Releases 頁面](https://github.com/Shiauka/asset-dashboard-tauri/releases) 下載最新版本：

| 平台 | 下載檔案 |
|------|---------|
| Windows 10 / 11 | `.exe`（NSIS 安裝程式）或 `.msi` |

> 目前僅提供 Windows 預編譯版本。macOS / Linux 使用者請參考下方[自行編譯](#自行編譯)章節。

---

## 功能

| 分頁 | 說明 |
|------|------|
| 資產分布 | 圓餅圖顯示五桶配置現況，點擊可展開個股明細；條形圖比對目標比例 vs 實際比例 |
| 資產走勢 | 以本機 JSON 快照繪製歷史資產曲線 |
| 績效分析 | 時間加權報酬率（TWR）計算，區隔投入資金與投資報酬 |
| 退休規劃 | 設定目標金額、退休年齡、月投入，自動計算達成進度與所需年化報酬率，含退休軌跡圖 |
| 再平衡分析 | 計算各標的缺口（萬元 / 股數），支援台幣 / 美金帳戶分開檢視 |
| 持倉明細 | 管理股票與現金帳戶，自訂目標配置比例 |
| 交易紀錄 | 買入、賣出、現金轉帳完整記錄，支援編輯與刪除（自動回溯調整歷史快照） |

**其他功能：**
- 啟動時自動從 Yahoo Finance 抓取最新報價，匯率從台灣銀行牌告匯率取得
- 隱藏金額模式（一鍵模糊所有數字）
- `?demo` 網址參數可進入示範模式，不影響實際資料
- 資料以每日 JSON 快照格式存放在自訂根目錄

---

## 五桶框架

| 桶子 | 預設標的 | 目標比例 |
|------|---------|---------|
| 核心桶 | 0050 / VOO | 35% |
| 攻擊桶 | 00631L / QQQ | 30% |
| 全球分散桶 | VEA / VWO | 15% |
| 另類資產桶 | IBIT / IAU | 5% |
| 現金防禦桶 | SGOV / 台幣活存 | 15% |

標的和比例可在持倉明細分頁自由調整。

---

## 技術架構

- **前端**：React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + Recharts + Radix UI
- **後端**：Tauri v2（Rust）— 負責檔案讀寫、報價抓取、歷史快照回溯更新
- **資料儲存**：本機 JSON 檔（每日一個 `YYYY-MM-DD.json`，存放在使用者指定的根目錄）

---

## 自行編譯

### 前置需求

所有平台都需要：

- **Node.js 18+**：https://nodejs.org/
- **Rust**：https://rustup.rs/（安裝後執行 `rustup update stable`）

---

#### Windows

1. **Microsoft C++ Build Tools**
   安裝 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾選「C++ 桌面開發」工作負載。

2. **WebView2 Runtime**
   Windows 10（2004 後）和 Windows 11 已內建，若沒有請至 [Microsoft 官網](https://developer.microsoft.com/microsoft-edge/webview2/) 下載 Evergreen Bootstrapper。

3. **Node.js**：建議用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 管理版本。

#### macOS

```bash
# 安裝 Xcode Command Line Tools
xcode-select --install
```

#### Linux（Ubuntu / Debian）

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

其他發行版請參考 [Tauri 官方文件](https://v2.tauri.app/start/prerequisites/)。

---

### 編譯步驟

```bash
# 1. clone 專案
git clone https://github.com/Shiauka/asset-dashboard-tauri.git
cd asset-dashboard-tauri

# 2. 安裝前端相依套件
npm install

# 3-A. 開發模式（開啟 Tauri 視窗，支援 hot-reload）
npm run dev

# 3-B. 打包成安裝程式
npm run build
```

第一次執行 `npm run build` 時，Cargo 需要下載並編譯 Rust 依賴，大約需要 5–15 分鐘（視網速與 CPU 而定），之後增量編譯會快很多。

**編譯產出位置：**

| 平台 | 產出路徑 | 檔案類型 |
|------|---------|---------|
| Windows | `src-tauri/target/release/bundle/nsis/` | `.exe` 安裝程式 |
| Windows | `src-tauri/target/release/bundle/msi/` | `.msi` 安裝程式 |
| macOS | `src-tauri/target/release/bundle/dmg/` | `.dmg` |
| Linux | `src-tauri/target/release/bundle/deb/` | `.deb` |
| Linux | `src-tauri/target/release/bundle/appimage/` | `.AppImage` |

---

### 僅跑前端（瀏覽器模式）

不需要 Rust 環境，適合只想看 UI 的情況：

```bash
npm install
npm run vite:dev
# 開啟 http://localhost:1420/?demo 可使用示範資料
```

> 注意：瀏覽器模式下報價抓取、本機檔案讀寫等功能無法使用（需要 Tauri 後端）。

---

## 資料儲存說明

第一次啟動後，點擊工具列的 📁 圖示，設定「根目錄」路徑（例如 `C:\Users\你的帳號\Documents\AssetDB`）。

之後每次手動點「儲存」或新增交易時，會在根目錄寫入 `YYYY-MM-DD.json`。再次開啟 app 時，自動讀取最新那份並重建歷史走勢圖。

所有資料保留在本機，不上傳任何伺服器。

---

## License

MIT
