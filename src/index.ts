#!/usr/bin/env node


import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { BranchManager } from './branchManager.js';
import { AutoExecutionPolicy, CommandSafetyValidator, WorkflowPlanner, AutoExecutionPolicyRule } from './autoExecution.js';
import { BranchingThoughtInput, VisualizationOptions } from './types.js';
import chalk from 'chalk';

enum SessionState {
  INIT = 'INIT',
  BRANCH_CREATED = 'BRANCH_CREATED',
  BRANCH_FOCUSED = 'BRANCH_FOCUSED',
  THOUGHT_ADDED = 'THOUGHT_ADDED',
  ACTIVE = 'ACTIVE',
  RESET = 'RESET',
}
class BranchingThoughtServer {
  private autoExecutionPolicy = new AutoExecutionPolicy({
    rules: [
      { type: 'add-thought', safe: true },
      { type: 'focus', safe: true },
      { type: 'create-branch', safe: true },
      { type: 'semantic-search', safe: true },
      { type: 'extract-tasks', safe: true },
      // Add more as needed, user can modify at runtime
    ]
  });
  private commandSafetyValidator = new CommandSafetyValidator(this.autoExecutionPolicy);
  private workflowPlanner = new WorkflowPlanner();
  private sessionState: SessionState = SessionState.INIT;

  // Map session states to allowed commands
  private allowedCommands: Record<SessionState, string[]> = {
    [SessionState.INIT]: ['create-branch', 'list'],
    [SessionState.BRANCH_CREATED]: ['focus', 'list', 'create-branch'],
    [SessionState.BRANCH_FOCUSED]: [
      'add-thought', 'insights', 'crossrefs', 'hub-thoughts', 'semantic-search',
      'link-thoughts', 'add-snippet', 'snippet-search', 'summarize-branch',
      'doc-thought', 'extract-tasks', 'review-branch', 'visualize', 'ask',
      'focus', 'list', 'create-branch', 'history', 'summarize-tasks', 'advance-task', 'assign-task'
    ],
    [SessionState.THOUGHT_ADDED]: [
      'insights', 'crossrefs', 'hub-thoughts', 'semantic-search',
      'link-thoughts', 'add-snippet', 'snippet-search', 'summarize-branch',
      'doc-thought', 'extract-tasks', 'review-branch', 'visualize', 'ask',
      'focus', 'list', 'create-branch', 'history', 'summarize-tasks', 'advance-task', 'assign-task', 'add-thought'
    ],
    [SessionState.ACTIVE]: [
      'add-thought', 'insights', 'crossrefs', 'hub-thoughts', 'semantic-search',
      'link-thoughts', 'add-snippet', 'snippet-search', 'summarize-branch',
      'doc-thought', 'extract-tasks', 'review-branch', 'visualize', 'ask',
      'focus', 'list', 'create-branch', 'history', 'summarize-tasks', 'advance-task', 'assign-task',
      'reset-session', 'clear-cache', 'get-cache-stats'
    ],
    [SessionState.RESET]: ['create-branch', 'list'],
  };

