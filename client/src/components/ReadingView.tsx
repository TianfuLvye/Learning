// 阅读模式：模拟书籍双页阅读。
// 按顶层块分页——单个标题、段落、列表、表格、代码块不会被拆分到两页之间。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ClozeBlankPublic, ClozeBlankResult } from '@shared/types';
import { useMarkdownBlocks, type MarkdownViewProps } from './MarkdownView';

interface Page {
  start: number;
  end: number;
  /** 该页第一个块所属的最近上级标题 */
  heading: string;
}

interface Props extends Omit<MarkdownViewProps, 'className' | 'measureWidth'> {
  /** 文档变化时重置分页 */
  docKey: string;
  initialBlock: number;
  onPositionChange: (block: number) => void;
  /** 复习模式复用同一分页结果 */
  onPagination?: (pages: Page[]) => void;
  renderKey?: string | number;
}

/** 测量每个块在目标宽度下的高度，再按页高贪心装箱 */
export function paginate(heights: number[], pageHeight: number, gap: number, isHeading: boolean[] = []): Page[] {
  const pages: Page[] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < heights.length; i++) {
    const h = Math.min(heights[i] || 0, pageHeight);
    const need = acc === 0 ? h : acc + gap + h;
    if (acc > 0 && need > pageHeight) {
      // 标题随后续内容一起换页：回退页尾连续的标题块
      let end = i - 1;
      while (end > start && isHeading[end]) end--;
      const carried = () => {
        let sum = 0;
        for (let k = end + 1; k <= i; k++) {
          const hk = Math.min(heights[k] || 0, pageHeight);
          sum = sum === 0 ? hk : sum + gap + hk;
        }
        return sum;
      };
      // 标题与后续块合计放不下一页时，不再移动标题
      if (end < i - 1 && carried() > pageHeight) end = i - 1;
      pages.push({ start, end, heading: '' });
      start = end + 1;
      acc = carried();
    } else {
      acc = need;
    }
  }
  if (heights.length > 0) pages.push({ start, end: heights.length - 1, heading: '' });
  return pages.length ? pages : [{ start: 0, end: -1, heading: '' }];
}

/** 块之间的外边距已包含在块高度内（flow-root），无需额外间隙 */
const GAP = 0;

