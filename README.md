# 🚦 Branch-Thinking MCP Tool

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js)
![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue?logo=typescript)
![MCP](https://img.shields.io/badge/MCP-Server-orange?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiByeD0iNSIgZmlsbD0iI0ZGMzYwMCIvPjwvc3ZnPg==)
![MIT License](https://img.shields.io/badge/license-MIT-lightgrey)

> ⚡️ **Branch-based thought navigation, cross-referencing, and AI-powered task/insight management for Model Context Protocol (MCP) servers.**

---

## ✨ Features

- 🌳 **Branch Management:** Create, focus, and navigate multiple lines of thought
- 🔗 **Cross-References:** Link related thoughts across branches (typed, scored)
- 💡 **AI Insights:** Automatic insight and summary generation
- ⏳ **Priority Tracking:** Dynamic scoring for branches and thoughts
- 🧠 **Semantic Search:** Find relevant thoughts, ideas, and code snippets
- ✅ **Task Management:** Persistent, queryable, and updatable tasks
- 🗂️ **Batch Operations:** Add or process multiple thoughts/insights at once
- 🧩 **Code Snippet Storage:** Save and search reusable code
- 📊 **Visualization:** Generate graphs of branches, cross-refs, and knowledge hubs

---

## 🖼️ Architecture & Flow

```mermaid
flowchart TD
    User([User/Agent 🤖])
    Tool([Branch-Thinking MCP Tool 🚦])
    BM[BranchManager 🧠]
    Disk[(Persistent Storage 💾)]
    User-->|Commands|Tool
    Tool-->|Manage/Query|BM
    BM-->|Save/Load|Disk
    BM-->|Results|Tool
    Tool-->|Output|User
```

---

## 🚀 Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/your-org/branch-thinking-mcp.git
cd branch-thinking-mcp
npm install
npm run build
```

### 2. Configure

Add to your `claude_desktop_config.json`:

```json
"branch-thinking": {
  "command": "node",
  "args": [
    "/your-custom-mcp-dir-here/branch-thinking/dist/index.js"
  ]
}
```

### 3. Run

```bash
node dist/index.js
```

---

## 🛠️ Supported Commands

| Command | Description |
|---------|-------------|
| `list` | Show all branches with status |
| `focus [branchId]` | Switch focus to a branch |
| `history [branchId?]` | Show thought history |
| `insights [branchId?]` | Get AI-generated insights |
| `crossrefs [branchId?]` | Show cross-references |
| `hub-thoughts [branchId?]` | List hub thoughts |
| `semantic-search [query]` | Find similar thoughts |
| `list-tasks [branchId] [status] [assignee] [due]` | List/filter tasks |
| `update-task-status [taskId] [status]` | Update a task’s status |
| `summarize-tasks [branchId]` | Summarize tasks |
| `link-thoughts [from] [to] [type] [reason?]` | Link two thoughts |
| `add-snippet [content] [tags]` | Save a code snippet |
| `snippet-search [query]` | Search code snippets |
| `summarize-branch [branchId?]` | AI summary of branch |
| `doc-thought [thoughtId]` | Document a thought |
| `extract-tasks [branchId?]` | Extract actionable items |
| `review-branch [branchId?]` | AI review of branch |
| `visualize [branchId?]` | Visual graph of connections |
| `ask [question]` | AI answer from knowledge base |

---

## 🧠 How It Works

1. **Agents or users submit "thoughts"** (ideas, tasks, notes, code, etc.) to the tool, specifying a branch or letting the tool auto-create one.
2. **Each thought is scored** (semantic centrality, recency, diversity, confidence, key points).
3. **Thoughts are automatically cross-referenced** using semantic similarity (multi-hop up to 3 levels), with links scored and typed (e.g., "very similar", "related").
4. **Branches** represent parallel lines of reasoning, sub-tasks, or research threads. You can focus, switch, or summarize any branch.
5. **AI generates insights, summaries, and suggestions** for each branch, based on your evolving knowledge graph.
6. **Tasks** are persistent and can be managed, queried, and updated via commands.
7. **Code snippets** can be saved, tagged, and searched for reuse.
8. **Visualization** commands generate a graph of branches, cross-references, and hub thoughts for easy navigation.

### 🔎 Example Workflow

```json
{
  "content": "Refactor the API for clarity",
  "branchId": "dev"
}
```

- `list` — See all branches
- `focus dev` — Switch to "dev" branch
- `insights dev` — Get AI insights for "dev"
- `link-thoughts thought-1 thought-2 supports "Thought 1 supports Thought 2"`
- `visualize dev` — Visualize connections in "dev"

### 🧑‍💻 Advanced Usage Scenarios

- **Brainstorming:** Add multiple thoughts in batch to quickly capture a meeting or ideation session.
- **Research:** Use semantic search and cross-refs to surface relevant prior work, related ideas, or code.
- **Project Management:** Track tasks, update statuses, and summarize progress by branch.
- **Code Documentation:** Use doc-thought and summarize-branch to generate documentation and overviews.

---

## 💡 Best Practices & AI Agent Guidance

- **Decompose complex goals** into sequences of thought/task/insight commands.
- **Iterate and adapt:** Use feedback from summaries, reviews, and visualizations to refine next actions.
- **Explicitly specify parameters** (branchId, status, assignee, etc.) for precise results.
- **Use batch mode** for efficiency when adding multiple thoughts or tasks.
- **Regularly review hub thoughts and AI insights** to discover non-obvious connections.
- **Use cross-references and multi-hop links** to foster creativity and bridge ideas.
- **Prompt agents** (Claude, GPT-4, etc.) to "think step by step" or "use chain of thought" for best results.

---

## 🛠️ Technology Stack

| ![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?logo=node.js) | ![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue?logo=typescript) | ![MCP](https://img.shields.io/badge/MCP-Server-orange?logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiByeD0iNSIgZmlsbD0iI0ZGMzYwMCIvPjwvc3ZnPg==) |
|---|---|---|
| Node.js 18+ | TypeScript 4.x | Model Context Protocol (MCP) |

---

## 🛡️ Troubleshooting & Advanced Configuration

- **Tool not responding?** Check your MCP server logs and ensure the tool is listed in `claude_desktop_config.json`.
- **Persistent storage issues?** Ensure the server has write access to its working directory.
- **Customizing scoring/AI?** Edit `src/branchManager.ts` for advanced algorithms and heuristics.
- **Want to add new commands?** Extend `handleCommand` in `src/index.ts`.

---

## 🔮 Future Updates

- [ ] 🌐 **Web-based visualization dashboard** — Interactive graph UI for branches and thoughts
- [ ] 🤝 **Real-time multi-user collaboration** — Multiple agents/users editing and thinking together
- [ ] 🗂️ **Import/export integrations** — Connect with Obsidian, Logseq, and other knowledge tools
- [ ] 🧬 **Advanced AI-driven branch merging** — Automatic suggestion and merging of related branches
- [ ] 🛡️ **Granular access control** — Fine-grained permissions for branches and thoughts
- [ ] 📦 **Plugin system** — Extend tool with custom logic, scoring, or integrations
- [ ] 🔔 **Notification hooks** — Get notified on key branch/task changes
- [ ] 🧑‍🎨 **Customizable scoring/insight algorithms** — Plug in your own AI models

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Please open a PR or issue on GitHub.

1. Fork this repo
2. Create a new branch (`git checkout -b feature/your-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## 📚 References & Related Projects

- [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/servers)
- [Sequential Thinking Tool](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking)
- [Obsidian](https://obsidian.md/)
- [Logseq](https://logseq.com/)

---

## 📝 Credits

- **Concept & Testing:** @ssdeanx
- **Core Code Generation:** Claude, GPT-4, and Cascade
- **Implementation, Fixes, and Documentation:** @ssdeanx

---

## 📄 License

[MIT](LICENSE)
