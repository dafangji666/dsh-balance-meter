# dsh-balance-meter

在 DSH 输入框下方的状态行常驻一个 **DeepSeek 官方 API 余额**指示器：

```
● ¥ 46.13 ⟳
```

与「会话统计 / TOKEN 用量 / 上下文已用」同一行，并且排在**最后**。

## 显示规则

余额分成 **三档**，圆点、金额、卡片右上角状态文字都跟随同一档位变色：

| 档位 | 条件 | 颜色 | 文案 | 圆点动画周期 |
|---|---|---|---|---|
| 充足 | `余额 ≥ 快充值吧阈值` | 绿色 | `余额充足` | 2.4s |
| 提醒 | `要见底了阈值 ≤ 余额 < 快充值吧阈值` | 黄色 | `快充值吧` | 1.8s |
| 告急 | `余额 < 要见底了阈值` | 红色 | `要见底了` | 1.2s |
| 读取中 | 请求未返回 | 灰色 | `读取中` | 1.4s |
| 读取失败 | 请求出错 | 红色 | `读取失败` | — |

两档阈值恒定满足 `要见底了阈值 ≤ 快充值吧阈值`：保存时若填反，服务端会把
「快充值吧阈值」抬到与「要见底了阈值」相等，避免出现红色档永远无法触发。

| 元素 | 行为 |
|---|---|
| 圆点 | 按上表变色（呼吸动画）；读取中灰色；出错红色 |
| 金额 | `¥` 与数字间有一个空格；两位小数；提醒档变黄、告急档变红 |
| 刷新图标 | 点击实时请求官方接口刷新（点击时旋转） |
| 圆点 / 金额 | 点击弹出详情面板 |

颜色取自 DSH 主题变量：`--dsw-alias-state-success-primary`（绿）、
`--dsw-alias-state-warn-primary`（黄）、`--dsw-alias-state-error-primary`（红）。
注意变量族是 **`warn`** 而非 `warning`。

圆点直径 **6px**（`.bm-dot` 的 `width/height`），在状态行里只作为颜色提示。

金额与刷新图标同在一个 `gap:4px` 的 inline-flex 触发器中，二者之间**没有
分隔符**，以尽量少占状态行宽度。

刷新图标外层有 `.bm-iconHost`（14×14、`align-self:center` 的 inline-flex 盒），
图标本体 `display:block`，因此与同行其它元素**垂直居中对齐**，不会因
inline 基线下移而错位。

**只查询 DeepSeek 官方接口** `https://api.deepseek.com/user/balance`。
LevelUp / TKEN 等其它提供方一律不查询、不显示 —— 本插件显示的是
**DeepSeek 官方账户余额**，与当前会话使用哪个 provider 无关。

## 详情面板

点击金额，在上方弹出卡片（portal 渲染，点击外部关闭）：

| 区块 | 内容 |
|---|---|
| 头部 | 左侧 `余额详情 · DeepSeek 官方 API`，右侧状态文字（`余额充足` / `快充值吧` / `要见底了`），文字颜色跟随档位 |
| 余额 | 总余额大字（颜色跟随档位）、`总余额` 标签、`充值 ¥X · 赠送 ¥Y` |
| 更新时间 | `余额更新于 …` |
| 预警阈值 | 两行数字输入框：`快充值吧`、`要见底了`，各自可编辑，共用 `保存` 按钮 |
| 操作 | `去充值`（跳转官方控制台）、`立即刷新` |

## 自动同步

