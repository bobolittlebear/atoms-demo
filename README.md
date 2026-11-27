# Atoms Demo 工作台

输入一句自然语言需求，工作台会依次经过「判断 → 规划 → 生成 → 检查 → 预览」五个阶段，生成一个单页面、零外部依赖的 CRUD Web 应用。生成的应用可以直接在页面内操作，刷新或重启后数据仍在。进入预览后，还能继续提出增量修改，或把应用导出为可离线运行的压缩包。


---

## 核心功能

### 三栏工作台

| 栏 | 内容 |
|---|---|
| 左栏 | 会话列表：新建、切换、删除会话；状态点区分进行中、运行中、未运行、失败 |
| 中栏 | 五段阶段轨道 + 对话消息流 + 需求/修改输入框 |
| 右栏 | 「预览 · 代码 · 终端 · 记录」四个标签页 + 「导出」按钮 |

在宽度 ≥1280px 时显示完整三栏；768–1279px 时左栏收窄为图标栏；<768px 时纵向堆叠，会话改为下拉选择。

### 对话消息流（中栏）

- 用户消息、AI 回复、系统提示，以及追问、计划、生成任务、检查项、失败、修改中等阶段卡片，统一按时间顺序排列，新内容追加在最底部。
- 收到新内容时，对话栏自动滚动到底部（只滚动对话栏自身）。
- 每个停顿状态都有可点击的按钮继续推进，例如「确认计划」「继续 / 重新检查」「重启应用」。

### 五阶段主流程

1. **判断**：判断需求是否已明确数据对象。信息不足时只追问一次，最多给出 3 个候选回答，也可以自己补充一句。
2. **规划**：给出字段（名称、类型、是否必填、文本长度上限）、3 个文件的职责、4 条接口契约，以及补齐的默认值。计划可以不认可一次；第二次不认可时强制继续。
3. **生成**：逐个文件生成 `server.js`、`index.html`、`app.js`，界面实时显示每个文件的进度。
4. **检查**：
   - 形态检查：用 acorn 做语法检查，报错精确到文件和行号；单文件不超过 500 行；禁止引用外部依赖或外网资源；`server.js` 必须定义 `handle(req, store)`；`index.html` 必须引入 `app.js`；`app.js` 不得使用浏览器本地存储；页面不得引用已删除的字段。
   - 真实运行检查：启动一个独立的检查实例，使用检查专用数据，依次执行查（兼容缺字段的旧记录）、增（含重复提交去重）、查（全部字段读回）、改（全部字段）、换端口重启后再查（持久化、未声明的键保留）、删（含删除不存在的记录返回 404）、删后再查。
   - 检查不通过时，只重新生成出错的文件并重新检查，最多自动修复 3 次；仍失败则进入失败态，保留备份代码，并提供「重新检查」和「回退到备份版本并检查」。
5. **预览**：用新的实例启动应用，在右栏页面内操作；「重启」会更换端口号重新启动，数据保留。

### 右栏标签页

- **预览**：在页面内运行生成的应用，提供刷新、重启、重新检查、全屏。
- **代码**：查看并手动编辑三个文件，可「保存」或「保存并重新检查」（用于验证改坏文件后能否被检查发现并自动修复）。
- **终端**：实时的执行日志（生成、检查、实例启动与报错）。
- **记录**：四类过程记录——对话、计划、执行日志、摘要。没有内容时显示明确的占位文字；对话超过 12 条时自动生成摘要，也可以手动生成。

四个标签页常驻挂载，切换时只改变显示状态；每个标签页有独立的错误兜底，单个标签页出错不会导致整页白屏。

### 增量修改

应用处于预览阶段时，输入框会切换为「修改」：

- 系统先判断修改类型：增量修改、新应用（会提示并提供「新建会话」按钮）、字段类型变更（不支持，说明原因）、超出能力范围（如多页面、登录，直接拒绝）。只有增量修改会被执行。
- 增量修改会计算影响面，只重新生成受影响的文件；新增或删除字段时，至少会重新生成 `server.js` 和 `app.js`。
- 多次修改会累积到计划的 `changes` 中，后一次修改基于前一次的结果。
- 修改流程只改代码，不改写已有数据：旧记录缺少的字段显示为空值，已删除字段的取值仍保留在数据里，字段加回来后原值还在。
- 检查的探测内容跟随当前声明的全部字段，新增字段也会被实际写入并读回。
- 修复 3 次仍失败时，代码和计划回滚到修改前的版本并重新启动，数据不受影响。
- 修改进行期间，界面显示「修改中」提示。

