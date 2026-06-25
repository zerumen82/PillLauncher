import React, { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
loader.config({ monaco });

const OUTLINE_ICONS = {
  class:       { icon: 'C', color: 'text-amber-400' },
  interface:   { icon: 'I', color: 'text-sky-400' },
  enum:        { icon: 'E', color: 'text-emerald-400' },
  annotation:  { icon: '@', color: 'text-purple-400' },
  record:      { icon: 'R', color: 'text-teal-400' },
  struct:      { icon: 'S', color: 'text-amber-400' },
  function:    { icon: 'f', color: 'text-purple-400' },
  method:      { icon: 'm', color: 'text-purple-400' },
  trait:       { icon: 'T', color: 'text-blue-400' },
  impl:        { icon: 'I', color: 'text-gray-400' },
  module:      { icon: 'm', color: 'text-gray-400' },
  object:      { icon: 'O', color: 'text-emerald-400' },
  macro:       { icon: 'M', color: 'text-pink-400' },
  package:     { icon: 'P', color: 'text-gray-500' },
  type:        { icon: 't', color: 'text-cyan-400' },
  protocol:    { icon: 'Pr', color: 'text-blue-400' },
};
const DEFAULT_OUTLINE = { icon: '-', color: 'text-gray-400' };

function flattenOutline(items, depth = 0) {
  const result = [];
  for (const item of items) {
    result.push({ ...item, _depth: depth });
    if (item.children?.length) result.push(...flattenOutline(item.children, depth + 1));
  }
  return result;
}

export default function EditorModal({ path, line, col, onClose, panel, initialContent, readOnly, fontSize, breakpoints, onToggleBreakpoint }) {
  const isDiff = !!initialContent;
  const [fileInfo, setFileInfo] = useState(null);
  const [loading, setLoading] = useState(!isDiff);
  const [error, setError] = useState(null);
  const [editorContent, setEditorContent] = useState(initialContent || '');
  const [modified, setModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef(null);
  const [monacoReady, setMonacoReady] = useState(false);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const editorContainerRef = useRef(null);
  const mounted = useRef(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchMatches, setSearchMatches] = useState([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef(null);
  const decorationRef = useRef(null);
  const bpDecorationRef = useRef(null);
  const [showOutline, setShowOutline] = useState(true);
  const [activeLine, setActiveLine] = useState(line || 1);
  const [outlineWidth, setOutlineWidth] = useState(160);

  useEffect(() => { return () => { mounted.current = false; }; }, []);

  const loadFile = useCallback(async () => {
    if (isDiff) return;
    setLoading(true);
    setError(null);
    try {
      const info = await invoke('read_file', { path });
      if (!mounted.current) return;
      setFileInfo(info);
      setEditorContent(info.content);
      setModified(false);
      setSaved(false);
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e));
    }
    if (mounted.current) setLoading(false);
  }, [path, isDiff]);

  useEffect(() => { loadFile(); }, [loadFile]);

  const handleEditorDidMount = (editor, m) => {
    editorRef.current = editor;
    monacoRef.current = m;
    setMonacoReady(true);
    setMonacoFailed(false);
    if (line) {
      editor.revealLineInCenter(line);
      editor.setSelection(new m.Range(line, 1, line, 1));
      editor.createDecorationsCollection([{
        range: new m.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'error-line-bg', glyphMarginClassName: 'error-glyph' }
      }]);
    }
    // Gutter click → toggle breakpoint
    editor.onMouseDown((e) => {
      const t = e.target.type;
      if (t === m.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === m.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
        const ln = e.target.position.lineNumber;
        onToggleBreakpoint?.(path, ln);
      }
    });
    // Apply initial breakpoint decorations
    const bps = breakpoints?.[path];
    if (bps?.length) {
      bpDecorationRef.current = editor.createDecorationsCollection(
        bps.map(l => ({
          range: new m.Range(l, 1, l, 1),
          options: { isWholeLine: true, className: 'breakpoint-line', glyphMarginClassName: 'breakpoint-glyph' }
        }))
      );
    }
    // Track cursor position for outline highlight
    editor.onDidChangeCursorPosition((e) => {
      setActiveLine(e.position.lineNumber);
    });
    setTimeout(() => editor.focus(), 100);
  };

  const handleChange = (value) => {
    if (isDiff) return;
    setEditorContent(value);
    setModified(true);
    setSaved(false);
  };

  const doSave = useCallback(async () => {
    if (isDiff || !modified) return;
    setSaving(true);
    try {
      await invoke('save_file', { path, content: editorContent });
      setModified(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  }, [path, editorContent, modified, isDiff]);

  useEffect(() => {
    if (!modified || isDiff) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(doSave, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [editorContent, modified, isDiff, doSave]);

  const handleSave = async () => {
    if (isDiff) return;
    setSaving(true);
    try {
      await invoke('save_file', { path, content: editorContent });
      setModified(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String(e));
    }
    setSaving(false);
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape' && searchTerm) {
      e.preventDefault();
      setSearchTerm('');
      setSearchMatches([]);
      if (decorationRef.current) { decorationRef.current.clear(); decorationRef.current = null; }
      return;
    }
    if (e.key === 'Escape') onClose();
  };

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorContent, path, searchTerm]);

  const doSearch = useCallback((term) => {
    const editor = editorRef.current;
    if (!editor || !term) {
      setSearchMatches([]);
      if (decorationRef.current) { decorationRef.current.clear(); decorationRef.current = null; }
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    const matches = model.findMatches(term, false, true, false, null, true);
    setSearchMatches(matches);
    if (decorationRef.current) decorationRef.current.clear();
    const decorations = matches.map((m, i) => ({
      range: m.range,
      options: { inlineClassName: i === 0 ? 'search-match-active' : 'search-match' },
    }));
    decorationRef.current = editor.createDecorationsCollection(decorations);
    if (matches.length > 0) {
      setSearchIdx(0);
      editor.revealRangeInCenter(matches[0].range);
      editor.setSelection(matches[0].range);
    } else {
      setSearchIdx(-1);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => doSearch(searchTerm), 150);
    return () => clearTimeout(t);
  }, [searchTerm, doSearch]);

  const goToMatch = useCallback((idx) => {
    if (searchMatches.length === 0 || idx < 0 || idx >= searchMatches.length) return;
    setSearchIdx(idx);
    const m = searchMatches[idx];
    const editor = editorRef.current;
    editor.revealRangeInCenter(m.range);
    editor.setSelection(m.range);
    if (decorationRef.current) {
      const decorations = searchMatches.map((match, i) => ({
        range: match.range,
        options: { inlineClassName: i === idx ? 'search-match-active' : 'search-match' },
      }));
      decorationRef.current.set(decorations);
    }
  }, [searchMatches]);

  // Sync breakpoint decorations when breakpoints prop changes
  useEffect(() => {
    const editor = editorRef.current;
    const m = monacoRef.current;
    if (!editor || !m) return;
    const bps = breakpoints?.[path] || [];
    bpDecorationRef.current = editor.createDecorationsCollection(
      bps.map(l => ({
        range: new m.Range(l, 1, l, 1),
        options: { isWholeLine: true, className: 'breakpoint-line', glyphMarginClassName: 'breakpoint-glyph' }
      }))
    );
  }, [breakpoints, path]);

  const handleOutlineSelect = useCallback((item) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(item.line);
    editor.setSelection(new (monacoRef.current || monaco).Range(item.line, 1, item.line, 1));
    editor.focus();
  }, []);

  const editorBody = (
    <>
      <header className="h-7 flex items-center px-3 border-b border-white/5 bg-[#131622] shrink-0 gap-2">
        {isDiff && <span className="text-[9px] text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded uppercase font-bold">diff</span>}
        <div className="flex-1" />
        {modified && <span className="text-[9px] text-amber-400 font-semibold">● MODIFICADO</span>}
        {saving && <span className="text-[9px] text-gray-500 animate-pulse">guardando…</span>}
        {saved && <span className="text-[9px] text-emerald-400">✓ guardado</span>}
        {!isDiff && fileInfo?.outline?.length > 0 && (
          <button onClick={() => setShowOutline(s => !s)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono transition-all cursor-pointer
              ${showOutline ? 'text-cyan-400 bg-cyan-500/10' : 'text-gray-600 hover:text-gray-400'}`}
            title="Toggle outline panel">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M12 3v9l6 3"/></svg>
            {fileInfo.outline.length}
          </button>
        )}
        {error && <span className="text-[9px] text-red-400 font-semibold truncate max-w-[200px]" title={error}>⚠ {error}</span>}
      </header>

      {!isDiff && fileInfo && (
        <div className="h-9 flex items-center px-3 border-b border-white/5 bg-[#0e1018] shrink-0 gap-2">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-gray-500 shrink-0">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input ref={searchInputRef}
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            placeholder="Buscar en el archivo…"
            className="flex-1 bg-transparent text-[11px] text-gray-300 outline-none placeholder:text-gray-700 font-mono"
          />
          {searchTerm && (
            <>
              <span className="text-[10px] text-gray-600 font-mono tabular-nums">
                {searchMatches.length > 0 ? `${searchIdx + 1}/${searchMatches.length}` : '0/0'}
              </span>
              <button onClick={() => goToMatch(searchIdx - 1)} disabled={searchMatches.length === 0}
                className="text-gray-600 hover:text-gray-300 disabled:opacity-30 cursor-pointer p-0.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
              <button onClick={() => goToMatch(searchIdx + 1)} disabled={searchMatches.length === 0}
                className="text-gray-600 hover:text-gray-300 disabled:opacity-30 cursor-pointer p-0.5">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
              <button onClick={() => { setSearchTerm(''); setSearchMatches([]); if (decorationRef.current) { decorationRef.current.clear(); decorationRef.current = null; } }}
                className="text-gray-700 hover:text-gray-400 cursor-pointer p-0.5">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </>
          )}
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-gray-400 animate-pulse text-sm">Cargando archivo…</span>
        </div>
      )}

      {error && (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-6 text-center">
            <p className="text-red-400 text-sm font-mono">{error}</p>
            <button onClick={loadFile} className="mt-3 px-4 py-1.5 rounded-lg bg-[#1e2438] text-gray-300 hover:bg-[#252b40] text-xs cursor-pointer">Reintentar</button>
          </div>
        </div>
      )}

      {!loading && !error && (fileInfo || isDiff) && (
        <div className="flex-1 flex min-h-0">
          <div ref={editorContainerRef} className="flex-1 min-h-0">
            <Editor
              height="100%"
              language={isDiff ? 'diff' : (fileInfo?.language || 'plaintext')}
              value={editorContent}
              onChange={handleChange}
              theme="vs-dark"
              onMount={handleEditorDidMount}
              loading={
                <div className="h-full flex items-center justify-center">
                  <span className="text-gray-400 animate-pulse text-sm">Cargando editor…</span>
                </div>
              }
              options={{
                fontSize: fontSize || 12,
                fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
                minimap: { enabled: !isDiff, scale: 1 },
                lineNumbers: 'on', scrollBeyondLastLine: false,
                automaticLayout: true, tabSize: 2,
                bracketPairColorization: { enabled: true },
                renderWhitespace: 'selection',
                padding: { top: 8 },
                smoothScrolling: true,
                glyphMargin: !isDiff,
                folding: !isDiff,
                foldingHighlight: !isDiff,
                readOnly: isDiff || readOnly,
                domReadOnly: isDiff || readOnly,
              }}
            />
          </div>
          {showOutline && !isDiff && fileInfo?.outline?.length > 0 && (
            <>
              <div className="w-[3px] shrink-0 relative cursor-col-resize group"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startX = e.clientX;
                  const startW = outlineWidth;
                  const onMove = (ev) => {
                    const w = startW + (ev.clientX - startX);
                    setOutlineWidth(Math.max(80, Math.min(400, w)));
                  };
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                  };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}>
                <div className="absolute inset-y-0 left-0 w-[2px] bg-white/[0.03] group-hover:bg-cyan-500/40 transition-colors" />
              </div>
              <div className="shrink-0 bg-[#0e1018] overflow-y-auto overflow-x-hidden"
                style={{ width: outlineWidth }}>
                {(() => {
                  const flat = flattenOutline(fileInfo.outline);
                  let activeIdx = -1;
                  for (let i = 0; i < flat.length; i++) {
                    const next = flat[i + 1];
                    if (activeLine >= flat[i].line && (!next || activeLine < next.line)) {
                      activeIdx = i; break;
                    }
                  }
                  return flat.map((item, i) => {
                    const oi = OUTLINE_ICONS[item.kind] || DEFAULT_OUTLINE;
                    const isActive = i === activeIdx;
                    return (
                      <div key={i}
                        onClick={() => handleOutlineSelect(item)}
                        className={`flex items-center gap-1 px-2 py-1 cursor-pointer transition-all text-[10px] font-mono border-l-2
                          ${isActive
                            ? 'bg-cyan-500/10 text-cyan-300 border-l-cyan-400'
                            : 'text-white/30 hover:text-white/60 hover:bg-white/[0.02] border-l-transparent'
                          }`}
                        style={{ paddingLeft: 8 + (item._depth || 0) * 10 }}>
                        <span className={`${oi.color} text-[8px] font-bold w-3 shrink-0`}>{oi.icon}</span>
                        <span className="truncate flex-1 min-w-0">{item.name}</span>
                        <span className="text-[7px] text-gray-700 shrink-0">{item.line}</span>
                      </div>
                    );
                  });
                })()}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );

  if (panel) {
    return (
      <div className="h-full flex flex-col min-h-0 bg-[#0e1018] rounded-2xl border border-white/10 overflow-hidden" onKeyDown={handleKeyDown}>
        {editorBody}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[92vw] h-[88vh] bg-[#0e1018] rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden" onKeyDown={handleKeyDown}>
        {editorBody}
      </div>
    </div>
  );
}
