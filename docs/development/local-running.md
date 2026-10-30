# 本地运行与验证

## 环境与启动

使用 Node.js 24 或更新版本（项目使用内置 SQLite）。依赖版本由 package-lock.json 锁定。

```sh
npm ci
# 首次使用且没有 .env 时复制；已有配置时不要覆盖。
cp -n .env.deepseek.example .env
# 先在 .env 第一项 AI_API_KEY= 后填写 DeepSeek API key，再执行下列命令。
npm run build
npm start
```

在本机浏览器访问 `http://127.0.0.1:4310`。服务仅监听本机地址。前端文件由本地服务提供，关闭浏览器不会关闭服务；终端停止服务后，采集和分析也会停止。

开发调试可运行 `npm run dev`，前端开发代理默认连接 4310 端口；修改后端端口时需同步开发代理。普通使用优先采用上面的构建与启动流程。

## 真实数据与配置

默认入口是自动发现 GitHub Trending 项目，不需要经营者寻找或粘贴项目链接。没有 AI 配置时仍可采集和查看真实候选。当前本地 `.env` 已切换为 DeepSeek 方案，填写一项后重启服务：

```dotenv
AI_API_KEY=你的DeepSeek_API密钥
```

DeepSeek 模板为 `.env.deepseek.example`：两个服务地址均为 `https://api.deepseek.com`，分析模型为 `deepseek-flash`，检索模型为 `deepseek-v4-pro`。根据 [DeepSeek JSON 输出文档](https://api-docs.deepseek.com/guides/json_mode/) 与 [Responses 兼容说明](https://api-docs.deepseek.com/guides/responses_api/)（2026-10-30 核对），联网检索工具 `web_search` 仅由 Pro 模型支持，不能将检索模型改为 Flash。现有解析仍要求返回实际查询词和引用，缺失时会明确报错；尚未执行真实 DeepSeek 联调。

OpenAI 模板仍为 `.env.example`，分析与公开检索均预设为 `gpt-4.1-mini`。使用该模板时 `AI_API_KEY` 填 OpenAI 密钥。

两种方案均可将 `SEARCH_API_KEY` 留空以复用 `AI_API_KEY`；独立检索密钥优先。仅当两个地址相同且为上述 OpenAI 或 DeepSeek 官方地址时复用，混用服务或自定义地址须单独填写检索密钥。切换模板时保留本地数据库与批次数量等设置，并使用对应供应商的 key。

OpenAI 模板的模型依据官方 [模型文档](https://developers.openai.com/api/docs/models/gpt-4.1-mini) 和 [网页检索支持列表](https://developers.openai.com/api/docs/guides/tools-web-search) 选择（2026-10-30 核对）。真实可用性仍取决于账号模型权限、余额与网络，配置完整不代表真实调用已验证。

需要自定义服务时再修改以下选项：

- `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`：用于生成选题分析。支持兼容 Chat Completions 的 OpenAI、DeepSeek 等服务，具体模型必须由账号提供。
- `SEARCH_BASE_URL`、`SEARCH_API_KEY`、`SEARCH_MODEL`：用于 Responses API 的 `web_search` 中文公开检索。不能仅因分析服务兼容 OpenAI 接口，就认为它也支持该检索工具。
- `GITHUB_TOKEN`：可选。没有令牌时仍可访问公开仓库，遇到限流会显示错误。
- `RADAR_BATCH_SIZE`：每批分析数量，初始实现默认 10，可调整；它是实施默认值，不代表用户已确认长期名额规则。

地址填写 API 根地址，不要附加 `/chat/completions` 或 `/responses`。切换分析服务（例如 DeepSeek）时须同时修改 `AI_BASE_URL`、`AI_MODEL` 和 `AI_API_KEY`；若仍使用 OpenAI 检索，保留默认 `SEARCH_BASE_URL`、`SEARCH_MODEL`，单独填写 OpenAI 的 `SEARCH_API_KEY`。自定义地址不自动补全模型名称；模型须由对应服务支持。

不要将密钥粘贴到聊天或提交到 Git。前端只显示服务配置是否完整与模型名称，不返回密钥。真实服务未配置时，不能用模拟结果代替项目分析，也不能把网络失败当成没有中文教程。

## 数据与检查

SQLite 默认保存于 `data/radar.sqlite`，包括候选、证据、分析版本、人工决定及运行记录。`data/`、`.env` 和构建产物已加入忽略列表；升级或迁移前应备份本地数据。

```sh
npm run typecheck
npm test
```

测试中的外部服务响应为固定夹具或模拟响应，用于验证解析、契约、失败行为与持久化，不代表真实 AI 效果验证。真实项目试评需完成服务配置后，从自动发现的候选中选择 10 个项目，逐项检查来源、结论和下一步行动。

可选执行公开来源烟测（真实联网，读取榜单及前三个仓库，不加载密钥、不调用 AI，使用内存数据库）：

```sh
npx tsx scripts/smoke-discovery.ts
```

它还会通过进程内请求检查本地 API 和构建后的页面交付，无需启动浏览器或监听端口。运行前先执行 `npm run build`。

首个里程碑聚焦自动发现到人工判断的完整链路；每日定时运行、趋势历史、7 天预测及到期复盘按后续任务实现，不能将发现批次运行误称为每日调度已完成。

## 生图与素材导出配置

`GPT_IMAGE_MODEL` 单独指定网关目录中真实存在的图片模型，程序不会用 `GPT_MODEL` 猜测生图模型；置空即关闭配图。地址、密钥与附加请求头沿用 `GPT_*` 网关配置，与分析和检索互不覆盖。

2026-10-30 在该网关实测：`gpt-image-2.5-sunburst` 可通过 Responses 的 `image_generation` 工具生成与编辑图片，单张耗时约 22–74 秒，因此生图请求超时设为 300 秒；中文公开检索同款请求实测 136.7 秒，检索超时相应设为 240 秒（原先 120 秒会稳定截断该路径）。逐调用脱敏记录见 `docs/development/evidence/`。

打包导出生成 STORE 方式 ZIP（不压缩，不引第三方依赖），内含所选版本的 `文案.txt` 与已成功配图，不含内部资料、证据 ID、服务配置或密钥。文件名使用 UTF-8 标记：

```sh
# 已验证可用的解包方式
tar -xf material-xiaohongshu-xxxxxxxx.zip -C 目标目录
```

macOS 自带的 `unzip` 6.00（2009 版 Info-ZIP 分支）不识别 UTF-8 名称标记，会把中文目录显示为乱码并拒绝创建目录；这是该工具的历史限制，不是包结构错误——同一文件经 `tar`、Python `zipfile` 与 `unzip -t` 校验均正常且图片字节一致。需要终端解包时请改用 `tar`、`ditto -x -k` 或 Homebrew `unzip`。
