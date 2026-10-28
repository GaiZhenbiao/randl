<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>面向 W&amp;B Python SDK 的自托管实验跟踪。</b><br>
  保留你的 <code>wandb.init()</code> 和 <code>wandb.log()</code> 代码，把运行发送到你自己的服务器。<br>
  可以在仪表盘中浏览它们，用 <code>randl</code> CLI 编写脚本，或询问内置的助手。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <b>简体中文</b> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.es.md">Español</a>
</p>

![一个 randl 工作区，正在比较学习率扫描中的十二个运行](.github/assets/readme/hero.webp)

randl（“rewards and losses”，即奖励与损失）是一个由你自己运行的实验跟踪工具。只需设置两个环境变量，原版 `wandb` 包就会把数据记录到 randl，快速的 Web 仪表盘会在指标、媒体和制品到达时随即显示。同一个工作区还可以通过 `randl` 命令行操作，或交给运行在你所选模型提供商上的 AI 助手处理。所有内容都保存在你的机器或服务器上：一个 Node.js 进程、一个 SQLite 数据库和一个存放文件的文件夹。

## 为什么选择 randl

- **W&B SDK 即插即用。** 把 `WANDB_BASE_URL` 指向 randl，训练代码保持不变。指标、配置、摘要、图像、视频、音频、表格、直方图、文件、制品、恢复运行、离线同步和停止请求均可配合真实 SDK 使用。
- **数据归你所有。** 无需账号，也无需云服务。默认监听 `127.0.0.1`；配置 API 密钥和 HTTPS 反向代理后，可以从任何地方访问。
- **功能完整的仪表盘。** 带已保存视图的工作区、分组、平滑、计算指标、媒体面板、运行表格、制品和项目概览。界面提供七种语言。
- **替你配置工作区的助手。** 用自然语言提出要求，例如“比较我最好的三个运行”或“添加一个按学习率分组的价值损失面板”，它就会读取你的运行，并使用与仪表盘和 CLI 相同的工具构建视图、面板和运行选择。模型提供商由你自选：Anthropic、OpenAI、Google、OpenRouter 等众多选择。未经你确认，它无法删除项目。
- **可通过命令行编写脚本。** `randl` CLI 可在本地或远程服务器上管理项目、运行、视图、面板、运行选择、制品和插件，并输出 JSON，便于配合 `jq`、脚本和 CI 使用。`randl tools` 用 JSON Schema 描述每个工具，因此 Claude Code 或 Codex 等编码智能体也能操作 randl。
- **长运行、多运行都很快。** 图表在滚动进入视野时才加载，获取的点数与绘图区的像素数大致相当（每个分桶取最小值和最大值，因此尖峰依然可见），并在你缩放图表或把图表调大时进一步细化。
- **存储精简。** 历史记录以压缩块的形式无损保存。在我们的合成基准测试中，整个数据库（含索引）占用的空间约为其所存 JSON 历史记录的五分之一。

## 快速开始

