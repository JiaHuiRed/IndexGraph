# IndexGraph 更新日志

## 0.0.10（2026-10-27）

> 性能批次 + 一处入口修复。查询热路径重构为「一次 O(符号+边) 遍历建派生查找表 + 后续全部查表」，顺带修掉 MCP `file` 参数的相对路径解析 bug。行为不变（输出形状、行号、打分、截断策略全部原样），只换内部数据访问方式。流程同样先量后改：CPU 剖面定位热点 → 基准对照 → 回归固定。

### 🐛 修复

- **`indexgraph_node` 的 `file` 过滤器：相对路径按 cwd 解析而不是 index root** — 工具文档写的是 "relative to project root, or absolute"，实现却 `path.resolve(opts.file)`（按进程 cwd）。MCP 调用方传 `projectPath` 指向被查询项目、自身 cwd 在别处时，相对路径参数被静默清空，报 "Symbol not found"（已实测复现：cwd 切换后返回 NULL）。修为按 `index.root` 解析，CLI 路径（root 即 cwd）行为不变。补 T08e 回归。

### ⚡ 性能

- **查询热路径：派生查找表取代逐符号全表扫边** — 原来每次「谁调用了 X」都遍历全部文件的边列表（每符号每查询 O(总边数)）；`explore` 的调用图传播对候选池每个符号都来这么一遍，CSS 重查询（几千个候选）直接劣化成「候选数 × 总边数」次迭代——CPU 剖面里 **91.8% 的时间烧在 `calleesOf`**（200 HTML + 6000 规则夹具，explore CSS 查询 614ms）。现在一次 O(符号+边) 遍历建出 `byName / byId / callersById / calleesById` 四张表，之后全部查表；表按 index 对象身份进 WeakMap 缓存（配合下条的不可变约束，无失效协议也正确）。同一夹具：explore CSS 查询 **614 → 34ms**，`node` depth=1 **3.5 → 0.1ms**、depth=3 **6.8 → 0.1ms**；冷构建持平（~350ms）。
- **MCP 热路径：index.json 按 mtime+size 缓存已解析结果** — MCP 是长驻进程，每次工具调用都全量 JSON.parse 一遍索引（9200 符号时 ~30ms，随索引体积线性涨）。改为按文件 stat 缓存的解析结果：任何写入（本进程或其它进程，如并发 CLI `init`）都会改变 stat 强制重读；`saveIndex` 成功后即丢弃缓存条目，变异后的索引对象不会挂在过时 stat 上。热查询 **32.6 → 10.6ms**（剩余是 scanDiff 的只 stat 遍历）。
- **CSS 行号：逐规则 slice+scan（O(n²)）改预计算换行偏移 + 二分（O(n)）** — 旧 `lineOf` 对每条规则都把文本切一刀数换行，大样式表冷构建全额支付。6000 规则单量行号计算 ~40ms → 新算法全量解析（含切分/别名）12.3ms；规则数再涨差距按平方拉大。
- **HTML 文件每文件只读一遍** — `extractScripts`/`extractStyles` 原先各读一次盘，`parseFileEntry` 改为读一次、内容级接口 `extractScriptsFrom`/`extractStylesFrom` 分发给两路（路径级接口保留，行为不变）。
- **跨文件未解析调用的回退：线性 `find` 改名字 Map** — `parseBlock` 里块内找不到目标时的兜底从 `symbols.find` 改为预建的首现名字表，O(调用×符号) → O(调用)。

### 🔒 内部约束（性能正确性的前提）

- **ensureFresh 增量更新改为浅拷贝后变更** — `lib/query` 的派生表按 index 对象身份缓存，因此「loadIndex 返回的对象不可变」成为硬约束：`ensureFresh` 发现 diff 时先 `{...index, files: {...index.files}}` 再改（files 条目本就是整体替换、从不就地编辑），任何持有旧对象的一方（解析缓存、已建派生表）看到的数据永远自洽。T10c 固定这条约束：增量更新后查询必须反映新调用边，不能吐旧边。

### 🧪 验证

