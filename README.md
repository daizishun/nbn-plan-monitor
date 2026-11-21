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

- **套餐数据来源**：内置快照是 2026-11-21 的当前数据（250 个套餐、151 家供应商、440 条价格历史；其中 105 个来自原版工具当天数据库里已核对过的数据，145 个是同日对照 Canstar 后补入的），价格逐项核对自 WhistleOut 价目表、Finder 最便宜 NBN 套餐表、Superloop 等供应商官网/CIS 文件，以及 nbnco 供应商目录（见页面底部的供应商目录）。每个套餐下方都标注了来源和核对日期；长期价一律按第一年 12 个月的平均月费计算，签约前请以供应商 CIS 为准。
- **本地数据库**：首次启动自动建空库，打开页面时 `seedPlans` 会把上述快照写入库中（已有的行不会被覆盖）。数据库文件只存在你自己的机器上。
- **当前套餐**：默认是空的，需要你自己在页面上输入供应商、速度档位和每月月费，推荐和省钱计算才会出现；也可以随时清除。
- **没有自动刷新**：原版在 Muse 托管环境里靠后台代理每天自动核价；独立运行版没有这个代理，也没有「立即刷新」按钮——按下面「手动核价流程」自行核对后录入，刷新页面即可看到更新后的数据（`markRefreshFailed` 用于记录一次失败的检查）。NBN 没有公开的价格数据接口，核对不到的套餐会保留原价和原核对日期，不会用猜测的数字填充。

## 数据获取方式

套餐价格的核对以 **Canstar 为主来源**，其他来源作交叉核对。2026-11-21 对照核对的结论：Canstar 去重后 8 档共 243 个套餐，比工具现有的 105 个更全，因此定为主来源（对照存档见原版工具的研究记录 `research_notes/nbn-canstar-comparison-20261121/canstar-reconciliation-20261121.md`）。

### 来源清单

1. **Canstar NBN 套餐页（主来源）**：<https://www.canstar.com.au/internet/nbn-plans/>
2. **WhistleOut NBN 价目总表（交叉核对）**：<https://www.whistleout.com.au/Broadband/NBN-Plans-Price-Check-SLP>
3. **Finder 最便宜 NBN 套餐表（交叉核对）**：<https://www.finder.com.au/broadband-plans/nbn/cheap-nbn-plans>；1000 档单独看 <https://www.finder.com.au/broadband-plans/nbn/nbn-1000-gigabit-internet>
4. **各供应商官网 / CIS 文件（交叉核对，官网为准）**：页面底部「供应商目录」里有官网链接，每个套餐下方也标注了它的来源链接。
5. **供应商名单**：以 nbnco 服务商目录为准（<https://www.nbnco.com.au/residential/service-providers>）。

### Canstar 具体查法

- 筛选条件：Internet Type = NBN；Internet Speed 按档位筛；Need A Modem? = Show All；**Online Partners 开关关掉（全量），改完务必刷新页面再读数**——只点开关不刷新，计数不变。
- 总数：开关开着 440 条，关掉 458 条；“500M 及以上”开着 218、关掉 224。
- 开着时各档条数：12+25 合计 70、50 是 58、100+250 合计 94、500 是 77、750 是 39、1000 是 61、2000 是 41。
- 去重后数量（2026-11-21 核对）：25 档 33、50 档 33、100 档 51、250 档 6、500 档 48、750 档 24、1000 档 34、2000 档 14，共 243 个（另有 12M 档 5 个）。
- 限制：页面一次最多显示 160 行；没有 12 与 25、100 与 250 的精确档位筛选——这两对按行里实际速度拆开再数；条数是列表变体数，不是去重后的套餐数；页面自述不是全市场比价。

### 去重规则

同一商家 + 同一套餐名 + 同一价格组合算一个；同一套餐的 BYO / 带 modem / 合约 / 捆绑变体只算一个。

### 价格口径

