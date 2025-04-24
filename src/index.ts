#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BranchManager } from './branchManager.js';
import { BranchingThoughtInput } from './types.js';
import chalk from 'chalk';

class BranchingThoughtServer {
  private branchManager = new BranchManager();

  // Made async to allow awaiting handleCommand
  async processThought(input: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      const inputData = input as any;
      
      // Handle commands if present
      if (inputData.command) {
        // Await handleCommand since it is now async
        return await this.handleCommand(inputData.command);
      }

      // Handle regular thought input (single or batch)
      let lastThought;
      let branch;
      if (Array.isArray(inputData)) {
        lastThought = this.branchManager.addThought(inputData);
        branch = this.branchManager.getBranch(lastThought.branchId)!;
      } else {
        const thoughtInput = input as BranchingThoughtInput;
        lastThought = this.branchManager.addThought(thoughtInput);
        branch = this.branchManager.getBranch(lastThought.branchId)!;
      }
      // Format the response with the branch status
      const formattedStatus = await this.branchManager.formatBranchStatus(branch);
      console.error(formattedStatus); // Display in the console

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            thoughtId: lastThought.id,
            branchId: lastThought.branchId,
            branchState: branch.state,
            branchPriority: branch.priority,
            numInsights: branch.insights.length,
            numCrossRefs: branch.crossRefs.length,
            activeBranch: this.branchManager.getActiveBranch()?.id
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }]
      };
    }
  }

  // Made async to allow await for new commands
  private async handleCommand(command: { 
    type: string; 
    branchId?: string; 
    query?: string; 
    topN?: number; 
    fromThoughtId?: string; 
    toThoughtId?: string; 
    linkType?: string; 
    reason?: string; 
    tags?: string[]; 
    author?: string; 
    content?: string; 
    thoughtId?: string; 
    question?: string;
    status?: string;
    assignee?: string;
    due?: string;
    taskId?: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      switch (command.type) {
        case 'insights': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) {
            throw new Error('No active branch and no branchId provided');
          }
          const insights = this.branchManager.getCachedInsights(branchId);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                branchId,
                insights
              }, null, 2)
            }]
          };
        }
        case 'list': {
          const branches = this.branchManager.getAllBranches();
          const activeBranchId = this.branchManager.getActiveBranch()?.id;
          const output = branches.map(b => {
            const isActive = b.id === activeBranchId;
            const prefix = isActive ? chalk.green('→') : ' ';
            return `${prefix} ${b.id} [${b.state}] - ${b.thoughts[b.thoughts.length - 1]?.content.slice(0, 50)}...`;
          }).join('\n');
          
          return {
            content: [{
              type: "text",
              text: `Current Branches:\n${output}`
            }]
          };
        }

        case 'focus': {
          if (!command.branchId) {
            throw new Error('branchId required for focus command');
          }
          this.branchManager.setActiveBranch(command.branchId);
          const branch = this.branchManager.getBranch(command.branchId)!;
          const formattedStatus = await this.branchManager.formatBranchStatus(branch);
          console.error(formattedStatus);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: 'success',
                message: `Now focused on branch: ${command.branchId}`,
                activeBranch: command.branchId
              }, null, 2)
            }]
          };
        }

        case 'history': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) {
            throw new Error('No active branch and no branchId provided');
          }
          const branch = this.branchManager.getBranch(branchId)!;
          const history = await this.branchManager.getBranchHistory(branchId);
          
          return {
            content: [{
              type: "text",
              text: history
            }]
          };
        }

        case 'crossrefs': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) throw new Error('No active branch and no branchId provided');
          const branch = this.branchManager.getBranch(branchId)!;
          const crossRefs = branch.crossRefs || [];
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                branchId,
                crossReferences: crossRefs
              }, null, 2)
            }]
          };
        }
        case 'hub-thoughts': {
          // List thoughts with the highest cross-branch connections/scores
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) throw new Error('No active branch and no branchId provided');
          const branch = this.branchManager.getBranch(branchId)!;
          const thoughts = branch.thoughts || [];
          // Sort by number of crossRefs and score
          const sorted = [...thoughts].sort((a, b) => {
            const aScore = (a.crossRefs?.length || 0) + (typeof a.score === 'number' ? a.score : 0);
            const bScore = (b.crossRefs?.length || 0) + (typeof b.score === 'number' ? b.score : 0);
            return bScore - aScore;
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                branchId,
                hubThoughts: sorted.slice(0, 10)
              }, null, 2)
            }]
          };
        }
        case 'semantic-search': {
          if (!('query' in command) || typeof command.query !== 'string') throw new Error('semantic-search requires a query string');
          const query = command.query;
          const topN = typeof command.topN === 'number' ? command.topN : 5;
          // semanticSearch returns a Promise, so we must handle this asynchronously
          // But handleCommand is not async, so we throw an error if used in sync context
          // This is a limitation of the current design; ideally, processThought should be async
          // For now, we block with a deasync workaround (not ideal), or we can throw an error
          // For demonstration, we'll throw an error if not handled async
          throw new Error('semantic-search is only available via async API. Please call processThought asynchronously.');
        }
        case 'link-thoughts': {
          if (!('fromThoughtId' in command) || !('toThoughtId' in command) || !('linkType' in command)) {
            throw new Error('link-thoughts requires fromThoughtId, toThoughtId, and linkType');
          }
          const { fromThoughtId, toThoughtId, linkType, reason } = command;
          const validLinkType = linkType as 'supports' | 'contradicts' | 'related' | 'expands' | 'refines';
          const success = this.branchManager.linkThoughts(fromThoughtId!, toThoughtId!, validLinkType, reason);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: success ? 'linked' : 'failed',
                fromThoughtId,
                toThoughtId,
                linkType,
                reason
              }, null, 2)
            }] 
          };
        }
        case 'add-snippet': {
          if (!('content' in command) || typeof command.content !== 'string' || !('tags' in command) || !Array.isArray(command.tags)) throw new Error('add-snippet requires content (string) and tags (array)');
          const snippet = this.branchManager.addSnippet(command.content, command.tags, typeof command.author === 'string' ? command.author : undefined);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(snippet, null, 2)
            }]
          };
        }
        case 'snippet-search': {
          if (!('query' in command) || typeof command.query !== 'string') throw new Error('snippet-search requires a query string');
          const results = this.branchManager.searchSnippets(command.query, typeof command.topN === 'number' ? command.topN : 5);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ results }, null, 2)
            }]
          };
        }
        case 'summarize-branch': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) throw new Error('No branchId provided and no active branch.');
          return {
            content: [{
              type: "text",
              text: await this.branchManager.summarizeBranch(branchId)
            }]
          };
        }
        case 'doc-thought': {
          if (!('thoughtId' in command) || typeof command.thoughtId !== 'string') throw new Error('doc-thought requires a thoughtId (string)');
          return {
            content: [{
              type: "text",
              text: await this.branchManager.summarizeThought(command.thoughtId)
            }]
          };
        }
        case 'extract-tasks': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          const tasks = await this.branchManager.extractTasks(branchId);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, tasks }, null, 2)
            }]
          };
        }
        case 'list-tasks': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          const status = command.status;
          const assignee = command.assignee;
          const due = command.due;
          const tasks = await this.branchManager.queryTasks({ branchId, status, assignee, due });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, status, assignee, due, tasks }, null, 2)
            }]
          };
        }
        case 'update-task-status': {
          const taskId = command.taskId;
          const status = command.status;
          if (!taskId || !status) throw new Error('update-task-status requires taskId and status');
          const updated = await this.branchManager.updateTaskStatus(taskId, status as 'open' | 'in_progress' | 'closed');
          return {
            content: [{
              type: "text",
              text: updated ? `Task ${taskId} updated to status ${status}` : `Task ${taskId} not updated (stateless mode)`
            }]
          };
        }
        case 'summarize-tasks': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          const summary = await this.branchManager.summarizeTasks(branchId);
          return {
            content: [{
              type: "text",
              text: summary
            }]
          };
        }
        case 'review-branch': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) throw new Error('No branchId provided and no active branch.');
          const reviews = await this.branchManager.reviewBranch(branchId);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, reviews }, null, 2)
            }]
          };
        }
        case 'visualize': {
          const branchId = command.branchId || this.branchManager.getActiveBranch()?.id;
          const data = this.branchManager.visualizeBranch(branchId);

          // Build Mermaid diagram string
          let mermaid = 'graph TD\n';
          for (const node of data.nodes) {
            mermaid += `  ${node.id.replace(/[^a-zA-Z0-9_]/g, '_')}[${node.label}]\n`;
          }
          for (const edge of data.edges) {
            const from = edge.from.replace(/[^a-zA-Z0-9_]/g, '_');
            const to = edge.to.replace(/[^a-zA-Z0-9_]/g, '_');
            mermaid += `  ${from} --|${edge.label}|--> ${to}\n`;
          }

          return {
            content: [
              {
                type: "json",
                text: JSON.stringify({ branchId, visualization: data }, null, 2)
              },
              {
                type: "mermaid",
                text: mermaid
              }
            ]
          };
        }
      }
      // Default return for unknown command types
      return {
        content: [{
          type: "text",
          text: `Unknown command type: ${command.type}`
        }]
      };
    }
    catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }]
      };
    }
  }
}