  private updateSessionState(commandType: string) {
    switch (commandType) {
      case 'create-branch':
        this.sessionState = SessionState.BRANCH_CREATED;
        break;
      case 'focus':
        this.sessionState = SessionState.BRANCH_FOCUSED;
        break;
      case 'add-thought':
        this.sessionState = SessionState.THOUGHT_ADDED;
        break;
      case 'reset-session':
        this.sessionState = SessionState.INIT;
        break;
      default:
        if (
          this.sessionState === SessionState.THOUGHT_ADDED ||
          this.sessionState === SessionState.BRANCH_FOCUSED
        ) {
          this.sessionState = SessionState.ACTIVE;
        }
        break;
    }
  }
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
    rule?: AutoExecutionPolicyRule; // for policy management commands
    autoVisualize?: boolean;
  }): Promise<{ content: Array<{ type: string; text: string }> }> {
    console.error(`[CMD] Received command: ${command.type}`);
    try {
      // === Policy Management Commands ===
      if (command.type === 'add-policy-rule' && command.rule) {
        this.autoExecutionPolicy.addRule(command.rule);
        return { content: [{ type: 'text', text: 'Policy rule added.' }] };
      }
      if (command.type === 'remove-policy-rule' && command.rule) {
        this.autoExecutionPolicy.removeRule(command.rule.type, command.rule.pattern);
        return { content: [{ type: 'text', text: 'Policy rule removed.' }] };
      }
      if (command.type === 'list-policy-rules') {
        return { content: [{ type: 'text', text: JSON.stringify(this.autoExecutionPolicy.listRules(), null, 2) }] };
      }
      // === Multi-step Workflow Planning ===
      const workflow = this.workflowPlanner.plan(command);
      let results: Array<{ type: string; text: string }> = [];
      for (const step of workflow) {
        // === Safety Validation ===
        const isSafe = this.commandSafetyValidator.isSafe({ type: step.type, content: step.params.content });
        if (!isSafe) {
          results.push({ type: 'text', text: `Command '${step.type}' is not marked safe for auto-execution. Skipping.` });
          continue;
        }
        // Only execute if allowed in current state
        if (!this.allowedCommands[this.sessionState].includes(step.type)) {
          results.push({ type: 'text', text: `Command '${step.type}' is not allowed in the current session state (${this.sessionState}).` });
          continue;
        }
        // Additional preconditions for branch-dependent commands
        const commandsRequiringBranch = [
          'add-thought', 'insights', 'crossrefs', 'hub-thoughts', 'semantic-search',
          'link-thoughts', 'add-snippet', 'snippet-search', 'summarize-branch',
          'doc-thought', 'extract-tasks', 'review-branch', 'visualize', 'ask',
          'history', 'summarize-tasks', 'advance-task', 'assign-task'
        ];
        if (commandsRequiringBranch.includes(step.type)) {
          const branchId = step.params.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId || !this.branchManager.getBranch(branchId)) {
            results.push({ type: 'text', text: `Command '${step.type}' requires a valid branch. Please create and focus a branch first.` });
            continue;
          }
        }
        // State transition after successful command
        this.updateSessionState(step.type);
        console.error(`[STATE] Session state is now: ${this.sessionState}`);
        // === Actual Command Execution (call original switch) ===
        // Recurse for sub-commands or call switch for atomic ones
        const atomicResult = await this._executeAtomicCommand(step.type, step.params);
        if (atomicResult?.content) results = results.concat(atomicResult.content);
      }
      return { content: results };
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
  // Extracted atomic command executor (original switch/case logic)
  private async _executeAtomicCommand(type: string, params: any): Promise<{ content: Array<{ type: string; text: string }> }> {
    switch (type) {
        case 'create-branch': {
           if (!params.branchId) throw new Error('branchId required for create-branch');
           const branch = this.branchManager.createBranch(params.branchId, params.parentBranchId);
           const content: Array<{ type: string; text: string }> = [{
             type: "text",
             text: `Created branch '${branch.id}'${params.parentBranchId ? ` with parent '${params.parentBranchId}'` : ''}.`
           }];
           if (params.autoVisualize) {
             const options = { branchId: branch.id } as VisualizationOptions;
             const vizData = this.branchManager.visualizeBranch(options);
             content.push({ type: "text", text: JSON.stringify({ visualization: vizData }, null, 2) });
           }
           return { content };
         }
        case 'insights': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
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
          if (!params.branchId) {
            throw new Error('branchId required for focus command');
          }
          this.branchManager.setActiveBranch(params.branchId);
          const branch = this.branchManager.getBranch(params.branchId)!;
          const formattedStatus = await this.branchManager.formatBranchStatus(branch);
          console.error(formattedStatus);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: 'success',
                message: `Now focused on branch: ${params.branchId}`,
                activeBranch: params.branchId
              }, null, 2)
            }]
          };
        }
        case 'history': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) {
            throw new Error('No active branch and no branchId provided');
          }
          const history = await this.branchManager.getBranchHistory(branchId);
          return {
            content: [{
              type: "text",
              text: history
            }]
          };
        }
        case 'crossrefs': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
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
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
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
          if (!('query' in params) || typeof params.query !== 'string') {
            throw new Error('semantic-search requires a query string');
          }
          const query = params.query;
          const topN = typeof params.topN === 'number' ? params.topN : 5;
          // Perform semantic search
          const results = await this.branchManager.semanticSearch(query, topN);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ query, topN, results }, null, 2)
            }]
          };
        }
        case 'link-thoughts': {
          if (!('fromThoughtId' in params) || !('toThoughtId' in params) || !('linkType' in params)) {
            throw new Error('link-thoughts requires fromThoughtId, toThoughtId, and linkType');
          }
          const { fromThoughtId, toThoughtId, linkType, reason } = params;
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
          if (!('content' in params) || typeof params.content !== 'string' || !('tags' in params) || !Array.isArray(params.tags)) throw new Error('add-snippet requires content (string) and tags (array)');
          const snippet = this.branchManager.addSnippet(params.content, params.tags, typeof params.author === 'string' ? params.author : undefined);
          return {
            content: [{
              type: "text",
              text: JSON.stringify(snippet, null, 2)
            }]
          };
        }
        case 'snippet-search': {
          if (!('query' in params) || typeof params.query !== 'string') throw new Error('snippet-search requires a query string');
          const results = this.branchManager.searchSnippets(params.query, typeof params.topN === 'number' ? params.topN : 5);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ results }, null, 2)
            }]
          };
        }
        case 'summarize-branch': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
          if (!branchId) throw new Error('No branchId provided and no active branch.');
          return {
            content: [{
              type: "text",
              text: await this.branchManager.summarizeBranch(branchId)
            }]
          };
        }
        case 'doc-thought': {
          if (!('thoughtId' in params) || typeof params.thoughtId !== 'string') throw new Error('doc-thought requires a thoughtId (string)');
          return {
            content: [{
              type: "text",
              text: await this.branchManager.summarizeThought(params.thoughtId)
            }]
          };
        }
        case 'extract-tasks': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
          const tasks = await this.branchManager.extractTasks(branchId);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, tasks }, null, 2)
            }]
          };
        }
        case 'list-tasks': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
          const status = params.status;
          const assignee = params.assignee;
          const due = params.due;
          const tasks = await this.branchManager.queryTasks({ branchId, status, assignee, due });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ branchId, status, assignee, due, tasks }, null, 2)
            }]
          };
        }
        case 'update-task-status': {
          const taskId = params.taskId;
          const status = params.status;
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
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
          const summary = await this.branchManager.summarizeTasks(branchId);
          return {
            content: [{
              type: "text",
              text: summary
            }]
          };
        }
        case 'review-branch': {
          const branchId = params.branchId || this.branchManager.getActiveBranch()?.id;
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
          // Pass full visualization options
          const options = params as VisualizationOptions;
          const data = this.branchManager.visualizeBranch(options);
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        }
        case 'ask': {
          if (!('question' in params) || typeof params.question !== 'string') throw new Error('ask requires a question string');
          const question = params.question;
          const answer = await this.branchManager.askQuestion(question);
          return {
            content: [{
              type: "text",
              text: answer
            }]
          };
        }
        case 'reset-session': {
          // already transitioned
          return { content: [{ type: "text", text: 'Session has been reset.' }] };
        }
        case 'clear-cache': {
          this.branchManager.clearCache();
          return { content: [{ type: "text", text: 'Cache cleared.' }] };
        }
        case 'get-cache-stats': {
          const stats = this.branchManager.getCacheStats();
          return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
        }
      }
      // Default return for unknown command types
      return {
        content: [{
          type: "text",
          text: `Unknown command type: ${type}`
        }]
      };
    }
  }