### 导出

点击右栏的「导出」，下载 `<应用名>.zip`。解压后的目录 `atoms-app/` 包含：

| 文件 | 说明 |
|---|---|
| `server.js` / `index.html` / `app.js` | 生成的应用 |
| `run.js` | 独立启动器，只使用 Node.js 内置模块，负责提供静态文件、`/api/items` 接口，并把数据持久化到 `data.json`（原子替换写入） |
| `README.md` | 运行说明 |
| `data.json` | 导出时应用已有数据才会包含此文件；否则在首次写入时自动创建 |

运行方式（只需 Node.js 18 及以上版本，无需安装依赖、无需联网）：

```bash
cd atoms-app
node run.js            # 默认 http://127.0.0.1:3000/
PORT=8080 node run.js  # 指定端口
```

没有完整生成物时，「导出」按钮不可点击，不会生成空压缩包。

---

## 技术架构

```
浏览器（React 工作台）
 ├─ 状态机 useWorkbench：阶段流转、按会话加锁、修复/回滚、平台重启后的恢复
 ├─ 检查器 checker：形态检查 + 真实运行检查
 ├─ 运行时 runtime：每个应用实例运行在独立的 Web Worker 中
 │    └─ store.read / store.write ──► 后端实体 atoms_docs（按会话隔离）
 ├─ 预览 iframe（srcdoc）──postMessage 代理 fetch──► 对应的 Worker 实例
 └─ web-sdk ──► 后端（FastAPI）
                 ├─ /api/v1/agent/*：判断、规划、生成、修改判定、摘要（调用大模型）
                 └─ 实体表 atoms_sessions / atoms_docs
```

- **前端**：Vite + React + TypeScript + Tailwind CSS + shadcn/ui，通过 `@metagptx/web-sdk` 访问后端；语法检查使用 `acorn`，摘要渲染使用 `markdown-to-jsx`。
- **后端**：FastAPI + SQLAlchemy，路由自动发现；调用大模型使用 `openai` SDK。
- **数据**：
  - `atoms_sessions`：`sid`、`title`、`stage`，以及 `state`（JSON 字符串，保存计划、文件、检查项、消息、日志、修订备份等）。
  - `atoms_docs`：`sid`、`kind`、`name`、`content`；`kind=app-data` 存放生成应用的数据，`kind=check-data` 是检查专用数据，检查结束后清空。
- **隔离**：每个生成应用运行在独立的 Web Worker 中，Worker 内屏蔽 `fetch`、`XMLHttpRequest`、`WebSocket`、`importScripts`、`indexedDB` 等接口，只能通过 `store` 读写本会话的数据。这是**进程级隔离（防误伤），不是安全沙箱**。
- **资源上限**：应用需在 10 秒内就绪；单次请求超过 5 秒即终止实例；单次写入不得超过 1 MB。

### Agent 接口（`/api/v1/agent`）

| 接口 | 作用 |
|---|---|
| `POST /intent` | 判断需求信息是否足够，必要时给出追问与候选回答 |
| `POST /plan` | 生成或重新生成计划（字段、文件、接口、默认值） |
| `POST /generate` | 生成单个文件，支持修复上下文 `repair` 和增量修改说明 `change` |
| `POST /revise` | 判定修改类型与影响面 |
| `POST /summary` | 生成会话摘要 |

单次模型调用超过 90 秒会被中止；模型返回的 JSON 结构不合法时，会修正格式后重试一次。

---

## 目录结构

