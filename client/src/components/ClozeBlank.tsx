// 挖空输入框：直接嵌入 Markdown 渲染结果中的知识点位置
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClozeBlankPublic, ClozeBlankResult } from '@shared/types';

interface Props {
  blank: ClozeBlankPublic;
  value: string;
  onChange?: (v: string) => void;
  /** 只读展示（复习模式未提交时也允许查看答案） */
  result?: ClozeBlankResult;
  disabled?: boolean;
  interactive?: boolean;
}

/** 中文字符按整宽估算输入框宽度 */
function widthFor(length: number, value: string) {
  const chars = Math.max(value.length, length, 2);
  return `${Math.min(Math.max(chars, 2), 24) * 1.05 + 1.4}ch`;
}

export function ClozeBlank({ blank, value, onChange, result, disabled, interactive = true }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const [tipOpen, setTipOpen] = useState(false);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!tipOpen || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setTipPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)), top: rect.bottom + 6 });
  }, [tipOpen]);

  useEffect(() => {
    if (!tipOpen) return;
    const close = () => setTipOpen(false);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [tipOpen]);

  if (result) {
    const cls = result.correct ? 'cloze-blank--correct' : 'cloze-blank--wrong';
    return (
      <span className={`cloze-blank ${cls}`}>
        <input
          ref={ref}
          className="cloze-blank__input"
          style={{ width: widthFor(result.answer.length, result.userAnswer || result.answer) }}
          value={result.userAnswer}
          readOnly
          tabIndex={-1}
          aria-label={`挖空答案，你的回答：${result.userAnswer || '（空）'}，正确答案：${result.answer}`}
        />
        {!result.correct && <span className="cloze-blank__answer">{result.answer}</span>}
        {(result.explanation || result.knowledgePoint) && (
          <button
            type="button"
            className="cloze-blank__mark"
            aria-label="查看解析"
            onClick={() => setTipOpen((v) => !v)}
          >
            ?
          </button>
        )}
        {tipOpen && tipPos && (
          <span className="cloze-tip" style={{ left: tipPos.left, top: tipPos.top, position: 'fixed' }}>
            {result.knowledgePoint && <span className="cloze-tip__label">知识点：{result.knowledgePoint}</span>}
            {result.explanation}
            {result.acceptedAnswers.length > 0 && (
              <span className="cloze-tip__label">也可接受：{result.acceptedAnswers.join('、')}</span>
            )}
          </span>
        )}
      </span>
    );
  }

  if (!interactive) {
    return <span className="cloze-blank cloze-blank--static">＿＿＿</span>;
  }

  return (
    <span className="cloze-blank">
      <input
        ref={ref}
        className="cloze-blank__input"
        style={{ width: widthFor(blank.length, value) }}
        value={value}
        disabled={disabled}
        placeholder="?"
        aria-label="请填写被挖空的内容"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.preventDefault();
        }}
      />
    </span>
  );
}
