# NBN 套餐监测

澳洲 NBN 宽带套餐比较工具：按速度档位（25 / 50 / 100 / 250 / 500 / 750 / 1000 / 2000 Mbps）列出各供应商套餐的优惠价、优惠期和长期价（第一年 12 个月平均月费），输入自己的当前套餐后给出换套餐能省多少钱的推荐，并用图表展示各档最低价的价格历史。

React 前端 + Bun 服务端 + drizzle + SQLite，单机可运行，不依赖任何外部服务。

## 安装

需要 [Bun](https://bun.sh)（开发时用 1.3+）。

```bash
bun install
```

## 编译

```bash
bun run build        # 服务端 + 客户端一起编译
bun run typecheck    # 类型检查（客户端 + 服务端）
```

## 运行

```bash
bun run start        # 默认 http://localhost:3000
```

首次启动时，服务端会自动按 `drizzle/` 下的迁移创建 SQLite 数据库（默认 `./app.db`，里面是空表）；打开页面后会自动载入内置的套餐快照（见“数据说明”）。也可以用 `bun run dev` 以 watch 模式启动开发。

## 环境变量

复制 `.env.example` 为 `.env` 后修改（`.env` 不会进 git）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口 |
| `DATABASE_PATH` | `./app.db` | SQLite 数据库文件路径（相对路径以启动时的工作目录为准） |

## 数据说明

- **套餐数据来源**：内置快照是 2026-11-22 的当前数据（372 个套餐、48 家供应商、440 条价格历史；其中 105 个来自原版工具数据库里已核对过的数据，149 个是对照 Canstar 后补入的，118 个是对照 nbntracker-data 后补入的）。数据来源以 **Canstar 为主**，**nbntracker-data 为第二来源/交叉核对**，WhistleOut、Finder 和供应商官网/CIS 用于核对。每个套餐下方都标注了来源（纯文字）和核对日期；套餐行里的品牌名是官网链接（48 家有套餐的供应商都已逐个核对过官网地址），点品牌名打开供应商官网自行核对。长期价一律按第一年 12 个月的平均月费计算，签约前请以供应商 CIS 为准。
- **本地数据库**：首次启动自动建空库，打开页面时 `seedPlans` 会把上述快照同步进库：缺失的行插入，已有行里种子值变了的（价格、速度、来源、核对日期、优惠截止日、备注、供应商官网地址）按种子更新，价格变了的行标绿色 ↑ 并记一条价格历史。数据库文件只存在你自己的机器上。
- **当前套餐**：默认是空的，需要你自己在页面上输入供应商、速度档位和每月月费，推荐和省钱计算才会出现；也可以随时清除。
- **没有更新接口**：独立运行版不提供更新数据的接口（没有「立即刷新」按钮，也没有录入/核价接口）。数据由维护者**每周**用脚本更新种子文件并推送到 GitHub（见「每周更新流程」），重新部署后刷新页面即可看到更新后的数据。NBN 没有公开的价格数据接口，核对不到的套餐会保留原价和原核对日期，不会用猜测的数字填充。

## 页面显示规则

- **每档每个品牌只显示一行**：同一品牌同一档位只显示按当前比较基准最便宜的那一行；其余变体不显示，数据保留在库里（主行备注里如果有重要变体价格信息，例如 Optus 标准价 $89 的说明，会保留在备注文字里）。页面另外按同品牌同档位同价去重（372 行快照显示为 357 行）。
- **比较基准（12 / 24 个月均价）**：默认按 12 个月均价比较（第一年总费用 ÷ 12）。「每档长期价最低」和「套餐明细」顶部各有一个切换，共用同一个状态、两边同步；切到 24 个月均价后（两年总费用 ÷ 24，优惠价占头几个月就按几个月算、最多 24 个月，没有优惠的套餐 24 个月均价就是续费价），每档最便宜标记、各档排序、顶部推荐和每个套餐行上显示的均价都按 24 个月均价算，立即生效——套餐行只显示当前基准的那个均价（24 个月平均和两年总费用），不再并列两个平均；计算过程里仍写出两个窗口的算式。价格走势图仍按 12 个月均价（历史记录是第一年数据）。
- **优惠过期的套餐不显示**：`promo_end` 早于今天的套餐不显示（数据保留在库里）。注意：很多优惠截止日期只在备注文字里、没进 `promo_end` 字段，这些还不能自动隐藏。
- **每档最便宜和顶部推荐只按显示出来的行算**。
- **更新状态图标**：每个套餐旁的小圆图标表示最近一次种子同步的结果：绿色 ↑ 是价格有更新，灰色 － 是没有更新，红色 ! 是更新失败。推荐框里“我已经用的最便宜”时不显示图标和计算过程。

## 数据获取方式

套餐价格的核对以 **Canstar 为主来源**，**nbntracker-data 为第二来源**（交叉核对），其他来源作补充核对。2026-11-21 对照核对的结论：Canstar 去重后 8 档共 243 个套餐，比工具现有的 105 个更全，因此定为主来源（对照存档见原版工具的研究记录 `research_notes/nbn-canstar-comparison-20261121/canstar-reconciliation-20261121.md`）；nbntracker-data 是 <https://nbntracker.au> 背后的套餐数据库，每天抓取一次，8 档共 237 个住宅固定线路套餐，带每家供应商的 CIS 文件链接，适合做第二来源交叉核对（评估见 `research_notes/nbn-canstar-comparison-20261121/nbntracker-evaluation-20261121.md`）。

### 来源清单

1. **Canstar NBN 套餐页（主来源）**：<https://www.canstar.com.au/internet/nbn-plans/>
2. **nbntracker-data（第二来源 / 交叉核对）**：<https://github.com/springupsoftware/nbntracker-data>——<https://nbntracker.au> 的套餐数据库，**CC BY-SA 4.0 协议**：使用、改编和再发布都要署名（注明来源是 nbntracker-data / springupsoftware）并以相同协议分享。本项目在 `server/src/seed.ts` 文件头和每个由它补入的套餐行（`source: "nbntracker-data"`）里都已署名；用它的数据做的衍生快照同样以 CC BY-SA 4.0 分享。
3. **WhistleOut NBN 价目总表（交叉核对）**：<https://www.whistleout.com.au/Broadband/NBN-Plans-Price-Check-SLP>
4. **Finder 最便宜 NBN 套餐表（交叉核对）**：<https://www.finder.com.au/broadband-plans/nbn/cheap-nbn-plans>；1000 档单独看 <https://www.finder.com.au/broadband-plans/nbn/nbn-1000-gigabit-internet>
5. **各供应商官网 / CIS 文件（交叉核对，官网为准）**：套餐行里的品牌名就是官网链接，每个套餐下方也标注了它的来源。
6. **供应商名单与官网地址**：以 nbnco 服务商目录（<https://www.nbnco.com.au/residential/service-providers>）为准，48 家有套餐的供应商的官网地址已逐个核对，写在 `server/src/seed.ts` 的 `SEED_PROVIDERS` 里（另有一份映射见原版工具的研究记录 `research_notes/nbn-canstar-comparison-20261121/provider-websites.json`）。

### Canstar 具体查法

- 筛选条件：Internet Type = NBN；Internet Speed 按档位筛；Need A Modem? = Show All；**Online Partners 开关关掉（全量），改完务必刷新页面再读数**——只点开关不刷新，计数不变。
- 总数：开关开着 440 条，关掉 458 条；“500M 及以上”开着 218、关掉 224。
- 开着时各档条数：12+25 合计 70、50 是 58、100+250 合计 94、500 是 77、750 是 39、1000 是 61、2000 是 41。
- 去重后数量（2026-11-21 核对）：25 档 33、50 档 33、100 档 51、250 档 6、500 档 48、750 档 24、1000 档 34、2000 档 14，共 243 个（另有 12M 档 5 个）。
- 限制：页面一次最多显示 160 行；没有 12 与 25、100 与 250 的精确档位筛选——这两对按行里实际速度拆开再数；条数是列表变体数，不是去重后的套餐数；页面自述不是全市场比价。

### 自动取数脚本（主来源）：Canstar

Canstar 没有公开的价格数据接口，但套餐表是服务端直接渲染在结果页里的，不用登录、不用 API key，一次请求就能拉全量。脚本 `scripts/canstar_fetch.py`（Python 3 + curl）就是走这条路，2026-11-21 首次验证通过。

**取数方法**：请求结果页 `https://www.canstar.com.au/internet/nbn-plans/results/?tV=<base64>&returned=true`，其中 `tV` 是 base64 编码的筛选条件：`initialPageSize=500&pageSize=500&onlinePartner=false&sortBy=default&sortDir=desc&comparisonId=<任意 uuid>&nbnSpeed=nbnSpeed12PlusFlt&typeInternetPlan=NBN&isModemIncluded=skip&edit=true`。`pageSize=500` 一次拉到全部 458 条（Online Partners 关掉时的全量）；`nbnSpeed` 档位值是 `12PlusFlt` / `50PlusFlt` / `100PlusFlt` / `500PlusFlt` / `750PlusFlt` / `1000PlusFlt` / `2000PlusFlt`（均为“X 及以上”累计档位，精确档位按每条套餐的“Max download speed”划分）。价格以展示字符串形式嵌在卡片里，脚本解析广告价大字 + 小字“for N months, then $Y/mth”（得优惠价/月数/续费价），用 “Equivalent monthly cost” 栏校验 12 个月均价。12M 档不取（本项目不收 12M 套餐）；名字含 Fixed Wireless 的行不取（只要住宅固定线路）。

**用法**（在项目根目录跑）：

```bash
python3 scripts/canstar_fetch.py [--verify]
# 输出到 canstar-out/：
#   canstar_plans.json          全部实时套餐行
#   canstar_diff.json           与内置快照的比对结果（含种子候选的说明）
#   seed_new.ts                 更新后的种子候选文件（见「每周更新流程」）
```

**比对结果（`canstar_diff.json`）分这几类**：

- `changed`：价格真的变了的行——先去供应商官网确认，再决定是否采用（候选文件里已按实时价更新）。
- `known_exceptions`：已知的价格口径差异，不是真的变价——候选文件里**不覆盖**，保留快照价。目前两类：DODO 的 WhistleOut 专享优惠价（比 Canstar 标准价低约 $4，专享价是对的）；SpinTel NBN 100 的 $69/$76 分歧（Canstar 显示 $69×6，快照是 $76×6，nbntracker-data 2026-11-21 抓取也显示 $76×6，和快照一致，所以 $69 不采用）。
- `variant_mismatch`：同一套餐名有多个价格变体、且没有一个和快照对得上——人工核对后再定，候选文件里不改。
- `seed_missing`：快照里有、实时数据里按名字找不到的行——大多是名字对不上，不是套餐下架（见 `rename_candidates`：品牌 + 档位 + 三个价格全一样，只是名字不同，例如工具里的 “Kogan Internet / Gold Plus 500”）。
- `live_new`：实时数据里有、快照里没有的行——候选文件里已作为新增行列出，应用前人工确认是新套餐；其中和快照已有行同品牌同档同价的（只是名字不同）会单独列为 `duplicate_of_seed`，不新增（服务端的去重会把它删掉）。
- `seed_candidate`：候选文件改了哪些行、新增哪些行、哪些因为存疑没改，以及候选文件的行数统计。

**注意**：候选文件只改 `changed` 里的行（价格、来源、来源链接、核对日期、晚间速度）；`known_exceptions`、`variant_mismatch`、`rename_candidates` 的行保持快照原值。`--verify` 会在临时库里做两阶段验证（先用当前种子起服务，再换上候选种子起服务，核对行数、改价、新增行和供应商官网地址），验证通过才打印 `verify OK`。

### 自动取数脚本（第二来源）：nbntracker-data

脚本 `scripts/nbntracker_fetch.py`（Python 3）拉取 nbntracker-data 仓库（公开仓库，不用登录、不用 key），解析各供应商的 `*_plans.cue` 文件，和内置快照比对，生成种子候选文件。2026-11-21 首次验证通过，同日 117 行并入内置快照。

**取数方法**：`git clone`（已有副本时 `git pull`）<https://github.com/springupsoftware/nbntracker-data.git>，默认放到 `/tmp/nbntracker-data`；解析时用花括号配对的解析器读每个 `*_plans.cue` 里的套餐结构。**千万不要用正则去掉 `//` 注释**：`cis_url` 里的 `https://` 会被误伤，导致解析丢行。只取住宅固定线路、8 个档位（25/50/100/250/500/750/1000/2000）：排除 technology 为 satellite / nbn-fw / 5g / 4g 的行、名字含 Business 的行、名字含 Fixed Wireless 的行、NBN12 / NBN400 档（technology 字段缺失的供应商以名字为准，例如 SpinTel、IT'S FUBAR 的 Fixed Wireless 套餐）。

**用法**（在项目根目录跑）：

```bash
python3 scripts/nbntracker_fetch.py [--verify]
# 输出到 nbntracker-out/：
#   nbntracker_plans.json       全部实时套餐行（237 个，住宅固定线路、8 档）
#   nbntracker_diff.json        与内置快照的比对结果（含种子候选的说明）
#   seed_new.ts                 更新后的种子候选文件（见「每周更新流程」）
```

**比对结果（`nbntracker_diff.json`）分这几类**（和 Canstar 脚本同类）：

- `changed`：价格真的变了的行——先去供应商官网确认，再决定是否采用（候选文件里已按实时价更新）。
- `known_exceptions`：已知的价格口径差异，不是真的变价——候选文件里**不覆盖**，保留快照价。目前两类：DODO 的 WhistleOut 专享优惠价（比标准价低约 $4，专享价是对的）；实时数据里某套餐没有优惠、而快照里有优惠（例如 Aussie 的黑五优惠价，抓取器没抓到优惠不等于优惠结束了），快照的优惠价保留。
- `variant_mismatch`：同一套餐名有多个价格变体、且没有一个和快照对得上——人工核对后再定，候选文件里不改。
- `seed_missing`：快照里有、实时数据里按名字找不到的行——大多是名字对不上，不是套餐下架（见 `rename_candidates`：品牌 + 档位 + 三个价格全一样，只是名字不同，例如实时数据里的 “SpinTel 100/20Mbps” 对应快照里的 “SpinTel NBN 100”）。
- `live_new`：实时数据里有、快照里没有的行——候选文件里已作为新增行列出，应用前人工确认是新套餐；其中和快照已有行同品牌同档同价的（只是名字不同）会单独列为 `duplicate_of_seed`，不新增。
- `seed_candidate`：候选文件改了哪些行、新增哪些行、哪些因为存疑没改，以及候选文件的行数统计。

**注意**：

- 候选文件里每行都标了来源：`source: "nbntracker-data"`，`source_url` 是该套餐的 CIS 文件链接（没有 CIS 链接时用仓库地址）；已知例外的行不改来源。
- 候选文件里不写晚间速度（`tes`）：nbntracker 的下载/上传速度是套餐最高速度，不是晚间典型速度，写进去会把 `tes` 写错、还会误标绿色 ↑。新增行也不带 `tes`；`speedUp` 写的是最高上传速度。
- 有优惠截止日期的，候选文件会把 `promo_end` 补到对应行上（例如 Dodo 2026-12-08）。
- 供应商名字以快照里的拼写为准（例如实时数据的 “Tangerine Telecom” 录成 “Tangerine”，“More Telecom” 录成 “More”，“Origin Energy” 录成 “Origin”）。

### 去重规则

同一商家 + 同一套餐名 + 同一价格组合算一个；同一套餐的 BYO / 带 modem / 合约 / 捆绑变体只算一个。服务端 `seedPlans` 也按“同品牌 + 同档位 + 全部价格数字相同”去重，名字不同但价格全一样的行只留一行。

### 价格口径

长期价 = 第一年 12 个月平均月费 =（优惠价 × 优惠月数 + 续费价 × 剩余月数）÷ 12；无优惠则为续费价。Canstar 的 “Equivalent monthly cost” 栏就是这个数，可以直接取用，但要按上面公式复算一遍。

### 核对方法

1. 先在 Canstar 主来源上按档位逐行核对，再用 nbntracker-data 和 WhistleOut、Finder 两张总表交叉核对。
2. 官网价格和总表不一致时，以官网为准；签约前再以供应商的 CIS 文件为准。
3. 每次核对记下核对日期（`checked_date`，格式 `YYYY-MM-DD`），写进种子对应行的 `checkedDate`。
4. 核不到的套餐不要动，保留原价和原核对日期，不要猜数字填进去。
5. 同一套餐在不同来源价格不一致时，先看是不是优惠版本的区别（例如 DODO 的 WhistleOut 专享价比 Canstar 标准价低约 $4，专享价是对的；SpinTel NBN 100 的 Canstar $69 对 nbntracker-data 的 $76，以后者为准）；分不清的以官网为准，仍分不清的保留原价并在备注里写明。

## 每周更新流程（种子 + GitHub）

**一周一次**，按下面顺序做；平时不用每天跑：

1. **跑两个脚本**（项目根目录）：`python3 scripts/canstar_fetch.py --verify` 和 `python3 scripts/nbntracker_fetch.py --verify`，各约 20 秒再加验证时间。输出在 `canstar-out/` 和 `nbntracker-out/`（每次跑脚本生成的中间结果，不推送）。
2. **看 diff**：先看两个 `*_diff.json` 的 `seed_candidate`——`updated` 是改了价格的行，`added` 是新增的行，`not_updated` 里是因存疑没改的（`known_exceptions`、`variant_mismatch`、`rename_candidates`）；`changed` 里的行先去供应商官网确认，`known_exceptions` 不要覆盖，`variant_mismatch` 人工核对，`live_new` 确认是新套餐后再采用。两个脚本是各对当前种子生成的候选文件，先以后者为准合并不冲突的部分（或逐个应用），不要直接拿一个覆盖另一个。
3. **更新种子**：把确认无误的候选内容合进 `server/src/seed.ts`（改价的行、新加的行、补填的 `promo_end`；`provider` / `planName` 用快照里的拼写，`source` 写核对来源，`source_url` 写来源链接；`SEED_VERSION` 改成当天日期）。**只新增、不改已有行的价格**——除非 `changed` 里确认是真的变价。核对不到的套餐不动。
4. **验证**：`bun run typecheck && bun run build` 通过；起临时服务、调 `seedPlans`，确认行数和显示正确（两个脚本的 `--verify` 已经做过同样的两阶段验证）。
5. **推送 GitHub**：把改动的文件（脚本、种子、README）按仓库的快照推送流程推上去。

## 接口

服务同时提供前端页面和 `POST /actions`（请求体 `{ "action": "...", "args": {...} }`，返回 `{ "data": ... }`）：

| action | 说明 |
| --- | --- |
| `getState` | 全部套餐、价格历史、供应商官网地址、上次检查状态和已保存的当前套餐 |
| `seedPlans` | 把种子文件同步进库：缺失的套餐/供应商行插入，已有行里种子值变了的按种子更新（价格变了标绿色 ↑ 并记价格历史），并清理重复行；种子没变时什么都不写 |
| `saveCurrentPlan` | 保存当前套餐（`provider`、`tier`、`monthlyPrice`） |
| `clearCurrentPlan` | 清除已保存的当前套餐 |

另外 `GET /health` 返回 `{ "ok": true }`。

独立版**没有**更新数据的接口：没有 `refreshPrices`、`saveRefreshedPlans`、`markRefreshFailed`，页面上也没有「立即刷新」按钮。数据唯一来源是 `server/src/seed.ts`，每周由维护者用上面两个脚本更新种子文件并推送到 GitHub。

## 项目结构

```
client/            React 前端（src/App.tsx、api.ts，构建脚本 build.mjs）
scripts/           自动取数脚本：canstar_fetch.py（主来源 Canstar，一次拉全量并比对）和 nbntracker_fetch.py（第二来源 nbntracker-data，拉仓库、解析 CUE 并比对），各生成更新后的种子候选文件（seed_new.ts）+ 比对报告；见 README「数据获取方式」
server/src/        Bun 服务端
  index.ts         HTTP 入口：静态文件 + POST /actions
  actions.ts       全部 action 的定义（zod 校验 + 处理逻辑）
  db.ts            SQLite 连接、迁移与请求上下文
  schema.ts        drizzle 表结构
  seed.ts          2026-11-22 套餐快照（372 个套餐、48 家供应商、440 条价格历史）与供应商官网地址（SEED_PROVIDERS）
  sdk.ts           本地垫片，替代原来 Muse 内部的 @hatch/space-sdk
drizzle/           SQL 迁移（0001–0004）
```

## 出处

本项目由一个 Muse 托管的 fullstack artifact 打包而来。为独立运行做的替换见 `server/src/sdk.ts`、`client/src/local-sdk.tsx`、`client/src/space-styles.css` 和 `server/src/index.ts` 的文件头注释：原来依赖的内部包 `@hatch/space-sdk`（只在 Muse 托管环境里提供，不在 npm 上）被本地实现取代——服务端是 `Bun.serve` + drizzle，客户端是直接 `fetch("/actions")` 的轻量 RPC 客户端；原版的后台自动核价（依赖 Muse 的代理）在独立版里不可用，改为每周由维护者用脚本更新种子文件（见「每周更新流程」）。功能与界面其余部分保持不变。
