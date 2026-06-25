import React, { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

const FILE_ICONS = {
  js: { bg: '#f7df1e', fg: '#222', label: 'JS' },
  jsx: { bg: '#f7df1e', fg: '#222', label: 'JS' },
  mjs: { bg: '#f7df1e', fg: '#222', label: 'JS' },
  cjs: { bg: '#f7df1e', fg: '#222', label: 'JS' },
  ts: { bg: '#3178c6', fg: '#fff', label: 'TS' },
  tsx: { bg: '#3178c6', fg: '#fff', label: 'TS' },
  mts: { bg: '#3178c6', fg: '#fff', label: 'TS' },
  cts: { bg: '#3178c6', fg: '#fff', label: 'TS' },
  rs: { bg: '#de5833', fg: '#fff', label: 'RS' },
  py: { bg: '#3572A5', fg: '#fff', label: 'PY' },
  java: { bg: '#b07219', fg: '#fff', label: 'JV' },
  go: { bg: '#00ADD8', fg: '#222', label: 'GO' },
  css: { bg: '#563d7c', fg: '#fff', label: 'CSS' },
  scss: { bg: '#c6538c', fg: '#fff', label: 'SC' },
  sass: { bg: '#c6538c', fg: '#fff', label: 'SA' },
  html: { bg: '#e44d26', fg: '#fff', label: 'HT' },
  htm: { bg: '#e44d26', fg: '#fff', label: 'HT' },
  json: { bg: '#5B5B5B', fg: '#89e051', label: '{}' },
  jsonc: { bg: '#5B5B5B', fg: '#89e051', label: '{}' },
  md: { bg: '#4a4a4a', fg: '#fff', label: 'MD' },
  mdx: { bg: '#4a4a4a', fg: '#fff', label: 'MD' },
  yaml: { bg: '#4a4a4a', fg: '#cbd5e1', label: 'YM' },
  yml: { bg: '#4a4a4a', fg: '#cbd5e1', label: 'YM' },
  toml: { bg: '#4a4a4a', fg: '#cbd5e1', label: 'TM' },
  xml: { bg: '#4a4a4a', fg: '#cbd5e1', label: 'XM' },
  kt: { bg: '#7F52FF', fg: '#fff', label: 'KT' },
  kts: { bg: '#7F52FF', fg: '#fff', label: 'KT' },
  gradle: { bg: '#02303a', fg: '#fff', label: 'GR' },
  groovy: { bg: '#4298b8', fg: '#fff', label: 'GR' },
  dart: { bg: '#00B4AB', fg: '#fff', label: 'DA' },
  swift: { bg: '#F05138', fg: '#fff', label: 'SW' },
  rb: { bg: '#CC342D', fg: '#fff', label: 'RB' },
  php: { bg: '#777BB4', fg: '#fff', label: 'PH' },
  sh: { bg: '#4eaa25', fg: '#fff', label: 'SH' },
  bash: { bg: '#4eaa25', fg: '#fff', label: 'SH' },
  ps1: { bg: '#012456', fg: '#fff', label: 'PS' },
  sql: { bg: '#e38c00', fg: '#fff', label: 'SQ' },
  dockerfile: { bg: '#384d54', fg: '#fff', label: 'DK' },
  vue: { bg: '#42b883', fg: '#fff', label: 'VU' },
  svelte: { bg: '#ff3e00', fg: '#fff', label: 'SV' },
};

const GIT_BADGE_STYLES = {
  'M ': 'bg-amber-500/25 text-amber-300',
  ' M': 'bg-amber-500/25 text-amber-300',
  'A ': 'bg-emerald-500/25 text-emerald-300',
  ' A': 'bg-emerald-500/25 text-emerald-300',
  'D ': 'bg-red-500/25 text-red-300',
  ' D': 'bg-red-500/25 text-red-300',
  'R ': 'bg-sky-500/25 text-sky-300',
  '??': 'bg-gray-500/25 text-gray-400',
  '!!': 'bg-gray-500/10 text-gray-600',
};
const GIT_BADGE_LABEL = { 'M ':'M',' M':'M','A ':'A',' A':'A','D ':'D',' D':'D','R ':'R','??':'?','!!':'!' };

function FileIcon({ name, isDir }) {
  const e = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (isDir) {
    if (['node_modules','.git','target','build','dist','.gradle','.idea'].includes(name))
      return <div className="w-[16px] h-[16px] rounded-[5px] flex items-center justify-center text-[7px] font-bold text-gray-600 bg-gray-800/40 border border-white/[0.03] shrink-0">#</div>;
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400/50 shrink-0">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
    );
  }
  const meta = FILE_ICONS[e];
  if (meta)
    return (
      <div className="w-[16px] h-[16px] rounded-[5px] flex items-center justify-center text-[7px] font-bold leading-none shrink-0 border border-white/[0.06]" style={{ background: meta.bg, color: meta.fg }}>
        {meta.label}
      </div>
    );
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-600 shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
    </svg>
  );
}

function HighlightMatch({ text, filter }) {
  if (!filter) return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(filter.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="file-highlight">{text.slice(idx, idx + filter.length)}</span>
      {text.slice(idx + filter.length)}
    </>
  );
}

function GitBadge({ status }) {
  if (!status) return null;
  const c = GIT_BADGE_STYLES[status] || 'bg-gray-500/20 text-gray-500';
  const label = GIT_BADGE_LABEL[status] || status;
  return <span className={`text-[7px] font-bold px-1 py-[1px] rounded leading-none ${c}`}>{label}</span>;
}

