import chalk from 'chalk';
import { ThoughtBranch, ThoughtData, Insight, CrossReference, InsightType, CrossRefType, BranchingThoughtInput, ThoughtLink, CodeSnippet, TaskItem, ReviewSuggestion, VisualizationData, VisualizationNode, VisualizationEdge, ExternalSearchResult, Profile, VisualizationOptions } from './types.js';
import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';
import { LRUCache } from 'lru-cache';

/**
 * Embedding cache for node/thought embeddings.
 * Uses LRU and TTL for freshness and memory efficiency.
 */
const EMBEDDING_CACHE_TTL = 1000 * 60 * 30; // 30 minutes
const EMBEDDING_CACHE_MAX = 1000;

/**
 * Summary cache for expensive summarization results.
 * Uses LRU and TTL for speed and freshness.
 */
const SUMMARY_CACHE_TTL = 1000 * 60 * 5; // 5 minutes
const SUMMARY_CACHE_MAX = 100;

import * as _ from 'lodash';
import graphlibPkg from '@dagrejs/graphlib';
import type { Graph as GraphType } from '@dagrejs/graphlib';
const { Graph, alg } = graphlibPkg as typeof import('@dagrejs/graphlib');
import { kmeans } from 'ml-kmeans';

// Cosine similarity for two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class BranchManager {
  /**
   * Embedding cache with LRU and TTL.
   */
  private embeddingCache = new LRUCache<string, number[]>({ max: EMBEDDING_CACHE_MAX, ttl: EMBEDDING_CACHE_TTL });
  /**
   * Summary cache for branch summaries (LRU+TTL).
   */
  private summaryCache = new LRUCache<string, string>({ max: SUMMARY_CACHE_MAX, ttl: SUMMARY_CACHE_TTL });

  // --- New feature fields ---
  private snippets: CodeSnippet[] = [];
  private snippetCounter = 0;

  // Embedding pipeline and cache
  private embeddingPipeline: FeatureExtractionPipeline | null = null;
  // Use 'any' for summarization pipeline due to type issues with summary_text property
  private summarizationPipeline: any = null;
  private embeddings: Map<string, number[]> = new Map(); // thoughtId -> embedding

  // Flag to optionally skip automatic task extraction
  private skipNextTaskExtraction: boolean = false;

  /**
   * Invalidate caches for a given thought or branch. Call after mutation.
   */
  private invalidateCachesFor(thoughtId?: string, branchId?: string) {
    if (thoughtId) this.embeddingCache.delete(thoughtId);
    if (branchId) this.summaryCache.delete(branchId);
    // Add more cache invalidations as needed
  }

  // Example: Call this.invalidateCachesFor when a thought/branch/task is updated.


  /**
   * Load the summarization pipeline if not already loaded.
   */
  private async getSummarizationPipeline(): Promise<any> {
    if (!this.summarizationPipeline) {
      this.summarizationPipeline = await pipeline('summarization', 'Xenova/distilbart-cnn-6-6');
    }
    return this.summarizationPipeline;
  }

  /**
   * Summarize all thoughts in a branch as a digest.
   */
  /**
   * Summarize all thoughts in a branch as a digest, using cache for speed.
   * @param branchId The branch to summarize
   */
  public async summarizeBranchThoughts(branchId: string): Promise<string> {
    if (this.summaryCache.has(branchId)) return this.summaryCache.get(branchId)!;
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error('Branch not found');
    const text = branch.thoughts.map(t => t.content).join('\n');
    const summarizer = await this.getSummarizationPipeline();
    const summary = await summarizer(text, { min_length: 20, max_length: 120 });
    const result = Array.isArray(summary) ? (summary as any)[0].summary_text : (summary as any).summary_text;
    this.summaryCache.set(branchId, result);
    return result;
  }


  /**
   * Load the embedding pipeline (MiniLM) if not already loaded.
   */
  private async getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.embeddingPipeline) {
      this.embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return this.embeddingPipeline;
  }

  // Truncate text to 512 tokens (OpenAI/transformers style) for embedding speed
  private truncateText(text: string, maxTokens = 512): string {
    try {
      // Synchronously import js-tiktoken
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { encoding_for_model } = require("js-tiktoken");
      // Always use o200k_base for compatibility with modern models
      const enc = encoding_for_model("o200k_base");
      const tokens = enc.encode(text);
      if (tokens.length > maxTokens) {
        return enc.decode(tokens.slice(0, maxTokens));
      }
      return text;
    } catch (err) {
      // Fallback: word-based truncation
      const words = text.split(/\s+/);
      return words.length > maxTokens ? words.slice(0, maxTokens).join(' ') : text;
    }
  }

  // Compute a simple hash for content
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash |= 0;
    }
    return hash.toString();
  }

  // Load persistent embedding cache from disk (JSON)
  private persistentEmbeddingPath = './embeddings-cache.json';
  private persistentEmbeddingCache: Record<string, { embedding: number[]; hash: string }> = {};
  private persistentCacheLoaded = false;

  private async loadPersistentEmbeddingCache() {
    if (this.persistentCacheLoaded) return;
    try {
      const fs = await import('fs/promises');
      const data = await fs.readFile(this.persistentEmbeddingPath, 'utf8');
      this.persistentEmbeddingCache = JSON.parse(data);
    } catch (e) {
      this.persistentEmbeddingCache = {};
    }
    this.persistentCacheLoaded = true;
  }

  private async savePersistentEmbeddingCache() {
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(this.persistentEmbeddingPath, JSON.stringify(this.persistentEmbeddingCache), 'utf8');
    } catch (e) {}
  }

  // LRU cache for embeddings (in-memory)
  private embeddingLRU = new LRUCache<string, number[]>({ max: 256 });

  /**
   * Compute an embedding for a given text.
   */
  /**
   * Compute an embedding for a given text.
   * Uses token-based truncation (o200k_base) for consistent input length.
   * Handles pooling for MiniLM-style output.
   */
  public async embedText(text: string): Promise<number[]> {
    const key = this.hashContent(text);
    // Check LRU first for fastest access
    if (this.embeddingLRU.has(key)) {
      return this.embeddingLRU.get(key)!;
    }
    // Fallback to larger embeddingCache
    if (this.embeddingCache.has(key)) {
      const emb = this.embeddingCache.get(key)!;
      // Promote to LRU for faster future access
      this.embeddingLRU.set(key, emb);
      return emb;
    }
    const pipeline = await this.getEmbeddingPipeline();
    const truncated = this.truncateText(text);
    // Execute pipeline and extract array data
    const rawOutput: any = await pipeline(truncated, { pooling: 'mean', normalize: true });
    // rawOutput may be an array or an object with 'data' property
    const arr: any[] = Array.isArray(rawOutput)
      ? rawOutput
      : Array.isArray(rawOutput.data)
      ? rawOutput.data
      : ([] as any[]);
    const first = arr[0];
    const embedding: number[] = Array.isArray(first)
      ? (first as number[])
      : (Array.isArray(arr) ? (arr as unknown as number[]) : []);
    // Set in both caches
    this.embeddingLRU.set(key, embedding);
    this.embeddingCache.set(key, embedding);
    return embedding;
  }

  /**
   * Compute and store embeddings for all thoughts (batch & parallelized, only new/changed).
   */
  public async embedAllThoughts(): Promise<void> {
    await this.loadPersistentEmbeddingCache();
    const tasks: Promise<void>[] = [];
    for (const branch of this.branches.values()) {
      for (const thought of branch.thoughts) {
        // Use token-based truncation for hashing and embedding
        tasks.push((async () => {
          const truncated = this.truncateText(thought.content);
          const hash = this.hashContent(truncated);
          // Only embed if not in persistent cache or content changed
          if (!this.persistentEmbeddingCache[hash]) {
            const emb = await this.embedText(thought.content);
            this.embeddings.set(thought.id, emb);
          } else {
            this.embeddings.set(thought.id, this.persistentEmbeddingCache[hash].embedding);
          }
        })());
      }
    }
    // Batch/parallelize up to 8 at a time
    for (let i = 0; i < tasks.length; i += 8) {
      await Promise.all(tasks.slice(i, i + 8));
    }
    await this.savePersistentEmbeddingCache();
    await this.updateAllCrossRefsAndScores();
  }

  /**
   * Compute pairwise similarity for all thoughts in each branch. Store top cross-refs and update scores.
   */
  // Configurable cross-ref similarity threshold
  private crossRefThreshold = 0.7;

  // Helper: recency bonus (1 if <1d, 0.5 if <7d, else 0)
  private recencyBonus(ts: Date): number {
    const now = Date.now();
    const diffMs = now - new Date(ts).getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays < 1) return 1;
    if (diffDays < 7) return 0.5;
    return 0;
  }

  // Helper: diversity bonus (unique branchIds in cross-refs, normalized)
  private diversityBonus(crossRefs: { toThoughtId: string; branchId?: string }[], allThoughts: ThoughtData[]): number {
    const ids = new Set<string>();
    for (const cr of crossRefs) {
      const t = allThoughts.find(t => t.id === cr.toThoughtId);
      if (t) ids.add(t.branchId);
    }
    return Math.min(ids.size / 5, 1); // up to 1.0 if 5+ branches
  }

  public async updateAllCrossRefsAndScores(): Promise<void> {
    // Build a flat map of all thoughts for diversity
    const allThoughts: ThoughtData[] = [];
    for (const branch of this.branches.values()) {
      allThoughts.push(...branch.thoughts);
    }
    // Cross-ref and score per branch
    for (const branch of this.branches.values()) {
      const thoughts = branch.thoughts;
      const embeddings = thoughts.map(t => this.embeddings.get(t.id));
      // Build cross-ref candidates with threshold/type
      for (let i = 0; i < thoughts.length; i++) {
        const t = thoughts[i];
        const embA = embeddings[i];
        if (!embA) continue;
        const sims: { toThoughtId: string; score: number; type: string }[] = [];
        for (let j = 0; j < allThoughts.length; j++) {
          if (thoughts[i].id === allThoughts[j].id) continue;
          const embB = this.embeddings.get(allThoughts[j].id);
          if (!embB) continue;
          const sim = cosineSimilarity(embA, embB);
          if (sim > this.crossRefThreshold) {
            let type = sim > 0.85 ? 'very similar' : 'related';
            sims.push({ toThoughtId: allThoughts[j].id, score: sim, type });
          }
        }
        // Sort and keep top 3
        t.crossRefs = sims.sort((a, b) => b.score - a.score).slice(0, 3).map(cr => ({ toThoughtId: cr.toThoughtId, score: cr.score, type: cr.type }));
      }
    }
    // Bidirectional links: if A cross-refs B, ensure B links to A if mutual
    for (const branch of this.branches.values()) {
      for (const t of branch.thoughts) {
        if (!t.crossRefs) continue;
        for (const cr of t.crossRefs) {
          const other = allThoughts.find(x => x.id === cr.toThoughtId);
          if (!other) continue;
          if (!other.crossRefs) other.crossRefs = [];
          if (!other.crossRefs.find(x => x.toThoughtId === t.id)) {
            // Only add if similarity is mutual (above threshold)
            const embA = this.embeddings.get(t.id);
            const embB = this.embeddings.get(other.id);
            if (embA && embB) {
              const sim = cosineSimilarity(embA, embB);
              if (sim > this.crossRefThreshold) {
                other.crossRefs.push({ toThoughtId: t.id, score: sim, type: sim > 0.85 ? 'very similar' : 'related' });
                // Keep only top 3
                other.crossRefs.sort((a, b) => b.score - a.score);
                other.crossRefs = other.crossRefs.slice(0, 3);
              }
            }
          }
        }
      }
    }
    // Multi-hop (2-hop and 3-hop)
    const multiHopThreshold = 0.5;
    for (const t of allThoughts) {
      if (!t.crossRefs) continue;
      const directIds = new Set(t.crossRefs.map(cr => cr.toThoughtId));
      // 2-hop
      for (const cr1 of t.crossRefs) {
        const t2 = allThoughts.find(x => x.id === cr1.toThoughtId);
        if (!t2 || !t2.crossRefs) continue;
        for (const cr2 of t2.crossRefs) {
          if (cr2.toThoughtId === t.id || directIds.has(cr2.toThoughtId)) continue;
          // Path score = min(sim1, sim2)
          const pathScore = Math.min(cr1.score, cr2.score);
          if (pathScore > multiHopThreshold && !(t.crossRefs.find(x => x.toThoughtId === cr2.toThoughtId))) {
            t.crossRefs.push({ toThoughtId: cr2.toThoughtId, score: pathScore, type: 'multi-hop' });
          }
        }
      }
      // 3-hop
      for (const cr1 of t.crossRefs) {
        const t2 = allThoughts.find(x => x.id === cr1.toThoughtId);
        if (!t2 || !t2.crossRefs) continue;
        for (const cr2 of t2.crossRefs) {
          const t3 = allThoughts.find(x => x.id === cr2.toThoughtId);
          if (!t3 || !t3.crossRefs) continue;
          for (const cr3 of t3.crossRefs) {
            if (cr3.toThoughtId === t.id || directIds.has(cr3.toThoughtId) || t.crossRefs.find(x => x.toThoughtId === cr3.toThoughtId && x.type === 'multi-hop')) continue;
            // Path score = min(sim1, sim2, sim3)
            const pathScore = Math.min(cr1.score, cr2.score, cr3.score);
            if (pathScore > multiHopThreshold) {
              t.crossRefs.push({ toThoughtId: cr3.toThoughtId, score: pathScore, type: 'multi-hop' });
            }
          }
        }
      }
      // Optionally, keep only top 6 (direct+multi-hop)
      t.crossRefs.sort((a, b) => b.score - a.score);
      t.crossRefs = t.crossRefs.slice(0, 6);
    }
    // Scoring
    for (const branch of this.branches.values()) {
      for (const t of branch.thoughts) {
        const directSum = t.crossRefs ? t.crossRefs.filter(cr => cr.type !== 'multi-hop').reduce((sum, cr) => sum + cr.score, 0) : 0;
        const multiHopSum = t.crossRefs ? t.crossRefs.filter(cr => cr.type === 'multi-hop').reduce((sum, cr) => sum + cr.score, 0) : 0;
        const degree = t.crossRefs ? t.crossRefs.length : 0;
        const recency = this.recencyBonus(t.timestamp);
        const diversity = t.crossRefs ? this.diversityBonus(t.crossRefs, allThoughts) : 0;
        const confidence = t.metadata.confidence || 0;
        const keyPoints = t.metadata.keyPoints?.length || 0;
        t.score = 0.5 * directSum + 0.25 * multiHopSum + 0.2 * degree + 0.1 * recency + 0.1 * diversity + 0.2 * confidence + 0.1 * keyPoints;
      }
      branch['score'] = branch.thoughts.length > 0 ? branch.thoughts.reduce((sum, t) => sum + (t.score || 0), 0) / branch.thoughts.length : 0;
    }
  }

  /**
   * Semantic search: find top N most similar thoughts to a query.
   */
  public async semanticSearch(query: string, topN: number = 5): Promise<{ thought: ThoughtData; score: number }[]> {
    await this.embedAllThoughts();
    const queryEmb = await this.embedText(query);
    // Compute cosine similarity
    const scores: { thought: ThoughtData; score: number }[] = [];
    for (const branch of this.branches.values()) {
      for (const thought of branch.thoughts) {
        const emb = this.embeddings.get(thought.id);
        if (emb) {
          const score = cosineSimilarity(queryEmb, emb);
          scores.push({ thought, score });
        }
      }
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, topN);
  }

  /**
   * Link two thoughts (across any branches) with a semantic relation.
   * @param fromThoughtId The source thought ID
   * @param toThoughtId The target thought ID
   * @param type The type of link (supports, contradicts, etc.)
   * @param reason Optional reason for the link
   */
  public linkThoughts(fromThoughtId: string, toThoughtId: string, type: 'supports' | 'contradicts' | 'related' | 'expands' | 'refines', reason?: string): boolean {
    const from = this.findThoughtById(fromThoughtId);
    const to = this.findThoughtById(toThoughtId);
    if (!from || !to) return false;
    if (!from.linkedThoughts) from.linkedThoughts = [];
    // Prevent duplicate links
    if (!from.linkedThoughts.some(l => l.toThoughtId === toThoughtId && l.type === type)) {
      from.linkedThoughts.push({ toThoughtId, type, reason });
      return true;
    }
    return false;
  }

  /**
   * Retrieve all linked thoughts for a given thought ID, across all branches.
   */
  public getLinkedThoughts(thoughtId: string): { thought: ThoughtData; link: ThoughtLink }[] {
    const thought = this.findThoughtById(thoughtId);
    if (!thought || !thought.linkedThoughts) return [];
    return thought.linkedThoughts
      .map(link => {
        const t = this.findThoughtById(link.toThoughtId);
        if (t) return { thought: t, link };
        return null;
      })
      .filter((x): x is { thought: ThoughtData; link: ThoughtLink } => x !== null);
  }

  /**
   * Utility: Find a thought by ID across all branches.
   */
  public findThoughtById(thoughtId: string): ThoughtData | undefined {
    for (const branch of this.branches.values()) {
      const t = branch.thoughts.find(th => th.id === thoughtId);
      if (t) return t;
    }
    return undefined;
  }

  private branches: Map<string, ThoughtBranch> = new Map();
  private insightCounter = 0;
  private thoughtCounter = 0;
  private crossRefCounter = 0;
  private activeBranchId: string | null = null;

  // LRU caches
  private historyCache = new LRUCache<string, string>({ max: 32 });
  private statusCache = new LRUCache<string, string>({ max: 32 });
  private insightsCache = new LRUCache<string, Insight[]>({ max: 64 });

  generateId(prefix: string): string {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    return `${prefix}-${timestamp}-${random}`;
  }

  createBranch(branchId: string, parentBranchId?: string): ThoughtBranch {
    const branch: ThoughtBranch = {
      id: branchId,
      parentBranchId,
      state: 'active',
      priority: 1.0,
      confidence: 1.0,
      thoughts: [],
      insights: [],
      crossRefs: []
    };
    this.branches.set(branchId, branch);
    // Set as active if it's the first branch
    if (!this.activeBranchId) {
      this.activeBranchId = branchId;
    }
    return branch;
  }

  private createInsight(
    type: InsightType,
    content: string,
    context: string[],
    parentInsights?: string[]
  ): Insight {
    return {
      id: `insight-${++this.insightCounter}`,
      type,
      content,
      context,
      parentInsights,
      applicabilityScore: 1.0,
      supportingEvidence: {}
    };
  }

  private createCrossReference(
    fromBranch: string,
    toBranch: string,
    type: CrossRefType,
    reason: string,
    strength: number
  ): CrossReference {
    return {
      id: `xref-${++this.crossRefCounter}`,
      fromBranch,
      toBranch,
      type,
      reason,
      strength,
      touchpoints: []
    };
  }

  /**
   * Add one or more thoughts and/or insights to a branch.
   * Accepts a single BranchingThoughtInput or an array of them.
   * Returns the last ThoughtData added (for compatibility).
   */
  public addThought(input: BranchingThoughtInput | BranchingThoughtInput[]): ThoughtData {
    const inputs = Array.isArray(input) ? input : [input];
    // Set skip flag for next status/history task extraction
    this.skipNextTaskExtraction = inputs.some(item => item.skipExtractTasks === true);
    let lastThought: ThoughtData | undefined;
    for (const item of inputs) {
      // Validate content
      if (!item.content || !item.content.trim()) {
        throw new Error('Thought content cannot be empty');
      }
      // Validate and assign profile if provided
      if (item.profileId && !this.profiles.has(item.profileId)) {
        throw new Error(`Profile not found: ${item.profileId}`);
      }
      // Use active branch if no branchId provided
      const branchId = item.branchId || this.activeBranchId || this.generateId('branch');
      let branch = this.branches.get(branchId);
      if (!branch) {
        branch = this.createBranch(branchId, item.parentBranchId);
      }
      const thought: ThoughtData = {
        id: `thought-${++this.thoughtCounter}`,
        content: item.content,
        branchId: branch.id,
        profileId: item.profileId,
        timestamp: new Date(),
        metadata: {
          type: item.type,
          confidence: item.confidence || 1.0,
          keyPoints: item.keyPoints || []
        }
      };
      // Compute thought score
      let score = thought.metadata.confidence;
      score += thought.metadata.keyPoints.length * 0.1;
      score += (item.crossRefs?.length || 0) * 0.2;
      score += (item.thoughtCrossRefs?.length || 0) * 0.2;
      thought.score = score;
      // Auto-generate a simple insight per thought
      const simpleInsight = this.createInsight(
        'observation',
        `Auto-generated insight from thought: ${thought.content.slice(0, 50)}`,
        [thought.id]
      );
      branch.insights.push(simpleInsight);
      this.insightsCache.set(branch.id, branch.insights.slice(-10));
      // Add thought-level cross references if provided
      if (item.thoughtCrossRefs) {
        thought.linkedThoughts = item.thoughtCrossRefs.map(ref => ({
          toThoughtId: ref.toThoughtId,
          type: ref.type,
          reason: ref.reason
        }));
      }
      branch.thoughts.push(thought);
      lastThought = thought;
      // Create insights if key points are provided
      if (item.keyPoints) {
        const insight = this.createInsight(
          'observation',
          `Identified key points: ${item.keyPoints.join(', ')}`,
          [item.type],
          item.relatedInsights
        );
        branch.insights.push(insight);
        // Update insights cache for this branch
        this.insightsCache.set(branchId, branch.insights.slice(-10));
      }
      // Create cross references if specified
      if (item.crossRefs) {
        item.crossRefs.forEach(ref => {
          const crossRef = this.createCrossReference(
            branch!.id,
            ref.toBranch,
            ref.type,
            ref.reason,
            ref.strength
          );
          branch!.crossRefs.push(crossRef);
          // Auto-reverse cross reference on target branch
          const targetBranch = this.branches.get(ref.toBranch);
          if (targetBranch) {
            const reverseCr = this.createCrossReference(
              ref.toBranch,
              branch!.id,
              ref.type,
              `[Auto] ${ref.reason}`,
              ref.strength
            );
            targetBranch.crossRefs.push(reverseCr);
          }
        });
      }
      // Auto-generate advanced insights per thought
      this.generateAdvancedInsights(branch);

      this.updateBranchMetrics(branch);
      // Invalidate caches for this branch
      this.historyCache.delete(branchId);
      this.statusCache.delete(branchId);
    }
    return lastThought!;
  }

  /**
   * Analyze thoughts in a branch for advanced insight generation.
   * Adds new insights for frequent key points and sentiment trends.
   */
  public generateAdvancedInsights(branch: ThoughtBranch): void {
    // Prepare linking: existing insight IDs
    const parentIds: string[] = branch.insights.map(i => i.id);
    // Analyze frequent key points
    const keyPointCounts: Record<string, number> = {};
    branch.thoughts.forEach(t => {
      (t.metadata.keyPoints || []).forEach(kp => {
        keyPointCounts[kp] = (keyPointCounts[kp] || 0) + 1;
      });
    });
    const frequentKeyPoints = Object.entries(keyPointCounts)
      .filter(([_, count]) => count > 1)
      .map(([kp]) => kp);
    if (frequentKeyPoints.length > 0) {
      const insight = this.createInsight(
        'behavioral_pattern',
        `Frequent key points detected: ${frequentKeyPoints.join(', ')}`,
        frequentKeyPoints,
        parentIds
      );
      branch.insights.push(insight);
      this.insightsCache.set(branch.id, branch.insights.slice(-10));
      // Auto cross-reference new insight to prior insights
      parentIds.forEach(pid => {
        const cr = this.createCrossReference(
          branch.id,
          branch.id,
          'builds_upon',
          `Insight ${insight.id} builds on ${pid}`,
          1.0
        );
        branch.crossRefs.push(cr);
      });
      parentIds.push(insight.id);
    }
    // Simple sentiment analysis: count positive/negative/neutral
    let pos = 0, neg = 0, neu = 0;
    const positiveWords = ['good', 'great', 'positive', 'success', 'improve', 'yes'];
    const negativeWords = ['bad', 'fail', 'negative', 'problem', 'issue', 'no'];
    branch.thoughts.forEach(t => {
      const lc = t.content.toLowerCase();
      if (positiveWords.some(w => lc.includes(w))) pos++;
      else if (negativeWords.some(w => lc.includes(w))) neg++;
      else neu++;
    });
    if (pos || neg) {
      const sentiment = pos > neg ? 'positive' : (neg > pos ? 'negative' : 'mixed');
      const insight = this.createInsight(
        'observation',
        `Branch sentiment trend: ${sentiment} (${pos} positive, ${neg} negative, ${neu} neutral)`,
        [],
        parentIds
      );
      branch.insights.push(insight);
      this.insightsCache.set(branch.id, branch.insights.slice(-10));
      // Auto cross-reference new sentiment insight to prior insights
      parentIds.forEach(pid => {
        const cr = this.createCrossReference(
          branch.id,
          branch.id,
          'builds_upon',
          `Insight ${insight.id} builds on ${pid}`,
          1.0
        );
        branch.crossRefs.push(cr);
      });
    }
  }

  /**
   * Smarter prioritization: combines confidence, insight score, cross-ref, recency, diversity.
   */
  private updateBranchMetrics(branch: ThoughtBranch): void {
    const avgConfidence = branch.thoughts.reduce((sum, t) => sum + t.metadata.confidence, 0) / branch.thoughts.length;
    const insightScore = branch.insights.reduce((sum, i) => sum + (i.applicabilityScore || 1), 0) * 0.1;
    const crossRefScore = branch.crossRefs.reduce((sum, ref) => sum + ref.strength, 0) * 0.1;
    // Recency: newer thoughts boost priority
    const now = Date.now();
    const recencyScore = branch.thoughts.length > 0 ? Math.max(0, 1 - ((now - branch.thoughts[branch.thoughts.length-1].timestamp.getTime()) / (1000*60*60))) : 0;
    // Diversity: number of unique key points
    const keyPointSet = new Set(branch.thoughts.flatMap(t => t.metadata.keyPoints || []));
    const diversityScore = keyPointSet.size * 0.05;
    branch.priority = avgConfidence + insightScore + crossRefScore + recencyScore + diversityScore;
    branch.confidence = avgConfidence;
  }

  getBranch(branchId: string): ThoughtBranch | undefined {
    return this.branches.get(branchId);
  }

  getAllBranches(): ThoughtBranch[] {
    return Array.from(this.branches.values());
  }

  getActiveBranch(): ThoughtBranch | undefined {
    return this.activeBranchId ? this.branches.get(this.activeBranchId) : undefined;
  }

  setActiveBranch(branchId: string): void {
    if (!this.branches.has(branchId)) {
      throw new Error(`Branch ${branchId} not found`);
    }
    this.activeBranchId = branchId;
  }

  /**
   * Get cached insights for a branch, or the latest from the branch if not cached.
   */
  public getCachedInsights(branchId: string): Insight[] {
    const cached = this.insightsCache.get(branchId);
    if (cached) return cached;
    const branch = this.branches.get(branchId);
    if (!branch) return [];
    const insights = branch.insights.slice(-10);
    this.insightsCache.set(branchId, insights);
    return insights;
  }

  async getBranchHistory(branchId: string): Promise<string> {
    // Try cache first
    const cached = this.historyCache.get(branchId);
    if (cached) return cached;
    const branch = this.branches.get(branchId);
    if (!branch) {
      throw new Error(`Branch ${branchId} not found`);
    }
    const header = chalk.blue(`History for branch: ${branchId} (${branch.state})`);
    const timeline = branch.thoughts.map((t, i) => {
      const timestamp = t.timestamp.toLocaleTimeString();
      return `│ [${timestamp}] ${t.content}`;
    }).join('\n');
    // Optionally skip task extraction
    const tasks = this.skipNextTaskExtraction ? [] : await this.extractTasks(branchId);
    const taskLines = tasks.map(t => `│ [Task] ${t.content}`).join('\n');
    const insights = branch.insights.slice(-10).map(i => `│ [Insight] ${i.content}`).join('\n');
    const result = `
┌─────────────────────────────────────────────
│ ${header}
├─────────────────────────────────────────────
${timeline}
${insights ? `\n├─────────────────────────────────────────────\n${insights}` : ''}
${taskLines ? `\n├─────────────────────────────────────────────\n${taskLines}` : ''}
└─────────────────────────────────────────────`;
    this.historyCache.set(branchId, result);
    // Reset skip flag
    this.skipNextTaskExtraction = false;
    return result;
  }

  // Format branch status
  public async formatBranchStatus(branch: ThoughtBranch): Promise<string> {
    // Try cache first
    const cached = this.statusCache.get(branch.id);
    if (cached) return cached;
    const isActive = branch.id === this.activeBranchId;
    const header = `${chalk.blue('Branch:')} ${branch.id} (${branch.state})${isActive ? chalk.green(' [ACTIVE]') : ''}`;
    const stats = `Priority: ${branch.priority.toFixed(2)} | Confidence: ${branch.confidence.toFixed(2)}`;
    const thoughts = branch.thoughts.map(t => 
      `  ${chalk.green('•')} ${t.content} (${t.metadata.type})`
    ).join('\n');
    const insights = branch.insights.map(i =>
      `  ${chalk.yellow('→')} ${i.content}`
    ).join('\n');
    const crossRefs = branch.crossRefs.map(r =>
      `  ${chalk.magenta('↔')} ${r.toBranch}: ${r.reason} (${r.strength.toFixed(2)})`
    ).join('\n');
    // --- New: snippets, tasks, reviews ---
    const snippets = this.snippets.filter(s => s.tags.includes(branch.id));
    const snippetSection = snippets.length
      ? chalk.cyan(`Snippets:\n${snippets.map(s => `  - ${s.content.slice(0, 40)} [${s.tags.join(', ')}]`).join('\n')}`)
      : '';

    // Optionally skip automatic task extraction
    const tasks = this.skipNextTaskExtraction ? [] : await this.extractTasks(branch.id);
    const taskSection = tasks.length
      ? chalk.magenta(`Tasks:\n${tasks.map((t: TaskItem) => `  - ${t.content}`).join('\n')}`)
      : '';

    const reviews = await this.reviewBranch(branch.id);
    const reviewSection = reviews.length
      ? chalk.red(`Reviews:\n${reviews.map((r: ReviewSuggestion) => `  - ${r.content}`).join('\n')}`)
      : '';

    const result = `
┌─────────────────────────────────────────────
│ ${header}
│ ${stats}
├─────────────────────────────────────────────
│ Thoughts:
${thoughts}
${snippetSection ? `│ ${snippetSection}\n` : ''}${taskSection ? `│ ${taskSection}\n` : ''}${reviewSection ? `│ ${reviewSection}\n` : ''}│ Insights:
${insights}
│ Cross References:
${crossRefs}
└─────────────────────────────────────────────`;
    this.statusCache.set(branch.id, result);
    // Reset skip flag after formatting
    this.skipNextTaskExtraction = false;
    return result;
  }

  /**
   * Merge one branch into another, transferring thoughts, insights, and cross-references.
   */
  public mergeBranches(sourceBranchId: string, targetBranchId: string): ThoughtBranch {
    const source = this.branches.get(sourceBranchId);
    const target = this.branches.get(targetBranchId);
    if (!source || !target) {
      throw new Error(`Cannot merge: branch not found`);
    }
    // Transfer content
    target.thoughts.push(...source.thoughts);
    target.insights.push(...source.insights);
    target.crossRefs.push(...source.crossRefs);
    this.updateBranchMetrics(target);
    // Remove source branch
    this.branches.delete(sourceBranchId);
    if (this.activeBranchId === sourceBranchId) {
      this.activeBranchId = targetBranchId;
    }
    return target;
  }

  // ... (other methods remain unchanged)

  public searchSnippets(query: string, topN: number = 5): CodeSnippet[] {
    // Simple search: match query in content or tags
    const lower = query.toLowerCase();
    const matches = this.snippets.filter(s =>
      s.content.toLowerCase().includes(lower) ||
      s.tags.some(tag => tag.toLowerCase().includes(lower))
    );
    // Sort by recency
    return matches.sort((a, b) => b.created.getTime() - a.created.getTime()).slice(0, topN);
  }

  // --- Automated Documentation Generation ---
  public async summarizeBranch(branchId: string): Promise<string> {
    return this.summarizeBranchThoughts(branchId); // Uses existing summarization pipeline
  }

  public async summarizeThought(thoughtId: string): Promise<string> {
    const thought = this.findThoughtById(thoughtId);
    if (!thought) throw new Error('Thought not found');
    // Use summarization pipeline on single thought
    const summarizer = await this.getSummarizationPipeline();
    const summary = await summarizer(thought.content, { min_length: 10, max_length: 60 });
    return Array.isArray(summary) ? (summary as any)[0].summary_text : (summary as any).summary_text;
  }

  // --- Automated Task and Issue Extraction ---
  // --- Persistent Task Store ---
  private taskStorePath = './.tasks.json';
  private tasks: TaskItem[] = [];

  private async loadTasks(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      const raw = await fs.readFile(this.taskStorePath, 'utf8');
      this.tasks = JSON.parse(raw).tasks || [];
    } catch (e) {
      this.tasks = [];
    }
  }

  private async saveTasks(): Promise<void> {
    try {
      const fs = await import('fs/promises');
      await fs.writeFile(this.taskStorePath, JSON.stringify({ tasks: this.tasks }, null, 2), 'utf8');
    } catch (e) {}
  }

  /**
   * Query tasks by various filters
   */
  public async queryTasks({ branchId, status, assignee, due, priority }: { branchId?: string, status?: string, assignee?: string, due?: string, priority?: number }): Promise<TaskItem[]> {
    await this.loadTasks();
    let tasks = this.tasks;
    if (branchId) tasks = tasks.filter(t => t.branchId === branchId);
    if (status) tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee);
    if (due) tasks = tasks.filter(t => t.due === due);
    if (priority) tasks = tasks.filter(t => t.priority === priority);
    // Sort by priority, due, status
    tasks = tasks.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || (a.due ? new Date(a.due).getTime() : 0) - (b.due ? new Date(b.due).getTime() : 0));
    return tasks;
  }

  /**
   * Summarize task stats for a branch or all branches
   */
  public async summarizeTasks(branchId?: string): Promise<string> {
    await this.loadTasks();
    const tasks = branchId
      ? this.tasks.filter(t => t.branchId === branchId)
      : this.tasks;
    const open = tasks.filter(t => t.status === 'open');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const closed = tasks.filter(t => t.status === 'closed');
    const stale = tasks.filter(t => t.stale);
    return [
      `Total tasks: ${tasks.length}`,
      `Open: ${open.length}`,
      `In Progress: ${inProgress.length}`,
      `Closed: ${closed.length}`,
      `Stale: ${stale.length}`
    ].join('\n');
  }

  // --- Task Extraction and Management ---