- 前后基准对照（200 HTML + 6000 规则合成夹具，9200 符号 / 18200 边）：见上各条；冷构建持平、`ensureFresh` 热路径 3.1x。
- CSS 行号新旧算法等价对拍：400 规则混合夹具（跨行注释、多行选择器、`@media`/`@supports` 嵌套、`@keyframes`、`@import`）426 个符号 **0 偏差**。
- T10 新增 4 例：规模正确性 + 时间护栏（400 HTML + 8000 规则，冷 explore 309ms；旧算法同规模模拟 **20520ms**，2000ms 阈值经双向验证能抓住退化）、解析缓存被外部重写后的重读、增量更新后派生表失效、生成样式表的逐行行号断言。
- `npm test`：**43/43 通过**（0.0.9 的 39 + 本轮 4）。

## 0.0.9（2026-10-10）

> 对 0.0.8（d2beb63）的第三方跟进审计定向修复：三项均为「入口接线与异常隔离」回退，不动 0.0.8 主体设计。流程遵循审计要求：先补失败夹具记录红灯 → 最小修改 → 定向+全量回归。

### 🛡️ 可靠性

- **损坏索引不再被误判成“未初始化”（IG08-F01，P2）** — 0.0.8 给 `loadIndex()` 加了坏 JSON 返回 null 的自愈能力，但 MCP/CLI 两个入口仍用 `loadIndex()` 做存在性前置检查——损坏 JSON 同样返回 null，于是被当成“没建过索引”提示去跑 `init`，`ensureFresh()` 的重建路径根本走不到，自愈形同虚设（库层有测试、入口层没有，正好漏的是真实用户路径）。修复：新增 `indexFileState(root)` 区分 `missing / exists`（仅 ENOENT 算 missing，权限/磁盘等真 IO 错误照常抛出，不伪装成空索引）；两个入口改用状态判定后再进 `ensureFresh()`。**产品语义不变**：从未初始化过的项目仍然提示先 `init`，不会静默全量建索引。
- **单个坏代码块不再带走后续好块（IG08-F02，P2）** — 0.0.8 重构 `parseFileEntry()` 时把异常粒度从“每块”放大成了“整文件一次 try/catch”：一个 `<script>` 解析失败，后面的正常 script 和全部 `<style>` 都被跳过；而条目已写入 mtime/size，文件不变增量检查就不会重试，漏掉的符号要等文件下次改动才补上。这是相对 v0.0.7（逐块隔离）的回归。修复：文件级 IO 错误仍整文件隔离（一个诊断），**块级解析错误逐块捕获**——出错前成功的符号保留，失败块以 `script@起始行: 原因` / `style@起始行: 原因` 记入 `parseError`，诊断信息不静默吞掉，文件修好后按 mtime 变化正常重解析、错误状态解除。
- **CLI 查不存在的符号不再抛 TypeError（IG08-F03，P3）** — 0.0.8 给 MCP 入口修过“先判 null 再解构”，同一份 CLI 代码漏改：`const { matches, omitted } = nodeInfo(...)` 在 nodeInfo 返回 null（无命中）时直接解构崩溃，堆栈甩到用户脸上。修为先判 `!result` 再解构，输出既有的未命中文案。

### 🧪 验证

- 红灯先行：F01×4（MCP/CLI 各自损坏+未初始化）、F02×3、F03×1 共 8 个失败夹具，修复前按审计推导逐条复现（F01 实测输出正是 “corrupt — rebuilding” 后紧跟 “no .indexgraph index found … run init”；F03 实测 `TypeError: Cannot destructure property 'matches'`）。
- `npm test`：**38/38 通过**（0.0.8 的 29 + 本轮 9）。新增覆盖：真实 MCP stdio 损坏自愈（查询成功且 index.json 修复为当前 schema）、真实 MCP stdio 未初始化提示保持不变、坏块→好块→好样式经 MCP 实际返回、CLI 子进程损坏自愈/未初始化退出码/不存在符号干净未命中。
- 未初始化语义双重确认：MCP 与 CLI 的 missing-index 用例在修复前后均为绿，确保没有把“请先 init”换成静默首建。

## 0.0.8（2026-10-10）

> 本版源于一份第三方静态源码审计（基线 `main@e6348b1`，审计编号 IG-01～IG-09）。实施顺序遵循审计建议：先保真（调用边正确性、索引一致性），再提速（增量更新），再省 Token（输出预算）。全部修复均以「先构造失败夹具 → 最小修复 → 固定为回归测试」的流程落地。

### ✨ 新增

