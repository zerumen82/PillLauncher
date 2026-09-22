import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openInExplorer, baseName, joinPath, relativeTo } from './openInExplorer.js';

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

const HEAVY_DIRS = ['node_modules', '.git', '.cargo', 'target', 'build', 'dist', '.gradle', '.idea', '.venv', 'venv', '__pycache__'];

function FileIcon({ name, isDir, open }) {
  const e = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (isDir) {
    if (HEAVY_DIRS.includes(name))
      return <div className="w-[16px] h-[16px] rounded-[5px] flex items-center justify-center text-[7px] font-bold text-gray-600 bg-gray-800/40 border border-white/[0.03] shrink-0">#</div>;
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${open ? 'text-amber-300/90' : 'text-amber-400/50'}`}>
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

// Fila de archivo (misma apariencia en la raíz y en subcarpetas)
function FileRow({ entry, rootPath, selectedFile, filter, gitStatus, onOpenFile, onContextMenu }) {
  return (
    <button onClick={() => onOpenFile(entry.path)} title={entry.path}
      onContextMenu={(ev) => { ev.preventDefault(); onContextMenu?.(ev, { path: entry.path, name: entry.name, isDir: false }); }}
      className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] transition-all duration-100 cursor-pointer text-left group
        ${selectedFile === entry.path
          ? 'text-white bg-gray-500/20 ring-1 ring-gray-500/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
          : 'text-gray-500 hover:text-gray-200 hover:bg-white/[0.04]'
        }`}>
      <span className="shrink-0"><FileIcon name={entry.name} isDir={false} /></span>
      <span className="truncate flex-1">
        <HighlightMatch text={entry.name} filter={filter} />
      </span>
      <GitBadge status={gitStatus?.[relativeTo(rootPath, entry.path)]} />
    </button>
  );
}

// Input inline para crear archivos/carpetas mostrando SIEMPRE la carpeta destino
function CreateInput({ parentPath, parentLabel, type, onCreated, onCancel, onLog, onOpenFile }) {
  const [name, setName] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async () => {
    const nm = name.trim();
    if (!nm) return;
    const full = joinPath(parentPath, nm);
    try {
      await invoke(type === 'file' ? 'create_file' : 'create_folder', { path: full });
      onLog?.(`${type === 'file' ? 'Archivo' : 'Carpeta'} creado: ${full}`, 'ok');
      setName('');
      onCreated?.(full, type);
      if (type === 'file') onOpenFile?.(full);
    } catch (err) {
      onLog?.(`No se pudo crear "${nm}": ${err}`, 'err');
    }
  };

  return (
    <div className="flex items-center gap-1 py-0.5" title={`Se creará en: ${parentPath}`}>
      <span className="text-[9px] font-mono text-gray-600 shrink-0 max-w-[70px] truncate" title={parentPath}>{parentLabel}/</span>
      <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onCancel?.();
        }}
        placeholder={type === 'folder' ? 'nueva-carpeta' : 'archivo.ext'}
        className="flex-1 min-w-0 bg-[#1a1e2e] text-[10px] text-gray-200 placeholder:text-gray-700 rounded px-1.5 py-0.5 border border-cyan-500/30 outline-none font-mono focus:border-cyan-500/60 transition-all" />
      <button onClick={submit} title="Crear (Enter)"
        className="text-[9px] text-emerald-400 hover:text-emerald-300 px-1 rounded bg-emerald-500/10 font-bold shrink-0">✓</button>
      <button onClick={() => onCancel?.()} title="Cancelar (Esc)"
        className="text-[9px] text-gray-500 hover:text-gray-300 px-1 rounded bg-white/[0.04] font-bold shrink-0">✕</button>
    </div>
  );
}

function TreeBtn({ title, active, onClick, children }) {
  return (
    <button onClick={onClick} title={title}
      className={`w-5 h-5 flex items-center justify-center rounded transition-colors cursor-pointer shrink-0
        ${active ? 'text-cyan-400 bg-cyan-500/10' : 'text-gray-600 hover:text-gray-300 hover:bg-white/[0.06]'}`}>
      {children}
    </button>
  );
}