你需要 [Node.js](https://nodejs.org/) 22.19 或更高版本。Python 仅用于你的训练代码。

**1. 安装并启动 randl。** 在本仓库的克隆目录中执行：

```sh
npm ci
npm run build
npm start
```

服务器监听 [http://127.0.0.1:8742](http://127.0.0.1:8742)，数据保存在 `.data/` 中。使用
`npm start -- --port 9000 --data-dir /path/to/data` 可修改端口或数据目录。

**2. 让 W&B SDK 指向它。** 在运行训练代码的 shell 中执行：

```sh
pip install wandb numpy pillow moviepy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

这个占位密钥适用于未配置 API 密钥的本地服务器。只有从 NumPy 数组记录视频时才需要 `moviepy`。

**3. 记录一个运行**，方式和你平时一样：

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

**4. 打开 [http://127.0.0.1:8742](http://127.0.0.1:8742)。** 该运行会出现在 `local` 实体下的
**quickstart** 项目中，每个指标各有一个图表，图像和视频也各有对应的面板。项目标题栏中的
**连接 SDK** 会显示上述设置，并已填好项目。

其他连接方式：

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` 会把 randl 保存为你的用户账号的默认
  W&B 主机，无需使用环境变量。
- 使用 `WANDB_MODE=offline` 记录的运行，在设置好上述变量后可通过 `wandb sync wandb/offline-run-*` 上传。
- 未指定实体就启动的运行会使用服务器的默认实体 `local`。启动服务器时加上 `--entity NAME`（或
  `RANDL_ENTITY=NAME`）即可改用其他实体，例如你的 W&B 用户名。

## 功能一览

### 紧跟运行进度的工作区

工作区以分区组织面板，比较所有可见的运行，面板会随数据到达实时更新。在运行列表中单击或拖动即可显示、隐藏或**单独显示**运行（可同时单独显示多个运行），最多可将 20 个运行置顶，还可以为运行指定各自的颜色。面板、运行选择、颜色、筛选条件和图表设置都保存在**视图**中，并支持撤销和重做。

- 折线图、面积图、堆叠面积图、百分比面积图、条形图、散点图、历史散点图、平行坐标图、直方图、表格、图像、音频和视频面板。
- 悬停或使用键盘即可查看数值；光标和悬停的运行会在各面板和运行列表之间联动。
- 在图表上拖动即可缩放；只会获取缺失的数据点。
- 四种平滑方法（EMA、时间加权 EMA、高斯和居中滑动平均）、对数坐标轴、固定范围以及**从 Y 轴范围中排除离群值**，均可按面板、按分区或为整个工作区设置。
- 将面板导出为 PNG，或将其数据导出为 CSV。

### 分组与聚合

![按学习率分组的回合回报，悬停卡片显示每个分组的平均值](.github/assets/readme/grouped.webp)

可按任意配置值、标签或运行字段对图表分组，绘制每个分组的平均值、中位数、最小值或最大值，并以色带显示离散程度。悬停时会显示每个分组的名称及其平均的运行数。运行列表和运行表格可以独立于图表进行分组。

### 每个运行一个图表

![网格布局：每个运行一个小图表，共享 X 轴和 Y 轴范围](.github/assets/readme/grid.webp)

**布局 → 网格**会把每个运行或分组分别绘制在共享坐标轴的小图表中，**封面流**则一次显示一个。悬停、光标和缩放在各个单元格之间保持联动。

### 图像、视频和音频

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/media.webp" alt="一个运行在每个已记录步的图像样本，从噪声逐渐变为清晰的精灵图"></td>
    <td width="50%"><img src=".github/assets/readme/coverflow.webp" alt="深色主题下图像样本的封面流"></td>
  </tr>
</table>

媒体面板把每个已记录的文件显示为一个图块，既可以显示所有运行在某一步的文件，也可以显示一个运行在各步的文件，并配有整个分区共享的步滑块。图像和视频封面只为可见的图块加载。视频位于屏幕内时会静音自动循环播放（两者都可以关闭），并以流式传输播放，支持跳转。**封面流**一次展示一个文件，在图块上按 Enter 可全屏打开。

### 计算指标

![面板编辑器中的一个计算指标，用两个已记录的指标相除](.github/assets/readme/computed.webp)

在已记录的指标旁绘制公式，例如 `${rollout/pole_falls} / ${rollout/episodes}`。公式在分组和平滑之前按每条历史记录求值，并提供语法高亮以及指标名称和 `Math.` 函数的自动补全。randl 自行解析公式，不会执行任何 JavaScript。

### 运行表格

![按学习率分组并选中了三个运行的运行表格](.github/assets/readme/table.webp)

搜索、筛选、排序和分组运行，从配置、摘要和运行字段中最多选择 32 列，并可选中运行来添加标签、停止或删除。已删除的运行可在项目设置中恢复。

### 项目概览与服务器状态

![一个项目概览，显示一个运行中的运行、各运行状态和存储用量](.github/assets/readme/overview.webp)

每个项目的概览会列出运行中的运行及其实时运行时长，按状态统计运行数，汇总计算时长和存储用量，并链接到最大的和最近的运行。**服务器**页面以图表展示最近一小时的请求数、响应时间、传输字节数和错误率，以及内存和数据库大小。

### 向助手提问

![助手正在使用与 CLI 相同的工具创建视图](.github/assets/readme/assistant.webp)

点击标题栏中的**助手**，描述你想看到的内容。助手知道你当前打开的是哪个项目和视图，会查找运行、指标和已保存的视图，并亲自完成更改。例如：

- “比较我在回合回报上表现最好的三个运行。”它会读取这些运行的摘要，创建一个包含回合回报图表的视图，并单独显示这三个运行。
- “添加一个按学习率分组的价值损失面板。”它会在当前打开的视图中添加一个折线图，按配置值 `learning_rate` 分组。
- “给已崩溃的运行加上‘不稳定’标签并隐藏它们。”它会为这些运行添加标签，并更新视图的运行选择。

每次工具调用在执行时都会列在对话中，得到的结果是一个普通的已保存视图，你可以继续手动编辑。对话保存在**对话历史**中。助手删除的运行可在项目设置中恢复。删除项目是唯一需要你确认的操作：对话中会出现一张卡片，等待你输入项目名称，模型无法代为确认。

助手基于 Pi 编码智能体构建，只加载 randl 的管理工具，无法访问 shell 或文件。在**应用设置 → 助手**中选择提供商和模型：可以为 Anthropic、OpenAI、Google、Mistral、OpenRouter 或 Pi 支持的其他提供商保存 API 密钥，在服务器上通过 Pi 登录，或者在 Pi 的 `models.json` 中添加你自己的端点。提示词和工具结果会发送给模型的提供商。

### 用 randl CLI 编写脚本

![一个终端会话：创建视图、添加面板、单独显示运行并向助手提问](.github/assets/readme/cli.webp)

助手能做的一切也都有对应的 `randl` 命令，此外还有制品、插件和项目管理命令。命令输出 JSON，因此可以与 `jq`、shell 脚本和 CI 作业组合使用，对远程服务器也同样适用。下面这个会话手动构建了一个视图：

```sh
alias randl="node $PWD/backend/dist/cli.js"  # once, from the repository root

VIEW=$(randl views create --project demo/cartpole-ppo --name "Best learning rate" | jq -r .id)
randl panels add --view $VIEW --metric charts/episodic_return
randl runs --project demo/cartpole-ppo \
  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \
  | randl select --view $VIEW --solo-file -
```

`randl tools` 列出每个管理工具及其参数的 JSON Schema，`randl tool NAME --json ARGUMENTS` 可以调用其中任意一个，包括较短的命令未提供的选项：

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "'$VIEW'", "plugin": "line", "metric": "losses/value_loss", "settings": {"groupBy": "config.learning_rate"}}'
```

`randl agent` 向助手发送一个请求并输出其回复，每次工具调用都输出到标准错误。除非你用 `--confirm-delete-project entity/project` 允许删除某个项目，否则它会拒绝删除项目。

```sh
randl agent 'Compare my three best runs on episodic return'
```

**配合编码智能体使用。** 命令从不要求交互输入，输出 JSON，出错时把错误输出到标准错误并以非零状态退出，因此 Claude Code 或 Codex 等编码智能体可以直接使用 randl。让智能体先阅读 `randl --help` 和 `randl tools`，然后就可以让它做事，例如为它刚启动的实验设置一个视图。

截图中使用的是本地替代模型；工具调用是在真实的服务器上执行的。

### 适配各种屏幕，支持你的语言

<table>
  <tr>
    <td width="34%"><img src=".github/assets/readme/mobile.webp" alt="手机上的工作区"></td>
    <td>
      布局可适配手机屏幕，图表支持触控操作：长按后拖动即可缩放。<br><br>
      浅色和深色主题可跟随系统或由你选择，并提供多种强调色。运行颜色在两种主题下都使用
      W&amp;B 的调色板。<br><br>
      界面提供英语、简体中文、繁体中文（台湾）、日语、韩语、法语和西班牙语版本。运行名称、指标键和其他已记录的数据始终按记录时的原样显示。
    </td>
  </tr>
</table>

## W&B 兼容性

randl 实现了 Python SDK 在跟踪时使用的那部分 W&B 协议。它已使用真实的 `wandb` **0.30.0** 包测试过，包括使用和不使用 API 密钥两种情况。

| 支持的功能                                                      | 说明                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `wandb.init`、`run.log`、配置、摘要、标签、分组、备注           |                                                                   |
| 图像、视频、音频、表格和直方图                                  | 显示在媒体、表格和直方图面板中                                    |
| `define_metric` 步指标和隐藏指标                                | 摘要聚合由 SDK 计算                                               |
| 结束、失败、恢复（`resume="allow"` / `"must"`）以及从仪表盘停止 | 超过 10 分钟没有联系的运行会被标记为已崩溃                        |
| 运行文件、环境元数据、系统指标和控制台日志                      |                                                                   |
| 制品：记录、版本、别名、使用和下载                              | 每个文件最大 10 GiB                                               |
| `wandb login --host`、`WANDB_MODE=offline` 配合 `wandb sync`    |                                                                   |
| `run.alert()`                                                   | 显示在运行页面上；不发送电子邮件或聊天通知                        |
| 使用 `wandb.Api()` 读取运行                                     | 不带筛选条件的 `Api().run(...)` 和 `Api().runs("entity/project")` |

不支持：Reports、Sweeps、Registry、Launch、Weave、Vega 或 Plotly 自定义图表、W&B 账号和团队（randl 只有一个所有者）、外部制品引用和分段上传制品，以及读取运行之外的公共 API 调用。不支持的请求会返回错误，而不会假装已存储数据。

## 自托管

在你自己的工作站上，只需 `npm start`。如需从其他机器使用 randl，请为它设置所有者 API 密钥，并将其置于 HTTPS 反向代理之后：

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

浏览器使用该密钥登录。在客户端机器上，把同一个密钥导出为 `RANDL_API_KEY`；CLI 读取 `RANDL_URL` 和 `RANDL_API_KEY`，SDK 也使用相同的值：

```sh
export RANDL_URL=https://randl.example.com
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="$RANDL_API_KEY"
```

[DEPLOYMENT.md](DEPLOYMENT.md)（英文）介绍了 [deploy/Caddyfile](deploy/Caddyfile) 中的 Caddy 示例、备份、上传限制以及助手提供商的设置。

| `randl serve` 选项 | 默认值          | 用途                                              |
| ------------------ | --------------- | ------------------------------------------------- |
| `--port`           | `8742`          | 监听端口                                          |
| `--host`           | `127.0.0.1`     | 监听地址                                          |
| `--data-dir`       | `.data`         | 数据库、上传的文件和已安装的插件                  |
| `--public-url`     |                 | 公共 HTTPS 地址（或 `RANDL_PUBLIC_URL`）          |
| `--entity`         | `local`         | 未指定实体的运行所使用的实体（或 `RANDL_ENTITY`） |
| `--run-timeout`    | `600`           | 运行中的运行在没有 SDK 联系多少秒后被标记为已崩溃 |
| `--frontend-dir`   | `frontend/dist` | 提供已部署的构建版界面副本                        |
| `--pi-agent-dir`   | `<data-dir>/pi` | 助手配置文件目录（或 `RANDL_PI_AGENT_DIR`）       |

如果已安装 `ffmpeg`，randl 会用它生成视频封面；可将 `RANDL_FFMPEG` 设置为其路径，或设为 `off`。

## 命令行

示例使用功能一览中设置的 `randl` 别名；在脚本中请改为调用 `node /path/to/randl/backend/dist/cli.js`。每个命令都输出 JSON，出错时以非零状态退出，并连接 `RANDL_URL`（默认为 `http://127.0.0.1:8742`），服务器设置了密钥时会使用 `RANDL_API_KEY`。`randl --help` 会列出所有命令。

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

## 面板插件

每个面板，无论是内置的还是安装的，都使用相同的插件接口：一个 `panel.json` 清单，以及一个接收数据并进行渲染的浏览器模块。插件可以向面板编辑器添加带类型的选项，并自带翻译。可从本地目录或 GitHub 仓库安装插件：

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

已安装的插件默认处于禁用状态。启用后，插件会在仪表盘中运行并可访问其数据，因此请只安装你信任的代码。randl 会复制源码，但从不运行安装或构建脚本。如需编写自己的插件，请参阅 [PLUGINS.md](PLUGINS.md)（英文）。

## 项目状态

randl 尚处于早期阶段，变化很快；不同版本之间可能会有破坏性变更。它是一个独立实现，与 Weights & Biases 没有关联；W&B 服务器和仪表盘不属于 randl。[CONTRIBUTING.md](CONTRIBUTING.md)（英文）介绍了开发环境设置、测试和架构。

## 许可证

randl 以 [MIT 许可证](LICENSE)发布。