```
/workspace
├─ README.md
├─ DESIGN.md                     # 视觉规范
├─ attachments/                  # 需求规格与设计文档（主流程、迭代能力）
└─ app/
   ├─ start_app_v2.sh            # 本地一键启动脚本
   ├─ frontend/
   │  └─ src/
   │     ├─ pages/Index.tsx                      # 三栏工作台主页面
   │     ├─ hooks/useWorkbench.ts                # 状态机与全部用户操作
   │     ├─ components/workbench/
   │     │  ├─ ui.tsx                            # 按钮、卡片、阶段轨道、状态图标
   │     │  ├─ StageCards.tsx                    # 追问/计划/任务/检查/失败/修改中等卡片
   │     │  └─ RightPanel.tsx                    # 预览/代码/终端/记录 + 导出
   │     └─ lib/workbench/
   │        ├─ types.ts                          # 共享类型与参数
   │        ├─ api.ts                            # 会话、数据、Agent 接口封装与错误提示
   │        ├─ runtime.ts                        # Worker 实例、预览文档构建
   │        ├─ checker.ts                        # 形态检查与运行检查
   │        └─ exporter.ts                       # 打包 zip 与独立启动器
   └─ backend/
      ├─ routers/agent.py                        # Agent 路由
      ├─ services/agent.py                       # 提示词、模型调用、结果校验
      ├─ routers|services|models/atoms_sessions.py, atoms_docs.py   # 实体 CRUD
      ├─ requirements.txt / requirements.default
      └─ core/、main.py、lambda_handler.py       # 框架文件，请勿修改
```

---

## AI 调用说明

后端 `services/agent.py` 中的 `_backends()` 根据环境变量选择模型通道：

1. **已配置 `DEEPSEEK_API_KEY`**：直接调用 DeepSeek 官方接口（默认 `https://api.deepseek.com`，模型 `deepseek-chat`，单次最多输出 8192 个 token）。
2. **未配置**：回退到 Atoms AI 网关，先用 `claude-opus-5`，失败后改用 `deepseek-v4-pro`。

错误处理：

- 余额或额度不足：立即返回 402 和中文提示，不再重试。
- DeepSeek Key 无效：返回 401，提示到 Atoms Cloud > Keys 更新。
- 429、5xx、超时、连接错误等临时问题：按 1.5 秒、3 秒退避重试 2 次；仍失败时返回 503。
- 前端会把以上状态码显示为中文说明，用户可以点「继续」重试。

密钥只在后端运行时从环境变量读取，不会出现在前端代码里，也不会写入仓库。

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 否（推荐配置） | 无 | DeepSeek 官方 API Key。在 Atoms Cloud > Keys 中配置，不要写进源码或 `.env` |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | DeepSeek 接口地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | DeepSeek 模型名 |
| `APP_AI_BASE_URL` / `APP_AI_KEY` | 平台注入 | — | Atoms AI 网关配置，仅在未配置 DeepSeek Key 时使用 |

---

## 本地开发与构建

在 Atoms 平台内，预览服务会自动运行，并在文件变更后自动重新加载，无需手动启动。

在自己的机器上：

```bash
# 前后端一起启动
cd app
./start_app_v2.sh --local

# 前端检查与构建
cd app/frontend
pnpm i                                       # 只在缺少 node_modules 时执行
pnpm exec tsc -p tsconfig.app.json --noEmit  # 类型检查（vite build 本身不做类型检查）
pnpm run lint
pnpm run build                               # 输出到 dist/

# 后端语法检查
cd app/backend
python -m py_compile services/agent.py routers/agent.py
```

后端依赖同时写在 `requirements.txt` 和 `requirements.default` 中，新增依赖时请两份一起更新。

---

## 部署的环境准备

本项目通过 Atoms 平台的「发布」按钮部署。平台负责托管前后端、注入数据库连接等配置；下面列出发布前需要准备和确认的内容。

### 1. 运行环境与版本

项目配置里没有锁定 Node.js、pnpm 和 Python 的版本（`package.json` 中没有 `engines` / `packageManager` 字段，也没有 `.nvmrc`）。下表是当前开发环境的实测版本，可作为参考：

| 组件 | 开发环境实测版本 | 说明 |
|---|---|---|
| Node.js | 22.23.4 | 用于前端构建 |
| pnpm | 10.33.2 | 前端包管理器，锁文件为 `pnpm-lock.yaml`；启动脚本在 pnpm 不可用时会改用 npm |
| Python | 3.10.18 | 后端代码使用了 `X \| None` 类型写法，**需要 Python 3.10 及以上** |
| uv | — | `start_app_v2.sh` 用 `uv venv` / `uv pip install` 安装后端依赖（版本未锁定） |

导出包（`run.js`）只需要 Node.js，README 中写的是 18 及以上；建议使用 20 及以上版本（未在 Node 18 上实测）。

### 2. 依赖安装与构建