长期价 = 第一年 12 个月平均月费 =（优惠价 × 优惠月数 + 续费价 × 剩余月数）÷ 12；无优惠则为续费价。Canstar 的 “Equivalent monthly cost” 栏就是这个数，可以直接取用，但要按上面公式复算一遍。

### 核对方法

1. 先在 Canstar 主来源上按档位逐行核对，再用 WhistleOut、Finder 两张总表交叉核对。
2. 官网价格和总表不一致时，以官网为准；签约前再以供应商的 CIS 文件为准。
3. 每次核对记下核对日期（`checked_date`，格式 `YYYY-MM-DD`），录入时填这一天。
4. 核不到的套餐不要录入，保留原价和原核对日期，不要猜数字填进去。
5. 同一套餐在不同来源价格不一致时，先看是不是优惠版本的区别（例如 DODO 的 WhistleOut 专享价比 Canstar 标准价低约 $4，专享价是对的）；分不清的以官网为准，仍分不清的保留原价并在备注里写明。

## 手动核价流程

独立运行版没有后台自动核价，价格不会自己更新。按下面流程手动核对并录入，价格、推荐和图表才会跟着更新。**建议每月核一次**；打算换套餐、看到促销新闻、或某个套餐的优惠快到期时，再加核一次。

### 第 0 步：看上次核对时间

打开页面，顶部「上次检查」显示的就是最近一次成功核对的日期。超过一个月没核，就可以开始下面流程。

### 第 1 步：列出要核的套餐

页面「套餐明细」里就是全部要核的套餐（250 个，分 25 / 50 / 100 / 250 / 500 / 750 / 1000 / 2000 八个档位）。不用一个一个打开网页：先在 Canstar 主来源上按档位批量核对，再用 WhistleOut 和 Finder 两张总表交叉核对，最后去供应商官网逐个确认有变动的。

### 第 2 步：去这些地方查价

1. **Canstar NBN 套餐页（主来源）**：<https://www.canstar.com.au/internet/nbn-plans/>——按上面「数据获取方式」里的查法逐档核对（筛选条件、开关关掉后刷新、160 行上限、12/25 与 100/250 按行里实际速度拆开、去重规则）。
2. **WhistleOut NBN 价目总表**：<https://www.whistleout.com.au/Broadband/NBN-Plans-Price-Check-SLP>——大多数套餐的优惠价和优惠后价格都能在这里一次看到。
3. **Finder 最便宜 NBN 套餐表**：<https://www.finder.com.au/broadband-plans/nbn/cheap-nbn-plans>；1000 档单独看 <https://www.finder.com.au/broadband-plans/nbn/nbn-1000-gigabit-internet>。
4. **各供应商官网**：页面底部「供应商目录」里有官网链接，每个套餐下方也标注了它的来源链接；官网价格和总表不一致时，以官网为准，签约前再以供应商的 CIS 文件为准。
5. **供应商名单**：以 nbnco 服务商目录为准（<https://www.nbnco.com.au/residential/service-providers>）。如果目录里出现新的供应商、或某个供应商停售 NBN，先记下来：新增的套餐录入时会新增一行；停售的套餐本次不录，保留原价和原核对日期，不要删行。

### 第 3 步：每个套餐核对这些字段

- **供应商（`provider`）**：页面上的名字，录入时照抄，不要改名（改名会新增一行而不是更新原行）。
- **套餐名（`plan_name`）**：同上，照抄页面上的名字。
- **档位（`tier`）**：25 / 50 / 100 / 250 / 500 / 750 / 1000 / 2000，填数字字符串。
- **优惠价（`intro_price`）**：前几个月的月费；没有优惠就留空。
- **优惠月数（`intro_months`）**：优惠价持续几个月；没有优惠就留空。
- **优惠后价格（`ongoing_price`）**：优惠期结束后的月费，必填。
- **典型晚间速度（`tes`）**：如 `50/17 Mbps`；官网上没写就留空，不要猜。
- **备注（`note`）**：优惠结束日期、要用优惠码、「仅限新用户」这类条件，有就写，没有不写。
- 只核上面这些字段：**长期价（第一年 12 个月平均月费）是工具自己算的，不用手动算，也不用录入。**