前端每 **5 分钟**（`POLL_MS = 300_000`）拉取一次余额；服务端另有
15 秒缓存，避免频繁打官方接口。阈值改动后档位/颜色会立即随响应更新。

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：解析 `DEEPSEEK_API_KEY` 凭据、请求官方余额接口、提供同源路由、持久化两档阈值并计算档位（另附余额采样，供 `state` 的 `usage` 字段使用） |
| `client.js` | 浏览器半侧：向 `conversation.composer.dock` 插槽注册状态行组件与详情卡片 |
| `cordis.patch.yml` | bundle patch：把插件行插入 profile |

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/balance-meter/state` | GET | 读取余额（服务端 15 秒缓存，避免频繁打官方接口） |
| `/balance-meter/refresh` | POST | 强制实时刷新（绕过缓存） |
| `/balance-meter/threshold` | POST | 保存两档阈值，body `{"warn": 数字, "low": 数字}` |

两档阈值都校验 0 ~ 1000000，任一非法时返回
`{"ok":false,"error":"阈值必须是 0 ~ 1000000 之间的数字"}`（不写入任何一档）。
成功响应用 `{"ok":true, "thresholds":{"warn":…,"low":…}, "level":"ok|warn|low"}` 回写。

为兼容旧版客户端，只传一个 `threshold` 时按「黄色 = 两倍、红色 = 原值」解释。

> `thresholds` 特意做成嵌套对象：旧版响应里有个同名的布尔字段 `low`
> （表示「余额是否低于阈值」），扁平写法会让布尔值覆盖数字阈值，
> 客户端读到 `Number(false) === 0`，红色档就永远无法触发。

## 持久化

两档阈值（以及 host 侧的余额采样/当日锚点）写入：

```
~/.dsh/storages/dsh-balance-meter.json
```

格式（原子写入：先写 `.tmp` 再 `rename`）：

```json
{ "warn": 10, "low": 5, "samples": [{ "at": 1790743246707, "total": 46.13 }], "anchor": { "date": "2026-09-30", "total": 46.13 } }
```

权威在**服务端**：两档阈值与 `level` 由 `index.js` 计算并下发，
浏览器只是展示与提交。

旧版只有单个 `threshold` 的状态文件会自动迁移：`low` 取原值、
`warn` 取原值的两倍，随后按新格式回写。

> 注：`state` 响应里仍带一个 `usage` 字段（余额变化采样：`spentToday` /
> `delta` / `sinceAt` / `samples`），由 host 侧余额采样得出。详情卡片**不展示**
> 任何用量信息 —— 官方 API 没有 token 用量/账单接口，而卡片只需呈现余额、
> 阈值与操作入口。该字段保留仅为兼容与调试。

## 关键实现细节

- **插槽**：状态行由 `@deepseek-ai/dsh-client-ui-chat` 的 `StatsPills` 注册在
  `conversation.composer.dock`（list 插槽，`id: "stats"`, `order: 0`）。
  本插件以 `id: "balance"`, `order: 100` 注册到同一插槽。

- **如何排到最后**：`conversation.composer.dock` 的插槽包装元素是
  `display: contents`，浏览器插槽项与「上下文已用」(`ContextMeter`) 因此处于
  同一个 flex 行。DOM 上的兄弟关系无法靠插槽 `order` 越过，所以组件自身的
  根元素带 `order: 9999`，由 flex 排序把整组推到该行末尾。
  实测视觉顺序（按 x 坐标）：会话统计 → 上下文已用 → **余额**。

- **客户端注册**：必须走 `ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register(...))`。
  直接 `register` 会抛 `slot "…" is not declared`。

- **凭据**：使用 `ctx.get('credentials')?.resolve('DEEPSEEK_API_KEY')`，
  与 DSH 其它插件一致；密钥不写入插件配置。

- **路由前缀**：`webServer.register` 的 `kind: 'prefix'` 路径**不能带尾斜杠**。
  `/balance-meter` 可匹配 `/balance-meter/state`；写成 `/balance-meter/`
  则完全匹配不到（实测 404）。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:dafangji666/dsh-balance-meter
```

或先克隆到本地，再以绝对路径安装：

```bash
git clone https://github.com/dafangji666/dsh-balance-meter.git /root/dsh-balance-meter
dsh plugin --profile web add link:/root/dsh-balance-meter
```

插件以 `link:` 方式安装时，配置位于用户目录，升级 DSH 后一般无需重做。
若 DSH 之后更换配置系统，检查 `~/.dsh/profiles/web/package.json` 的
`dsh.profile.bundles` 是否仍包含 `dsh-balance-meter`。

### 生效范围

- **浏览器半侧（`client.js`）**：改完后刷新页面即生效，无需重启，
  客户端 bundle 每次请求都从磁盘重新读取（URL 带 `rev` 指纹）。
- **Host 半侧（`index.js`）**：Node 会缓存已导入的 ESM 模块，**仅重启服务**
  或让 `dsh-hmr` 覆盖到该模块才会重新导入。本插件开发时验证过的做法是在
  profile patch 里**覆盖** `dsh-base` 已有的 `hmr` 条目（`dsh-base` 已把
  `@deepseek-ai/dsh-hmr` 注册为 `id: hmr`、`root: []`），加上 watch root：

  ```yaml
  - id: hmr
    name: "@deepseek-ai/dsh-hmr"
    config:
      root:
        - /root/dsh-balance-meter
  ```

  把 `/root/dsh-balance-meter` 换成你实际的插件目录。
  必须复用 `id: hmr`：另起一个 id 会再挂一个实例，watch 不会生效。
  `dsh.profile.patchReload` 为 `live`，改完 patch 文件即自动重载配置，
  之后 `touch` 插件目录里的文件即可让宿主重新导入模块。
  **验证完记得删掉该条目并还原 profile patch。**

  注意：`systemctl restart dsh-web.service` 会连带结束运行在该服务
  cgroup 内的会话进程，请在服务外部执行重启。

## 可调参数

| 参数 | 位置 | 默认值 |
|---|---|---|
| 快充值吧阈值（黄） | 详情面板输入框（持久化到服务端） | `10`（元，`DEFAULT_WARN_THRESHOLD`） |
| 要见底了阈值（红） | 详情面板输入框（持久化到服务端） | `5`（元，`DEFAULT_LOW_THRESHOLD`） |
| 阈值上限 / 下限 | `index.js` 的 `MAX_THRESHOLD` / `MIN_THRESHOLD` | `1000000` / `0` |
| 服务端缓存 | `index.js` 的 `CACHE_MS` | `15000`（毫秒） |
| 前端轮询 | `client.js` 的 `POLL_MS` | `300000`（毫秒，即 5 分钟） |
| 用量样本上限 | `index.js` 的 `MAX_SAMPLES` | `720`（条） |
| 去充值地址 | `client.js` 的 `TOPUP_URL` | `https://platform.deepseek.com/top_up` |
