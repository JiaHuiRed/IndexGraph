# IndexGraph — 前端代码图谱

> _A local code graph for frontend logic embedded in HTML `<script>`/`<style>` blocks, standalone `.css` stylesheets, standalone `.js`/`.mjs`/`.cjs` scripts, and `.tsx`/`.jsx`/`.vue` components — trace a UI element back to its implementation._

[![Version](https://badgen.net/badge/版本/0.2.0/blue)](CHANGELOG.md)
[![License](https://badgen.net/badge/license/MIT/green)](LICENSE)

**IndexGraph**s是一个简单的前端代码搜索工具，用来在特定情况下降本增效：写在 `.html` 文件里 `<script>`/`<style>` 标签内联的前端 JS 和 CSS，外加独立 `.css` 样式表、独立的 `.js`/`.mjs`/`.cjs` 脚本文件，以及 `.tsx`/`.jsx`/`.vue` 前端组件文件。100% 本地，不上传任何代码。

---

## ✨ 特色

- **UI 追踪（`indexgraph trace`）** — 从「界面上看到的东西」反查实现代码：给按钮文案、CSS class、DOM id、静态 `data-action`、组件名或选择器，返回声明组件、直接绑定的事件处理器、处理器的调用链，以及命中的 CSS 样式候选；每条关系都带证据标注（`direct binding` / `candidate` / `selector match`），动态表达式、运行时分支、跨文件同名歧义一律以候选呈现，不冒充确定边
  - **函数级索引** — 提取内联 `<script>`、独立 `.js`/`.mjs`/`.cjs` 脚本文件、`.tsx`/`.jsx` 组件与 Vue `<script setup>` 里的函数声明 / 箭头函数赋值，记录真实行号（映射回原始文件，不是提取后的偏移量）；大写开头且含 JSX 的函数识别为组件。独立脚本文件整体当作一个从第 1 行开始的 script 块，与本文件内联 `<script>` 走同一套解析；ESM（`import`/`export`）解析失败时自动改用 module 模式重试，不会整文件丢弃
- **调用关系图** — 谁调用了谁，一次查询就有调用者 + 被调用者列表；每条边绑定到具体符号（`file#行:列` 身份），同名函数不串线，嵌套函数各自拥有自己的调用边
- **CSS 规则索引** — 提取内联 `<style>` 与独立 `.css` 文件里的规则（含 Vue `<style scoped>`），按完整选择器索引，也能直接用裸的 class/id 名查（比如 `group-hdr` 能找到 `table.rec-table th.group-hdr`）；`@media`/`@supports` 会递归展开成内部选择器各自独立可查，`@keyframes`/`@font-face` 这类整体当一个符号（内部不是选择器列表，拆了也没意义）
- **UI 元素索引** — `.html`（parse5 真实解析）与组件文件里的每个标签都记录 tag、id、class、静态文本、常用提示属性（`aria-label`/`placeholder` 等）与事件绑定；HTML 里的 `<template>` 内容同样覆盖
- **精确查询** — `indexgraph node <name>`：已知函数名/选择器/class/id 时，一次拿到源码（+ JS 的调用链）
- **模糊探索** — `indexgraph explore "<关键词>"`：不知道确切名字时，按名称 / 正文匹配打分排序，JS 函数和 CSS 规则一起参与排序；孤证单提及的低分结果直接丢弃——没有真命中就诚实返回空，不拿凑数结果误导
- **MCP server** — 接入 Claude Code 等 agent，作为 `indexgraph_node` / `indexgraph_explore` / `indexgraph_trace` / `indexgraph_type_info` 工具直接调用；前三个查前端代码图（trace 即 UI 追踪），最后一个返回 TypeScript/JavaScript 文件指定位置的语义类型和文档（不要求 `.indexgraph`，`indexgraph_node` 支持 `depth` 参数收集 1–3 级调用链，另有 `file`/`maxResults`/`mode:"summary"` 用于同名符号消歧与输出预算控制）
- 源码永远现读现取（不是缓存），跟 Read 工具看到的内容逐字节一致
- **索引过期自动重建** — 查询前按文件 mtime/size 检测是否有改动，过期就透明重建，不用记得手动重跑 `indexgraph init`；已改动文件走增量更新（只重解析变化的那几个文件），零符号文件也登记在册、热查询零重新解析；项目整体复制/搬迁、索引文件损坏、旧版本索引（v2 → v3 自动升级）时同样自动重建并指向当前根目录，不会误读旧路径或坏缓存；只有**从未建过索引**的项目才提示先 `init`

---

## 🚀 开始使用

```bash
# 安装依赖
npm install

# 全局链接 CLI（开发/本地使用）
npm link

# 在目标项目里建索引
cd your-project
indexgraph init

# 查询
indexgraph node renderTable
indexgraph explore "对账单附件怎么渲染的"

# UI 追踪：从界面上看到的东西反查实现
indexgraph trace --text "保存设置"
indexgraph trace --class settings-save --depth 2
indexgraph trace --data-action save-settings --depth 2
```

---

## ⌨️ CLI 命令

| 命令 | 作用 |
|------|------|
  | `indexgraph init [路径]` | 扫描 `.html`/`.css`/`.js`/`.mjs`/`.cjs`/`.tsx`/`.jsx`/`.vue` 文件，提取内联 `<script>`/`<style>`、独立脚本/样式文件、组件符号与 UI 元素，建立索引 |
| `indexgraph files` | 列出已索引文件和符号数量（按符号数从多到少） |
| `indexgraph stats` | 索引摘要：文件/符号/边数量、按 kind 分布、索引文件体积 |
| `indexgraph dump` | 把索引按缩进 JSON 输出到 stdout（重定向到文件后再浏览） |
| `indexgraph node <name>` | 精确符号：源码 + 调用者 + 被调用者（函数名，或 CSS 选择器/class/id） |
| `indexgraph explore "<query>"` | 关键词模糊搜索 |
| `indexgraph trace` | UI 追踪：`--text "保存设置"` / `--class settings-save` / `--id save-btn` / `--data-action save-settings` / `--component Panel` / `--selector "button.save"` / `--tag button`，可加 `--file` 消歧、`--limit`/`--depth` 控制输出 |
| `indexgraph version` | 打印版本号 |

> `.indexgraph/index.json` 是**紧凑单行 JSON**——它给查询侧读，不是给人翻的。要看索引内容用 `indexgraph stats`（摘要）或 `indexgraph dump > index.pretty.json`（完整结构，缩进后浏览）。

## 🔌 接入 MCP（Claude Code 等）

```json
{
  "mcpServers": {
    "indexgraph": {
      "type": "stdio",
      "command": "node",
      "args": ["D:\\AI\\IndexGraph\\mcp-server.js"]
    }
  }
}
```

重启 agent 后即可使用 `indexgraph_node` / `indexgraph_explore` / `indexgraph_trace` / `indexgraph_type_info` 四个工具。`indexgraph_trace` 支持 `dataAction: "save-settings"` 精确定位静态 `data-action` 属性；可结合 `file`、`selector` 进一步筛选。动态 `data-action={expr}` / Vue `:data-action="expr"` 不能静态确定，不会被当作已命中的值。

`indexgraph_trace` 的典型用法：从 WebQA 等运行时观察工具拿到按钮文案/class，直接喂给 trace 拿到组件与事件绑定，再改代码验证——静态定位（IndexGraph）与运行时观察（WebQA）通过普通文本线索协作，互不依赖。

---

## ⚠️ 已知局限

- **UI 追踪是静态证据，不是运行时真相** — `direct binding` 只表示「静态可解析的引用」；点击后是否真的执行、动态 class 的最终取值、CSS cascade 谁赢，都不在承诺范围内（输出末尾有固定 caveat 提醒）。动态事件表达式（内联箭头函数等）和动态 class 以 `candidate` 呈现并保留表达式原文
- 代码图索引内联 JS（HTML `<script>`）、独立 `.js`/`.mjs`/`.cjs` 脚本文件、`.tsx`/`.jsx` 组件与 Vue `<script setup>`；独立的 `.ts` 文件不做通用语言图谱（定位保持前端专精）。独立 `.js` 走 acorn 只认纯 JS（script 失败自动回退 module 模式），**含 JSX 或 TypeScript 语法的脚本请改用 `.jsx`/`.tsx` 后缀**，走 TypeScript 解析器。TypeScript 的语义类型查询请使用 `indexgraph_type_info`
- 调用关系按词法作用域链做近似解析（内层声明遮蔽外层）；动态派发、对象方法调用追踪不到。跨文件调用无法确定指向哪个同名符号，以"候选"语气标注（`calleeName?`）而不是伪装成确定边；事件 handler 的同名符号歧义同样如实列出
- Vue 模板用 `@vue/compiler-dom` 的 `baseParse` 解析（保留表达式原文），不校验表达式中变量是否真的存在——`@click="onTypo"` 会如实标注「未索引」而不是猜一个近似名
- `indexgraph_node` 有响应总预算（默认 24000 字符源码），超出的同名匹配降级为一行定位信息并附重新查询提示，不会无界返回；`trace` 默认返回摘要与行号（每元素样式候选上限 8 条、调用链上限 20 条），源码请用 `indexgraph_node` 或 Read 获取
- 目前一次只处理一层——嵌套函数会被各自记录为独立符号，但父子关系不做特殊标注
- CSS 只认标准语法，不支持 Sass/Less 的嵌套写法（`&:hover` 这类）
- HTML 标签提取走 parse5 真实解析（JS 字符串里的伪 `<style>` 不再被误索引）；但 `<template>` 之外的非可见标签（`script`/`style`/`meta` 等）不进 UI 元素索引

---

## 🙏 致谢

设计理念上借鉴了 [CodeGraph](https://github.com/colbymchenry/codegraph)——`node`/`explore` 两个命令的分工、MCP 包一层的做法、"源码永远现读、不用缓存"这几个思路都来自它。

---

_构建者：Red_
