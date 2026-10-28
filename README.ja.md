<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>W&amp;B Python SDK のためのセルフホスト型実験トラッキング。</b><br>
  <code>wandb.init()</code> と <code>wandb.log()</code> のコードはそのままに、実行を自分のサーバーへ送れます。<br>
  ダッシュボードで探索するほか、<code>randl</code> CLI でスクリプトから操作したり、組み込みのアシスタントに頼んだりできます。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

![学習率スイープの 12 件の実行を比較する randl のワークスペース](.github/assets/readme/hero.webp)

randl（"rewards and losses"）は、自分で運用する実験トラッカーです。環境変数を 2 つ設定するだけで、標準の `wandb` パッケージがそのまま randl にログを送り、高速な Web ダッシュボードがメトリクス、メディア、アーティファクトを届いたそばから表示します。同じワークスペースは、`randl` コマンドラインからも、自分で選んだモデルプロバイダーで動く AI アシスタントからも操作できます。すべてのデータは手元のマシンまたは自分のサーバーに残ります。構成は Node.js プロセス 1 つ、SQLite データベース 1 つ、そしてファイルを置くフォルダー 1 つです。

## randl を選ぶ理由

- **W&B SDK にそのまま差し替え可能。** `WANDB_BASE_URL` を randl に向けるだけで、学習コードは変更不要です。メトリクス、構成、サマリー、画像、動画、音声、テーブル、ヒストグラム、ファイル、アーティファクト、再開、オフライン同期、停止リクエストが実際の SDK で動作します。
- **データは自分のもの。** アカウントもクラウドサービスも不要です。デフォルトでは `127.0.0.1` で待ち受けます。API キーと HTTPS リバースプロキシを使えば、どこからでもアクセスできます。
- **機能のそろったダッシュボード。** 保存済みビュー付きのワークスペース、グループ化、スムージング、計算メトリクス、メディアパネル、実行テーブル、アーティファクト、プロジェクトの概要を備えています。インターフェースは 7 か国語に対応しています。
- **ワークスペースを整えてくれるアシスタント。** 「最も良い 3 件の実行を比較して」や「学習率でグループ化した value loss のパネルを追加して」のように普段の言葉で頼むと、アシスタントが実行を読み取り、ダッシュボードや CLI と同じツールでビュー、パネル、実行の選択を作成します。モデルプロバイダーは Anthropic、OpenAI、Google、OpenRouter をはじめ多数の中から自分で選べます。あなたの確認なしにプロジェクトを削除することはできません。
- **コマンドラインからスクリプトで操作可能。** `randl` CLI は、ローカルまたはリモートのサーバー上のプロジェクト、実行、ビュー、パネル、実行の選択、アーティファクト、プラグインを管理し、`jq`、スクリプト、CI 向けに JSON を出力します。`randl tools` はすべてのツールを JSON Schema で記述するため、Claude Code や Codex などのコーディングエージェントも randl を操作できます。
- **長い実行や多数の実行でも高速。** グラフはスクロールして表示範囲に入った時点で読み込まれ、描画領域のピクセル数とほぼ同じ数のポイントだけを取得します（バケットごとに最小値と最大値を取るため、スパイクも見えたままです）。ズームや拡大をすると、より詳細なデータを取得します。
- **省スペースなストレージ。** 履歴は圧縮ブロックに可逆的に保存されます。私たちの合成ベンチマークでは、インデックスを含むデータベース全体のサイズが、格納している履歴を JSON にした場合の約 5 分の 1 でした。

## クイックスタート