/**
 * Extract actionable tasks from thoughts in a branch.
 * Updates persistent task store and returns the array of tasks.
 */
public async extractTasks(branchId?: string): Promise<TaskItem[]> {
  await this.loadTasks();
  const branches = branchId ? [this.getBranch(branchId)].filter(Boolean) : Array.from(this.branches.values());
  const taskRegex = /(?<type>TODO|FIXME|ACTION|TASK)(?:\((?<assignee>\w+)\))?:?\s*(?<description>.+?)(?:\s+by\s+(?<due>\d{4}-\d{2}-\d{2}))?(?=\n|$)/gi;
  let foundTasks: TaskItem[] = [];
  for (const branch of branches) {
    if (!branch) continue;
    for (const thought of branch.thoughts) {
      let match: RegExpExecArray | null;
      while ((match = taskRegex.exec(thought.content)) !== null) {
        const { type, assignee, description, due } = match.groups || {};
        const task: TaskItem = {
          id: `task-${branch.id}-${thought.id}-${match.index}`,
          branchId: branch.id,
          thoughtId: thought.id,
          type: type || 'TASK',
          content: description?.trim() || '',
          status: 'open',
          assignee: assignee || '',
          due: due || '',
          priority: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          creator: '',
          lastEditor: '',
          auditTrail: [],
          stale: false
        };
        // Avoid duplicate tasks
        if (!this.tasks.some(t => t.id === task.id)) {
          this.tasks.push(task);
        }
        foundTasks.push(task);
      }
    }
  }
  await this.saveTasks();
  return foundTasks;
}