function DirNode({ name, path: dirPath, onOpenFile, selectedFile, filter, gitStatus, showHidden, onContextMenu, onLog, treeSignal, createSignal, rootPath }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(null); // 'file' | 'folder' | null
  const mounted = useRef(true);
  useEffect(() => { return () => { mounted.current = false; }; }, []);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await invoke('list_dir', { path: dirPath, showHidden });
      if (mounted.current) setChildren(entries);
    } catch (err) {
      if (mounted.current) setChildren([]);
      onLog?.(`No se pudo leer ${dirPath}: ${err}`, 'err');
    }
    if (mounted.current) setLoading(false);
  }, [dirPath, showHidden, onLog]);

  const toggle = useCallback(async () => {
    if (open) { setOpen(false); return; }
    if (children === null) await loadChildren();
    setOpen(true);
  }, [open, children, loadChildren]);

  // valores vivos para las señales globales (evita dependencias circulares)
  const liveRef = useRef({});
  liveRef.current = { children, loadChildren };

  // al cambiar "mostrar ocultos" se recarga lo que ya estaba expandido
  const prevHidden = useRef(showHidden);
  useEffect(() => {
    if (prevHidden.current === showHidden) return;
    prevHidden.current = showHidden;
    if (children !== null) loadChildren();
  }, [showHidden, children, loadChildren]);

  // expandir todo / contraer todo / refrescar
  useEffect(() => {
    if (!treeSignal) return;
    const live = liveRef.current;
    if (treeSignal.mode === 'collapse') { setOpen(false); return; }
    if (treeSignal.mode === 'refresh') { if (live.children !== null) live.loadChildren(); return; }
    if (treeSignal.mode === 'expand') {
      if (live.children === null) live.loadChildren();
      setOpen(true);
    }
  }, [treeSignal]);

  // "nuevo archivo/carpeta aquí" desde el menú contextual
  useEffect(() => {
    if (!createSignal || createSignal.path !== dirPath) return;
    const live = liveRef.current;
    if (live.children === null) live.loadChildren();
    setOpen(true);
    setCreating(createSignal.type);
  }, [createSignal, dirPath]);

  const items = children || [];
  const filtered = filter ? items.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())) : items;
  const hasContent = filtered.length > 0;
  const folderCount = items.filter(e => e.is_dir).length;
  const fileCount = items.length - folderCount;

  const showChildren = open && children !== null;

  return (
    <div>
      <button onClick={toggle} onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(e, { path: dirPath, name, isDir: true }); }}
        title={dirPath}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] text-gray-400 hover:text-gray-200 hover:bg-white/[0.04] active:bg-white/[0.06] transition-all duration-100 cursor-pointer text-left group">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-gray-600 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        {loading
          ? <span className="flex items-center gap-1.5 w-full">
              <span className="shrink-0"><FileIcon name={name} isDir open={open} /></span>
              <span className="truncate text-gray-500">{name}</span>
              <span className="ml-auto w-3 h-3 rounded-full border border-gray-500/30 border-t-gray-400 animate-spin" />
            </span>
          : <span className="flex items-center gap-1.5 min-w-0 w-full">
              <span className="shrink-0"><FileIcon name={name} isDir open={open} /></span>
              <span className="truncate font-medium text-gray-300 group-hover:text-white transition-colors">
                <HighlightMatch text={name} filter={filter} />
              </span>
              {children !== null && (
                <span className="ml-auto shrink-0 text-[8px] font-mono px-1.5 py-[1px] rounded-full bg-white/[0.04] text-gray-600"
                  title={items.length === 0 ? 'carpeta vacía' : `${folderCount} carpeta(s) · ${fileCount} archivo(s)`}>
                  {items.length === 0 ? 'vacío' : items.length}
                </span>
              )}
            </span>
        }
      </button>
      <div style={{
        maxHeight: showChildren ? (hasContent || creating ? '4000px' : '26px') : (creating ? '4000px' : '0px'),
        opacity: showChildren || creating ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 250ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease',
      }}>
        {showChildren && (
          <div className="ml-[15px] pl-[9px] tree-indent-line">
            {creating && (
              <CreateInput parentPath={dirPath} parentLabel={name} type={creating}
                onCreated={() => loadChildren()}
                onCancel={() => setCreating(null)}
                onLog={onLog} onOpenFile={onOpenFile} />
            )}
            {hasContent ? (
              filtered.map(e =>
                e.is_dir
                  ? <DirNode key={e.path} name={e.name} path={e.path} onOpenFile={onOpenFile} selectedFile={selectedFile}
                      filter={filter} gitStatus={gitStatus} showHidden={showHidden} onContextMenu={onContextMenu}
                      onLog={onLog} treeSignal={treeSignal} createSignal={createSignal} rootPath={rootPath} />
                  : <FileRow key={e.path} entry={e} rootPath={rootPath} selectedFile={selectedFile} filter={filter}
                      gitStatus={gitStatus} onOpenFile={onOpenFile} onContextMenu={onContextMenu} />
              )
            ) : (!creating && (
              <p className="text-[9px] text-gray-700 italic pl-1.5 py-1 select-none">vacío</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SkeletonBar = ({ width, opacity }) => (
  <div className="h-3 rounded bg-gradient-to-r from-white/[0.02] via-white/[0.04] to-transparent animate-pulse" style={{ width, opacity }} />
);

function CtxMenu({ x, y, target, rootPath, onAction, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const handle = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const kb = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', kb);
    return () => { document.removeEventListener('mousedown', handle); document.removeEventListener('keydown', kb); };
  }, [onClose]);

  const rel = relativeTo(rootPath, target.path);
  const itemCls = 'w-full text-left px-3 py-1.5 text-[11px] text-gray-300 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer flex items-center gap-2';
  const go = (action) => { onAction?.(action, target); onClose(); };
  const I = ({ children }) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" className="text-gray-500 shrink-0">{children}</svg>
  );

  return (
    <div ref={ref}
      style={{ position: 'fixed', top: y, left: x, zIndex: 9999 }}
      className="bg-[#0e1118] border border-white/[0.08] rounded-xl shadow-2xl py-1 min-w-[220px] backdrop-blur-xl">
      <div className="px-3 py-1 mb-1 border-b border-white/[0.06]">
        <p className="text-[10px] text-gray-300 truncate font-mono flex items-center gap-1.5">
          <I>{target.isDir
            ? <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            : <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>}</I>
          <span className="truncate">{target.name}</span>
        </p>
        <p className="text-[9px] text-gray-600 font-mono truncate" title={target.path}>{rel}</p>
      </div>
      {target.isDir && (
        <>
          <button className={itemCls} onClick={() => go('new-file')}>
            <I><><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></></I>
            Nuevo archivo aquí
          </button>
          <button className={itemCls} onClick={() => go('new-folder')}>
            <I><><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></></I>
            Nueva carpeta aquí
          </button>
          <div className="h-px bg-white/[0.06] my-1" />
        </>
      )}
      <button className={itemCls} onClick={() => go('reveal')}>
        <I><><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/></></I>
        Abrir en Explorador
      </button>
      <button className={itemCls} onClick={() => go('copy-path')}>
        <I><><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></></I>
        Copiar ruta
      </button>
      <button className={itemCls} onClick={() => go('copy-relative')}>
        <I><><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></></I>
        Copiar ruta relativa
      </button>
    </div>
  );
}

export default function FileTree({ rootPath, onOpenFile, selectedFile, filter, gitStatus, onLog }) {
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [stalled, setStalled] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [showHidden, setShowHidden] = useState(true);
  const [treeSignal, setTreeSignal] = useState(null);
  const [createSignal, setCreateSignal] = useState(null);
  const [creating, setCreating] = useState(null); // creación en la raíz
  const seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { return () => { mounted.current = false; }; }, []);

  const rootName = baseName(rootPath);

  const loadRoot = useCallback(() => {
    if (!rootPath) return Promise.resolve();
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => { if (mounted.current) setStalled(true); }, 8000);
    return invoke('list_dir', { path: rootPath, showHidden })
      .then(r => { clearTimeout(timer); if (mounted.current) { setEntries(r); setLoading(false); } })
      .catch(e => {
        clearTimeout(timer);
        if (mounted.current) { setError(String(e)); setEntries([]); setLoading(false); }
        onLog?.(`No se pudo listar ${rootPath}: ${e}`, 'err');
      });
  }, [rootPath, showHidden, onLog]);

  useEffect(() => { setEntries(null); setStalled(false); loadRoot(); }, [loadRoot]);

  const emitSignal = useCallback((mode) => {
    seq.current += 1;
    setTreeSignal({ seq: seq.current, mode });
  }, []);

  const startCreate = useCallback((parentPath, type) => {
    if (!parentPath) return;
    if (parentPath === rootPath) { setCreating(type); return; }
    seq.current += 1;
    setCreateSignal({ seq: seq.current, path: parentPath, type });
  }, [rootPath]);

  const handleCtxAction = useCallback(async (action, target) => {
    if (action === 'new-file' || action === 'new-folder') {
      startCreate(target.path, action === 'new-file' ? 'file' : 'folder');
      return;
    }
    if (action === 'copy-path' || action === 'copy-relative') {
      const text = action === 'copy-path' ? target.path : relativeTo(rootPath, target.path);
      try { await writeText(text); onLog?.(`Copiado: ${text}`, 'ok'); }
      catch (e) { onLog?.(`No se pudo copiar la ruta: ${e}`, 'err'); }
      return;
    }
    if (action === 'reveal') {
      try {
        await openInExplorer(target.path, { isDir: target.isDir });
        onLog?.(`Explorador: ${target.path}`, 'dim');
      } catch (e) {
        onLog?.(`No se pudo abrir el Explorador: ${e?.message || e}`, 'err');
      }
    }
  }, [rootPath, startCreate, onLog]);

  const openCtx = useCallback((ev, target) => {
    ev.preventDefault();
    setCtxMenu({ x: ev.clientX, y: ev.clientY, target });
  }, []);

  if (!rootPath) return null;

  const filtered = entries ? (filter ? entries.filter(e => e.name.toLowerCase().includes(filter.toLowerCase())) : entries) : [];

  return (
    <div className="flex flex-col min-h-0">
      <div className="sticky top-0 z-10 px-2 py-1 bg-[#141826]/95 backdrop-blur border-b border-white/[0.05] flex items-center gap-1.5 shrink-0">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-400/70 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <span className="text-[10px] font-semibold text-gray-200 truncate" title={rootPath}>{rootName || rootPath}</span>
        {entries && (
          <span className="text-[8px] font-mono text-gray-600 shrink-0" title="elementos en la raíz">
            {filter ? `${filtered.length}/${entries.length}` : entries.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <TreeBtn title="Nuevo archivo en la raíz" onClick={() => setCreating('file')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
          </TreeBtn>
          <TreeBtn title="Nueva carpeta en la raíz" onClick={() => setCreating('folder')}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </TreeBtn>
          <div className="w-px h-3 bg-white/[0.08] mx-0.5 shrink-0" />
          <TreeBtn title={showHidden ? 'Ocultar archivos ocultos (.)' : 'Mostrar archivos ocultos (.)'}
            active={showHidden} onClick={() => setShowHidden(v => !v)}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </TreeBtn>
          <TreeBtn title="Expandir todo" onClick={() => emitSignal('expand')}><span className="text-[11px] leading-none">⊞</span></TreeBtn>
          <TreeBtn title="Contraer todo" onClick={() => emitSignal('collapse')}><span className="text-[11px] leading-none">⊟</span></TreeBtn>
          <TreeBtn title="Refrescar" onClick={() => emitSignal('refresh')}><span className="text-[11px] leading-none">⟳</span></TreeBtn>
        </div>
      </div>
      <div className="text-[11px] font-mono select-none space-y-[1px] p-1">
        {creating && (
          <CreateInput parentPath={rootPath} parentLabel={rootName || rootPath} type={creating}
            onCreated={() => loadRoot()}
            onCancel={() => setCreating(null)}
            onLog={onLog} onOpenFile={onOpenFile} />
        )}
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
        {filtered.map(e => e.is_dir
          ? <DirNode key={e.path} name={e.name} path={e.path} onOpenFile={onOpenFile} selectedFile={selectedFile}
              filter={filter} gitStatus={gitStatus} showHidden={showHidden} onContextMenu={openCtx} onLog={onLog}
              treeSignal={treeSignal} createSignal={createSignal} rootPath={rootPath} />
          : <FileRow key={e.path} entry={e} rootPath={rootPath} selectedFile={selectedFile} filter={filter} gitStatus={gitStatus}
              onOpenFile={onOpenFile} onContextMenu={openCtx} />
        )}
        {entries && entries.length === 0 && !creating && (
          <div className="flex flex-col items-center justify-center py-10 text-gray-700 gap-2 select-none">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <p className="text-[10px]">Carpeta vacía</p>
          </div>
        )}
        {entries && entries.length > 0 && filtered.length === 0 && (
          <p className="px-3 py-4 text-[10px] text-gray-600 italic">Sin coincidencias para “{filter}”</p>
        )}
        {ctxMenu && (
          <CtxMenu x={ctxMenu.x} y={ctxMenu.y} target={ctxMenu.target} rootPath={rootPath}
            onAction={handleCtxAction} onClose={() => setCtxMenu(null)} />
        )}
      </div>
    </div>
  );
}
