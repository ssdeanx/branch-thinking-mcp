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

  processThought(input: unknown): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    try {
      const inputData = input as any;
      
      // Handle commands if present
      if (inputData.command) {
        return this.handleCommand(inputData.command);
      }

      // Handle regular thought input
      const thoughtInput = input as BranchingThoughtInput;
      const thought = this.branchManager.addThought(thoughtInput);
      const branch = this.branchManager.getBranch(thought.branchId)!;
      
      // Format the response with the branch status
      const formattedStatus = this.branchManager.formatBranchStatus(branch);
      console.error(formattedStatus); // Display in the console

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            thoughtId: thought.id,
            branchId: thought.branchId,
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
        }],
        isError: true
      };
    }
  }

  private handleCommand(command: { type: string; branchId?: string }): { content: Array<{ type: string; text: string }> } {
    try {
      switch (command.type) {
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
          const formattedStatus = this.branchManager.formatBranchStatus(branch);
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
          const history = this.branchManager.getBranchHistory(branchId);
          
          return {
            content: [{
              type: "text",
              text: history
            }]
          };
        }

        default:
          throw new Error(`Unknown command: ${command.type}`);
      }
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
}

const BRANCHING_THOUGHT_TOOL: Tool = {
  name: "branch-thinking",
  description: `A tool for managing multiple branches of thought with insights and cross-references.
  
Each thought can:
- Belong to a specific branch
- Generate insights
- Create cross-references to other branches
- Include confidence scores and key points

The system tracks:
- Branch priorities and states
- Relationships between thoughts
- Accumulated insights
- Cross-branch connections

Commands:
- list: Show all branches and their status
- focus [branchId]: Switch focus to a specific branch
- history [branchId?]: Show the history of thoughts in a branch (uses active branch if none specified)`,
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The thought content"
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
            enum: ["list", "focus", "history"],
            description: "Command type"
          },
          branchId: {
            type: "string",
            description: "Branch ID for commands that require it"
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
    version: "0.1.0",
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