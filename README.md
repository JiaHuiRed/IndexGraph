# IndexGraph — 前端代码图谱

> _A local code graph for frontend logic embedded in HTML `<script>` blocks._

[![Version](https://badgen.net/badge/版本/0.0.3/blue)](CHANGELOG.md)
[![License](https://badgen.net/badge/license/MIT/green)](LICENSE)

**IndexGraph** 是 [CodeGraph](https://github.com/colbymchenry/codegraph) 的补充——专门吃它吃不下的那块：写在 `.html` 文件里 `<script>` 标签内联的前端 JS。100% 本地，不上传任何代码。

---

## ✨ 特色

- **函数级索引** — 提取内联 `<script>` 里的函数声明 / 箭头函数赋值，记录真实行号（映射回原始 `.html` 文件，不是提取后的偏移量）
- **调用关系图** — 谁调用了谁，一次查询就有调用者 + 被调用者列表
- **精确查询** — `indexgraph node <函数名>`：已知函数名时，一次拿到源码 + 调用链
- **模糊探索** — `indexgraph explore "<关键词>"`：不知道确切名字时，按函数名 / 函数体匹配打分排序
- **MCP server** — 接入 Claude Code 等 agent，作为 `indexgraph_node` / `indexgraph_explore` 工具直接调用
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
| `indexgraph init [路径]` | 扫描 `.html` 文件，提取内联 `<script>`，建立索引 |
| `indexgraph files` | 列出已索引文件和符号数量 |
| `indexgraph node <name>` | 精确符号：源码 + 调用者 + 被调用者 |
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

重启 agent 后即可使用 `indexgraph_node` / `indexgraph_explore` 两个工具。

---

## ⚠️ 已知局限

- 只解析纯 JS（无 `src=` 属性的内联 `<script>`），不含 TS/JSX
- 调用关系是同文件内的词法匹配，不做真正的作用域解析（动态派发、跨文件 import 追踪不到）
- 目前一次只处理一层——嵌套函数会被各自记录为独立符号，但父子关系不做特殊标注

---

## 🙏 致谢

设计理念上借鉴了 [CodeGraph](https://github.com/colbymchenry/codegraph)——`node`/`explore` 两个命令的分工、MCP 包一层的做法、"源码永远现读、不用缓存"这几个思路都来自它。IndexGraph 是从零实现的（没有读过 CodeGraph 的源码，它是编译发布的闭源分发包），定位是补上它不支持 `.html` 内联 `<script>` 的那块空白，不是它的替代品。

---

_构建者：Red_
