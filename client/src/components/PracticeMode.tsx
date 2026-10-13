// 练习模式：选择题 / 原文挖空 / 问答题，题目按顺序分配到左右两栏
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CircleCheck, Loader2, RefreshCw, RotateCcw, Sparkles, WifiOff } from 'lucide-react';
import type { ClozeBlankResult, ExerciseType, McqGradeResult, ClozeGradeResult, PublicExercise } from '@shared/types';
import { useExercises, type StoredQa } from '../store';
import { api, ApiError } from '../lib/api';
import { MarkdownView } from './MarkdownView';
import { McqCard } from './McqCard';
import { QaCard } from './QaCard';
import { toast } from './Toasts';

const TAB_LABEL: Record<ExerciseType, string> = { mcq: '选择题', cloze: '原文挖空', qa: '问答题' };

interface Props {
  docPath: string;
  content: string;
  title: string;
  aiConfigured: boolean;
  onNavigate: (path: string, hash: string) => void;
  onBlocked: (reason: string) => void;
  onGotoReview: () => void;
  docHash: string;
}

export function PracticeMode({ docPath, content, title, aiConfigured, onNavigate, onBlocked, onGotoReview, docHash }: Props) {
  const {
    sets,
    answers,
    results,
    qa,
    activeTab,
    loading,
    errors,
    setActiveTab,
    generate,
    setAnswer,
    setQaDraft,
    setQaEvaluation,
    submit,
    resetAnswers,
    cancelGenerate,
  } = useExercises();

  const [qaLoading, setQaLoading] = useState<string | null>(null);
  const [qaError, setQaError] = useState<string | null>(null);
  const qaController = useRef<AbortController | null>(null);

  // 离开练习模式时中止未完成的点评请求
  useEffect(() => () => qaController.current?.abort(), []);
  const set = sets[activeTab];
  const stale = Boolean(set && set.docHash !== docHash);

  const docAnswers = answers[docPath] ?? { mcq: {}, cloze: {} };
  const docResults = results[docPath] ?? {};
  const docQa = qa[docPath] ?? {};

  const clozeResults = useMemo(() => {
    const map: Record<string, ClozeBlankResult> = {};
    for (const b of docResults.cloze?.blanks ?? []) map[b.id] = b;
    return map;
  }, [docResults.cloze]);

  const allClozeResults = (docResults.cloze?.blanks ?? []).length > 0;

  // 题目分布在左右两栏
  const distribute = <T,>(items: T[]): [T[], T[]] => {
    const mid = Math.ceil(items.length / 2);
    return [items.slice(0, mid), items.slice(mid)];
  };

  const totals = {
    mcq: sets.mcq ? { done: Object.keys(docAnswers.mcq).length, total: sets.mcq.type === 'mcq' ? sets.mcq.questions.length : 0 } : null,
    cloze: sets.cloze ? { done: Object.values(docAnswers.cloze).filter((v) => v.trim()).length, total: sets.cloze.type === 'cloze' ? sets.cloze.blanks.length : 0 } : null,
    qa: sets.qa
      ? {
          done: Object.values(docQa).filter((s) => s?.evaluation).length,
          total: sets.qa.type === 'qa' ? sets.qa.questions.length : 0,
        }
      : null,
  };

  const handleQaSubmit = async (questionId: string, answer: string) => {
    if (!set || set.type !== 'qa') return;
    qaController.current?.abort();
    const controller = new AbortController();
    qaController.current = controller;
    setQaLoading(questionId);
    setQaError(null);
    try {
      const { evaluation } = await api.evaluate(set.setId, questionId, answer, controller.signal);
      setQaEvaluation(docPath, questionId, { ...evaluation });
      toast('已获得点评');
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'cancelled') toast('已取消点评');
      else setQaError(e.message);
    } finally {
      if (qaController.current === controller) {
        qaController.current = null;
        setQaLoading(null);
      }
    }
  };

  const cancelQa = () => {
    qaController.current?.abort();
    qaController.current = null;
    setQaLoading(null);
  };

  const renderHeader = () => (
    <div className="practice__head">
      <div className="segmented" role="tablist" aria-label="题型">
        {(['mcq', 'cloze', 'qa'] as ExerciseType[]).map((t) => (
          <button key={t} role="tab" aria-selected={activeTab === t} onClick={() => setActiveTab(t)}>
            {TAB_LABEL[t]}
            {totals[t] ? ` ${totals[t]!.done}/${totals[t]!.total}` : ''}
          </button>
        ))}
      </div>
      <span style={{ flex: 1 }} />
      {set && <span className="pill">共 {set.type === 'mcq' || set.type === 'qa' ? set.questions.length : set.blanks.length} 题</span>}
      {set && <span className="pill">{set.fromCache ? '来自缓存' : '刚刚生成'}</span>}
      {set && (
        <button
          className="btn"
          onClick={() => generate(docPath, activeTab, true).then(() => toast('已重新生成练习'))}
          disabled={Boolean(loading[activeTab])}
          title="忽略缓存，重新调用 DeepSeek 生成"
        >
          <RefreshCw size={14} /> 重新生成
        </button>
      )}
      {activeTab !== 'qa' && set && docResults[activeTab] && (
        <button className="btn" onClick={() => resetAnswers(docPath, activeTab)}>
          <RotateCcw size={14} /> 重新作答
        </button>
      )}
      {activeTab !== 'qa' && set && !docResults[activeTab] && (
        <button className="btn btn--primary" onClick={() => submit(docPath, activeTab)} disabled={!aiConfigured}>
          <CircleCheck size={15} /> 提交答案
        </button>
      )}
      {docResults.mcq || docResults.cloze || Object.keys(docQa).length > 0 ? (
        <button className="btn btn--ghost" onClick={onGotoReview}>
          进入复习与反馈 <ChevronRight size={14} />
        </button>
      ) : null}
    </div>
  );

  const renderEmpty = () => (
    <div className="state">
      <WifiOff size={26} color="var(--text-3)" />
      <div className="state__title">{aiConfigured ? `还没有生成${TAB_LABEL[activeTab]}` : 'AI 练习不可用'}</div>
      <div className="state__desc">
        {aiConfigured
          ? '点击下方按钮，DeepSeek 会严格依据当前文章内容生成练习。生成后会自动缓存，同一篇文章不会重复调用 API。'
          : '尚未配置 DeepSeek API Key。请在项目根目录的 .env 中设置 DEEPSEEK_API_KEY 并重启服务。阅读、目录导航与学习进度不受影响。'}
      </div>
      <button className="btn btn--primary" onClick={() => generate(docPath, activeTab, false)} disabled={!aiConfigured || Boolean(loading[activeTab])}>
        {loading[activeTab] ? <Loader2 size={15} /> : <Sparkles size={15} />}
        {loading[activeTab] ? '正在生成…' : `开始生成${TAB_LABEL[activeTab]}`}
      </button>
    </div>
  );

  const renderLoading = () => (
    <div className="state">
      <div className="spinner" />
      <div className="state__title">DeepSeek 正在依据《{title}》出题…</div>
      <div className="state__desc">首次生成通常需要 10~40 秒，请稍候。生成结果会被缓存，下次打开无需等待。</div>
      <button className="btn" onClick={() => cancelGenerate(activeTab)}>
        取消
      </button>
    </div>
  );

  let body: ReactNode = null;

  if (errors[activeTab]) {
    body = (
      <div className="state">
        <div className="banner banner--error" style={{ maxWidth: 520 }}>
          {errors[activeTab]}
        </div>
        <button className="btn btn--primary" onClick={() => generate(docPath, activeTab, false)} disabled={!aiConfigured}>
          <RefreshCw size={15} /> 重试
        </button>
      </div>
    );
  } else if (loading[activeTab] && !set) {
    body = renderLoading();
  } else if (!set) {
    body = renderEmpty();
  } else if (set.type === 'mcq') {
    const [left, right] = distribute(set.questions);
    const result = docResults.mcq as McqGradeResult | undefined;
    const resultById = new Map((result?.questions ?? []).map((q) => [q.id, q]));
    body = (
      <>
        {result && (
          <div className="practice__head" style={{ paddingTop: 0 }}>
            <div className={`banner ${result.score === result.total ? 'banner--success' : 'banner--info'}`} style={{ marginBottom: 0, flex: 1 }}>
              本次得分 <strong>{result.score}</strong> / {result.total}（{Math.round((result.score / Math.max(1, result.total)) * 100)}%）
              {set.skipped > 0 && ` · 已丢弃 ${set.skipped} 道不符合校验的题目`}
            </div>
          </div>
        )}
        <div className="practice__cols">
          {[left, right].map((col, ci) => (
            <div className="practice__col" key={ci}>
              {col.map((q) => {
                const idx = set.questions.indexOf(q);
                return (
                  <McqCard
                    key={q.id}
                    index={idx}
                    question={q}
                    selected={docAnswers.mcq[q.id] ?? []}
                    onSelect={(ids) => setAnswer(docPath, 'mcq', q.id, ids)}
                    result={resultById.get(q.id)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </>
    );
  } else if (set.type === 'cloze') {
    const result = docResults.cloze as ClozeGradeResult | undefined;
    body = (
      <>
        {result && (
          <div className="practice__head" style={{ paddingTop: 0 }}>
            <div className={`banner ${result.score === result.total ? 'banner--success' : 'banner--info'}`} style={{ marginBottom: 0, flex: 1 }}>
              本次得分 <strong>{result.score}</strong> / {result.total} · 答案已标注在原文中
              {set.skipped > 0 && ` · 已跳过 ${set.skipped} 处无法可靠定位的挖空`}
            </div>
          </div>
        )}
        {/* 挖空题渲染完整文章，两栏布局在移动端会折叠为单栏 */}
        <div className="practice__cols">
          <div className="practice__col" style={{ flex: '2 1 0' }}>
            <MarkdownView
              content={content}
              docPath={docPath}
              blanks={set.blanks}
              clozeValues={docAnswers.cloze}
              onClozeChange={(id, v) => setAnswer(docPath, 'cloze', id, v)}
              clozeResults={allClozeResults ? clozeResults : undefined}
              clozeDisabled={Boolean(result)}
              onNavigate={onNavigate}
              onBlocked={onBlocked}
            />
          </div>
          {result && (
            <div className="practice__col" style={{ flex: '1 1 0', maxWidth: 360 }}>
              <div style={{ position: 'sticky', top: 0 }}>
                <div className={`banner ${result.score === result.total ? 'banner--success' : 'banner--info'}`} style={{ marginBottom: 12 }}>
                  得分 <strong>{result.score}</strong> / {result.total}（{Math.round((result.score / Math.max(1, result.total)) * 100)}%）
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.7 }}>
                  填空题已在原文中以颜色标注：<span style={{ color: '#248a3d', fontWeight: 600 }}>绿色</span> 为答对，<span style={{ color: 'var(--red)', fontWeight: 600 }}>红色</span> 为答错。
                  点击红色空格旁的 <code>?</code> 可查看解析。
                </div>
              </div>
            </div>
          )}
        </div>
      </>
    );
  } else {
    const [left, right] = distribute(set.questions);
    body = (
      <div className="practice__cols">
        {[left, right].map((col, ci) => (
          <div className="practice__col" key={ci}>
            {col.map((q) => {
              const idx = set.questions.indexOf(q);
              return (
                <QaCard
                  key={q.id}
                  index={idx}
                  question={q}
                  state={docQa[q.id]}
                  onDraftChange={(v) => setQaDraft(docPath, q.id, v)}
                  onSubmit={(answer) => handleQaSubmit(q.id, answer)}
                  loading={qaLoading === q.id}
                  error={qaLoading === q.id ? null : qaError}
                />
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="practice">
      {renderHeader()}
      {loading[activeTab] && set && (
        <div className="practice__head" style={{ paddingTop: 8 }}>
          <div className="banner banner--info" style={{ marginBottom: 0, flex: 1 }}>
            <span className="spinner spinner--sm" /> 正在重新生成{TAB_LABEL[activeTab]}，完成后将替换当前题目…
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={() => cancelGenerate(activeTab)}>
              取消
            </button>
          </div>
        </div>
      )}
      {qaLoading && activeTab === 'qa' && (
        <div className="practice__head" style={{ paddingTop: 8 }}>
          <div className="banner banner--info" style={{ marginBottom: 0, flex: 1 }}>
            <span className="spinner spinner--sm" /> DeepSeek 正在点评你的回答…
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={cancelQa}>
              取消
            </button>
          </div>
        </div>
      )}
      {stale && (
        <div className="practice__head" style={{ paddingTop: 8 }}>
          <div className="banner" style={{ marginBottom: 0, flex: 1 }}>
            文章内容已变化，当前练习基于旧版本生成。「重新生成」可基于最新内容出题。
          </div>
        </div>
      )}
      {!aiConfigured && activeTab !== 'qa' && set && !docResults[activeTab] && (
        <div className="practice__head" style={{ paddingTop: 8 }}>
          <div className="banner" style={{ marginBottom: 0, flex: 1 }}>
            未配置 DeepSeek API Key：阅卷功能可用，但无法生成新的练习。
          </div>
        </div>
      )}
      {body}
    </div>
  );
}

export { TAB_LABEL };