const BRANCHING_THOUGHT_TOOL: Tool = {
  name: "branch-thinking",
  description: `
# Branch-Thinking Tool

**Purpose:** Use branching commands to create, navigate, and analyze thought branches and tasks.

**Usage:** Provide a JSON payload with 'type' and relevant parameters in 'args' object. The tool returns an array of items in the format { type: string, text: string }.

**Supported Commands:**
- create-branch: { type: 'create-branch', branchId }
- focus: { type: 'focus', branchId }
- add-thought: { type: 'add-thought', branchId, content }
- semantic-search: { type: 'semantic-search', query, topN? }
- extract-tasks: { type: 'extract-tasks', branchId? }
- visualize: { type: 'visualize', branchId?, options? }
- list-branches: { type: 'list-branches' }
- history: { type: 'history', branchId }
- insights: { type: 'insights', branchId }
- crossrefs: { type: 'crossrefs', branchId }
- hub-thoughts: { type: 'hub-thoughts', branchId }
- link-thoughts: { type: 'link-thoughts', fromThoughtId, toThoughtId, linkType, reason? }
- add-snippet: { type: 'add-snippet', content, tags, author? }
- snippet-search: { type: 'snippet-search', query, topN? }
- summarize-branch: { type: 'summarize-branch', branchId? }
- doc-thought: { type: 'doc-thought', thoughtId }
- review-branch: { type: 'review-branch', branchId? }
- ask: { type: 'ask', question }
- summarize-tasks: { type: 'summarize-tasks', branchId? }
- advance-task: { type: 'advance-task', taskId, status }
- assign-task: { type: 'assign-task', taskId, assignee }
- reset-session: { type: 'reset-session' }
- clear-cache: { type: 'clear-cache' }
- get-cache-stats: { type: 'get-cache-stats' }

**Visualization Options:**
- clustering: { type: 'clustering', algorithm? }
- centrality: { type: 'centrality', metric? }
- overlays: { type: 'overlays', features? }
- analytics: { type: 'analytics', metrics? }

**Example Calls and Expected Responses:**

~~~json
// Add a thought
{ "name": "branch-thinking", "args": { "type": "add-thought", "branchId": "research", "content": "Define MCP best practices" } }
// →
[{"type":"text","text":"Thought added to branch research."}]
~~~

~~~json
// Get insights
{ "name": "branch-thinking", "args": { "type": "insights", "branchId": "research" } }
// →
[{"type":"text","text":"Insights for branch research: ['Best practices cluster around workflow safety and semantic search.', 'Cross-references indicate high reuse of planning patterns.']"}]
~~~

~~~json
// Get cross-references
{ "name": "branch-thinking", "args": { "type": "crossrefs", "branchId": "research" } }
// →
[{"type":"text","text":"Cross-references for branch research: [{ from: 't1', to: 't3', type: 'supports', reason: 't1 evidence for t3' }, { from: 't2', to: 't4', type: 'related' }]"}]
~~~

~~~json
// Extract tasks
{ "name": "branch-thinking", "args": { "type": "extract-tasks", "branchId": "research" } }
// →
[{"type":"text","text":"Tasks extracted: [{ id: 'task-123', content: 'Document MCP safety rules', status: 'open' }]"}]
~~~

~~~json
// Summarize tasks
{ "name": "branch-thinking", "args": { "type": "summarize-tasks", "branchId": "research" } }
// →
[{"type":"text","text":"Task summary: 1 open, 2 in progress, 0 closed."}]
~~~

~~~json
// Advance a task
{ "name": "branch-thinking", "args": { "type": "advance-task", "taskId": "task-123", "status": "in_progress" } }
// →
[{"type":"text","text":"Task task-123 status updated to in_progress."}]
~~~

~~~json
// Assign a task
{ "name": "branch-thinking", "args": { "type": "assign-task", "taskId": "task-123", "assignee": "alice" } }
// →
[{"type":"text","text":"Task task-123 assigned to alice."}]
~~~

~~~json
// Semantic search
{ "name": "branch-thinking", "args": { "type": "semantic-search", "query": "workflow planning", "topN": 3 } }
// →
[{"type":"text","text":"Top 3 semantic matches for 'workflow planning' returned."}]
~~~

~~~json
// Link thoughts
{ "name": "branch-thinking", "args": { "type": "link-thoughts", "fromThoughtId": "t1", "toThoughtId": "t2", "linkType": "supports" } }
// →
[{"type":"text","text":"Linked thought t1 to t2 as 'supports'."}]
~~~

~~~json
// Summarize branch
{ "name": "branch-thinking", "args": { "type": "summarize-branch", "branchId": "research" } }
// →
[{"type":"text","text":"Summary for branch research: ..."}]
~~~

~~~json
// Review branch
{ "name": "branch-thinking", "args": { "type": "review-branch", "branchId": "research" } }
// →
[{"type":"text","text":"Branch research reviewed. 2 suggestions found."}]
~~~
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
          autoVisualize: {
            type: "boolean",
            description: "Optional: Automatically visualize the branch after creation."
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
    version: "0.1.2",
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