// --- Contextual Code Review and Suggestions ---
  // --- Improved Code Review (ESLint stub) ---
  public async reviewBranch(branchId: string): Promise<ReviewSuggestion[]> {
    const branch = this.getBranch(branchId);
    if (!branch) throw new Error('Branch not found');
    const reviews: ReviewSuggestion[] = [];
    for (const thought of branch.thoughts) {
      // Use ESLint CLI for JS/TS code blocks (stub)
      if (/```[jt]s([\s\S]+?)```/gi.test(thought.content)) {
        // TODO: Integrate ESLint CLI and parse output for actionable suggestions
        reviews.push({
          id: `review-${branchId}-${thought.id}`,
          branchId,
          thoughtId: thought.id,
          content: `Static analysis review: (stub) found code block in thought`,
          type: 'improvement',
          created: new Date()
        });
      } else if (/bad|fix|improve|refactor|bug/i.test(thought.content)) {
        reviews.push({
          id: `review-${branchId}-${thought.id}`,
          branchId,
          thoughtId: thought.id,
          content: `Review suggested: ${thought.content}`,
          type: 'improvement',
          created: new Date()
        });
      }
    }
    return reviews;
  }

  // --- Task Status Update ---
/**
 * Update the status of a task in the persistent store.
 */
public async updateTaskStatus(taskId: string, status: 'open' | 'in_progress' | 'closed', user: string = ''): Promise<boolean> {
  await this.loadTasks();
  const idx = this.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return false;
  const task = this.tasks[idx];
  const oldStatus = task.status;
  task.status = status;
  task.updatedAt = new Date().toISOString();
  task.lastEditor = user;
  if (!task.auditTrail) task.auditTrail = [];
  task.auditTrail.push({
    timestamp: new Date().toISOString(),
    action: `Status changed from ${oldStatus} to ${status}`,
    user
  });
  await this.saveTasks();
  return true;
}

