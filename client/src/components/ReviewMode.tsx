// 复习与反馈模式：左栏恢复原文阅读，右栏展示题目解析与问答点评（可折叠、可调宽）
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ListChecks,
  Loader2,
  MessageSquareText,
  PanelRightClose,
  PanelRightOpen,
  Quote,
} from 'lucide-react';
import type { ClozeBlankResult, ClozeGradeResult, McqGradeResult } from '@shared/types';
import { useExercises, useSettings } from '../store';
import { api, ApiError } from '../lib/api';
import { MarkdownView } from './MarkdownView';
import { toast } from './Toasts';

interface Props {
  docPath: string;
  content: string;
  onNavigate: (path: string, hash: string) => void;
  onBlocked: (reason: string) => void;
}

type FeedbackTab = 'mcq' | 'cloze' | 'qa';

export function ReviewMode({ docPath, content, onNavigate, onBlocked }: Props) {
  const { sets, results, qa, setQaEvaluation } = useExercises();
  const { feedbackCollapsed, setFeedbackCollapsed, feedbackWidth, setFeedbackWidth } = useSettings();
  const docResults = results[docPath] ?? {};
  const docQa = qa[docPath] ?? {};
  const mcq = docResults.mcq as McqGradeResult | undefined;
  const cloze = docResults.cloze as ClozeGradeResult | undefined;

  const [tab, setTab] = useState<FeedbackTab>(() => (mcq ? 'mcq' : cloze ? 'cloze' : 'qa'));
  const [qaLoading, setQaLoading] = useState<string | null>(null);
  const [qaError, setQaError] = useState<string | null>(null);
  const [jumpQuote, setJumpQuote] = useState<string | null>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clozeResults = useMemo(() => {
    const map: Record<string, ClozeBlankResult> = {};
    for (const b of cloze?.blanks ?? []) map[b.id] = b;
    return map;
  }, [cloze]);

  // 点击“原文依据”时在左侧正文中定位并高亮
  useEffect(() => {
    if (!jumpQuote || !articleRef.current) return;
    const needle = quoteKey(jumpQuote);
    const walker = document.createTreeWalker(articleRef.current, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const value = (node.nodeValue ?? '').replace(/[\s　]+/g, '');
      if (needle && value.includes(needle)) {
        const el = node.parentElement;
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el?.animate([{ background: 'rgba(255,214,10,.5)' }, { background: 'transparent' }], { duration: 1600 });
        break;
      }
    }
    setJumpQuote(null);
  }, [jumpQuote]);

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      const startX = e.clientX;
      const startW = feedbackWidth;
      const move = (ev: PointerEvent) => {
        if (dragging.current) setFeedbackWidth(startW + (startX - ev.clientX));
      };
      const up = () => {
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [feedbackWidth, setFeedbackWidth],
  );

  const reEvaluate = async (questionId: string, answer: string) => {
    const set = sets.qa;
    if (!set || set.type !== 'qa' || !answer.trim()) return;
    setQaLoading(questionId);
    setQaError(null);
    try {
      const { evaluation } = await api.evaluate(set.setId, questionId, answer);
      setQaEvaluation(docPath, questionId, { ...evaluation });
      toast('已更新点评');
    } catch (err) {
      const e = err as ApiError;
      if (e.code !== 'cancelled') setQaError(e.message);
    } finally {
      setQaLoading(null);
    }
  };

  const renderMcqFeedback = () => {
    if (!mcq) return <MissingHint type="选择题解析" />;
    return (
      <>
        <div className={`banner ${mcq.score === mcq.total ? 'banner--success' : 'banner--info'}`}>
          选择题得分 <strong>{mcq.score}</strong> / {mcq.total}
        </div>
        {mcq.questions.map((q, i) => (
          <article className="card" key={q.id} style={{ padding: '14px 16px' }}>
            <div className="card__head">
              <span className="card__index">{i + 1}</span>
              <span className={`pill ${q.correct ? 'pill--green' : 'pill--red'}`}>{q.correct ? '正确' : '错误'}</span>
              <span className="pill">{q.type === 'single' ? '单选' : '多选'}</span>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 14.5, lineHeight: 1.65, fontWeight: 500 }}>{q.stem}</p>
            {q.options.map((o) => (
              <div key={o.id} className="option" style={{ cursor: 'default', padding: '8px 10px' }}>
                <span className="option__key">{o.id}</span>
                <span className="option__text">
                  {o.text}
                  <span className="option__explain">
                    {o.isCorrect ? '✓ ' : o.selected ? '✗ ' : '· '}
                    {o.explanation}
                  </span>
                </span>
                {o.isCorrect && <span className="option__tag option__tag--correct">答案</span>}
                {o.selected && !o.isCorrect && <span className="option__tag option__tag--wrong">你选的</span>}
              </div>
            ))}
            <div className={`explain ${q.correct ? 'explain--green' : 'explain--blue'}`}>
              <div className="explain__title">知识点解析{q.knowledgePoint ? ` · ${q.knowledgePoint}` : ''}</div>
              {q.explanation}
              {q.source?.quote && (
                <button className="source-quote" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setJumpQuote(q.source.quote)}>
                  <Quote size={11} style={{ marginRight: 4 }} />
                  原文依据：{q.source.quote}
                  {q.source.verified === false && '（未能在原文中定位）'}
                </button>
              )}
            </div>
          </article>
        ))}
      </>
    );
  };

  const renderClozeFeedback = () => {
    if (!cloze) return <MissingHint type="挖空答案" />;
    return (
      <>
        <div className={`banner ${cloze.score === cloze.total ? 'banner--success' : 'banner--info'}`}>
          挖空得分 <strong>{cloze.score}</strong> / {cloze.total} · 左侧原文中已标注答案
        </div>
        {cloze.blanks.map((b, i) => (
          <article className="card" key={b.id} style={{ padding: '14px 16px' }}>
            <div className="card__head">
              <span className="card__index">{i + 1}</span>
              <span className={`pill ${b.correct ? 'pill--green' : 'pill--red'}`}>{b.correct ? '正确' : '错误'}</span>
              {b.knowledgePoint && <span className="pill">{b.knowledgePoint}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: b.correct ? '#248a3d' : 'var(--red)' }}>
                {b.userAnswer || '（未填写）'}
              </span>
              {!b.correct && (
                <>
                  <span style={{ color: 'var(--text-3)' }}>→</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: '#248a3d' }}>{b.answer}</span>
                </>
              )}
            </div>
            <div className="explain" style={{ marginTop: 6 }}>
              {b.explanation}
              {b.acceptedAnswers.length > 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 6 }}>也可接受：{b.acceptedAnswers.join('、')}</div>
              )}
              <span className="source-quote">{b.context}</span>
            </div>
          </article>
        ))}
      </>
    );
  };

  const renderQaFeedback = () => {
    const set = sets.qa;
    const answered = set?.type === 'qa' ? set.questions.filter((q) => docQa[q.id]?.evaluation) : [];
    if (!set || set.type !== 'qa' || answered.length === 0) return <MissingHint type="问答点评" />;
    return (
      <>
        {qaError && <div className="banner banner--error">{qaError}</div>}
        {answered.map((q) => {
          const state = docQa[q.id]!;
          const ev = state.evaluation!;
          const idx = set.questions.indexOf(q);
          return (
            <article className="card" key={q.id} style={{ padding: '14px 16px' }}>
              <div className="card__head">
                <span className="card__index">{idx + 1}</span>
                <span className={`pill ${ev.score >= 70 ? 'pill--green' : ev.score >= 50 ? 'pill--orange' : 'pill--red'}`}>{ev.score} 分</span>
              </div>
              <p style={{ margin: '0 0 8px', fontSize: 14.5, fontWeight: 500, lineHeight: 1.6 }}>{q.question}</p>
              <div className="explain explain--blue" style={{ marginTop: 0 }}>
                <div className="explain__title">你的回答</div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{ev.answer}</div>
              </div>
              <div className="explain">
                <div className="explain__title">总体评价</div>
                {ev.overall}
              </div>
              <FeedbackList title="正确之处" items={ev.strengths} tone="green" />
              <FeedbackList title="遗漏的知识点" items={ev.missingPoints} />
              <FeedbackList title="存在的错误" items={ev.errors} tone="red" />
              <FeedbackList title="改进建议" items={ev.suggestions} tone="blue" />
              <div className="explain">
                <div className="explain__title">参考答案</div>
                {ev.referenceAnswer}
                {ev.evidence.map((e, k) => (
                  <button key={k} className="source-quote" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setJumpQuote(e.quote)}>
                    <Quote size={11} style={{ marginRight: 4 }} />
                    {e.quote}
                    {e.verified === false && '（未能在原文中定位）'}
                  </button>
                ))}
              </div>
              <textarea
                className="qa-input"
                style={{ minHeight: 96, marginTop: 10 }}
                defaultValue={ev.answer}
                id={`qa-retry-${q.id}`}
                placeholder="根据建议修改答案后重新提交"
              />
              <button
                className="btn btn--primary"
                style={{ marginTop: 8 }}
                disabled={qaLoading === q.id}
                onClick={() => {
                  const el = document.getElementById(`qa-retry-${q.id}`) as HTMLTextAreaElement | null;
                  reEvaluate(q.id, el?.value ?? '');
                }}
              >
                {qaLoading === q.id ? <Loader2 size={14} /> : <MessageSquareText size={14} />} 重新提交
              </button>
            </article>
          );
        })}
      </>
    );
  };

  const tabs: Array<[FeedbackTab, string, ReactNode]> = [
    ['mcq', '选择题解析', <ListChecks size={13} key="a" />],
    ['cloze', '挖空答案', <AlertCircle size={13} key="b" />],
    ['qa', '问答点评', <MessageSquareText size={13} key="c" />],
  ];

  return (
    <div className="workspace">
      <div className="book">
        <div className="book__spread">
          <section className="page" style={{ marginBottom: 0 }}>
            <div className="page__head">
              <span>原文</span>
              <span>复习对照</span>
            </div>
            <div className="page__body" ref={articleRef}>
              <MarkdownView
                content={content}
                docPath={docPath}
                className="md--measure"
                measureWidth
                blanks={sets.cloze?.type === 'cloze' ? sets.cloze.blanks : undefined}
                clozeResults={clozeResults}
                onNavigate={onNavigate}
                onBlocked={onBlocked}
              />
            </div>
          </section>
        </div>
      </div>

      {!feedbackCollapsed && (
        <div className="splitter" onPointerDown={startDrag} role="separator" aria-orientation="vertical" aria-label="调整反馈区宽度" />
      )}

      <div className={`feedback ${feedbackCollapsed ? 'feedback--collapsed' : ''}`} style={{ width: feedbackCollapsed ? 0 : feedbackWidth }}>
        {!feedbackCollapsed && (
          <>
            <div className="feedback__head">
              <button className="icon-btn" onClick={() => setFeedbackCollapsed(true)} title="折叠反馈区" aria-label="折叠反馈区">
                <PanelRightClose size={16} />
              </button>
              <div className="segmented" style={{ marginLeft: 4 }}>
                {tabs.map(([key, label, icon]) => (
                  <button key={key} aria-selected={tab === key} onClick={() => setTab(key)} title={label}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="feedback__body">
              {tab === 'mcq' && renderMcqFeedback()}
              {tab === 'cloze' && renderClozeFeedback()}
              {tab === 'qa' && renderQaFeedback()}
            </div>
          </>
        )}
      </div>

      {feedbackCollapsed && (
        <div style={{ position: 'absolute', right: 14, top: 68, zIndex: 30 }}>
          <button className="btn" onClick={() => setFeedbackCollapsed(false)}>
            <PanelRightOpen size={14} /> 展开反馈
          </button>
        </div>
      )}
    </div>
  );
}

function FeedbackList({ title, items, tone }: { title: string; items: string[]; tone?: 'green' | 'red' | 'blue' }) {
  if (items.length === 0) return null;
  return (
    <div className={`explain ${tone ? `explain--${tone}` : ''}`}>
      <div className="explain__title">{title}</div>
      <ul>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function MissingHint({ type }: { type: string }) {
  return (
    <div className="state">
      <div className="state__title">还没有{type}</div>
      <div className="state__desc">切换到「练习」模式完成并提交后，这里会显示详细的解析与反馈。</div>
    </div>
  );
}

function quoteKey(quote: string) {
  return quote
    .replace(/[*_`~>#]/g, '')
    .replace(/[\s　]+/g, '')
    .slice(0, 40);
}
