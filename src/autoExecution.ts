// AutoExecutionPolicy, CommandSafetyValidator, and WorkflowPlanner for autonomous agent execution
// No import needed for BranchManager here; remove unused import.


export type CommandType = string;

export interface AutoExecutionPolicyRule {
  type: CommandType;
  pattern?: RegExp; // Optional pattern to match command content
  safe: boolean;   // Whether this command is safe to auto-execute
}

export interface AutoExecutionPolicyConfig {
  rules: AutoExecutionPolicyRule[];
}

export class AutoExecutionPolicy {
  private rules: AutoExecutionPolicyRule[] = [];

  constructor(config?: AutoExecutionPolicyConfig) {
    if (config?.rules) this.rules = config.rules;
  }

  isAutoExecutable(command: { type: string; content?: string }): boolean {
    for (const rule of this.rules) {
      if (rule.type === command.type) {
        if (rule.pattern) {
          if (command.content && rule.pattern.test(command.content)) {
            return rule.safe;
          }
        } else {
          return rule.safe;
        }
      }
    }
    return false;
  }

  addRule(rule: AutoExecutionPolicyRule) {
    this.rules.push(rule);
  }

  removeRule(type: CommandType, pattern?: RegExp) {
    this.rules = this.rules.filter(r => r.type !== type || (pattern && r.pattern?.toString() !== pattern.toString()));
  }

  listRules() {
    return this.rules;
  }
}

export class CommandSafetyValidator {
  constructor(private policy: AutoExecutionPolicy) {}

  isSafe(command: { type: string; content?: string }): boolean {
    return this.policy.isAutoExecutable(command);
  }
}

// WorkflowPlanner: breaks down complex commands into atomic steps
export interface WorkflowStep {
  type: CommandType;
  params: Record<string, any>;
}

export class WorkflowPlanner {
  // For demo: simple hardcoded breakdowns; extend with LLM or rules as needed
  plan(command: { type: string; [key: string]: any }): WorkflowStep[] {
    switch (command.type) {
      case 'complex-task':
        // Example: break into sub-steps
        return [
          { type: 'create-branch', params: { branchId: command.branchId } },
          { type: 'focus', params: { branchId: command.branchId } },
          { type: 'add-thought', params: { branchId: command.branchId, content: command.content } },
        ];
      default:
        return [{ type: command.type, params: { ...command } }];
    }
  }
}
