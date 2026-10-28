<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>適用於 W&amp;B Python SDK 的自架實驗追蹤工具。</b><br>
  保留您的 <code>wandb.init()</code> 與 <code>wandb.log()</code> 程式碼，將執行傳送到您自己的伺服器。<br>
  在儀表板中探索執行、以 <code>randl</code> CLI 撰寫指令碼操作，或直接詢問內建的助理。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <b>繁體中文</b> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

![randl 工作區正在比較學習率掃描的十二個執行](.github/assets/readme/hero.webp)

randl（「rewards and losses」）是一套由您自行執行的實驗追蹤工具。只要設定兩個環境變數，原版 `wandb` 套件就會將資料記錄到 randl，快速的網頁儀表板會在資料送達時即時顯示您的指標、媒體與成品。同一個工作區也能透過 `randl` 命令列操作，或交給 AI 助理處理，助理會使用您選擇的模型供應商執行。所有資料都留在您的電腦或伺服器上：一個 Node.js 程序、一個 SQLite 資料庫，以及一個存放檔案的資料夾。

## 為什麼選擇 randl

- **可直接搭配 W&B SDK 使用。** 將 `WANDB_BASE_URL` 指向 randl，訓練程式碼無須修改。指標、組態、摘要、影像、影片、音訊、表格、直方圖、檔案、成品、恢復執行、離線同步與停止請求，都能搭配真正的 SDK 運作。
- **完全屬於您。** 不需要帳號，也不需要雲端服務。預設監聽 `127.0.0.1`；搭配 API 金鑰與 HTTPS 反向代理，即可從任何地方存取。
- **功能完整的儀表板。** 包含可儲存檢視的工作區、分組、平滑、計算指標、媒體面板、執行表格、成品與專案總覽。介面提供七種語言。
- **替您設定工作區的助理。** 用平常的話提出要求，例如「比較我最好的三個執行」或「新增一個依學習率分組的 value loss 面板」，助理就會讀取您的執行，並使用與儀表板及 CLI 相同的工具建立檢視、面板與執行選取。模型供應商由您自選：Anthropic、OpenAI、Google、OpenRouter 等眾多選擇。未經您確認，助理無法刪除專案。
- **可從命令列撰寫指令碼操作。** `randl` CLI 可在本機或遠端伺服器上管理專案、執行、檢視、面板、執行選取、成品與外掛程式，並輸出 JSON 供 `jq`、指令碼與 CI 使用。`randl tools` 以 JSON Schema 描述每一項工具，因此 Claude Code 或 Codex 等程式設計代理也能操作 randl。
- **長時間執行與大量執行都很快。** 圖表會在捲動進入畫面時才載入，擷取的資料點數量約與圖表的像素數相當（每個區間取最小值與最大值，讓尖峰保持可見），並在您縮放或放大圖表時進一步細化。
- **精簡的儲存空間。** 歷程記錄以壓縮區塊無損保存。在我們的合成基準測試中，整個資料庫（含索引）所佔空間約為其所保存 JSON 歷程記錄的五分之一。

## 快速入門

