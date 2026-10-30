import { useEffect, useRef, useState } from 'react';
import type { Evidence } from '../shared/contracts';
import { externalUrl } from './api';

// source 表示来源，人工提供不代表已独立核验。
const sourceLabels: Record<Evidence['source'], string> = { repository: '项目官方材料', search: '公开检索', manual: '人工提供' };
// coverage 表示实际读取范围，摘要不能等同全文核验。
const coverageLabels: Record<Evidence['coverage'], string> = { full: '完整材料', excerpt: '摘录 / 摘要', unverified: '未核验' };
const date = (value: string) => {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? '时间不可用' : time.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};

/** 仅将已知官方仓库字段转为阅读标签，未知字段仍完整保留在原始材料中。 */
function repositoryFields(evidence: Evidence): { label: string; value: string }[] | null {
  if (evidence.source !== 'repository' || evidence.title !== 'GitHub 仓库信息') return null;
  let value: unknown;
  try { value = JSON.parse(evidence.excerpt); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const fields: { label: string; value: string }[] = [];
  const add = (key: string, label: string) => {
    const entry = data[key];
    if (typeof entry === 'string' || typeof entry === 'number') fields.push({ label, value: String(entry) });
    else if (entry === null) fields.push({ label, value: '未提供' });
  };
  add('full_name', '仓库名称'); add('description', '项目简介'); add('language', '主要语言');
  add('stargazers_count', '累计 Star'); add('trendingDailyStars', '当次日榜增量');
  if (typeof data.archived === 'boolean') fields.push({ label: '维护状态', value: data.archived ? '已归档' : '未归档' });
  if (typeof data.pushed_at === 'string') fields.push({ label: '最近代码推送', value: date(data.pushed_at) });
  if (data.license && typeof data.license === 'object' && 'spdx_id' in data.license && typeof data.license.spdx_id === 'string') fields.push({ label: '许可证标识', value: data.license.spdx_id });
  else if (data.license === null) fields.push({ label: '许可证标识', value: '未提供，需核验' });
  return fields.length ? fields : null;
}

export function EvidenceList({ evidence, referencedIds, focusedId }: { evidence: Evidence[]; referencedIds: Set<string>; focusedId: string | null }) {
  if (!evidence.length) return <p className="small-empty">尚未收集证据，不能据此判断“没有中文教程”。</p>;
  return <ul className="evidence-list">{evidence.map(item => <EvidenceItem key={item.id} evidence={item} referenced={referencedIds.has(item.id)} focused={focusedId === item.id} />)}</ul>;
}

function EvidenceItem({ evidence, referenced, focused }: { evidence: Evidence; referenced: boolean; focused: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const summaryRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) { setExpanded(true); summaryRef.current?.focus(); }
  }, [focused]);
  const fields = repositoryFields(evidence);
  return <li><details className="evidence-item" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary ref={summaryRef} tabIndex={0}><div className="evidence-summary"><strong>{evidence.title}</strong><div className="evidence-meta"><span>{sourceLabels[evidence.source]}</span><span>{coverageLabels[evidence.coverage]}</span><time dateTime={evidence.collectedAt}>{date(evidence.collectedAt)}</time>{referenced && <span className="reference-label">当前分析引用</span>}</div></div></summary>
    <div className="evidence-body"><a href={externalUrl(evidence.url)} target="_blank" rel="noreferrer">打开来源 ↗</a>{evidence.query && <p className="evidence-query"><strong>检索词</strong> {evidence.query}</p>}
      {fields ? <><dl className="repository-facts">{fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl><details className="raw-material"><summary>查看原始数据</summary><pre>{evidence.excerpt}</pre></details></> : <div className="evidence-excerpt">{evidence.excerpt}</div>}
      {evidence.limitation && <p className="evidence-limitation"><strong>覆盖限制：</strong>{evidence.limitation}</p>}
    </div>
  </details></li>;
}
