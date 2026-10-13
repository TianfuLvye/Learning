import { CheckCircle2, ChevronDown, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { McqQuestionPublic, McqQuestionResult } from '@shared/types';

interface Props {
  index: number;
  question: McqQuestionPublic;
  selected: string[];
  onSelect: (optionIds: string[]) => void;
  /** 提交后才有值，提交前不包含任何答案信息 */
  result?: McqQuestionResult;
  readOnly?: boolean;
}

export function McqCard({ index, question, selected, onSelect, result, readOnly }: Props) {
  const [openExplain, setOpenExplain] = useState(false);
  const answered = selected.length > 0;

  const toggle = (id: string) => {
    if (readOnly || result) return;
    if (question.type === 'single') onSelect([id]);
    else onSelect(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const resultById = new Map((result?.options ?? []).map((o) => [o.id, o]));

  return (
    <article className={`card ${result ? (result.correct ? '' : 'card--focus') : ''}`}>
      <div className="card__head">
        <span className="card__index">{index + 1}</span>
        <span className={`pill ${question.type === 'multiple' ? 'pill--accent' : ''}`}>
          {question.type === 'single' ? '单选题' : '多选题'}
        </span>
        {result ? (
          result.correct ? (
            <span className="pill pill--green">
              <CheckCircle2 size={13} /> 回答正确
            </span>
          ) : (
            <span className="pill pill--red">
              <XCircle size={13} /> 回答错误
            </span>
          )
        ) : (
          <span className={`pill ${answered ? 'pill--accent' : ''}`}>{answered ? '已作答' : '未作答'}</span>
        )}
        {result?.knowledgePoint && <span className="pill">{result.knowledgePoint}</span>}
      </div>

      <p className="card__stem">{question.stem}</p>

      <div role={question.type === 'single' ? 'radiogroup' : 'group'}>
        {question.options.map((opt) => {
          const r = resultById.get(opt.id);
          const isSelected = r ? r.selected : selected.includes(opt.id);
          const cls = [
            'option',
            isSelected ? 'option--selected' : '',
            r && r.isCorrect ? 'option--correct' : '',
            r && !r.isCorrect && isSelected ? 'option--wrong' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <label key={opt.id} className={cls} style={{ cursor: readOnly || result ? 'default' : 'pointer' }}>
              <input
                type={question.type === 'single' ? 'radio' : 'checkbox'}
                name={`q-${question.id}`}
                checked={isSelected}
                disabled={readOnly || Boolean(result)}
                onChange={() => toggle(opt.id)}
              />
              <span className="option__key">{opt.id}</span>
              <span className="option__text">
                {opt.text}
                {r && (r.isCorrect || isSelected) && (
                  <span className="option__explain">
                    {r.isCorrect ? '✓ ' : '✗ '}
                    {r.explanation}
                  </span>
                )}
              </span>
              {r && r.isCorrect && <span className="option__tag option__tag--correct">正确答案</span>}
              {r && !r.isCorrect && isSelected && <span className="option__tag option__tag--wrong">你的选择</span>}
            </label>
          );
        })}
      </div>

      {result && (
        <>
          <button className="btn btn--ghost" style={{ paddingLeft: 0 }} onClick={() => setOpenExplain((v) => !v)}>
            <Info size={14} />
            {openExplain ? '收起解析' : '查看详细解析'}
            <ChevronDown size={14} style={{ transform: openExplain ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
          </button>
          {openExplain && (
            <div className={`explain ${result.correct ? 'explain--green' : 'explain--blue'}`}>
              <div className="explain__title">知识点解析</div>
              {result.explanation}
              {result.source?.quote && (
                <span className="source-quote">
                  原文依据{result.source.verified === false ? '（未能在原文中定位到该引文）' : ''}：{result.source.quote}
                  {result.source.section ? ` —— ${result.source.section}` : ''}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
