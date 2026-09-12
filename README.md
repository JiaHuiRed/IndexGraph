# IndexGraph — 前端代码图谱

> _A local code graph for frontend logic embedded in HTML `<script>`/`<style>` blocks, plus standalone `.css` stylesheets._

[![Version](https://badgen.net/badge/版本/0.0.7/blue)](CHANGELOG.md)
[![License](https://badgen.net/badge/license/MIT/green)](LICENSE)

**IndexGraph**s是一个简单的前端代码搜索工具，用来在特定情况下降本增效：写在 `.html` 文件里 `<script>`/`<style>` 标签内联的前端 JS 和 CSS，外加独立 `.css` 样式表。100% 本地，不上传任何代码。

---

## ✨ 特色

- **函数级索引** — 提取内联 `<script>` 里的函数声明 / 箭头函数赋值，记录真实行号（映射回原始 `.html` 文件，不是提取后的偏移量）
- **调用关系图** — 谁调用了谁，一次查询就有调用者 + 被调用者列表
- **CSS 规则索引** — 提取内联 `<style>` 与独立 `.css` 文件里的规则，按完整选择器索引，也能直接用裸的 class/id 名查（比如 `group-hdr` 能找到 `table.rec-table th.group-hdr`）；`@media`/`@supports` 会递归展开成内部选择器各自独立可查，`@keyframes`/`@font-face` 这类整体当一个符号（内部不是选择器列表，拆了也没意义）
- **精确查询** — `indexgraph node <name>`：已知函数名/选择器/class/id 时，一次拿到源码（+ JS 的调用链）
- **模糊探索** — `indexgraph explore "<关键词>"`：不知道确切名字时，按名称 / 正文匹配打分排序，JS 函数和 CSS 规则一起参与排序；孤证单提及的低分结果直接丢弃——没有真命中就诚实返回空，不拿凑数结果误导
- **MCP server** — 接入 Claude Code 等 agent，作为 `indexgraph_node` / `indexgraph_explore` / `indexgraph_type_info` 工具直接调用；前两个查前端代码图，后一个返回 TypeScript/JavaScript 文件指定位置的语义类型和文档（不要求 `.indexgraph`，`indexgraph_node` 支持 `depth` 参数收集 1–3 级调用链）
- 源码永远现读现取（不是缓存），跟 Read 工具看到的内容逐字节一致
- **索引过期自动重建** — 查询前按文件 mtime 检测是否有改动，过期就透明重建，不用记得手动重跑 `indexgraph init`

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
```

---

## ⌨️ CLI 命令

| 命令 | 作用 |
|------|------|
| `indexgraph init [路径]` | 扫描 `.html`/`.css` 文件，提取内联 `<script>`/`<style>`，建立索引 |
| `indexgraph files` | 列出已索引文件和符号数量 |
| `indexgraph node <name>` | 精确符号：源码 + 调用者 + 被调用者（函数名，或 CSS 选择器/class/id） |
| `indexgraph explore "<query>"` | 关键词模糊搜索 |
| `indexgraph version` | 打印版本号 |

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

重启 agent 后即可使用 `indexgraph_node` / `indexgraph_explore` / `indexgraph_type_info` 三个工具。

---

## ⚠️ 已知局限

- 代码图索引只解析纯 JS（无 `src=` 属性的内联 `<script>`），不把 TS/JSX 纳入索引；TypeScript/JavaScript 的语义类型查询请使用 `indexgraph_type_info`
- 调用关系是同文件内的词法匹配，不做真正的作用域解析（动态派发、跨文件 import 追踪不到）
- 目前一次只处理一层——嵌套函数会被各自记录为独立符号，但父子关系不做特殊标注
- CSS 只认标准语法，不支持 Sass/Less 的嵌套写法（`&:hover` 这类）
- `<script>`/`<style>` 提取是正则匹配标签文本，不区分"真的在页面里生效的标签"和"JS 字符串/模板字面量里刚好长得像标签的文本"——比如某个函数用字符串拼一段要 `document.write` 的打印页面 HTML，里面写的 `<style>...</style>` 也会被当成真实样式索引进去。索引到的内容仍然是文件里那个位置的真实文本（不会读错、不会读到别处），只是它未必是当前页面实际生效的规则，这一点脑子里过一下（这条只影响 `.html` 的标签提取；独立 `.css` 文件不走标签匹配、全文解析，无此问题）

---

## 🙏 致谢

设计理念上借鉴了 [CodeGraph](https://github.com/colbymchenry/codegraph)——`node`/`explore` 两个命令的分工、MCP 包一层的做法、"源码永远现读、不用缓存"这几个思路都来自它。

---

_构建者：Red_
