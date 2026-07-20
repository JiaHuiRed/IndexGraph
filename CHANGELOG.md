# IndexGraph 更新日志

## 0.0.4（2026-07-20）

### 🐛 修复

- **中文自然语言查询几乎拿不到任何 token** — 在 `SystemManager` 上实际用 `indexgraph_explore` 复盘时发现：`explore()` 用 `query.split(/\W+/)` 分词，JS 正则的 `\W` 只认 `[A-Za-z0-9_]` 是"单词字符"，连续的中文字符整段被当成分隔符，直接丢光。实测查询 `"高新收入辅助账汇总tab分页怎么做的"` 分词结果是 `["tab"]`——中文部分一个字都没留下。改为专门识别 CJK 字符游程（`\u{3400}-\u{9fff}`），整段游程保留为一个 token（短关键词查询够用，如"高新收入辅助账"），同时因为中文自然语言问句里"如何""在""里""做"这类虚词会跟实词粘在一起、整段游程当一个token又会因为太长匹配不到任何代码原文，额外生成有重叠的二字 bigram（如"高新收入"→"高新"/"新收"/"收入"）作为补充信号，参与打分时权重调低（0.34 vs 整词的 1），避免噪声bigram盖过精确匹配。改于 `lib/query.js`。
- **符号名部分命中时，正文文本打分被跳过** — `explore()` 原逻辑：只有当符号名一个词都没匹配上（`score===0`）时才去扫正文文本加分；名字里哪怕只沾上一个词的边（比如 `vIncomeLedger` 的名字里包含 "incomeledger"）就直接跳过正文扫描，导致它拿不到本该属于它的、正文里那些精确匹配的分数，反而被名字完全不相关、但正文里凑巧撞上几个常见词（"summary"/"total"/"row" 这类几乎每个列表渲染函数都有的词）的其它符号反超。实测查询 `"how does the incomeledger summary tab pagination and total row work"`，`vIncomeLedger` 完全没进前5，被 `vPersonnel`/`vSalary`/`vProcesses`/`vMaterials`/`vProjects` 挤掉。改为正文文本打分总是执行，不再看名字匹配与否；为避免每个符号都重新读一遍所在文件（尤其像 `SystemManager` 这种几百个符号全挤在一个 3000+ 行文件里的项目），加了单次 `explore()` 调用范围内的按文件缓存（不跨调用缓存，仍然保证每次查询读到的是当前磁盘内容）。顺手加了一小撮英文虚词停用词表（how/does/the/and/…），避免这类零信号词无谓拉低精度。改于 `lib/query.js`。

### 🧪 验证

- 在 `SystemManager` 上用真实数据对照修复前后：
  - 中文自然语言问句 `"如何在高新收入辅助账汇总tab里做分页和合计"`：修复前返回的5个结果（`_salTabsHtml`/`_bindSalTabs`/`_matTabsHtml`等）跟高新收入辅助账毫无关系，纯粹是"tab"这一个survive下来的词凑出来的；修复后 `_ilTabsHtml`/`vIncomeLedger` 排第1、2位。
  - 英文自然语言问句同上场景：修复前 `vIncomeLedger` 完全不在前5；修复后排第1。
  - 精确符号名查询（`vIncomeLedger`、`_findOrCreateProduct`）：修复前后结果一致，确认没有回归。
  - 短中文关键词查询 `"高新收入辅助账 汇总"`：前5命中全部跟查询主题相关（`vProducts`/`_syncProductsFromLedger`/`vIncomeLedger`/`editIncomeLedger`/`_ilTabsHtml`），`vProducts` 排第1是因为它的按钮提示文案里原文写了"高新收入辅助账"，不算跑偏。
- **注意**：`mcp-server.js` 在进程启动时 `require('./lib/query')` 一次，是长驻进程，修改 `lib/query.js` 后需要重启 MCP server 才会在实际调用的 `indexgraph_explore` 工具里生效（CLI `indexgraph explore` 每次是新进程，不受影响，已直接验证）。

## 0.0.3（2026-07-15）

### ✨ 新增

- **索引过期自动重建** — 在 `SystemManager` 上实测踩到的问题：索引建好后项目代码接着被大量修改，符号的行号在索引里没变，但文件里对应位置早就是别的内容了，`indexgraph node`/`explore` 会读出行号对得上但内容驴唇不对马嘴的结果，而且不报错，不容易发现。新增 `isStale()`（按每个已索引文件的 mtime 比对，检测文件改动/删除/新增）和 `ensureFresh()`（发现过期就透明地整体重建一次，索引方式跟 `init` 一致），CLI 和 MCP server 两条路径都接入，查询前自动确保新鲜，不用再记得手动 `indexgraph init`。改于 `lib/index-store.js`、`bin/indexgraph.js`、`mcp-server.js`。
- 顺手修了 `buildIndex()` 里 `builtAt` 字段一直是 `null` 从没赋值的问题。

### 🧪 验证

- 在 `SystemManager`（一个已知过期的索引，`vSalary` 等函数是索引建好后才加的）上实测：`indexgraph node vSalary` 先打印 `[indexgraph] index was stale, rebuilt automatically`，然后返回正确的当前源码；紧接着再查一次，不再触发重建（无提示、耗时对照持平在 0.2~0.3s），确认"改了才重建、没改不重建"符合预期。

## 0.0.2（2026-07-14）

### 🐛 修复

- **`explore` 结果超过 MCP 工具输出上限报错** — 在 `SystemManager`（`index.html` 内嵌了一份压缩版 SheetJS，单行超过 3 万字符）上测试时，一次 `explore` 查询返回了 28 万字符直接报错。原因是每个命中符号的源码没有任何长度上限。新增每符号 4000 字符截断（超出部分提示"用 `indexgraph_node` 看完整版"），`explore` 默认返回条数从 8 降到 5。改于 `lib/query.js`。

## 0.0.1（2026-07-14）

### ✨ 新增

- **首个可用版本** — CodeGraph 不支持 `.html` 文件，而这批项目（`dossier`、`SystemManager`）的前端逻辑全部写在单个 `.html` 文件内联的 `<script>` 里，等于完全没有索引覆盖。IndexGraph 专门补这块：提取内联 `<script>`、用 acorn 解析函数声明/箭头函数赋值、记录调用关系图，行号映射回原始 `.html` 文件（不是提取后的偏移量）。新增 `lib/extract.js`、`lib/parse.js`、`lib/index-store.js`、`lib/query.js`。
- **CLI** — `indexgraph init [路径]` / `files` / `node <name>` / `explore "<query>"` / `version`。新增 `bin/indexgraph.js`。
- **MCP server** — 用官方 `@modelcontextprotocol/sdk` 实现 `indexgraph_node`、`indexgraph_explore` 两个工具，stdio 方式接入 Claude Code 等 agent。新增 `mcp-server.js`。

### 🧪 验证

- 在 `dossier` 项目的 `templates/index.html`（203KB，单文件）上实测：索引出 152 个符号、207 条调用边；`indexgraph node makeEntityCombo` 精确返回函数源码 + 4 个调用者 + 5 个被调用符号；`indexgraph explore "attachment slot rendering account_stmt"` 前 6/8 命中都是真正相关的函数（`renderTable` 排第一），明显优于同等自然语言问题在 CodeGraph 上的表现。