- **node:test 自动化测试套件（IG-09）** — `npm test` 从固定失败占位变为 29 个真实用例（`node --test`），覆盖：函数行号映射、嵌套调用边隔离、跨文件/同文件同名消歧、CSS 别名与 `@media` 展开、CJK bigram 与相关性地板、graph 传播、索引新增/修改/删除增量、根路径搬迁、原子写与坏 JSON 自愈、100 同名的输出预算、monorepo 就近 tsconfig，以及**真正 spawn `mcp-server.js` 走 stdio JSON-RPC 的端到端调用**（不是只测内部函数）。测试夹具全部自建临时项目，不依赖任何真实个人项目。
- **`indexgraph_node` 输出预算与消歧参数（IG-05）** — 新增 `file`（限定文件，消歧同名符号）、`maxResults`（限制返回条数）、`mode: "summary"`（每符号只带 300 字符源码前缀 + 位置 + 调用链，用于廉价地翻同名列表）；响应整体有源码总预算（默认 24000 字符），装不下的匹配降级为一行 `{file}:{startLine}` 定位信息附在结果尾部并提示重查方式——100 个同名函数不再产出无界 MCP 响应，截断后仍保留继续定位的抓手。depth>1 的边列表每方向封顶 60 条并标记截断。
- **explore 图谱候选救回（IG-04）** — v0.0.7 的相关性地板在调用图传播加分**之前**执行，纯包装函数（body 里只有一次 `renderModal()` 调用、名字正文零命中）永远拿不到图谱分而被静默丢弃。现在强直接命中的调用者以 0.2 倍分数进入候选池，结果带 `matchReason: direct | graph`（MCP 输出对 graph 候选标注 `~via call graph`），文本命中排序不被撼动，孤证过滤（0.0.6 地板）保持不变。

### 🛡️ 可靠性

- **索引根目录搬迁防护（IG-02，P1）** — 索引 `index.json` 里存的绝对 `root` 此前从不与当前请求根目录比对：项目复制/搬迁后（保留时间戳），`indexgraph_node` 会继续用旧绝对路径读**另一个目录**的源码。现在 `isStale` 入口先校验 `schemaVersion` 与 `index.root === 当前 root`，不匹配一律整体重建；重建后的索引指向当前项目。
- **索引原子写与损坏自愈（IG-07，P2）** — `saveIndex` 改为先写同目录唯一临时文件（`pid + 时间戳 + 随机`，并发 CLI/MCP 进程互不踩踏）再 `rename` 原子替换，写中断不再留下截断的 index.json；`loadIndex` 遇到损坏 JSON 打印 stderr 警告并按"无索引"处理触发重建，MCP 不再因一次坏写长期瘫痪；权限/磁盘等不可恢复的读错误仍然如实抛出。
- **调用边按符号身份绑定（IG-01，P1）** — 两个结构性错误一起修：① 解析器改为一次 `walk.ancestor` 遍历，调用归属**最近的命名函数祖先**——嵌套函数拥有自己的调用边，外层作用域不再越权认领，无名函数（IIFE、方法赋值）内的调用宁可不记也不误挂；② 符号获得 `rel#startLine:col` 唯一 id，调用边以 `{fromId, toId}` 绑定到具体符号——不同文件（或同文件遮蔽）的同名函数各挂各的调用者，不再仅因字符串同名就合并调用图。同块内目标解析沿词法作用域链逐层向外（内层声明遮蔽外层）；跨文件调用无法确定指向时记录为**候选边**，仅当目标名字确实是项目内某符号时保留，输出以尾缀 `?` 标注，绝不以确定语气呈现。
- **顺手修掉一个必现崩溃** — mcp-server 的 `indexgraph_node` 在符号不存在时对 `null` 解构直接抛 `TypeError`（JSON-RPC -32603），测试套件首次真实走 stdio 协议时暴露，已修。

### ⚡ 性能

- **零符号文件入库 + 增量更新（IG-03，P2）** — 此前只保存有符号的文件，导致每次查询都要把全部零符号 HTML/CSS **重新读盘并解析一遍**（判断"是否开始产生符号"）；任一文件变化则全量重建。现在索引登记**所有被扫描文件**（含零符号与解析失败标记），过期探测只 stat 不解析；变更文件走增量路径——只重解析 `scanDiff` 报告的那几个文件，删除/新增各自精确处理。mtime 比较带 2ms 容差（NTFS 时间戳 100ns 精度经任何复制路径都会漂移，严格相等会让每次查询都误判陈旧全量重建），size 作为第二信号。1000 文件（70% 零符号）基准：热查询单次文件读取 **701 → 1**（只剩 index.json），单文件变更从全量重建（1000 文件重解析）降到 1 个文件；冷构建持平（~190ms）。

