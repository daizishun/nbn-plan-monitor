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

- **套餐数据来源**：内置快照是 2026-11-19 的研究数据，价格逐项核对自 WhistleOut 价目表、Finder 最便宜 NBN 套餐表、Superloop 等供应商官网/CIS 文件，以及 nbnco 供应商目录（约 140 家，见页面底部的供应商目录）。每个套餐下方都标注了来源和核对日期；长期价一律按第一年 12 个月的平均月费计算，签约前请以供应商 CIS 为准。
- **本地数据库**：首次启动自动建空库，打开页面时 `seedPlans` 会把上述快照写入库中（已有的行不会被覆盖）。数据库文件只存在你自己的机器上。
- **当前套餐**：默认是空的，需要你自己在页面上输入供应商、速度档位和每月月费，推荐和省钱计算才会出现；也可以随时清除。
- **没有自动刷新**：原版在 Muse 托管环境里靠后台代理每天自动核价；独立运行版没有这个代理，点「立即刷新」会提示手动更新方式——自行核对 WhistleOut、Finder 或供应商官网后，通过 `POST /actions` 的 `saveRefreshedPlans` 接口录入复核结果（`markRefreshFailed` 用于记录一次失败的检查）。NBN 没有公开的价格数据接口，核对不到的套餐会保留原价和原核对日期，不会用猜测的数字填充。

## 接口

服务同时提供前端页面和 `POST /actions`（请求体 `{ "action": "...", "args": {...} }`，返回 `{ "data": ... }`）：

| action | 说明 |
| --- | --- |
| `getState` | 全部套餐、价格历史、供应商目录、上次检查状态和已保存的当前套餐 |
| `seedPlans` | 补齐缺失的快照套餐/供应商行（幂等，已有行不覆盖），并清理重复行 |
| `saveCurrentPlan` | 保存当前套餐（`provider`、`tier`、`monthlyPrice`） |
| `clearCurrentPlan` | 清除已保存的当前套餐 |
| `refreshPrices` | 独立版无后台核价，始终返回未启动并提示手动更新方式 |
| `saveRefreshedPlans` | 录入人工复核的价格（`checked_date` + `plans` 数组），更新/新增套餐并记价格历史 |
| `markRefreshFailed` | 记录一次失败的检查，把全部套餐标为更新失败 |

另外 `GET /health` 返回 `{ "ok": true }`。

## 项目结构

```
client/            React 前端（src/App.tsx、api.ts，构建脚本 build.mjs）
server/src/        Bun 服务端
  index.ts         HTTP 入口：静态文件 + POST /actions
  actions.ts       全部 action 的定义（zod 校验 + 处理逻辑）
  db.ts            SQLite 连接、迁移与请求上下文
  schema.ts        drizzle 表结构
  seed.ts          2026-11-19 套餐快照与 nbnco 供应商目录
  sdk.ts           本地垫片，替代原来 Muse 内部的 @hatch/space-sdk
drizzle/           SQL 迁移（0001–0004）
```

## 出处

本项目由一个 Muse 托管的 fullstack artifact 打包而来。为独立运行做的替换见 `server/src/sdk.ts`、`client/src/local-sdk.tsx`、`client/src/space-styles.css` 和 `server/src/index.ts` 的文件头注释：原来依赖的内部包 `@hatch/space-sdk`（只在 Muse 托管环境里提供，不在 npm 上）被本地实现取代——服务端是 `Bun.serve` + drizzle，客户端是直接 `fetch("/actions")` 的轻量 RPC 客户端；原版的后台自动核价（依赖 Muse 的代理）在独立版里不可用，改为手动录入。功能与界面其余部分保持不变。