### 第 4 步：录入保存

服务先跑起来（默认 <http://localhost:3000>），用 curl 调服务端的 `saveRefreshedPlans` 接口。一次最多录 120 个套餐，库里一共 250 个，要分 3 次录完。`checked_date` 填你核对当天的日期（格式 `YYYY-MM-DD`）：

```bash
curl -X POST http://localhost:3000/actions \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "saveRefreshedPlans",
    "args": {
      "checked_date": "2026-12-19",
      "plans": [
        {
          "provider": "Aussie Broadband",
          "plan_name": "NBN 500/50",
          "tier": "500",
          "intro_price": 79,
          "intro_months": 6,
          "ongoing_price": 99,
          "tes": "500 Mbps",
          "note": "优惠价需用码 SPRING25。"
        }
      ]
    }
  }'
```

说明：

- **不是全量覆盖**：录入按供应商 + 套餐名 + 档位匹配——命中的行更新价格，没见过的新套餐新增一行，**没放进 `plans` 数组的行保留原价和原核对日期**，不会被清空或覆盖。
- **匹配规则**：按供应商 + 套餐名 + 档位找到原行更新；如果供应商在官网改了套餐名，但品牌、档位和三个价格数字全一样，工具会自动归到原行，不会多出一行；完全新的套餐会新增一行。
- **没核到的套餐不用放进 `plans` 数组**：它们保留原价和原核对日期，页面上显示「没有更新」，不会用猜测的数字填充。
- **返回值**：`updated` 是价格变了的行数，`unchanged` 是价格没变或没核到的行数，`inserted` 是新增的行数，`checked_date` 是本次核对日期。

### 录入校验规则

`saveRefreshedPlans` 在写入之前会对整批数据一次性校验，任何一行不通过都返回 HTTP 400，**整批都不写入**（不会出现只写一半的情况）。错误返回是：

```json
{
  "error": "请求参数不合法",
  "issues": [
    { "path": "plans.3.tier", "message": "第 4 行 tier：档位必须是 25/50/100/250/500/750/1000/2000 其中之一" }
  ]
}
```

`path` 里的行号从 0 起（`plans.3` 就是第 4 个套餐），`message` 会写明是哪一行、哪个字段、什么问题。校验规则：

- **必填字段齐全**：每个套餐的 `provider`、`plan_name`、`tier`、`ongoing_price` 和整批的 `checked_date` 缺一不可；
- **档位**：`tier` 必须是 25 / 50 / 100 / 250 / 500 / 750 / 1000 / 2000 其中之一；
- **价格**：`intro_price`、`ongoing_price` 必须是数字且大于等于 0；
- **优惠月数**：`intro_months` 是大于等于 0 的整数；大于 0 时 `intro_price` 必须有值（有优惠期就必须有优惠价）；
- **核对日期**：`checked_date` 必须是真实存在的日期（`YYYY-MM-DD`，例如 2026-02-30 会被拒绝）；
- **数量**：`plans` 数组至少 1 个、最多 120 个套餐。

### 第 5 步：验证价格已更新

1. 刷新页面，顶部「上次检查」应变成你填的 `checked_date`。
2. 每个套餐旁的小圆图标：绿色 ↑ 是价格有更新，灰色 － 是没有更新；点开每个第一年总费用后面的「计算过程」，确认「优惠价 × 月数 + 优惠后价 × 剩余月数 = 第一年总费用」的等式算得对。
3. 价格历史图表上应多了一个当天的点；顶部推荐和每档最低价会按新价格重新算。

### 查不到怎么办

- **某个网站打不开、某个套餐查不到**：那一行不要放进 `plans` 数组，保留原价和原核对日期，不要猜数字填进去。
- **整批都查不了**（比如网络断了）：可以调 `markRefreshFailed` 记一次失败的检查，页面会把全部套餐标为更新失败，下次再核：