function DirNode({ name, path: dirPath, onOpenFile, selectedFile, filter, depth = 0, gitStatus }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { return () => { mounted.current = false; }; }, []);

  const toggle = useCallback(async () => {
    if (open) { setOpen(false); return; }
    if (!children) {
      setLoading(true);
      try {
        const entries = await invoke('list_dir', { path: dirPath });
        if (mounted.current) setChildren(entries);
      } catch { if (mounted.current) setChildren([]); }
      if (mounted.current) setLoading(false);
    }
    setOpen(true);
  }, [open, children, dirPath]);

  const childCount = children ? children.filter(e => !e.is_dir).length : null;
  const filtered = children ? (filter ? children.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())) : children) : [];
  const hasContent = filtered.length > 0;

  const showChildren = open && children;

  return (
    <div>
      <button onClick={toggle}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] active:bg-white/[0.06] transition-all duration-100 cursor-pointer text-left group">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-gray-600 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {loading
          ? <span className="flex items-center gap-1.5 w-full">
              <span className="shrink-0"><FileIcon name={name} isDir /></span>
              <span className="truncate text-gray-500">{name}</span>
              <span className="ml-auto w-3 h-3 rounded-full border border-gray-500/30 border-t-gray-400 animate-spin" />
            </span>
          : <span className="flex items-center gap-1.5 min-w-0 w-full">
              <span className="shrink-0"><FileIcon name={name} isDir /></span>
              <span className="truncate font-medium text-gray-300 group-hover:text-white transition-colors">
                <HighlightMatch text={name} filter={filter} />
              </span>
              {childCount !== null && childCount > 0 && (
                <span className="ml-auto text-[8px] text-gray-600 font-mono bg-white/[0.04] px-1.5 py-[1px] rounded-full">{childCount}</span>
              )}
            </span>
        }
      </button>
      <div style={{
        maxHeight: showChildren && hasContent ? '4000px' : showChildren ? '24px' : '0px',
        opacity: showChildren ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 250ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease',
      }}>
        {showChildren && (
          <div className="ml-[16px] pl-[8px] tree-indent-line">
            {hasContent ? (
              filtered.map(e =>
                e.is_dir
                  ? <DirNode key={e.path} name={e.name} path={e.path} onOpenFile={onOpenFile} selectedFile={selectedFile} filter={filter} depth={depth + 1} gitStatus={gitStatus} />
                  : (
                    <button key={e.path} onClick={() => onOpenFile(e.path)}
                      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] transition-all duration-100 cursor-pointer text-left group
                        ${selectedFile === e.path
                          ? 'text-white bg-gray-500/20 ring-1 ring-gray-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                          : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.04]'
                        }`}>
                      <span className="shrink-0"><FileIcon name={e.name} isDir={false} /></span>
                      <span className="truncate flex-1">
                        <HighlightMatch text={e.name} filter={filter} />
                      </span>
                      <GitBadge status={gitStatus?.[e.name]} />
                    </button>
                  )
              )
            ) : (
              <p className="text-[9px] text-gray-700 italic pl-1.5 py-1 select-none">vacío</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const SkeletonBar = ({ width, opacity }) => (
  <div className="h-3 rounded bg-gradient-to-r from-white/[0.02] via-white/[0.04] to-transparent animate-pulse" style={{ width, opacity }} />
);

export default function FileTree({ rootPath, onOpenFile, selectedFile, filter, gitStatus }) {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stalled, setStalled] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!rootPath) return;
    setLoading(true);
    setEntries(null);
    setError(null);
    setStalled(false);
    const timer = setTimeout(() => { if (mounted.current) setStalled(true); }, 8000);
    invoke('list_dir', { path: rootPath })
      .then(r => { clearTimeout(timer); if (mounted.current) { setEntries(r); setLoading(false); } })
      .catch(e => { clearTimeout(timer); if (mounted.current) { setError(String(e)); setEntries([]); setLoading(false); } });
    return () => clearTimeout(timer);
  }, [rootPath]);

  if (!rootPath) return null;

  const filtered = entries ? (filter ? entries.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())) : entries) : [];

  return (
    <div className="text-[11px] font-mono select-none space-y-[1px]">
      {loading && !entries && !error && (
        <div className="px-3 py-4 space-y-2">
          {[60, 72, 55, 85, 65].map((w, i) => (
            <SkeletonBar key={i} width={`${w}%`} opacity={1 - i * 0.12} />
          ))}
          {stalled && (
            <p className="text-[9px] text-yellow-600/60 mt-2 italic slide-in">⏳ sigue cargando…</p>
          )}
        </div>
      )}
      {error && (
        <div className="px-3 py-2 text-[10px] text-red-400/60 font-mono">✕ {error}</div>
      )}
      {filtered.map(e =>
        e.is_dir
          ? <DirNode key={e.path} name={e.name} path={e.path} onOpenFile={onOpenFile} selectedFile={selectedFile} filter={filter} gitStatus={gitStatus} />
          : (
            <button key={e.path} onClick={() => { onOpenFile(e.path); }}
              className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] transition-all duration-100 cursor-pointer text-left group
                ${selectedFile === e.path
                  ? 'text-white bg-gray-500/20 ring-1 ring-gray-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
                  : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.04]'
                }`}>
              <span className="shrink-0"><FileIcon name={e.name} isDir={false} /></span>
              <span className="truncate flex-1">
                <HighlightMatch text={e.name} filter={filter} />
              </span>
              <GitBadge status={gitStatus?.[e.name]} />
            </button>
          )
      )}
      {entries && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 text-gray-700 gap-2 select-none">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <p className="text-[10px]">Directorio vacío</p>
        </div>
      )}
    </div>
  );
}