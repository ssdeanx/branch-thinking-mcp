import chalk from 'chalk';
import { ThoughtBranch, ThoughtData, Insight, CrossReference, InsightType, CrossRefType, BranchingThoughtInput, ThoughtLink, CodeSnippet, TaskItem, ReviewSuggestion, VisualizationData, VisualizationNode, VisualizationEdge, ExternalSearchResult } from './types.js';
import { pipeline, FeatureExtractionPipeline } from '@xenova/transformers';

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
import { LRUCache } from 'lru-cache';

export class BranchManager {
  // --- New feature fields ---
  private snippets: CodeSnippet[] = [];
  private snippetCounter = 0;

  // Embedding pipeline and cache
  private embeddingPipeline: FeatureExtractionPipeline | null = null;
  // Use 'any' for summarization pipeline due to type issues with summary_text property
  private summarizationPipeline: any = null;
  private embeddings: Map<string, number[]> = new Map(); // thoughtId -> embedding

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
  public async summarizeBranchThoughts(branchId: string): Promise<string> {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error('Branch not found');
    const text = branch.thoughts.map(t => t.content).join('\n');
    const summarizer = await this.getSummarizationPipeline();
    const summary = await summarizer(text, { min_length: 20, max_length: 120 });
    // Use 'any' to access summary_text property regardless of output shape
    return Array.isArray(summary) ? (summary as any)[0].summary_text : (summary as any).summary_text;
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
    const truncated = this.truncateText(text);
    const hash = this.hashContent(truncated);
    await this.loadPersistentEmbeddingCache();
    // Check in-memory LRU cache
    if (this.embeddingLRU.has(hash)) {
      return this.embeddingLRU.get(hash)!;
    }
    // Check persistent cache
    if (this.persistentEmbeddingCache[hash]) {
      this.embeddingLRU.set(hash, this.persistentEmbeddingCache[hash].embedding);
      return this.persistentEmbeddingCache[hash].embedding;
    }
    const embeddingPipeline = await this.getEmbeddingPipeline();
    const output = await embeddingPipeline(truncated);
    // MiniLM returns [1, tokens, dim] or { data: [[...]] }
    let tokenVectors: number[][] = Array.isArray(output) ? output[0] : output.data[0];
    // Mean pooling: average across tokens
    const pooled = new Array(tokenVectors[0].length).fill(0);
    for (const vec of tokenVectors) {
      for (let i = 0; i < vec.length; i++) {
        pooled[i] += vec[i];
      }
    }
    for (let i = 0; i < pooled.length; i++) {
      pooled[i] /= tokenVectors.length;
    }
    this.embeddings.set(hash, pooled);
    this.embeddingLRU.set(hash, pooled);
    this.persistentEmbeddingCache[hash] = { embedding: pooled, hash };
    await this.savePersistentEmbeddingCache();
    return pooled;
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
  addThought(input: BranchingThoughtInput | BranchingThoughtInput[]): ThoughtData {
    const inputs = Array.isArray(input) ? input : [input];
    let lastThought: ThoughtData | undefined;
    for (const item of inputs) {
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
        timestamp: new Date(),
        metadata: {
          type: item.type,
          confidence: item.confidence || 1.0,
          keyPoints: item.keyPoints || []
        }
      };
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
        });
      }
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
      branch.insights.push(this.createInsight(
        'behavioral_pattern',
        `Frequent key points detected: ${frequentKeyPoints.join(', ')}`,
        frequentKeyPoints
      ));
    }
    // Simple sentiment analysis: count positive/negative/neutral
    let pos = 0, neg = 0, neu = 0;
    const positiveWords = ['good', 'great', 'positive', 'success', 'improve'];
    const negativeWords = ['bad', 'fail', 'negative', 'problem', 'issue'];
    branch.thoughts.forEach(t => {
      const lc = t.content.toLowerCase();
      if (positiveWords.some(w => lc.includes(w))) pos++;
      else if (negativeWords.some(w => lc.includes(w))) neg++;
      else neu++;
    });
    if (pos || neg) {
      const sentiment = pos > neg ? 'positive' : (neg > pos ? 'negative' : 'mixed');
      branch.insights.push(this.createInsight(
        'observation',
        `Branch sentiment trend: ${sentiment} (${pos} positive, ${neg} negative, ${neu} neutral)`,
        []
      ));
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
      const number = chalk.gray(`${i + 1}.`);
      const content = t.content;
      const type = chalk.yellow(`[${t.metadata.type}]`);
      const points = t.metadata.keyPoints.length > 0 
        ? chalk.green(`\n   Key Points: ${t.metadata.keyPoints.join(', ')}`)
        : '';
      return `${number} ${timestamp} ${type}\n   ${content}${points}`;
    }).join('\n\n');
    const insights = branch.insights.map(i =>
      chalk.yellow(`→ ${i.content}`)
    ).join('\n');
    // --- New: snippets, tasks, reviews ---
    const snippets = this.snippets.filter(s => s.tags.includes(branchId));
    const snippetSection = snippets.length
      ? chalk.cyan(`Snippets:\n${snippets.map(s => `  - ${s.content.slice(0, 40)} [${s.tags.join(', ')}]`).join('\n')}`)
      : '';

    const tasks = await this.extractTasks(branchId);
    const taskSection = tasks.length
      ? chalk.magenta(`Tasks:\n${tasks.map((t: TaskItem) => `  - ${t.content}`).join('\n')}`)
      : '';

    const reviews = await this.reviewBranch(branchId);
    const reviewSection = reviews.length
      ? chalk.red(`Reviews:\n${reviews.map((r: ReviewSuggestion) => `  - ${r.content}`).join('\n')}`)
      : '';

    const result = `
┌─────────────────────────────────────────────
│ ${header}
├─────────────────────────────────────────────
${timeline}
${snippetSection ? `\n├─────────────────────────────────────────────\n│ ${snippetSection}` : ''}
${taskSection ? `\n├─────────────────────────────────────────────\n│ ${taskSection}` : ''}
${reviewSection ? `\n├─────────────────────────────────────────────\n│ ${reviewSection}` : ''}
${insights ? `\n├─────────────────────────────────────────────\n│ Insights:\n${insights}` : ''}
└─────────────────────────────────────────────`;
    this.historyCache.set(branchId, result);
    return result;
  }

  async formatBranchStatus(branch: ThoughtBranch): Promise<string> {
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

    const tasks = await this.extractTasks(branch.id);
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
    return result;
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
    const tasks = branchId ? this.tasks.filter(t => t.branchId === branchId) : this.tasks;
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

  public validateAssignee(user: string): boolean {
    // TODO: Validate user/assignee (stub)
    return true;
  }


  // --- Code Snippet Management ---
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

  // --- Visualization ---
  public visualizeBranch(branchId?: string): VisualizationData {
    // Simple graph: nodes = thoughts, branches; edges = crossrefs, links
    const nodes: VisualizationNode[] = [];
    const edges: VisualizationEdge[] = [];
    const branches = branchId ? [this.getBranch(branchId)!] : Array.from(this.branches.values());
    for (const branch of branches) {
      nodes.push({ id: branch.id, label: branch.id, type: 'branch' });
      for (const thought of branch.thoughts) {
        nodes.push({ id: thought.id, label: thought.content.slice(0, 30), type: 'thought' });
        edges.push({ from: branch.id, to: thought.id, label: 'has', type: 'thought' });
        if (thought.linkedThoughts) {
          for (const link of thought.linkedThoughts) {
            edges.push({ from: thought.id, to: link.toThoughtId, label: link.type, type: 'link' });
          }
        }
      }
      for (const crossRef of branch.crossRefs) {
        edges.push({ from: branch.id, to: crossRef.toBranch, label: crossRef.type, type: 'crossref' });
      }
    }
    return { nodes, edges };
  }

  // --- Smart Q&A (stub) ---
  public async askQuestion(question: string): Promise<string> {
    // Placeholder: In real implementation, use AI/LLM
    return `AI answer to: ${question}`;
  }
}