[Node.js](https://nodejs.org/) 22.19 以降が必要です。Python は学習コードを動かす場合にのみ必要です。

**1. randl をインストールして起動します。** このリポジトリのクローンで次を実行します。

```sh
npm ci
npm run build
npm start
```

サーバーは [http://127.0.0.1:8742](http://127.0.0.1:8742) で待ち受け、データを `.data/` に保存します。どちらかを変更するには `npm start -- --port 9000 --data-dir /path/to/data` を使います。

**2. W&B SDK の接続先を randl にします。** 学習コードを実行するシェルで次を実行します。

```sh
pip install wandb numpy pillow moviepy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

このプレースホルダーのキーは、API キーが設定されていないローカルサーバーで使えます。`moviepy` は NumPy 配列から動画をログに記録する場合にのみ必要です。

**3. いつもどおりに実行をログに記録します。**

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

**4. [http://127.0.0.1:8742](http://127.0.0.1:8742) を開きます。** 実行は `local` エンティティの **quickstart** プロジェクトに表示され、メトリクスごとのグラフと、画像および動画のパネルが並びます。プロジェクトヘッダーの **SDK を接続** を開くと、プロジェクトが入力済みの状態でこれらの設定を確認できます。

その他の接続方法：

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` を実行すると、環境変数を使う代わりに、randl がユーザーアカウントのデフォルトの W&B ホストとして保存されます。
- `WANDB_MODE=offline` で記録した実行は、環境変数を設定したあとで `wandb sync wandb/offline-run-*` を実行するとアップロードされます。
- エンティティを指定せずに開始した実行は、サーバーのデフォルトのエンティティ `local` を使います。別のエンティティ（W&B のユーザー名など）を使うには、`--entity NAME`（または `RANDL_ENTITY=NAME`）を付けてサーバーを起動します。

## 機能紹介

### 実行に追従するワークスペース

ワークスペースでは、表示中のすべての実行をパネルのセクションで比較でき、パネルはデータが届くたびにライブで更新されます。実行の一覧でクリックやドラッグをして実行を表示、非表示、**ソロ表示**に切り替えられ（複数の実行を同時にソロ表示できます）、最大 20 件の実行を上部にピン留めし、実行ごとに色を設定できます。パネル、実行の選択、色、フィルター、グラフの設定は**ビュー**に保存され、元に戻す・やり直しにも対応しています。

- 折れ線グラフ、面グラフ、積み上げ面グラフ、100% 積み上げ面グラフ、棒グラフ、散布図、履歴散布図、平行座標、ヒストグラム、テーブル、画像、音声、動画のパネル。
- ホバーまたはキーボードで値を確認できます。カーソルとホバー中の実行は、パネル間および実行の一覧と連動します。
- グラフ上をドラッグするとズームします。取得するのは不足しているポイントだけです。
- 4 種類のスムージング方法（EMA、時間加重 EMA、ガウシアン、中心化移動平均）、対数軸、固定範囲、**Y 軸の範囲から外れ値を除外**を、パネルごと、セクションごと、またはワークスペース全体で設定できます。
- パネルを PNG として、またはそのデータを CSV としてエクスポートできます。

### グループ化と集計

![学習率でグループ化したエピソードリターン。ホバーカードに各グループの平均値を表示](.github/assets/readme/grouped.webp)

任意の構成値、タグ、実行フィールドでグラフをグループ化し、各グループの平均値、中央値、最小値、最大値をばらつきの帯とともに描画できます。ホバーすると、各グループの名前と、平均を取っている実行の数が表示されます。実行の一覧と実行テーブルは、グラフとは別にグループ化できます。

### 実行ごとに 1 つのグラフ

![グリッドレイアウト：実行ごとに小さなグラフを 1 つずつ表示し、X と Y の範囲を共有](.github/assets/readme/grid.webp)

**レイアウト → グリッド** では、実行またはグループごとに軸を共有した小さなグラフを描画し、**カバーフロー** ではそれらを 1 つずつ表示します。ホバー、カーソル、ズームはセル間で連動します。

### 画像、動画、音声

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/media.webp" alt="1 つの実行の記録済みの全ステップの画像サンプル。ノイズからきれいなスプライトへ変化"></td>
    <td width="50%"><img src=".github/assets/readme/coverflow.webp" alt="ダークテーマでの画像サンプルのカバーフロー"></td>
  </tr>
</table>

メディアパネルは、記録されたすべてのファイルをタイルとして表示します。1 つのステップの全実行、または 1 つの実行の全ステップのどちらかを表示でき、ステップスライダーはセクション内で共有されます。画像と動画のポスターは、表示範囲内のタイルの分だけ読み込まれます。動画は画面上にある間、ミュートで自動再生・ループ再生され（どちらもオフにできます）、シーク可能なストリーミングで再生されます。**カバーフロー** はファイルを 1 つずつ表示し、タイル上で Enter を押すと全画面で開きます。

### 計算メトリクス

![記録済みの 2 つのメトリクスを割り算する計算メトリクスを設定したパネルエディター](.github/assets/readme/computed.webp)

`${rollout/pole_falls} / ${rollout/episodes}` のような式を、記録済みのメトリクスと並べて描画できます。式はグループ化とスムージングの前に履歴レコードごとに評価され、シンタックスハイライトと、メトリクス名および `Math.` 関数の補完が使えます。式は randl 自身が解析するため、JavaScript は実行されません。

### 実行テーブル

![学習率でグループ化し、3 件の実行を選択した実行テーブル](.github/assets/readme/table.webp)

実行の検索、フィルター、並べ替え、グループ化ができ、構成、サマリー、実行フィールドから最大 32 列を選べます。実行を選択してタグ付け、停止、削除を行えます。削除した実行はプロジェクト設定から復元できます。

### プロジェクトの概要とサーバーの状態

![実行中の実行が 1 件あるプロジェクトの概要。実行の状態とストレージ使用量を表示](.github/assets/readme/overview.webp)

各プロジェクトの概要には、実行中の実行がライブの実行時間とともに一覧表示され、状態ごとの実行数、計算時間とストレージの合計、最大の実行と最近の実行へのリンクが表示されます。**サーバー** ページでは、直近 1 時間のリクエスト、応答時間、転送バイト数、エラー率を、メモリとデータベースサイズとあわせてグラフで確認できます。

### アシスタントに頼む

![CLI と同じツールでビューを作成するアシスタント](.github/assets/readme/assistant.webp)

ヘッダーの **アシスタント** を開き、見たいものを伝えます。アシスタントは開いているプロジェクトとビューを把握しており、実行、メトリクス、保存済みビューを調べて、自分で変更を加えます。たとえば次のように頼めます。

- 「エピソードリターンで最も良い 3 件の実行を比較して。」 実行のサマリーを読み取り、エピソードリターンのグラフを含むビューを作成して、その 3 件の実行をソロ表示します。
- 「学習率でグループ化した value loss のパネルを追加して。」 開いているビューに折れ線グラフを追加し、構成値 `learning_rate` でグループ化します。
- 「クラッシュした実行に unstable タグを付けて非表示にして。」 実行にタグを付け、ビューの実行の選択を更新します。

各ツール呼び出しは実行されるたびに会話内に表示され、結果は通常の保存済みビューになるため、そのまま手作業で編集を続けられます。会話は **会話履歴** に残ります。アシスタントが削除した実行は、プロジェクト設定から復元できます。確認が必要な操作はプロジェクトの削除だけです。会話内のカードがプロジェクト名の入力を待ち、モデルが代わりに確定することはできません。

アシスタントは Pi コーディングエージェントをベースにしており、randl の管理ツールだけを読み込みます。シェルやファイルへのアクセスはありません。プロバイダーとモデルは **アプリ設定 → アシスタント** で選択します。Anthropic、OpenAI、Google、Mistral、OpenRouter、または Pi が対応するその他のプロバイダーの API キーを保存するか、サーバー上で Pi にサインインするか、Pi の `models.json` に独自のエンドポイントを追加します。プロンプトとツールの実行結果は、そのモデルのプロバイダーに送信されます。

### randl CLI でスクリプト化する

![ビューの作成、パネルの追加、実行のソロ表示、アシスタントへの依頼を行うターミナルセッション](.github/assets/readme/cli.webp)

アシスタントにできることはすべて `randl` コマンドでも実行でき、さらにアーティファクト、プラグイン、プロジェクト管理のコマンドもあります。コマンドは JSON を出力するため、`jq`、シェルスクリプト、CI ジョブと組み合わせられ、リモートサーバーに対しても同じように動作します。次のセッションでは、手作業でビューを作成します。

```sh
alias randl="node $PWD/backend/dist/cli.js"  # once, from the repository root

VIEW=$(randl views create --project demo/cartpole-ppo --name "Best learning rate" | jq -r .id)
randl panels add --view $VIEW --metric charts/episodic_return
randl runs --project demo/cartpole-ppo \
  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \
  | randl select --view $VIEW --solo-file -
```

`randl tools` はすべての管理ツールを引数の JSON Schema とともに一覧表示し、`randl tool NAME --json ARGUMENTS` でそのどれでも呼び出せます。短いコマンドでは指定できないオプションも使えます。

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "'$VIEW'", "plugin": "line", "metric": "losses/value_loss", "settings": {"groupBy": "config.learning_rate"}}'
```

`randl agent` はアシスタントにリクエストを 1 つ送信して返答を出力し、各ツール呼び出しを標準エラー出力に表示します。`--confirm-delete-project entity/project` で許可しない限り、プロジェクトの削除は拒否されます。

```sh
randl agent 'Compare my three best runs on episodic return'
```

**コーディングエージェントと使う。** コマンドは入力を求めることがなく、JSON を出力し、エラーは標準エラー出力に報告して 0 以外の終了ステータスを返します。そのため、Claude Code や Codex などのコーディングエージェントが randl を直接使えます。エージェントに `randl --help` と `randl tools` を読むよう指示してから、たとえば起動したばかりの実験用のビューを用意するよう頼んでみてください。

スクリーンショットではローカルの代替モデルを使用しています。ツール呼び出しは実際のサーバーに対して実行されました。

### どの画面でも、あなたの言語で

<table>
  <tr>
    <td width="34%"><img src=".github/assets/readme/mobile.webp" alt="スマートフォンで表示したワークスペース"></td>
    <td>
      レイアウトはスマートフォンの画面に合わせて調整され、グラフはタッチで操作できます。長押ししてからドラッグするとズームします。<br><br>
      ライトテーマとダークテーマはシステム設定または選択に従い、アクセントカラーも選べます。実行の色には、どちらのテーマでも W&amp;B のパレットを使います。<br><br>
      インターフェースは英語、簡体字中国語、繁体字中国語（台湾）、日本語、韓国語、フランス語、スペイン語に対応しています。実行名、メトリクスのキー、その他の記録されたデータは、常に記録されたとおりに表示されます。
    </td>
  </tr>
</table>

## W&B との互換性

randl は、Python SDK がトラッキングに使う W&B プロトコルの部分を実装しています。実際の `wandb` **0.30.0** パッケージを使い、API キーありとなしの両方でテストしています。

| 動作するもの                                                              | 備考                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `wandb.init`、`run.log`、構成、サマリー、タグ、グループ、メモ             |                                                                     |
| 画像、動画、音声、テーブル、ヒストグラム                                  | メディア、テーブル、ヒストグラムの各パネルに表示                    |
| `define_metric` のステップメトリクスと非表示メトリクス                    | サマリーの集計は SDK が計算                                         |
| 完了、失敗、再開（`resume="allow"` / `"must"`）、ダッシュボードからの停止 | 10 分間通信のない実行はクラッシュとしてマーク                       |
| 実行のファイル、環境メタデータ、システムメトリクス、コンソールログ        |                                                                     |
| アーティファクト：記録、バージョン、エイリアス、使用、ダウンロード        | 1 ファイルあたり最大 10 GiB                                         |
| `wandb login --host`、`WANDB_MODE=offline` と `wandb sync`                |                                                                     |
| `run.alert()`                                                             | 実行ページに表示。メールやチャットへの通知はなし                    |
| `wandb.Api()` による実行の読み取り                                        | フィルターなしの `Api().run(...)` と `Api().runs("entity/project")` |

サポートしていないもの：Reports、Sweeps、Registry、Launch、Weave、Vega や Plotly のカスタムグラフ、W&B のアカウントとチーム（randl のオーナーは 1 人です）、外部アーティファクト参照とマルチパートのアーティファクトアップロード、実行の読み取り以外の公開 API 呼び出し。サポートしていないリクエストには、データを保存したふりをせずにエラーを返します。

## セルフホスティング

自分のワークステーションで使うだけなら、`npm start` だけで十分です。他のマシンから randl を使うには、オーナーの API キーを設定し、HTTPS リバースプロキシの背後に置きます。

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

ブラウザーはこのキーでサインインします。クライアントマシンでは、同じキーを `RANDL_API_KEY` としてエクスポートします。CLI は `RANDL_URL` と `RANDL_API_KEY` を読み取り、SDK にも同じ値を渡します。

```sh
export RANDL_URL=https://randl.example.com
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="$RANDL_API_KEY"
```

[DEPLOYMENT.md](DEPLOYMENT.md)（英語）では、[deploy/Caddyfile](deploy/Caddyfile) にある Caddy の設定例、バックアップ、アップロードの上限、アシスタントのプロバイダー設定について説明しています。

| `randl serve` のオプション | デフォルト      | 用途                                                                  |
| -------------------------- | --------------- | --------------------------------------------------------------------- |
| `--port`                   | `8742`          | 待ち受けポート                                                        |
| `--host`                   | `127.0.0.1`     | 待ち受けアドレス                                                      |
| `--data-dir`               | `.data`         | データベース、アップロードされたファイル、インストール済みプラグイン  |
| `--public-url`             |                 | 公開 HTTPS アドレス（または `RANDL_PUBLIC_URL`）                      |
| `--entity`                 | `local`         | エンティティを指定しない実行のエンティティ（または `RANDL_ENTITY`）   |
| `--run-timeout`            | `600`           | 実行中の実行をクラッシュとみなすまでの、SDK からの通信がない秒数      |
| `--frontend-dir`           | `frontend/dist` | ビルド済みインターフェースのデプロイ済みコピーを配信                  |
| `--pi-agent-dir`           | `<data-dir>/pi` | アシスタントのプロファイルディレクトリ（または `RANDL_PI_AGENT_DIR`） |

`ffmpeg` がインストールされている場合、randl はそれを使って動画のポスターを作成します。`RANDL_FFMPEG` にそのパス、または `off` を設定できます。

## コマンドライン

以下の例では、機能紹介で定義した `randl` エイリアスを使っています。スクリプトでは代わりに `node /path/to/randl/backend/dist/cli.js` を呼び出してください。どのコマンドも JSON を出力し、エラー時には 0 以外のステータスで終了します。接続先は `RANDL_URL`（デフォルトは `http://127.0.0.1:8742`）で、サーバーに API キーが設定されている場合は `RANDL_API_KEY` を使います。`randl --help` ですべてのコマンドを一覧表示できます。

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

## パネルプラグイン

組み込みかインストール済みかにかかわらず、すべてのパネルは同じプラグインインターフェースを使います。`panel.json` マニフェストと、データを受け取って描画するブラウザーモジュールです。プラグインはパネルエディターに型付きのオプションを追加したり、独自の翻訳を同梱したりできます。プラグインはローカルディレクトリまたは GitHub リポジトリからインストールします。

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

インストールしたプラグインは無効の状態で始まります。有効にすると、ダッシュボード内でそのデータにアクセスできる状態で動作するため、信頼できるコードのみをインストールしてください。randl はソースをコピーし、インストールスクリプトやビルドスクリプトを実行することはありません。独自のプラグインを作成するには [PLUGINS.md](PLUGINS.md)（英語）を参照してください。

## ステータス

randl はまだ新しく、変化の速いプロジェクトです。バージョン間で互換性のない変更があることを想定してください。randl は独立した実装であり、Weights & Biases とは提携関係にありません。W&B のサーバーとダッシュボードは randl には含まれていません。開発環境のセットアップ、テスト、アーキテクチャについては [CONTRIBUTING.md](CONTRIBUTING.md)（英語）で説明しています。

## ライセンス

randl は [MIT ライセンス](LICENSE)で公開されています。