您需要 [Node.js](https://nodejs.org/) 22.19 或更新版本。只有您的訓練程式碼需要 Python。

**1. 安裝並啟動 randl。** 在此存放庫的複本中執行：

```sh
npm ci
npm run build
npm start
```

伺服器會監聽 [http://127.0.0.1:8742](http://127.0.0.1:8742)，並將資料存放在 `.data/`。使用 `npm start -- --port 9000 --data-dir /path/to/data` 可變更這兩項設定。

**2. 讓 W&B SDK 指向它。** 在執行訓練程式碼的 shell 中：

```sh
pip install wandb numpy pillow moviepy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

這個預留位置金鑰適用於未設定 API 金鑰的本機伺服器。只有從 NumPy 陣列記錄影片時才需要 `moviepy`。

**3. 照平常的方式記錄執行：**

```python
import numpy as np
import wandb

with wandb.init(project="quickstart", config={"lr": 3e-4, "batch_size": 64}) as run:
    for step in range(200):
        loss = 2.0 * np.exp(-step / 60) + 0.05 * np.random.rand()
        metrics = {"train/loss": loss, "train/accuracy": 1 - loss / 2.1}
        if step % 50 == 0:
            image = np.random.randint(0, 255, (64, 64, 3), dtype=np.uint8)
            metrics["samples"] = wandb.Image(image, caption=f"step {step}")
            frames = np.random.randint(0, 255, (16, 3, 64, 64), dtype=np.uint8)  # time, channel, H, W
            metrics["rollout"] = wandb.Video(frames, fps=8, format="mp4")
        run.log(metrics)
```

**4. 開啟 [http://127.0.0.1:8742](http://127.0.0.1:8742)。** 執行會出現在 `local` entity 下的
**quickstart** 專案中，每個指標各有一張圖表，影像與影片也各有面板。專案標頭中的
**連接 SDK** 會顯示這些設定，並已填入專案名稱。

其他連接方式：

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` 會將 randl 儲存為您使用者帳號的預設 W&B 主機，不必使用環境變數。
- 以 `WANDB_MODE=offline` 記錄的執行，在設定好變數後可用 `wandb sync wandb/offline-run-*` 上傳。
- 未指定 entity 的執行會使用伺服器的預設 entity `local`。啟動伺服器時加上 `--entity NAME`
  （或 `RANDL_ENTITY=NAME`）即可改用其他 entity，例如您的 W&B 使用者名稱。

## 功能導覽

### 跟得上執行進度的工作區

工作區會在由面板組成的區段中比較所有可見的執行，面板會隨著資料送達即時更新。在執行清單中點按或拖曳，即可顯示、隱藏或**單獨顯示**執行（可同時單獨顯示多個執行）；最多可將 20 個執行釘選在頂端，也能為執行指定專屬顏色。面板、執行選取、顏色、篩選條件與圖表設定都會儲存在**檢視**中，並支援復原與重做。

- 折線圖、面積圖、堆疊面積圖、百分比面積圖、長條圖、散佈圖、歷程散佈圖、平行座標圖、直方圖、表格、影像、音訊與影片面板。
- 以滑鼠懸停或鍵盤檢視數值；游標與懸停中的執行會在各面板與執行清單之間連動。
- 在圖表上拖曳即可縮放；只會擷取缺少的資料點。
- 四種平滑方法（EMA、時間加權 EMA、高斯與置中移動平均）、對數座標軸、固定範圍，以及
  **從 Y 軸範圍中排除離群值**，可針對個別面板、區段或整個工作區設定。
- 將面板匯出為 PNG，或將其資料匯出為 CSV。

### 分組與彙總

![依學習率分組的 episodic return，懸停卡片顯示各組的平均值](.github/assets/readme/grouped.webp)

可依任何組態值、標籤或執行欄位將圖表分組，繪製各組的平均值、中位數、最小值或最大值，並附上離散程度色帶。懸停時會顯示各組名稱及其平均了多少個執行。執行清單與執行表格可以獨立於圖表進行分組。

### 每個執行一張圖表

![格狀版面配置：每個執行一張小圖表，共用 X 軸與 Y 軸範圍](.github/assets/readme/grid.webp)

**版面配置 → 格狀**會將每個執行或群組繪製在各自的小圖表中並共用座標軸，**封面流**則一次顯示一個。懸停、游標與縮放會在各格之間保持連動。

### 影像、影片與音訊

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/media.webp" alt="單一執行在每個已記錄步數的影像樣本，從雜訊逐漸變成清晰的精靈圖"></td>
    <td width="50%"><img src=".github/assets/readme/coverflow.webp" alt="深色主題下的影像樣本封面流"></td>
  </tr>
</table>

媒體面板會將每個已記錄的檔案顯示為一個圖塊，可以呈現所有執行在同一步的結果，或單一執行在各步的結果，並由區段共用步數滑桿。影像與影片封面只會為畫面中的圖塊載入。影片在畫面上時會靜音自動播放並循環播放（兩者皆可關閉），並以串流方式播放、支援跳轉。**封面流**會一次呈現一個檔案，在圖塊上按 Enter
即可以全螢幕開啟。

### 計算指標

![面板編輯器中有一個將兩個已記錄指標相除的計算指標](.github/assets/readme/computed.webp)

可將 `${rollout/pole_falls} / ${rollout/episodes}` 這類公式與已記錄的指標並列繪製。公式會在分組與平滑之前針對每筆歷程記錄計算，並提供語法醒目提示，以及指標名稱與 `Math.` 函式的自動完成。
randl 會自行解析公式，不會執行任何 JavaScript。

### 執行表格

![依學習率分組並選取了三個執行的執行表格](.github/assets/readme/table.webp)

可搜尋、篩選、排序執行並將其分組，從組態、摘要與執行欄位中選擇最多 32 個欄，並選取執行來加上標籤、停止或刪除。已刪除的執行可從專案設定中還原。

### 專案總覽與伺服器狀態

![專案總覽，顯示一個執行中的執行、執行狀態與儲存空間用量](.github/assets/readme/overview.webp)

每個專案的總覽會列出執行中的執行及其即時執行時長、依狀態統計執行數量、加總運算時長與儲存空間，並連結到最大與最近的執行。**伺服器**頁面會以圖表呈現最近一小時的請求數、回應時間、傳輸位元組數與錯誤率，以及記憶體與資料庫大小。

### 詢問助理

![助理正使用與 CLI 相同的工具建立檢視](.github/assets/readme/assistant.webp)

開啟標頭中的**助理**，描述您想看到的內容。助理知道您目前開啟的專案與檢視，會查詢執行、指標與已儲存的檢視，並自行完成變更。例如：

- 「比較我在 episodic return 上最好的三個執行。」助理會讀取各執行的摘要，建立一個含有 episodic return 圖表的檢視，並單獨顯示這三個執行。
- 「新增一個依學習率分組的 value loss 面板。」助理會在目前開啟的檢視中新增一張折線圖，並依組態值 `learning_rate` 分組。
- 「將當機的執行加上 unstable 標籤並隱藏它們。」助理會為這些執行加上標籤，並更新檢視的執行選取。

每次工具呼叫在執行時都會列在對話中，結果則是一般的已儲存檢視，您可以繼續手動編輯。對話會保存在**對話記錄**中。助理刪除的執行可從專案設定中還原。刪除專案是唯一需要您確認的操作：對話中會出現一張卡片，等待您輸入專案名稱，模型無法代為確認。

助理以 Pi 程式設計代理為基礎，只載入 randl 的管理工具，無法使用 shell 或存取檔案。請在 **應用程式設定 → 助理** 中選擇供應商與模型：可以儲存 Anthropic、OpenAI、Google、Mistral、OpenRouter 或其他 Pi 支援之供應商的 API 金鑰、在伺服器上以 Pi 登入，或在 Pi 的 `models.json` 中加入您自己的端點。提示詞與工具結果會傳送給模型的供應商。

### 以 randl CLI 撰寫指令碼

![終端機工作階段：建立檢視、新增面板、單獨顯示執行並詢問助理](.github/assets/readme/cli.webp)

助理能做的每件事都有對應的 `randl` 指令，此外還有成品、外掛程式與專案管理指令。指令會輸出 JSON，因此可以搭配 `jq`、shell 指令碼與 CI 作業使用，對遠端伺服器的操作方式也完全相同。以下工作階段以手動方式建立一個檢視：

```sh
alias randl="node $PWD/backend/dist/cli.js"  # once, from the repository root

VIEW=$(randl views create --project demo/cartpole-ppo --name "Best learning rate" | jq -r .id)
randl panels add --view $VIEW --metric charts/episodic_return
randl runs --project demo/cartpole-ppo \
  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \
  | randl select --view $VIEW --solo-file -
```

`randl tools` 會列出每一項管理工具及其引數的 JSON Schema，`randl tool NAME --json ARGUMENTS` 則可呼叫其中任何一項，包括較短的指令未提供的選項：

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "'$VIEW'", "plugin": "line", "metric": "losses/value_loss", "settings": {"groupBy": "config.learning_rate"}}'
```

`randl agent` 會向助理送出一個請求並輸出它的回覆，每次工具呼叫則輸出到標準錯誤。除非您以 `--confirm-delete-project entity/project` 允許，否則它會拒絕刪除專案。

```sh
randl agent 'Compare my three best runs on episodic return'
```

**搭配程式設計代理。** 指令從不要求互動輸入、會輸出 JSON，並在標準錯誤回報錯誤且以非零結束狀態結束，因此 Claude Code 或 Codex 等程式設計代理可以直接使用 randl。請代理先閱讀 `randl --help` 與 `randl tools`，然後再請它做事，例如為它剛啟動的實驗設定一個檢視。

螢幕截圖使用的是本機替代模型；工具呼叫是在真正的伺服器上執行的。

### 任何螢幕、您的語言

<table>
  <tr>
    <td width="34%"><img src=".github/assets/readme/mobile.webp" alt="手機上的工作區"></td>
    <td>
      版面配置會適應手機螢幕，圖表也支援觸控操作：長按後拖曳即可縮放。<br><br>
      淺色與深色主題可跟隨系統或由您自行選擇，並提供多種強調色。執行顏色在兩種主題中都使用
      W&amp;B 的調色盤。<br><br>
      介面提供英文、簡體中文、繁體中文（台灣）、日文、韓文、法文與西班牙文。執行名稱、指標鍵與其他已記錄的資料一律按記錄時的原樣顯示。
    </td>
  </tr>
</table>

## W&B 相容性

randl 實作了 Python SDK 用於追蹤的 W&B 協定部分。它已使用真正的 `wandb` **0.30.0** 套件進行測試，涵蓋有 API 金鑰與無 API 金鑰兩種情況。

| 支援項目                                                        | 備註                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `wandb.init`、`run.log`、組態、摘要、標籤、群組、備註           |                                                                   |
| 影像、影片、音訊、表格與直方圖                                  | 顯示在媒體、表格與直方圖面板中                                    |
| `define_metric` 步數指標與隱藏指標                              | 摘要彙總由 SDK 計算                                               |
| 完成、失敗、恢復（`resume="allow"` / `"must"`）以及從儀表板停止 | 10 分鐘未連線的執行會標示為已當機                                 |
| 執行檔案、環境中繼資料、系統指標與主控台記錄                    |                                                                   |
| 成品：記錄、版本、別名、使用與下載                              | 每個檔案最大 10 GiB                                               |
| `wandb login --host`、`WANDB_MODE=offline` 搭配 `wandb sync`    |                                                                   |
| `run.alert()`                                                   | 顯示在執行頁面上；不會傳送電子郵件或聊天通知                      |
| `wandb.Api()` 讀取執行                                          | 不含篩選條件的 `Api().run(...)` 與 `Api().runs("entity/project")` |

不支援：Reports、Sweeps、Registry、Launch、Weave、Vega 或 Plotly 自訂圖表、W&B 帳號與團隊（randl 只有單一擁有者）、外部成品參照與分段成品上傳，以及讀取執行以外的公開 API 呼叫。不支援的請求會傳回錯誤，而不會假裝已儲存資料。

## 自架

在您自己的工作站上，只需要 `npm start`。若要從其他電腦使用 randl，請為它設定擁有者 API 金鑰，並將它放在 HTTPS 反向代理之後：

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

瀏覽器以此金鑰登入。在用戶端電腦上，請將同一組金鑰匯出為 `RANDL_API_KEY`；CLI 會讀取 `RANDL_URL` 與 `RANDL_API_KEY`，SDK 則使用相同的值：

```sh
export RANDL_URL=https://randl.example.com
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="$RANDL_API_KEY"
```

[DEPLOYMENT.md](DEPLOYMENT.md)（英文）說明了 [deploy/Caddyfile](deploy/Caddyfile) 中的 Caddy 範例、備份、上傳限制與助理供應商設定。

| `randl serve` 選項 | 預設值          | 用途                                                     |
| ------------------ | --------------- | -------------------------------------------------------- |
| `--port`           | `8742`          | 監聽連接埠                                               |
| `--host`           | `127.0.0.1`     | 監聽位址                                                 |
| `--data-dir`       | `.data`         | 資料庫、上傳的檔案與已安裝的外掛程式                     |
| `--public-url`     |                 | 公開 HTTPS 位址（或 `RANDL_PUBLIC_URL`）                 |
| `--entity`         | `local`         | 未指定 entity 之執行所使用的 entity（或 `RANDL_ENTITY`） |
| `--run-timeout`    | `600`           | 執行中的執行在多少秒未與 SDK 連線後標示為已當機          |
| `--frontend-dir`   | `frontend/dist` | 提供已部署的建置後介面複本                               |
| `--pi-agent-dir`   | `<data-dir>/pi` | 助理設定檔目錄（或 `RANDL_PI_AGENT_DIR`）                |

如果已安裝 `ffmpeg`，randl 會使用它來產生影片封面；可將 `RANDL_FFMPEG` 設為其路徑，或設為 `off`。

## 命令列

以下範例使用功能導覽中的 `randl` 別名；在指令碼中請改為呼叫 `node /path/to/randl/backend/dist/cli.js`。每個指令都會輸出 JSON，發生錯誤時以非零狀態結束，並連線到 `RANDL_URL`（預設為 `http://127.0.0.1:8742`），若伺服器設有 API 金鑰則使用 `RANDL_API_KEY`。`randl --help` 會列出所有指令。

```sh
randl status
randl projects list
randl projects create --id local/robotics --name Robotics
randl runs --project local/quickstart
randl runs show --id local/quickstart/RUN_ID
randl runs add-tags --ids local/quickstart/RUN_ID --tags baseline
randl views list
randl artifacts list
randl artifacts download --id ARTIFACT_ID --output ./downloads
randl projects delete --id local/robotics --confirm Robotics
```

## 面板外掛程式

每個面板，不論是內建或另外安裝的，都使用相同的外掛程式介面：一份 `panel.json` 資訊清單，以及一個接收資料並加以呈現的瀏覽器模組。外掛程式可以在面板編輯器中新增具型別的選項，並附帶自己的翻譯。可從本機目錄或 GitHub 存放庫安裝外掛程式：

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

已安裝的外掛程式預設為停用。啟用後，它們會在儀表板中執行並可存取儀表板的資料，因此請只安裝您信任的程式碼。
randl 會複製原始碼，且絕不執行安裝或建置指令碼。若要撰寫自己的外掛程式，請參閱 [PLUGINS.md](PLUGINS.md)（英文）。

## 狀態

randl 仍在早期階段且變化快速；不同版本之間可能出現不相容的變更。它是獨立的實作，與 Weights & Biases
沒有任何關係；W&B 伺服器與儀表板並不包含在其中。[CONTRIBUTING.md](CONTRIBUTING.md)（英文）說明了開發環境設定、測試與架構。

## 授權

randl 以 [MIT 授權條款](LICENSE)釋出。
