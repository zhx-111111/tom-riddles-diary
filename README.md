# Tom Riddle's Diary（Web 版）

> Write on the page with your finger or pen. The diary **drinks your ink** — your
> words fade into the paper — the page thinks for a moment, and an answer writes
> itself back in a flowing hand, sentence by sentence.

本项目是 [MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（reMarkable
Paper Pro 墨水屏上的"汤姆·里德尔日记"，MIT 协议）的 **Cloudflare Workers 网页版**：
试玩地址：https://riddle.zh666.de5.net/

保留了原项目的核心玩法与回答处理逻辑（persona 提示词、记忆协议、逐句流式解析、
⁂ 誊写后记、⟦show:N⟧ 召唤指令、"喝掉墨迹"的溶解动画、写大问号呼出指南等全部
按原实现移植），把鹅毛笔换成了手指 / 触控笔 / 鼠标，把墨水屏换成了多种主题信纸。

- 前台日记界面为**纯英文**，名为 *Tom Riddle's Diary*；
- 后台管理页位于 `/admin`（**前台无任何入口**），密码登录，**中文界面**；
- 所有环境变量均已预设默认值，部署即可运行（只需填 API Key）。

---

## ✨ 功能一览

| 功能 | 说明 |
| --- | --- |
| 手写输入 | 手指 / 触控笔 / 鼠标书写，压感 + 速度调制笔宽，平滑曲线抗锯齿，支持触屏笔 |
| 日记喝墨 | 停笔 2.8 秒（可调）后提交页面，墨迹以哈希抖动方式"被喝掉"（移植原 `dissolve_pass`） |
| AI 回答 | 页面截图发给视觉模型，回答**逐句流式**返回，以 Dancing Script 手写体逐字写出（与原项目一致） |
| 记忆系统 | KV 保存每个会话的笔迹 + 誊写 + 回答；近期对话随请求携带；写 "show me what I wrote about…" 可召唤旧页面（你的笔迹以褪色墨色重新书写） |
| 多模型容错 | 主模型 `agnes-2.5-flash`（.cn 免费接口）；全部 Key 失败自动降级备用 `glm-4.6v-flash`（智谱免费视觉模型）；主模型读不了图时，备用模型先誊写笔迹再由主模型作答 |
| 多 Key 轮转 | Key 在 CF 控制台变量中用英文逗号分隔，轮转调用规避 429 限流 |
| 主题信纸 | 内置 **Midnight Ink（纯黑信纸 + 米白笔迹）**、**Marauder's Map（活点地图）**、**Aged Letter（复古做旧黄 + 黑偏褐笔迹）**；管理页可自定义任意信纸 / 笔迹颜色 |
| 全屏 / 横屏 | Apple 风格毛玻璃按钮；横屏可跟随系统、也可强制横屏（支持横屏 + 全屏叠加）；书写时按钮自动降为 20% 透明度并增强毛玻璃 |
| 深色模式 | 无独立开关，自动跟随系统稍变暗 |
| 手写指南 | 在纸上写一个大问号 **?**，呼出内置指南（移植原手势识别几何算法） |
| 擦除 | 双指触摸 = 橡皮；也可用左上角橡皮按钮 |
| 无思考过程 | 输出已关闭 thinking / reasoning，日记里只出现回答本身 |
| 多端适配 | PC / 手机 / 平板；iOS Safari、Android Chrome、微信内置浏览器等 |

---

## 🗒 更新记录（v2）

- 管理后台新增「单次输出长度」参数（`maxReplyChars`，按字符限制单页回答）；
- 前台与后台背景改为多彩液态玻璃风格：浅蓝、浅紫、紫罗兰、靛蓝、葱绿、鹅黄、浅粉、浅玫瑰红、天青色柔和渐变，每次打开随机流动；
- 模型书写回答时，前台所有按钮同样降为 20% 透明度（与用户书写时一致）；
- 信纸样式不再随系统深色模式变化（移除整体变暗滤镜）；
- Marauder's Map 主题加深复古棕黄色调（图案不变）；
- 手写输入流畅度与压感增强（更宽的压感响应曲线 + 笔宽缓动）；
- 新增应用图标（蓝紫渐变圆角方块 + 白色描边打开的书与羽毛笔），页面顶部居中展示，并作为添加到主屏幕的图标（apple-touch-icon + PWA manifest）。

---

## 🤖 模型配置（两个都是免费模型）

| 角色 | 模型 | Base URL | 文档 |
| --- | --- | --- | --- |
| 主模型（对话） | `agnes-2.5-flash` | `https://apihub.agnes-ai.cn/v1` | Agnes AI 官方文档（OpenAI 兼容协议，不限期免费） |
| 备用模型（视觉理解 / 誊写） | `glm-4.6v-flash` | `https://open.bigmodel.cn/api/paas/v4` | 智谱 BigModel 免费视觉模型 |

- 两个接口均为 **OpenAI 兼容 `/chat/completions`** 协议；
- Key 获取：Agnes → `platform.agnes-ai.cn` 控制台创建；智谱 → `open.bigmodel.cn` 控制台创建（`glm-4.6v-flash` 免费，需实名）；
- **多 Key**：在 CF 控制台对应变量里用英文逗号分隔，例如 `sk-aaa,sk-bbb,sk-ccc`，程序按轮转计数器分发请求，遇到 429 / 5xx / 无效 Key 自动换下一把；
- 已针对两个模型分别关闭思考输出（Agnes：`chat_template_kwargs.enable_thinking=false`；智谱：`thinking.type=disabled`），并过滤流式返回中的 reasoning 片段。

---

## 🚀 部署（Cloudflare Workers）

仓库为标准 GitHub 结构，两种方式任选。

### 方式一：CF 控制台关联 GitHub 仓库（推荐，推送即部署）

1. 将本仓库上传到你的 GitHub；
2. 打开 Cloudflare Dashboard → **Workers & Pages** → **Create Worker** → 选择 **Connect to Git**（Workers Builds），选中本仓库；
3. 构建设置保持默认（框架选择 `Workers`，构建命令可为 `npm install`，部署命令 `npx wrangler deploy`）；
4. 首次部署成功后，进入 Worker → **Settings → Variables and Secrets**，填入你的 API Key：
   - `AGNES_API_KEYS`：`sk-xxx`（多个用 `,` 分隔）
   - `ZHIPU_API_KEYS`：`xxx`（多个用 `,` 分隔）
   - 其余变量已有默认值，可按需修改；
5. **绑定 KV**：先创建一个 KV Namespace（例如 `diary-kv`），然后在 Worker → **Settings → Bindings → Add → KV Namespace**，变量名必须填 **`DIARY_KV`**。
   > 不绑定 KV 也能聊天，但记忆、历史轮数、管理页配置保存会不可用。
6. （可选）**Custom Domains** 绑定自己的域名，访问 `https://你的域名/admin` 进管理页。

### 方式二：wrangler CLI

```bash
git clone <你的仓库地址>
cd tom-riddles-diary
npm install
npx wrangler login
npx wrangler deploy
```

之后同样在 CF 控制台填 Key、绑定 KV（变量名 `DIARY_KV`）。

---

## 🔧 环境变量（全部已预设默认值）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `AGNES_API_KEYS` | 空 | 主模型 Key，多个用英文逗号分隔（**部署后必填**） |
| `AGNES_BASE_URL` | `https://apihub.agnes-ai.cn/v1` | 主模型接口（.cn 国内节点；备用地址 `https://api.agnes-ai.cn/v1`） |
| `AGNES_MODEL` | `agnes-2.5-flash` | 主模型名 |
| `ZHIPU_API_KEYS` | 空 | 备用视觉模型 Key，多个用英文逗号分隔（**部署后必填**） |
| `ZHIPU_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | 智谱接口 |
| `ZHIPU_MODEL` | `glm-4.6v-flash` | 备用视觉模型名 |
| `ADMIN_PASSWORD` | `tomriddle1943` | `/admin` 管理页登录密码（**建议修改**） |
| `TZ_OFFSET` | `8` | 时区偏移（小时），用于记忆日期的读法 |

**KV 绑定**：`DIARY_KV`（部署后在控制台绑定，见上文）。

---

## 🗝 管理后台（/admin）

前台日记不出现任何管理入口。访问 `https://你的域名/admin`，用 `ADMIN_PASSWORD` 登录（默认 `tomriddle1943`）。可修改的参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 回复书写速度 | 55 ms/字符 | Tom 手写回答的快慢 |
| 笔迹粗细 | 1.0（0.5–2.0） | 同时作用于你的笔迹与回答字重 |
| 停笔提交等待 | 2800 ms | 停笔多久后日记"喝掉"墨迹并提交 |
| 回复最大长度 | 2000 tokens | 防失控护栏（与原项目一致） |
| 单次输出长度 | 600 字符 | Tom 单页最多写多少字，超出按句截断并以省略号收尾 |
| 保留历史对话轮数 | 6 | 随每次请求带给模型的近期页数（原项目默认 6） |
| 记忆目录条数 | 10 | "show me…" 召唤用的记忆目录大小 |
| 最多记住的页数 | 400 | 超出则遗忘最旧页（与原项目一致） |
| 自定义主题 | — | 名称 + 信纸颜色 + 笔迹颜色，最多 12 个 |
| 清空所有记忆 | — | 删除 KV 中全部会话记忆 |

配置保存在 KV 的 `config` 键中，前台刷新后生效。

---

## 📖 玩法（前台为英文，此处翻译说明）

1. **写，然后停笔** —— 日记喝掉你的墨迹，Tom 以手写体回答；
2. **日记会记住** —— 写 `show me what I wrote about…`，旧页面会从纸里浮现：日期、你自己褪色的笔迹、Tom 当年的回答；触摸纸面返回今天；
3. **双指触摸**（或左上角橡皮）擦除；
4. 写一个大大的 **?** 呼出指南。

---

## 🏗 项目结构

```
├── wrangler.jsonc          # Worker 配置：assets + 预设环境变量
├── package.json
├── src/
│   ├── index.js            # Worker 路由 / 聊天编排 / KV 记忆 / 管理鉴权
│   ├── ai.js               # 双模型调用、多 Key 轮转、SSE 读取、降级链
│   ├── parser.js           # StreamParser 移植（逐句切分 / ⟦show:N⟧ / ⁂ 后记）
│   ├── prompts.js          # PERSONA + MEMORY_PROTOCOL（原项目逐字移植）
│   └── config.js           # 默认参数、主题、日期读法（spoken_date 移植）
├── public/
│   ├── index.html          # 日记前台（纯英文）
│   ├── admin.html          # 管理后台（中文，密码登录）
│   ├── css/                # diary.css（毛玻璃 / 信纸主题） + admin.css
│   ├── js/
│   │   ├── diary.js        # 主控制：提交、流式接收、全屏 / 横屏、主题
│   │   ├── inkpad.js       # 手写引擎：平滑笔迹、擦除、溶解、PNG 导出、? 检测
│   │   ├── hand.js         # 回答手写动画（Dancing Script 逐字书写）
│   │   └── admin.js        # 管理后台逻辑
│   └── fonts/DancingScript.ttf   # 原项目同款回答字体（SIL OFL 1.1）
├── README.md
├── LICENSE                 # MIT（含原项目署名）
└── .gitignore
```

---

## ⚙️ 与原项目的对应关系

| 原项目（Rust / reMarkable） | 本项目（Web / Cloudflare Workers） |
| --- | --- |
| `oracle.rs` PERSONA / MEMORY_PROTOCOL | `src/prompts.js` 逐字保留 |
| `oracle.rs` StreamParser（句子流 / ⟦show:N⟧ / ⁂） | `src/parser.js` 完整移植 |
| 每页 PNG（≤800px）发给视觉模型 | Canvas 导出同款 PNG（`inkpad.exportPNG`） |
| `memory.rs` 记忆 / 目录 / spoken_date | KV `s:<session>` + `src/config.js` |
| `ink.rs` dissolve_pass（哈希抖动溶解） | `inkpad.dissolve`（同款 px_hash） |
| `help.rs` 大问号手势 | `inkpad.looksLikeQuestionMark`（阈值按纸面缩放） |
| Dancing Script 骨架化笔画回放 | Dancing Script 逐字墨水动画（浏览器端等效呈现） |
| `RIDDLE_MEMORY_TURNS=6`、`MAX_TOKENS=2000`、2.8s 停笔 | 同名默认值，管理页可调 |

---

## ❓ 常见问题

- **部署后日记"沉默"？** 先检查 `AGNES_API_KEYS` 是否已填；再看 `ZHIPU_API_KEYS`（降级依赖它）。错误原因会以 Tom 的手写体写在纸上（如 `http 429` = 限流，稍候或多配几个 Key）。
- **微信内置浏览器**：全屏 API 不可用时自动退化为 CSS 全屏，其余功能正常。
- **iOS Safari**：不支持元素级全屏 API，使用 CSS 全屏兜底；横屏锁定不可用时用旋转布局兜底。
- **修改了管理页配置不生效？** 前台刷新页面即可；配置存储依赖 KV，未绑定 KV 时保存会提示。
- **Agnes 限流？** 免费层有 RPM 限制，多配几个 Key 轮转即可；仍被限流时程序会自动切 Key 并降级到智谱。

---

## 🕯 致谢与许可

- 原项目：[MaximeRivest/riddle](https://github.com/MaximeRivest/riddle)（MIT），本项目复用其提示词、解析器与多处算法实现，并在 `LICENSE` 中署名；
- 回答字体：[Dancing Script](https://github.com/googlefonts/DancingScript)（SIL OFL 1.1，见 `public/fonts/OFL.txt`）；
- 本项目整体以 MIT 协议发布。

*"I open at the close."*