export function ReadingView(props: Props) {
  const { blocks, className, renderBlock, headingFlags } = useMarkdownBlocks(props);
  const totalBlocks = blocks;
  const spreadRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [pageSize, setPageSize] = useState({ width: 520, height: 620 });
  /** 窄屏下单页阅读，宽屏下双页阅读 */
  const [perSpread, setPerSpread] = useState<1 | 2>(2);
  const [heights, setHeights] = useState<number[]>([]);
  const [spread, setSpread] = useState(0);
  const [turning, setTurning] = useState<'next' | 'prev' | null>(null);

  // 观察双页容器的实际尺寸
  useLayoutEffect(() => {
    const el = spreadRef.current;
    if (!el) return;
    const update = () => {
      setPerSpread(el.clientWidth < 760 ? 1 : 2);
      // 以实际页面正文区域（去掉内边距）作为可排版尺寸
      const body = el.querySelector<HTMLElement>('.page__body');
      if (!body) return;
      const cs = getComputedStyle(body);
      const width = Math.max(200, body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      // 预留少量余量，避免小数像素导致最后一个块被裁切
      const height = Math.max(160, body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 6);
      setPageSize((prev) => (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1 ? prev : { width, height }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.docKey]);

  // 测量每个块的高度（图片加载完成后重测）
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const measure = () => {
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-measure-block]'));
      const next = nodes.map((n) => n.getBoundingClientRect().height);
      setHeights((prev) => (prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 1) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const imgs = Array.from(el.querySelectorAll('img'));
    for (const img of imgs) img.addEventListener('load', measure);
    return () => {
      ro.disconnect();
      for (const img of imgs) img.removeEventListener('load', measure);
    };
  }, [props.docKey, pageSize.width, props.blanks, props.clozeResults]);

  const pages = useMemo(() => {
    if (heights.length !== blocks) return [{ start: 0, end: Math.max(0, blocks - 1), heading: '' }];
    return paginate(heights, pageSize.height, GAP, headingFlags);
  }, [heights, pageSize.height, blocks, headingFlags]);

  useEffect(() => {
    props.onPagination?.(pages);
  }, [pages, props.onPagination]);

  const spreadCount = Math.max(1, Math.ceil(pages.length / perSpread));

  // 位置变化 → 页码
  useEffect(() => {
    const idx = pages.findIndex((p) => props.initialBlock >= p.start && props.initialBlock <= p.end);
    setSpread(idx >= 0 ? Math.floor(idx / perSpread) : 0);
    // 仅当文档或字号/页宽变化导致的重新分页时调整
  }, [props.docKey, pages.length, pageSize.height, perSpread]);

  const goto = useCallback(
    (next: number, direction: 'next' | 'prev' | null) => {
      const clamped = Math.max(0, Math.min(spreadCount - 1, next));
      if (clamped === spread) return;
      setTurning(direction);
      setSpread(clamped);
      const firstBlock = pages[clamped * perSpread]?.start ?? 0;
      props.onPositionChange(firstBlock);
      setTimeout(() => setTurning(null), 340);
    },
    [pages, props, spread, spreadCount, perSpread],
  );

  // 键盘翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goto(spread + 1, 'next');
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goto(spread - 1, 'prev');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goto, spread]);

  const leftPage = pages[spread * perSpread];
  const rightPage = perSpread === 2 ? pages[spread * 2 + 1] : undefined;
  const unit = perSpread === 2 ? '跨页' : '页';
  const percent = spreadCount > 1 ? Math.round(((spread + 1) / spreadCount) * 100) : 100;

  const renderPage = (page: Page | undefined, side: 'left' | 'right') => {
    if (!page || page.end < page.start) {
      return (
        <section className="page" aria-hidden="true">
          <div className="page__head">
            <span>{perSpread === 1 ? '正文' : side === 'left' ? '左页' : '右页'}</span>
          </div>
          <div className="page__body" />
          <div className="page__foot">{side === 'right' && (spread === spreadCount - 1 ? '全文结束' : '')}</div>
        </section>
      );
    }
    const indices: number[] = [];
    for (let i = page.start; i <= page.end; i++) indices.push(i);
    return (
      <section className="page" aria-label={`${side === 'left' ? '左' : '右'}页，第 ${(side === 'left' ? spread * perSpread : spread * 2 + 1) + 1} 页`}>
        <div className="page__head">
          <span>{perSpread === 1 ? '正文' : side === 'left' ? '左页' : '右页'}</span>
          <span>{String((side === 'left' ? spread * perSpread : spread * 2 + 1) + 1)}</span>
        </div>
        <div className={`page__body ${turning ? 'page--turning' : ''}`}>
          <div className={className}>
            {indices.map((i) => (
              <div key={i} data-block={i}>
                {renderBlock(i)}
              </div>
            ))}
          </div>
        </div>
        <div className="page__foot">
          第 {spread + 1} / {spreadCount} {unit}
        </div>
      </section>
    );
  };

  return (
    <div className="book">
      <div className="book__spread" ref={spreadRef}>
        {renderPage(leftPage, 'left')}
        {perSpread === 2 && renderPage(rightPage, 'right')}
      </div>

      <div className="book__bar">
        <button className="icon-btn" onClick={() => goto(spread - 1, 'prev')} disabled={spread === 0} aria-label="上一页" title="上一页（←）">
          <ChevronLeft size={18} />
        </button>
        <div className="book__progress">
          第 {spread + 1} / {spreadCount} {unit} · {percent}%
        </div>
        <button
          className="icon-btn"
          onClick={() => goto(spread + 1, 'next')}
          disabled={spread >= spreadCount - 1}
          aria-label="下一页"
          title="下一页（→）"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* 离屏测量容器：与页面正文同样的排版宽度，用于计算分页 */}
      <div
        className="measure"
        ref={measureRef}
        style={{ width: pageSize.width, fontFamily: 'inherit' }}
        aria-hidden="true"
      >
        <div className={className} style={{ maxWidth: 'none' }}>
          {Array.from({ length: blocks }, (_, i) => (
            <div key={i} data-measure-block={i} data-block={i}>
              {renderBlock(i)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export type { Page };