### 🔧 改进

- **TypeScript 悬停的 monorepo 适配（IG-06，P2）** — tsconfig 搜索起点从项目根改为**请求文件所在目录**逐级向上（`packages/app/src/x.ts` 能正确吃到 `packages/app/tsconfig.json` 的 strict 等配置），到项目根为止；language service 缓存从进程级单例改为按配置键的有界 Map（4 个，LRU 淘汰时 `dispose()`），monorepo 多包交替查询不再反复销毁重建编译器，配置文件变更仍按 mtime+size 失效。

### 🧪 验证

- `npm test`：29/29 通过。基线复现脚本（IG-01 嵌套/同名串边、IG-02 伪造旧 root）修复前 3-4 处 FAIL、修复后全 PASS。
- 1000 文件基准对照 v0.0.7（同夹具）：见上。100 同名函数的 `indexgraph_node` 输出被预算封顶，omitted 列表给出每个未展示匹配的 `file:startLine`。
- MCP stdio 端到端：initialize → tools/list → node/explore/CSS 查询/不存在符号的 not found 文案，全部经真实 JSON-RPC 往返验证。
- 测试有效性自检：发现并修复了「spy 失效」问题——index-store 解构绑定 `parseBlock` 导致测试对解析计数的替换静默旁路（假绿），改为命名空间调用后 spy 前置 sanity 断言（buildIndex 计数必须 > 0）保证测量真实生效。

## 0.0.7（2026-09-12）

### ✨ 新增

- **TypeScript/JavaScript 语义类型查询** — 新增 `indexgraph_type_info` MCP 工具，按文件、行号和列号返回指定位置的推断类型、符号种类与文档，覆盖泛型、联合类型、重载和 API 签名问题；不要求目标项目先建立 `.indexgraph` 索引。
- **按需接入 TypeScript language service** — 优先使用目标项目的 TypeScript，缺少语义服务时回退到 IndexGraph 自带的 TypeScript 5.9.3；只以请求文件作为程序入口，按项目复用服务并按源文件版本刷新，返回字段限制 2048 字符，避免大项目和重复查询拖垮 MCP 进程。

## 0.0.6（2026-08-26）

### ✨ 新增

- **索引独立 `.css` 文件，不再只有 `.html` 内联** — 起因：在 financialcost（Jinja2 SSR 项目，样式全在 `app/static/style.css` 独立文件里）上实际使用发现盲区：CodeGraph 不支持 CSS，IndexGraph 又只认内联 `<style>`，独立样式表两边都不接，查样式规则只能退回 grep。这次收进来：`lib/index-store.js` 的 `findHtmlFiles()` 改名 `findIndexableFiles()` 并同时收 `.html`/`.css`；`buildIndex()` 对 `.css` 走专门分支——整个文件就是一个 style block（startLine=1），直接复用 0.0.5 的 `parseCssBlock()`，没有新解析器；`isStale()` 对新建 `.css` 文件的过期探测同步覆盖；`bin/indexgraph.js` 的 init 输出与 usage、MCP 两个工具的 description 同步更新。实测 financialcost：`style.css` 单文件入库 248 条 CSS 规则；`explore "backdrop-filter"` 第 1 名就是 `.topbar`（此前该查询只能命中一个凑数的 JS 函数）；`node topbar` 同时命中基础规则与 `@media (max-width:900px)` 内的展开规则，行号正确；JS 精确查询无回归。
- **explore 排序按命中次数计分、模板构建函数降权、调用图传播加分；node 支持调用链深度；explore 结果紧凑化**（d116417，8/5 完成，攒到本版一起记录）— `explore()` 打分从"是否包含"改为 `countHits()` 按出现次数计数（正文里提查询词 5 次的函数远比顺带提一次的相关），单词封顶 `MAX_WORD_HITS=5` 防超长文件刷分；CJK bigram 只按去重个数计分（`MAX_UNIQUE_BIGRAMS=4`），因为模板循环会把同一个按钮文案重复几十遍；名字带 render/build/xxxHtml 的模板构建函数正文降权 0.3 倍（它们的 body 内嵌整页按钮文案和提示，会"提到"所有功能关键词）；命中符号的调用者按被调用者得分的 0.2 倍传播加分（wrapper 是相关功能真正的入口表面）。`indexgraph_node` 新增 `depth` 参数（1–3）收集多级 callers/callees，扁平列表带 `level` 字段标跳数，MCP 输出按层渲染成 `Called by (1) <- A, B; (2) <- C` 保持可读。explore 每符号返回源码从全量改为 800 字符签名前缀（探索只需要形状，完整源码走 `indexgraph_node`）。