const BRANCHING_THOUGHT_TOOL: Tool = {
  name: "branch-thinking",
  description: `
# 🧠 Branch-Thinking Tool

AI-native tool for managing, visualizing, and reasoning over branching thoughts, tasks, code, and knowledge.

---

## ✨ Features

- **Semantic Search & Embeddings** — Instantly find relevant thoughts using high-quality vector search.
- **Agentic Visualization** — Generate JSON graphs and beautiful Mermaid diagrams.
- **Branch & Thought Management** — Organize, batch-add, and cross-link ideas.
- **Insight Generation & Task Automation** — Extract tasks, review code, and surface high-impact ideas.

---

## 🛠️ Core Commands

- Remember you must always start with new branch and thoughts.
- Always keep track of ids.
- When creating a branch give it random id.
- Always start with new branch and thoughts.
- \`content\` (string): — The content of the thought (idea, analysis, observation, etc.).
- \`type\` (string): — The type of the thought (e.g., analysis, observation, idea, etc.).
- \`add-thought [branchId] [content] [type]\` — Add a new thought to the specified branch. Provide the branch ID, the content of the thought (idea, analysis, observation, etc.), and an optional type for categorization.
- \`link-thoughts [fromThoughtId] [toThoughtId] [type] [reason]\` — Create a semantic link between two thoughts, specifying the relationship type (supports, contradicts, related, expands, refines, etc.) and an optional reason for the connection.
- \`list\` — Retrieve a list of all branches, including their IDs and current status (active/inactive).
- \`focus [branchId]\` — Set the active context to the specified branch, so all subsequent commands operate on this branch.
- \`history [branchId?]\` — Display the chronological history of thoughts and actions within a branch. If no branchId is provided, use the current active branch.
- \`insights [branchId?]\` — Show recent AI-generated insights for the branch, such as patterns, summaries, or recommendations.
- \`crossrefs [branchId?]\` — List all cross-references (links to other branches or thoughts) for the branch.
- \`hub-thoughts [branchId?]\` — Identify the most influential or highly connected thoughts in the branch.
- \`semantic-search [query]\` — Find thoughts across all branches that are semantically similar to the provided query using vector embeddings.
- \`add-snippet [content] [tags]\` — Save a code snippet with descriptive tags for later search and reference.
- \`snippet-search [query]\` — Search all saved code snippets by content or tag.
- \`summarize-branch [branchId?]\` — Generate a concise summary of all thoughts and insights in the branch.
- \`doc-thought [thoughtId]\` — Automatically generate documentation for a specific thought, providing context and explanation.
- \`extract-tasks [branchId?]\` — Extract actionable tasks from the thoughts in a branch using AI analysis.
- \`list-tasks [branchId] [status] [assignee] [due]\` — List all tasks in a branch, with optional filters for status, assignee, or due date.
- \`update-task-status [taskId] [status]\` — Update the status of a specific task (e.g., open, in_progress, closed).
- \`summarize-tasks [branchId]\` — Provide a summary of the status and key points of all tasks in a branch.
- \`review-branch [branchId?]\` — Run an AI-powered review of the branchs thoughts or code, surfacing suggestions and improvements.
- \`visualize [branchId?]\` — Output a JSON or Mermaid diagram graph of the branch, showing thoughts, tasks, and their relationships.
- \`ask [question]\` — Ask an AI-powered question about the knowledge base or branch content, and receive an answer based on the current context.

---

## 💡 Best Practices

- Use batch/insight modes for brainstorming and research.
- Regularly review hub thoughts and cross-references for hidden connections.
- Leverage visualization and semantic search for agentic workflows.

---

## ⚡ Quick Example

- ✍️ \`ask-snippet [content] [tags]\` — Add a code snippet to the branch.  
  _Params:_  
  - \`content\` (string): — The snippet code or text.  
  - \`tags\` (array of strings): — Tags for categorization.
- 📝 \`summarize-branch [branchId?]\` — Returns a summary of the specified branch.  
  _If no branchId is given, summarizes the active branch._

`,  
  inputSchema: {
    type: "object",
    properties: {
      content: {
        oneOf: [
          { type: "string", description: "Single thought content as a string." },
          { type: "array", items: { type: "object" }, description: "Batch mode: array of thought objects, each with content, branchId, and optional metadata." }
        ],
        description: "Thought content (string) or batch of thoughts (array of objects)."
      },
      branchId: {
        type: "string",
        description: "Branch ID to associate with the thought(s). If omitted, a new branch may be created or the active branch used."
      },
      parentBranchId: {
        type: "string",
        description: "Optional: ID of the parent branch for hierarchical organization."
      },
      type: {
        type: "string",
        description: "Thought type: e.g., 'analysis', 'hypothesis', 'observation', 'task', etc. Used for filtering and scoring."
      },
      confidence: {
        type: "number",
        description: "Optional: Confidence score (0-1) for the thought, for ranking or filtering."
      },
      keyPoints: {
        type: "array",
        items: { type: "string" },
        description: "Optional: Key points or highlights extracted from the thought."
      },
      relatedInsights: {
        type: "array",
        items: { type: "string" },
        description: "Optional: IDs of related insights, for semantic linking."
      },
      crossRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            toBranch: { type: "string", description: "Target branch ID for the cross-reference." },
            type: { type: "string", description: "Type of cross-reference (e.g., 'related', 'supports', 'contradicts', etc.)." },
            reason: { type: "string", description: "Optional: Reason or context for the cross-reference." },
            strength: { type: "number", description: "Optional: Numeric strength/confidence of the cross-reference (0-1)." }
          },
          required: ["toBranch", "type"]
        },
        description: "Optional: Array of cross-references to other branches, with type, reason, and strength."
      },
      command: {
        type: "object",
        description: "Optional: Navigation or workflow command. Used for agentic/AI interactions.",
        properties: {
          type: {
            type: "string",
            enum: ["list", "focus", "history", "insights", "crossrefs", "hub-thoughts", "semantic-search", "link-thoughts", "add-snippet", "snippet-search", "summarize-branch", "doc-thought", "extract-tasks", "review-branch", "visualize", "ask"],
            description: "Command type (see tool description for complete list and semantics)."
          },
          branchId: {
            type: "string",
            description: "Branch ID for commands that operate on a specific branch."
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for add-snippet or snippet-search commands."
          },
          author: {
            type: "string",
            description: "Optional: Author or agent for add-snippet command."
          },
          content: {
            type: "string",
            description: "Content for add-snippet, search, or ask commands."
          },
          thoughtId: {
            type: "string",
            description: "Thought ID for doc-thought, link-thoughts, or review commands."
          },
          question: {
            type: "string",
            description: "Free-form question for the ask command (AI/LLM query)."
          },
          query: {
            type: "string",
            description: "Query string for semantic-search, snippet-search, or other search commands."
          },
          topN: {
            type: "number",
            description: "Number of top results to return for semantic-search or snippet-search."
          },
          fromThoughtId: {
            type: "string",
            description: "Source thought ID for link-thoughts or cross-linking commands."
          },
          toThoughtId: {
            type: "string",
            description: "Target thought ID for link-thoughts or cross-linking commands."
          },
          linkType: {
            type: "string",
            description: "Type of link for link-thoughts command (e.g., supports, contradicts, related, expands, refines)."
          },
          reason: {
            type: "string",
            description: "Optional: Reason or context for linking thoughts."
          }
        },
        required: ["type"]
      }
    },
    anyOf: [
      { required: ["content", "type"] },
      { required: ["command"] }
    ]
  }
};

const server = new Server(
  {
    name: "branch-thinking-server",
    version: "0.1.1",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const thinkingServer = new BranchingThoughtServer();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [BRANCHING_THOUGHT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "branch-thinking") {
    return thinkingServer.processThought(request.params.arguments);
  }

  return {
    content: [{
      type: "text",
      text: `Unknown tool: ${request.params.name}`
    }],
    isError: true
  };
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Branch Thinking MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});