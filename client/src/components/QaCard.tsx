import { useState } from 'react';
import { CheckCircle2, Lightbulb, Loader2, RefreshCw, Send, Sparkles, TriangleAlert } from 'lucide-react';
import type { QaQuestionPublic } from '@shared/types';
import type { StoredQa } from '../store';

interface Props {
  index: number;
  question: QaQuestionPublic;
  state: StoredQa | undefined;
  onDraftChange: (v: string) => void;
  onSubmit: (answer: string) => Promise<void>;
  loading: boolean;
  error?: string | null;
  /** 复习模式：直接展示已有反馈 */
  forceShowFeedback?: boolean;
}

const LEVEL_TEXT: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '及格',
  poor: '需加强',
};

export function QaCard({ index, question, state, onDraftChange, onSubmit, loading, error, forceShowFeedback }: Props) {
  const [local, setLocal] = useState(state?.draft ?? '');
  const [editing, setEditing] = useState(false);
  const draft = editing ? local : (state?.draft ?? local);
  const evaluation = state?.evaluation;
  const showFeedback = Boolean(evaluation) && (!editing || forceShowFeedback);

  const submit = async () => {
    const answer = draft.trim();
    if (!answer) return;
    onDraftChange(answer);
    await onSubmit(answer);
    setEditing(false);
  };

  return (
    <article className="card">
      <div className="card__head">
        <span className="card__index">{index + 1}</span>
        <span className="pill pill--accent">问答题</span>
        <span className="pill">{{ basic: '基础', intermediate: '进阶', advanced: '挑战' }[question.difficulty]}</span>
        {evaluation && (
          <span className={`pill ${evaluation.score >= 70 ? 'pill--green' : evaluation.score >= 50 ? 'pill--orange' : 'pill--red'}`}>
            得分 {evaluation.score}
          </span>
        )}
      </div>

      <p className="card__stem">{question.question}</p>
      {question.focus && <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginBottom: 10 }}>考查点：{question.focus}</div>}

      <textarea
        className="qa-input"
        value={draft}
        placeholder="用自己的话作答，尽量覆盖概念、原因与例子…"
        disabled={loading || (showFeedback && !editing)}
        onChange={(e) => {
          setLocal(e.target.value);
          setEditing(true);
          onDraftChange(e.target.value);
        }}
      />

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn--primary" onClick={submit} disabled={loading || !draft.trim()}>
          {loading ? <Loader2 size={15} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Send size={15} />}
          {evaluation ? '重新提交' : '提交并获取点评'}
        </button>
        {evaluation && !editing && (
          <button className="btn" onClick={() => { setLocal(evaluation.answer); setEditing(true); }}>
            <RefreshCw size={14} /> 根据建议修改
          </button>
        )}
        {editing && evaluation && (
          <button className="btn" onClick={() => { setLocal(evaluation.answer); onDraftChange(evaluation.answer); setEditing(false); }}>
            取消修改
          </button>
        )}
      </div>

      {error && <div className="banner banner--error" style={{ marginTop: 12 }}>{error}</div>}

      {showFeedback && evaluation && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="explain explain--blue">
            <div className="explain__title">
              <Sparkles size={14} /> 总体评价 · {evaluation.score} 分（{LEVEL_TEXT[evaluation.level] ?? evaluation.level}）
            </div>
            {evaluation.overall}
          </div>

          {evaluation.strengths.length > 0 && (
            <div className="explain explain--green">
              <div className="explain__title">
                <CheckCircle2 size={14} /> 答得好的地方
              </div>
              <ul>
                {evaluation.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {evaluation.missingPoints.length > 0 && (
            <div className="explain">
              <div className="explain__title">
                <TriangleAlert size={14} /> 遗漏的知识点
              </div>
              <ul>
                {evaluation.missingPoints.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {evaluation.errors.length > 0 && (
            <div className="explain explain--red">
              <div className="explain__title">
                <TriangleAlert size={14} /> 需要纠正的地方
              </div>
              <ul>
                {evaluation.errors.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {evaluation.suggestions.length > 0 && (
            <div className="explain explain--blue">
              <div className="explain__title">
                <Lightbulb size={14} /> 改进建议
              </div>
              <ul>
                {evaluation.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="explain">
            <div className="explain__title">参考答案</div>
            {evaluation.referenceAnswer}
          </div>

          {evaluation.evidence.length > 0 && (
            <div className="explain">
              <div className="explain__title">文章依据</div>
              <ul style={{ listStyle: 'none', paddingLeft: 0 }}>
                {evaluation.evidence.map((e, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <span className="source-quote" style={{ marginTop: 0 }}>
                      {e.quote}
                      {e.verified === false ? '（未能在原文中定位）' : ''}
                    </span>
                    {e.explanation && <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{e.explanation}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