// --- External Tool Integration Stubs ---
  public async syncTasksWithGitHub(): Promise<void> {
    // TODO: Implement GitHub Issues sync (stub)
    // For each open task, create/update a GitHub Issue
  }

  public async notifyTask(user: string, task: TaskItem): Promise<void> {
    // TODO: Send notification (Slack/email) (stub)
  }
  /**
   * Visualize one or more branches as a graph structure with advanced metadata for agent guidance.
   *
   * - Clusters nodes using k-means (on embeddings if available, else degree)
   * - Adds cluster label and color
   * - Adds node metadata: task status, priority, next-action
   * - Uses graphlib for centrality (agent can focus on key nodes)
   * - Supports focusNode and multi-branch visualization
   *
   * @param options VisualizationOptions (branchId, branches, focusNode, etc.)
   * @returns VisualizationData with nodes, edges, and meta
   */
  /**
   * Compute closeness centrality for a graph.
   */
  private computeClosenessCentrality(g: GraphType): Record<string, number> {
    const centrality: Record<string, number> = {};
    for (const nodeId of g.nodes()) {
      const result = alg.dijkstra(g, nodeId);
      let sum = 0;
      let reachable = 0;
      for (const { distance } of Object.values(result)) {
        if (distance < Infinity) {
          sum += distance;
          reachable++;
        }
      }
      centrality[nodeId] = sum > 0 ? (reachable - 1) / sum : 0;
    }
    return centrality;
  }

  public visualizeBranch(options: VisualizationOptions = {}): VisualizationData {
    // Destructure options with defaults
    const {
      branchId,
      branches: optBranches,
      showClusters = true,
      edgeBundling = false,
      focusNode,
      levelOfDetail: lod = 'auto'
    } = options;

    // Determine branches to include
    const branchIds = optBranches ?? (branchId ? [branchId] : Array.from(this.branches.keys()));
    const branches = branchIds.map(id => this.getBranch(id)).filter(Boolean) as ThoughtBranch[];

    // Initialize graph and containers
    const g = new Graph({ directed: true });
    let nodes: VisualizationNode[] = [];
    let edges: VisualizationEdge[] = [];

    // Build nodes and edges
    for (const branch of branches) {
      g.setNode(branch.id);
      nodes.push({ id: branch.id, label: branch.id, type: 'branch' });
      for (const thought of branch.thoughts) {
        const label = thought.content.slice(0, 30);
        g.setNode(thought.id);
        nodes.push({ id: thought.id, label, type: 'thought' });
        g.setEdge(branch.id, thought.id);
        edges.push({ from: branch.id, to: thought.id });
        if (thought.linkedThoughts) {
          for (const link of thought.linkedThoughts) {
            g.setEdge(thought.id, link.toThoughtId);
            edges.push({ from: thought.id, to: link.toThoughtId, label: link.type, type: 'link' });
          }
        }
      }
      for (const cross of branch.crossRefs) {
        g.setEdge(branch.id, cross.toBranch);
        edges.push({ from: branch.id, to: cross.toBranch, label: cross.type, type: 'crossref' });
      }
    }

    // Deduplicate
    nodes = _.uniqBy(nodes, 'id');
    edges = _.uniqWith(edges, (a, b) => a.from === b.from && a.to === b.to);

    // Determine detail level
    const detail: 'low' | 'medium' | 'high' = lod === 'auto'
      ? (nodes.length > 100 ? 'medium' : 'high')
      : lod;

    // Container for analytics
    const analytics: Record<string, any> = {};

    // Clustering
    if (showClusters && detail !== 'low') {
      const useEmbeddings = this.embeddings.size >= nodes.length / 2;
      const features = nodes.map(n => useEmbeddings
        ? this.embeddings.get(n.id) || [0]
        : [(g.inEdges(n.id)?.length || 0) + (g.outEdges(n.id)?.length || 0)]
      );
      const k = Math.max(2, Math.round(Math.sqrt(nodes.length / 2)));
      try {
        const result = kmeans(features, k, { initialization: 'kmeans++', maxIterations: 100 });
        analytics.centroids = result.centroids;
        analytics.clusters = result.clusters;
        // Annotate nodes
        nodes = nodes.map((n, i) => ({
          ...n,
          cluster: result.clusters[i],
          clusterLabel: `Cluster ${result.clusters[i]}`,
          clusterColor: `hsl(${(result.clusters[i] * 30)}, 70%, 50%)`
        }));
      } catch {}
      // Group by cluster
      analytics.clusterGroups = _.groupBy(nodes, 'cluster');
    }

    // Centrality
    if (detail !== 'low') {
      const central = this.computeClosenessCentrality(g);
      analytics.centrality = central;
      nodes = nodes.map(n => ({
        ...n,
        centrality: central[n.id],
        highlight: focusNode === n.id
      }));
    }

    // High-detail analytics
    if (detail === 'high') {
      try { analytics.cycles = alg.findCycles(g); } catch {}
      try { analytics.topsort = alg.topsort(g); } catch {}
      if (focusNode && g.hasNode(focusNode)) {
        try { analytics.shortestPaths = alg.dijkstra(g, focusNode); } catch {}
      }
    }

    // Edge bundling stub
    if (edgeBundling) {
      analytics.edgeBundles = _.groupBy(edges, e => `${e.from}->${e.to}`);
    }

    // Task metadata
    nodes = nodes.map(n => {
      const task = this.tasks.find(t => t.id === n.id);
      if (task) {
        return { ...n, taskStatus: task.status, taskPriority: task.priority, nextAction: task.status !== 'closed' };
      }
      return n;
    });

    // Return combined result
    return {
      nodes,
      edges,
      meta: { ...options, ...analytics }
    };
  }

  // --- Code Snippet Management ---
  /**
   * Add a code snippet to the manager.
   * @param content The code content
   * @param tags Tags for the snippet
   * @param author Optional author
   * @returns The saved CodeSnippet
   */
  public addSnippet(content: string, tags: string[], author?: string): CodeSnippet {
    const snippet: CodeSnippet = {
      id: `snippet-${++this.snippetCounter}`,
      content,
      tags,
      created: new Date(),
      author
    };
    this.snippets.push(snippet);
    return snippet;
  }

  // --- Smart Q&A (stub) ---
  /**
   * Ask a question about the branch/thoughts (stub for AI/LLM)
   * @param question The question to answer
   * @returns AI-generated answer (stub)
   */
  public async askQuestion(question: string): Promise<string> {
    // Placeholder: In real implementation, use AI/LLM
    return `AI answer to: ${question}`;
  }

  // --- Profile management ---
  private profiles: Map<string, Profile> = new Map();

  /**
   * Create a new profile for thoughts.
   * @param name The profile name
   * @returns The created Profile
   */
  public createProfile(name: string): Profile {
    const id = this.generateId('profile');
    const profile: Profile = { id, name, settings: {} };
    this.profiles.set(id, profile);
    return profile;
  }

  /**
   * Get a profile by ID.
   * @param id Profile ID
   * @returns The Profile or undefined
   */
  public getProfile(id: string): Profile | undefined {
    return this.profiles.get(id);
  }

  /** Retrieve all tasks for a branch or all tasks */
  public async getTasks(branchId?: string): Promise<TaskItem[]> {
    await this.loadTasks();
    return branchId
      ? this.tasks.filter(t => t.branchId === branchId)
      : this.tasks;
  }

  /** Get the next open task by creation time */
  public async getNextTask(branchId?: string): Promise<TaskItem | null> {
    await this.loadTasks();
    const openTasks = (branchId
      ? this.tasks.filter(t => t.branchId === branchId)
      : this.tasks).filter(t => t.status === 'open');
    if (openTasks.length === 0) return null;
    openTasks.sort((a, b) => (new Date(a.createdAt!).getTime()) - (new Date(b.createdAt!).getTime()));
    return openTasks[0];
  }

  /** Advance a task's status */
  public async advanceTask(taskId: string, nextStatus: 'open' | 'in_progress' | 'closed'): Promise<boolean> {
    return this.updateTaskStatus(taskId, nextStatus);
  }

  /** Assign a task to a user */
  public async assignTask(taskId: string, assignee: string): Promise<boolean> {
    await this.loadTasks();
    const task = this.tasks.find(t => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.assignee = assignee;
    task.lastEditor = assignee;
    task.auditTrail = task.auditTrail || [];
    task.auditTrail.push({ action: `Assigned to ${assignee}`, user: assignee, timestamp: new Date().toISOString() });
    await this.saveTasks();
    return true;
  }

  /**
   * Clear all in-memory and persistent caches
   */
  public clearCache(): void {
    this.embeddingCache.clear();
    this.embeddings.clear();
    this.persistentEmbeddingCache = {};
  }

  /**
   * Get statistics about current caches
   */
  public getCacheStats(): Record<string, number> {
    return {
      embeddingCacheSize: this.embeddingCache.size,
      embeddingsMapSize: this.embeddings.size,
      persistentCacheEntries: Object.keys(this.persistentEmbeddingCache).length,
      snippetCount: this.snippets.length,
    };
  }

  /**
   * Cache for visualization analytics (e.g., from visualizeBranch).
   * Uses LRU and short TTL to speed repeated agent requests.
   */
  private analyticsCache = new LRUCache<string, VisualizationData>({ max: 50, ttl: 1000 * 60 * 5 }); // 5 min

  /**
   * Get or compute embedding for a thought and cache it.
   */
  private async getOrCreateEmbedding(thoughtId: string, content: string): Promise<number[]> {
    if (this.embeddingCache.has(thoughtId)) return this.embeddingCache.get(thoughtId)!;
    const pipeline = await this.getEmbeddingPipeline();
    const text = this.truncateText(content);
    const embeddingResult = await pipeline(text, {});
    // embeddingResult may be numeric[][]; take first token vector and flatten
    const vector = Array.isArray(embeddingResult) && Array.isArray((embeddingResult as any)[0])
      ? (embeddingResult as any)[0] as number[]
      : (embeddingResult as any) as number[];
    this.embeddingCache.set(thoughtId, vector);
    this.embeddings.set(thoughtId, vector);
    return vector;
  }

  /**
   * Prefetch embeddings for all thoughts in a branch.
   */
  private async prefetchEmbeddingsForBranch(branch: ThoughtBranch): Promise<void> {
    for (const t of branch.thoughts) {
      // fire-and-forget
      this.getOrCreateEmbedding(t.id, t.content).catch(() => {});
    }
  }

  /**
   * Prefetch caches for a branch: summary, embeddings, and optional analytics.
   * @param branchId The branch to prefetch
   * @param advanced When true, also precompute full visualization analytics
   */
  public async prefetchBranchCaches(branchId: string, advanced = false): Promise<void> {
    const branch = this.branches.get(branchId);
    if (!branch) return;
    // 1. Prefetch summary
    this.summarizeBranchThoughts(branchId).catch(() => {});
    // 2. Prefetch embeddings
    this.prefetchEmbeddingsForBranch(branch);
    // 3. Prefetch analytics if advanced
    if (advanced) {
      const key = branchId;
      if (!this.analyticsCache.has(key)) {
        // compute in background
        setImmediate(() => {
          try {
            const viz = this.visualizeBranch({ branchId, showClusters: true, edgeBundling: true, levelOfDetail: 'high' });
            this.analyticsCache.set(key, viz);
          } catch {}
        });
      }
    }
  }

  /**
   * Retrieve cached analytics or compute+cache if missing.
   */
  public getCachedAnalytics(branchId: string): VisualizationData {
    if (this.analyticsCache.has(branchId)) {
      return this.analyticsCache.get(branchId)!;
    }
    const viz = this.visualizeBranch({ branchId, showClusters: true, edgeBundling: true, levelOfDetail: 'high' });
    this.analyticsCache.set(branchId, viz);
    return viz;
  }
}