### 🐛 修复

- **explore 孤证凑数：低相关结果伪装成命中误导 agent** — financialcost 上实测：查询 `"backdrop-filter"` 时全项目唯一的 JS 命中是一个恰好叫 `filterWrap` 的局部变量（1 次 BODY_WORD 得分），却被当作 top 结果返回——agent 看到"有结果"会以为找到了相关代码，比诚实说"没找到"有害得多。修复：给 `explore()` 加相关性地板——符号名零命中的前提下，正文佐证不足两次（两个不同词、一词多次提及、或两个不同 CJK bigram）的直接不进结果池；过滤后为空时 CLI/MCP 走既有的 `No matches for "..."` 文案。已知残余：同名变量恰好出现两次仍会溜过地板（如 `filterWrap` 声明+使用各一次），以及 `close()` 这类 body 里只提一次 `modal` 变量名的真命中会被误砍——精确查询 `indexgraph_node close` 不受影响，换词重查可补救；为个案把地板降到 1 等于不改、提到 3 会误杀 CJK bigram 场景的真实命中，权衡后维持 2。回归验证：英文自然语言问句第 1 名仍是正确目标函数（0.0.4 行为保持）、`"BOM 编辑 弹窗"` 命中 `.bom-edit-modal`、项目里不存在的内容（`毛玻璃`）诚实返回空。
## 0.0.5（2026-07-28）

### ✨ 新增

- **索引 CSS，不再只有 JS** — 起因：在 `dossier` 项目上排查一个"双层表头（保证金分组）滚动后子表头盖住分组标题"的 bug，问题根源是 CSS（所有 `<th>` 共用同一条 `position:sticky;top:var(--sticky-offset,0px)` 规则，两行表头贴到了同一个 top），但 IndexGraph 只索引 `<script>`，查不到这条规则，只能退回 grep。这次补上 CSS 这一半：`lib/extract.js` 新增 `extractStyles()`（跟 `extractScripts()` 共用新提取的 `extractTagBlocks()` 辅助函数，用 `m[0].length - content.length - 闭合标签长度` 算开标签长度，比原来 `indexOf(content, 魔数偏移)` 的写法更不容易因为标签名长度变化而算错——顺手把 `extractScripts()` 也切到这条共用路径，行为不变）；`lib/parse.js` 新增 `parseCssBlock()`，手写一个轻量的、括号深度感知的选择器/规则块切分器（不用第三方 CSS 解析库），每条规则记录为一个 `{name: 选择器, kind:'css-rule', startLine, endLine}` 符号，没有调用边（CSS 没有"调用"这个概念）——这个"符号=名字+行号范围"的形状跟 JS 函数符号完全一样，所以 `lib/query.js` 的 `explore()`/`nodeInfo()`/`callersOf()`/`calleesOf()` 几乎不用改就能直接处理 CSS 符号（`callers`/`callees` 自然是空数组，不用特殊判断）。`@media`/`@supports`/`@document`/`@layer` 这类"里面还是选择器列表"的 at-rule 会递归展开，内部选择器各自独立成符号（名字前缀带上外层 at-rule 方便识别，如 `@media(max-width:980px) » .kpis`）；`@keyframes`/`@font-face`/`@import` 这类内容不是选择器列表的 at-rule 整体当一个不透明符号，不拆内部（`from`/`to`/百分比关键帧本来就不是有意义的查询目标）。
- **CSS 精确查询支持裸 class/id 名** — `table.rec-table th.group-hdr` 这种复合选择器，用户/agent 大概率只会打 `group-hdr` 而不是背出整条选择器。`parseCssBlock()` 给每条规则额外算一份 `aliases`（选择器里出现的每个 `.class`/`#id`，带 `.`/`#` 和不带的都收，外加逗号分隔的每个并列分支），`findSymbol()` 匹配时改成 `s.name === name || s.aliases?.includes(name)`——JS 符号没有 `aliases` 字段，这个改动对 JS 查询是纯粹的 no-op，不影响原有行为。之所以不把这些别名也注册成 `explore()` 里的独立符号条目：`explore()` 的模糊打分本来就是子串匹配（`nameLower.includes(w)`），完整选择器字符串本身已经包含这些子串，重复注册只会让同一条规则在 fuzzy 结果里占好几个坑，挤掉其它真正不同的规则。
- 改于 `lib/extract.js`、`lib/parse.js`、`lib/index-store.js`（`buildIndex()`/`isStale()` 两处都要并行处理 `extractScripts`+`extractStyles`）、`lib/query.js`；`bin/indexgraph.js`、`mcp-server.js` 的输出/工具描述跟着更新（代码块语言按 `kind` 是不是 css 开头切 `css`/`javascript`；MCP 的 `indexgraph_node`/`indexgraph_explore` 描述里说明现在也能查 CSS 选择器/class/id）。

