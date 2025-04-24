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
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, visualization: data }, null, 2)
            }]
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
  description: `# Branch-Thinking Tool: Advanced Knowledge and Coding Workflow Assistant

## How to Use
- Add a Thought: Provide a string (the thought content) and specify the branch. Optionally include metadata (type, confidence, key points).
- Batch Add: Submit an array of thought objects to add multiple thoughts or insights at once.
- Automatic Cross-Referencing: Thoughts are linked to the most semantically similar thoughts (direct and multi-hop, up to 3 hops) across all branches. Cross-references include a similarity score and type ("very similar", "related", "multi-hop").
- Scoring: Each thought and branch gets a dynamic score based on semantic centrality, recency, diversity, confidence, and key points.

## Commands
- list — Show all branches and their status, including aggregate scores.
- focus [branchId] — Switch focus to a specific branch for targeted thinking.
- history [branchId?] — View the chronological history of thoughts in a branch.
- insights [branchId?] — Retrieve recent, AI-generated insights for a branch.
- crossrefs [branchId?] — Show all cross-references for a branch.
- hub-thoughts [branchId?] — List thoughts with the highest cross-branch connections/scores.
- semantic-search [query] — Find thoughts similar to a query (using embeddings).
- list-tasks [branchId] [status] [assignee] [due] — List tasks for a branch, filterable by status, assignee, or due date.
- update-task-status [taskId] [status] — Update a task's status (currently stateless mode).
- summarize-tasks [branchId] — Show a summary of open/in progress/closed tasks for a branch.
- link-thoughts [fromThoughtId] [toThoughtId] [linkType] [reason?] — Link two thoughts explicitly.
- add-snippet [content] [tags] — Add a reusable code snippet with tags.
- snippet-search [query] — Search for relevant code snippets.
- summarize-branch [branchId?] — Generate a summary of all thoughts in a branch.
- doc-thought [thoughtId] — Generate documentation for a specific thought.
- extract-tasks [branchId?] — List actionable items or TODOs from a branch.
- review-branch [branchId?] — Get AI suggestions for code or thought improvements in a branch.
- visualize [branchId?] — Generate a visual graph of branch connections and cross-references.
- ask [question] — Get an AI-generated answer using the knowledge base.

Note: New commands may be added in the future. To see all supported commands, check the handleCommand method in src/index.ts.

## Best Practices
- Use batch mode to quickly capture brainstorms or meeting notes.
- Regularly review high-scoring thoughts and branches for action or deeper work.
- Follow cross-references and multi-hop links to discover non-obvious connections and foster creativity.
- Leverage scores to identify "hub" thoughts or ideas that bridge multiple areas.

## Example Usage
- Add a new thought: { content: "Refactor the API for clarity", branchId: "dev" }
- Batch add: [ { content: "Explore AI search integration", branchId: "features" }, { content: "Document scoring algorithm", branchId: "docs" } ]
- Switch focus: focus dev
- Get insights: insights features
- Show cross-references: crossrefs dev
- List hub thoughts: hub-thoughts features
- Semantic search: semantic-search "improve documentation"
- Link thoughts: link-thoughts thought-1 thought-2 supports "Thought 1 supports Thought 2"

This tool is ideal for advanced coding, research, and knowledge management workflows where deep connection and prioritization of ideas is critical.`,
  inputSchema: {
    type: "object",
    properties: {
      content: {
        oneOf: [
          { type: "string", description: "The thought content" },
          { type: "array", items: { type: "object" }, description: "Batch: array of thought objects" }
        ],
        description: "The thought content or batch of thoughts"
      },
      branchId: {
        type: "string",
        description: "Optional: ID of the branch (generated if not provided)"
      },
      parentBranchId: {
        type: "string",
        description: "Optional: ID of the parent branch"
      },
      type: {
        type: "string",
        description: "Type of thought (e.g., 'analysis', 'hypothesis', 'observation')"
      },
      confidence: {
        type: "number",
        description: "Optional: Confidence score (0-1)"
      },
      keyPoints: {
        type: "array",
        items: { type: "string" },
        description: "Optional: Key points identified in the thought"
      },
      relatedInsights: {
        type: "array",
        items: { type: "string" },
        description: "Optional: IDs of related insights"
      },
      crossRefs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            toBranch: { type: "string" },
            type: { type: "string" },
            reason: { type: "string" },
            strength: { type: "number" }
          }
        },
        description: "Optional: Cross-references to other branches"
      },
      command: {
        type: "object",
        description: "Optional: Navigation command",
        properties: {
          type: {
            type: "string",
            enum: ["list", "focus", "history", "insights", "crossrefs", "hub-thoughts", "semantic-search", "link-thoughts", "add-snippet", "snippet-search", "summarize-branch", "doc-thought", "extract-tasks", "review-branch", "visualize", "ask"],
            description: "Command type"
          },
          branchId: {
            type: "string",
            description: "Branch ID for commands that require it"
           },
           tags: {
             type: "array",
             items: { type: "string" },
             description: "Tags for add-snippet command"
           },
           author: {
             type: "string",
             description: "Optional author for add-snippet command"
           },
           content: {
             type: "string",
             description: "Snippet content for add-snippet command"
           },
           thoughtId: {
             type: "string",
             description: "Thought ID for doc-thought command"
           },
           question: {
             type: "string",
             description: "Question for ask command"
           },
           query: {
            type: "string",
            description: "Query string for semantic-search command"
          },
          topN: {
            type: "number",
            description: "Number of top results to return for semantic-search"
          },
          fromThoughtId: {
            type: "string",
            description: "Source thought ID for link-thoughts command"
          },
          toThoughtId: {
            type: "string",
            description: "Target thought ID for link-thoughts command"
          },
          linkType: {
            type: "string",
            description: "Type of link for link-thoughts command (supports, contradicts, related, expands, refines)"
          },
          reason: {
            type: "string",
            description: "Optional reason for the link (link-thoughts command)"
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