```bash
# 前端：安装依赖并做生产构建，产物在 app/frontend/dist/
cd app/frontend
pnpm install --frozen-lockfile
pnpm exec tsc -p tsconfig.app.json --noEmit
pnpm run lint
pnpm run build

# 后端：启动脚本的做法是先建虚拟环境，再依次安装两份依赖清单
cd app/backend
uv venv
uv pip install -r requirements.txt
uv pip install -r requirements.default
```

- 两份依赖清单内容基本一致（包含 FastAPI、SQLAlchemy、asyncpg、alembic、openai、Pillow 等），新增依赖时请同时更新两份。
- 平台发布时实际执行的安装和构建命令由平台决定，以上命令是本地自检方式。

### 3. 环境变量与密钥

| 变量 | 是否需要 | 来源 | 用途 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | 推荐（不配会回退到 Atoms AI） | Atoms Cloud > Keys | 后端直连 DeepSeek 调用大模型 |
| `DEEPSEEK_BASE_URL` | 可选 | Atoms Cloud > Keys 或环境变量 | DeepSeek 接口地址，默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 可选 | Atoms Cloud > Keys 或环境变量 | DeepSeek 模型名，默认 `deepseek-chat` |
| `DATABASE_URL` | 必需 | 平台注入 | 后端数据库连接；缺少时后端启动报错 |
| `APP_AI_BASE_URL` / `APP_AI_KEY` | 回退时需要 | 平台注入 | Atoms AI 网关，仅在未配置 `DEEPSEEK_API_KEY` 时使用 |

注意事项：

- 所有密钥只能在 Atoms Cloud > Keys 中配置，后端在运行时从环境变量读取。不要写进源码或 `.env`（`.env` 系列文件已列入 `.gitignore`），也不要放进前端代码。
- **生产环境也要配置 `DEEPSEEK_API_KEY`**。开发环境已配置并实测可用；生产环境是否已注入，当前**未确认**，请在发布前到 Keys 中核对。
- 如果密钥曾以明文出现在聊天等地方，请先到 DeepSeek 平台作废并重新生成，再更新到 Keys。

### 4. 后端服务与数据资源

- **后端服务**：FastAPI 应用，入口为 `app/backend/main.py`（部署入口 `lambda_handler.py`），路由从 `routers/` 自动发现。本项目的业务接口是 `/api/v1/agent/*` 和两个实体的 CRUD 接口。
- **数据库**：使用 PostgreSQL，业务表有两张：`atoms_sessions`（会话）和 `atoms_docs`（生成应用的数据与检查数据）。两张表已通过平台创建，迁移文件在 `app/backend/alembic/versions/`，本地部署需要手动建表`alembic upgrade head`。
- **鉴权**：业务接口没有接入登录鉴权（见「已知问题与限制」）。

### 5. 发布前检查清单

- [ ] `pnpm exec tsc -p tsconfig.app.json --noEmit`、`pnpm run lint`、`pnpm run build` 全部通过
- [ ] `python -m py_compile services/agent.py routers/agent.py` 通过
- [ ] `requirements.txt` 与 `requirements.default` 的依赖一致
- [ ] 源码中没有硬编码的密钥（可用 `rg "sk-[0-9a-f]{8,}" app` 检查，结果应为空）
- [ ] 没有修改 `app/backend/core/**`、`main.py`、`lambda_handler.py`、生成的 models 和 migrations，以及 `app/.mgx/config.yaml`
- [ ] 发布后打开线上地址，用「做一个任务清单，可以添加、完成、删除」走一遍五个阶段，确认能进入预览

---

## 已知问题与限制

- **隔离方式与规格不同**：生成应用运行在浏览器的 Web Worker 中，不是服务器子进程。界面显示的端口号是每个实例的逻辑标识，重启时会更换，但并不对应真实监听的端口。资源上限只有就绪 10 秒、单次请求 5 秒、单次写入 1 MB，没有内存和进程数量上限。
- **实例随浏览器页面存在**：关闭或刷新工作台页面后，正在运行的应用会停止（数据保留），此时会话显示为「未运行」，点「重启应用」即可恢复。
- **无鉴权**：会话与数据不区分用户，任何能访问工作台的人都能看到全部会话。
- **只支持单个数据对象的单页 CRUD**：不支持多页面、登录、上传、支付、字段类型变更、数据迁移，也不支持版本树和任意版本回滚（只能回到修改前）。
- **生成质量取决于模型**：同一需求两次生成的结果可能不同；系统只保证流程完整执行（检查一定运行、失败一定触发修复并给出原因）。