```bash
curl -X POST http://localhost:3000/actions \
  -H 'Content-Type: application/json' \
  -d '{"action": "markRefreshFailed", "args": {"reason": "WhistleOut 打不开"}}'
```

## 接口

服务同时提供前端页面和 `POST /actions`（请求体 `{ "action": "...", "args": {...} }`，返回 `{ "data": ... }`）：

| action | 说明 |
| --- | --- |
| `getState` | 全部套餐、价格历史、供应商目录、上次检查状态和已保存的当前套餐 |
| `seedPlans` | 补齐缺失的快照套餐/供应商行（幂等，已有行不覆盖），并清理重复行 |
| `saveCurrentPlan` | 保存当前套餐（`provider`、`tier`、`monthlyPrice`） |
| `clearCurrentPlan` | 清除已保存的当前套餐 |
| `refreshPrices` | 预留的自动核价触发接口：独立版无后台核价，始终返回未启动并提示手动更新方式（见下） |
| `saveRefreshedPlans` | 预留的自动核价结果录入接口：录入人工复核的价格（`checked_date` + `plans` 数组），按供应商 + 套餐名 + 档位匹配更新（不是全量覆盖，没录入的行保留原价），更新/新增套餐并记价格历史；录入前严格校验，不通过返回 400 且整批不写入（规则见「手动核价流程」第 4 步）；手动核价也走这个接口（流程见「手动核价流程」第 4 步） |
| `markRefreshFailed` | 记录一次失败的检查，把全部套餐标为更新失败 |

另外 `GET /health` 返回 `{ "ok": true }`。

### 自动核价预留接口

`refreshPrices` 和 `saveRefreshedPlans` 是预留给以后自动核价后台服务的对接点，接口定义、参数和返回结构完整保留，不能删：

- **`refreshPrices`**：请求 `{}`，返回 `{ "started": false, "message": "..." }`。以后接后台服务时，后台服务在这里启动核价任务：启动成功返回 `started: true`；独立版没有后台服务，始终返回 `started: false` 和手动更新指引，不改动任何已存数据。
- **`saveRefreshedPlans`**：请求 `{ "checked_date": "YYYY-MM-DD", "plans": [...] }`，返回 `{ "updated": 数字, "unchanged": 数字, "inserted": 数字, "checked_date": "YYYY-MM-DD" }`。后台服务核完价后调这个接口写入结果；每个套餐的字段定义见「手动核价流程」第 3 步（`provider`、`plan_name`、`tier`、`intro_price`、`intro_months`、`ongoing_price`、`tes`、`note`）。
- 页面上没有「立即刷新」按钮（刷新页面看更新后的数据）；`refreshPrices` 接口保留给以后接自动核价后台服务用，届时前端恢复调用即可，数据表结构不用改。

## 项目结构

```
client/            React 前端（src/App.tsx、api.ts，构建脚本 build.mjs）
server/src/        Bun 服务端
  index.ts         HTTP 入口：静态文件 + POST /actions
  actions.ts       全部 action 的定义（zod 校验 + 处理逻辑）
  db.ts            SQLite 连接、迁移与请求上下文
  schema.ts        drizzle 表结构
  seed.ts          2026-11-21 套餐快照（250 个套餐、151 家供应商、440 条价格历史）与 nbnco 供应商目录
  sdk.ts           本地垫片，替代原来 Muse 内部的 @hatch/space-sdk
drizzle/           SQL 迁移（0001–0004）
```

## 出处

本项目由一个 Muse 托管的 fullstack artifact 打包而来。为独立运行做的替换见 `server/src/sdk.ts`、`client/src/local-sdk.tsx`、`client/src/space-styles.css` 和 `server/src/index.ts` 的文件头注释：原来依赖的内部包 `@hatch/space-sdk`（只在 Muse 托管环境里提供，不在 npm 上）被本地实现取代——服务端是 `Bun.serve` + drizzle，客户端是直接 `fetch("/actions")` 的轻量 RPC 客户端；原版的后台自动核价（依赖 Muse 的代理）在独立版里不可用，改为手动录入。功能与界面其余部分保持不变。
