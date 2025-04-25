export type BranchState = 'active' | 'suspended' | 'completed' | 'dead_end';
export type InsightType = 'behavioral_pattern' | 'feature_integration' | 'observation' | 'connection';
export type CrossRefType = 'complementary' | 'contradictory' | 'builds_upon' | 'alternative';

export type ThoughtLinkType = 'supports' | 'contradicts' | 'related' | 'expands' | 'refines';

export interface ThoughtLink {
  toThoughtId: string;
  type: ThoughtLinkType;
  reason?: string;
}

export interface ThoughtData {
  id: string;
  content: string;
  branchId: string;
  profileId?: string;
  timestamp: Date;
  metadata: {
    type: string;
    confidence: number;
    keyPoints: string[];
  };
  linkedThoughts?: ThoughtLink[];
  score?: number;
  crossRefs?: Array<{ toThoughtId: string; score: number; type: string }>;
}

export interface Insight {
  id: string;
  type: InsightType;
  content: string;
  context: string[];
  parentInsights?: string[];
  applicabilityScore: number;
  supportingEvidence: {
    crossRefs?: string[];
    pattern?: string;
    data?: string[];
  };
}

export interface CrossReference {
  id: string;
  fromBranch: string;
  toBranch: string;
  type: CrossRefType;
  reason: string;
  strength: number;
  touchpoints: Array<{
    fromThought: string;
    toThought: string;
    connection: string;
  }>;
  relatedInsights?: string[];
}

export interface ThoughtBranch {
  id: string;
  parentBranchId?: string;
  state: BranchState;
  priority: number;
  confidence: number;
  thoughts: ThoughtData[];
  insights: Insight[];
  crossRefs: CrossReference[];
  score?: number; // Average thought score for the branch
}

export interface CodeSnippet {
  id: string;
  content: string;
  tags: string[];
  created: Date;
  author?: string;
}

export interface TaskItem {
  id: string;
  content: string; // The matched task line
  branchId: string;
  thoughtId?: string;
  status: 'open' | 'in_progress' | 'closed';
  type?: string; // e.g., TODO, FIXME, etc.
  assignee?: string;
  due?: string; // ISO date string
  description?: string; // Parsed actionable description
  priority?: number; // 1 (highest) - 5 (lowest)
  createdAt?: string;
  updatedAt?: string;
  creator?: string;
  lastEditor?: string;
  auditTrail?: Array<{ action: string; user: string; timestamp: string }>;
  stale?: boolean;
}

export interface ReviewSuggestion {
  id: string;
  branchId: string;
  thoughtId?: string;
  content: string;
  type: 'improvement' | 'bug' | 'refactor' | 'style' | 'other';
  created: Date;
}

export interface VisualizationNode {
  id: string;
  label: string;
  type: 'thought' | 'branch' | 'insight' | 'crossref' | 'snippet';
}

export interface VisualizationEdge {
  from: string;
  to: string;
  label?: string;
  type?: string;
}

export interface VisualizationData {
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
}

export interface ExternalSearchResult {
  source: string;
  title: string;
  url: string;
  snippet: string;
}

export interface BranchingThoughtInput {
  content: string;
  branchId?: string;
  parentBranchId?: string;
  type: string;
  profileId?: string;
  thoughtCrossRefs?: ThoughtLink[];
  confidence?: number;
  keyPoints?: string[];
  relatedInsights?: string[];
  crossRefs?: Array<{
    toBranch: string;
    type: CrossRefType;
    reason: string;
    strength: number;
  }>;
  // Optionally, allow snippet/task/review fields in input for future extensibility
  snippetContent?: string;
  snippetTags?: string[];
  taskContent?: string;
  reviewContent?: string;
  reviewType?: string;
  skipExtractTasks?: boolean;
}

// Profile for categorizing thoughts
export interface Profile {
  id: string;
  name: string;
  settings: Record<string, any>;
}