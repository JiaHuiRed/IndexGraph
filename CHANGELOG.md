# IndexGraph 更新日志

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
