// 前后端共享的数据类型定义

export type LearnStatus = 'not_started' | 'in_progress' | 'completed';
export type ExerciseType = 'mcq' | 'cloze' | 'qa';

export interface DirStats {
  total: number;
  completed: number;
  inProgress: number;
}

export interface TreeFileNode {
  type: 'file';
  name: string;
  /** 相对于 learn/ 的 POSIX 路径，作为文档唯一标识 */
  path: string;
  status: LearnStatus;
}

export interface TreeDirNode {
  type: 'dir';
  name: string;
  path: string;
  stats: DirStats;
  children: TreeNode[];
}

export type TreeNode = TreeFileNode | TreeDirNode;

export interface TreeResponse {
  root: TreeDirNode;
  stats: DirStats;
}

export interface DocResponse {
  path: string;
  title: string;
  content: string;
  hash: string;
  mtime: number;
  status: LearnStatus;
}

export interface AppConfigResponse {
  aiConfigured: boolean;
  model: string;
  baseUrl: string;
}

export interface SourceRef {
  quote: string;
  section?: string;
  /** 服务端校验：引用文本是否确实出现在原文中 */
  verified?: boolean;
}

// ---------------- 选择题 ----------------
export interface McqOptionPublic {
  id: string;
  text: string;
}

export interface McqQuestionPublic {
  id: string;
  type: 'single' | 'multiple';
  stem: string;
  options: McqOptionPublic[];
}

export interface McqOptionResult extends McqOptionPublic {
  isCorrect: boolean;
  explanation: string;
  selected: boolean;
}

export interface McqQuestionResult {
  id: string;
  type: 'single' | 'multiple';
  stem: string;
  correct: boolean;
  selectedOptionIds: string[];
  correctOptionIds: string[];
  options: McqOptionResult[];
  explanation: string;
  knowledgePoint?: string;
  source: SourceRef;
}

export interface McqGradeResult {
  type: 'mcq';
  score: number;
  total: number;
  questions: McqQuestionResult[];
  gradedAt: string;
}

// ---------------- 挖空题 ----------------
export interface ClozeBlankPublic {
  id: string;
  /** 文本节点稳定标识，见 shared/markdown.ts */
  nodeId: string;
  /** 在节点文本 value 中的起止位置（UTF-16 下标） */
  start: number;
  end: number;
  /** 答案字符数，用于提示输入框宽度 */
  length: number;
}

export interface ClozeBlankResult {
  id: string;
  nodeId: string;
  userAnswer: string;
  correct: boolean;
  answer: string;
  acceptedAnswers: string[];
  explanation: string;
  knowledgePoint?: string;
  context: string;
}

export interface ClozeGradeResult {
  type: 'cloze';
  score: number;
  total: number;
  blanks: ClozeBlankResult[];
  gradedAt: string;
}

// ---------------- 问答题 ----------------
export interface QaQuestionPublic {
  id: string;
  question: string;
  focus: string;
  difficulty: 'basic' | 'intermediate' | 'advanced';
}

export interface QaEvidence {
  quote: string;
  explanation: string;
  verified?: boolean;
}

export interface QaEvaluation {
  questionId: string;
  answer: string;
  score: number;
  level: 'excellent' | 'good' | 'fair' | 'poor';
  overall: string;
  strengths: string[];
  missingPoints: string[];
  errors: string[];
  suggestions: string[];
  referenceAnswer: string;
  evidence: QaEvidence[];
  evaluatedAt: string;
}

// ---------------- 练习集 ----------------
export interface ExerciseMeta {
  setId: string;
  path: string;
  type: ExerciseType;
  docHash: string;
  promptVersion: string;
  model: string;
  createdAt: string;
  fromCache: boolean;
  /** 被服务端校验丢弃的条目数量 */
  skipped: number;
  warnings: string[];
}

export type PublicExercise =
  | (ExerciseMeta & { type: 'mcq'; questions: McqQuestionPublic[] })
  | (ExerciseMeta & { type: 'cloze'; blanks: ClozeBlankPublic[] })
  | (ExerciseMeta & { type: 'qa'; questions: QaQuestionPublic[] });

export interface ScoreRecord {
  setId: string;
  score: number;
  total: number;
  at: string;
}

export interface DocScores {
  mcq?: ScoreRecord;
  cloze?: ScoreRecord;
  qa?: Record<string, { setId: string; score: number; at: string }>;
  history: Array<ScoreRecord & { type: ExerciseType }>;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: string };
}
