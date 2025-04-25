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
    parentBranchId?: string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
      switch (command.type) {
        case 'create-branch': {
          if (!command.branchId) throw new Error('branchId required for create-branch');
          const branch = this.branchManager.createBranch(command.branchId, command.parentBranchId);
          return {
            content: [{
              type: "text",
              text: `Created branch '${branch.id}'${command.parentBranchId ? ` with parent '${command.parentBranchId}'` : ''}.`
            }]
          };
        }
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
        case 'ask': {
          if (!('question' in command) || typeof command.question !== 'string') throw new Error('ask requires a question string');
          const question = command.question;
          const answer = await this.branchManager.askQuestion(question);
          return {
            content: [{
              type: "text",
              text: answer
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
  description: `
# Branch-Thinking Tool

The Branch-Thinking Tool is an AI-powered assistant for managing branching thoughts, tasks, insights, and cross-references. It provides a comprehensive set of commands and workflows to streamline ideation and execution.

## Core Features
- Semantic Search & Embeddings: Retrieve related thoughts via high-quality vector search.
- Visualization: Generate JSON and Mermaid diagrams of thought graphs and tasks.
- Insight Generation: Auto-generate and refine insights from thought metadata.
- Task Management: Extract, list, assign, and advance tasks with audit trails.
- Branch & Profile Management: Create, focus, and manage branches and profiles.

## Commands
- Always start by creating a new branch
- \`create-branch [branchId?]\`: Create a new branch or switch to an existing one.
- \`add-thought [branchId] [content] [--type TYPE] [--keyPoints KP] [--confidence FLOAT] [--profileId ID] [--crossRefs JSON]\`: Add a new thought with optional metadata.
- \`list-branches\`: List all branches with status and active indicator.
- \`focus [branchId]\`: Set the active branch context.
- \`history [branchId?]\`: Display chronological history of thoughts and tasks.
- \`insights [branchId?]\`: Show cached or real-time insights.
- \`crossrefs [branchId?]\`: List cross-references within and across branches.
- \`hub-thoughts [branchId?]\`: Identify top thoughts by score and cross-reference count.
- \`semantic-search [query] [--topN N]\`: Find semantically similar thoughts across branches.
- \`link-thoughts [fromId] [toId] [type] [reason?]\`: Create a semantic link between two thoughts.
- \`extract-tasks [branchId?]\`: Generate actionable tasks.
- \`list-tasks [branchId] [--status STATUS] [--assignee NAME] [--due DATE]\`: List tasks with optional filters.
- \`update-task-status [taskId] [status]\`: Advance a task's status.
- \`summarize-branch [branchId?]\`: Generate a concise summary of branch thoughts and insights.
- \`summarize-tasks [branchId?]\`: Summarize task statuses and key points.
- \`review-branch [branchId?]\`: Get an AI-driven review of branch code or content.
- \`visualize [branchId?]\`: Output JSON and Mermaid diagrams.
- \`add-snippet [content] [tags] [author?]\`: Save code snippets.
- \`snippet-search [query] [--topN N]\`: Search saved snippets.
- \`doc-thought [thoughtId]\`: Generate detailed documentation for a thought.
- \`ask [question]\`: Ask a free-form AI question.

## Quick Start Example
- \`create-branch research_idea\`
- \`focus research_idea\`
- \`add-thought research_idea "Define hypothesis on AI Flow" --type analysis --keyPoints hypothesis,AI --confidence 0.8\`
- \`extract-tasks\`
- \`insights\`
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
            enum: ["create-branch","list","focus","history","insights","crossrefs","hub-thoughts","semantic-search","link-thoughts","add-snippet","snippet-search","summarize-branch","doc-thought","extract-tasks","review-branch","visualize","ask"],
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
          },
          parentBranchId: {
            type: "string",
            description: "Optional: Parent branch ID for hierarchical organization when creating a branch."
          },
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