### ⚠️ 已知局限（这次顺手发现，写进 README）

- `<style>`/`<script>` 提取是对 HTML 原文做正则匹配，不区分"真的在页面里生效的标签"和"某个 JS 函数拼 HTML 字符串时里面恰好写了看起来像标签的文本"。实测在 `SystemManager` 的 `printOutboundList()` 里，函数体内一段要 `document.write()` 的打印页面 HTML 字符串里写了 `<style>...@media print{@page{margin:10mm}}...</style>`，也被当成真实样式规则索引了进去（`indexgraph explore "page margin print"` 能查到，标成 `@media print » @page`，行号 `index.html:2700` 是对的，只是它不是当前页面真的在用的规则）。这是正则提取的固有局限，JS 那边理论上有同样的问题（字符串里写 `<script>`），只是更少见没实测撞上。索引到的行号/源码本身是真实准确的，只是"这是不是真的页面样式"需要自己判断一下。

### 🧪 验证

- 在 `dossier`（本次 bug 的源项目）上跑 `indexgraph init`：`Indexed 1 file(s) with inline <script>/<style> — 453 symbols (158 CSS rules), 448 call edges`。
  - `indexgraph node group-hdr` → 正确找到 `table.rec-table th.group-hdr`（templates\index.html:110），验证裸 class 名查复合选择器。
  - `indexgraph node table-wrap` → 找到 `.table-wrap`（:107），验证不带前导 `.` 的 class 名也能查。
  - `indexgraph node ymPopupIn` → 找到 `@keyframes ymPopupIn`（:190），验证 at-rule 的名字部分也能当别名查。
  - `indexgraph explore "position sticky th top offset"` → 第 2 名直接命中 `table.rec-table th{...position:sticky;top:var(--sticky-offset,0px)...}`（这条正是本次 bug 的根源规则），同一批结果里还带出 `applyStickyOffset()` 和另一处已经手动实现了"多行表头分别 sticky"的 `buildSide()`（`top:calc(var(--sticky-offset,0px) + 33px)`）——如果这次修 bug 之前就有这个查询能力，能少走好几轮 grep。
  - `indexgraph explore "双层表头 保证金 重叠"` → 第 1 名就是这次实际改的 `renderTable()`，行号、内容都对得上刚提交的改动。
- 在 `SystemManager`（另一个真实项目，规模不同、样式写法也不同）上跑 `indexgraph init`：`Indexed 1 file(s) with inline <script>/<style> — 387 symbols (193 CSS rules), 537 call edges`，没有崩溃/抛错。
  - 该项目 `index.html:246` 有真实的 `@media(max-width:980px){...}` 块（跟 `@media` 后面没空格），`.kpis` 在外层（:158）和这个 media 块内（:250）各定义一次——`indexgraph node kpis` 两条都能查到，media 块内那条名字带 `@media(max-width:980px) » .kpis` 前缀、行号 250 正确，验证了 at-rule 递归展开 + 行号映射。
  - 该项目还有 `@media print{@page{margin:10mm}}` 这种"at-rule 套 at-rule"的双层嵌套（:1973、:2700，两处重复），没有递归属性（`@page` 不在可递归集合里）走的是"整体当一个不透明符号"分支，没有报错也没有死循环，符号名 `@media print » @page`——顺带发现了上面写进"已知局限"的那个正则误伤案例（这两处实际都在 JS 字符串里，不是真的页面 `<style>`）。
  - 精确符号查询（如已有的 JS 函数名）结果跟 0.0.4 时一致，确认没有回归。

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
