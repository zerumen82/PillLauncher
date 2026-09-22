import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import EditorModal from './EditorModal.jsx';
import DebugPanel from './DebugPanel.jsx';
import { Group, Panel, Separator } from 'react-resizable-panels';
import FileTree from './FileTree.jsx';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openInExplorer, baseName, joinPath, relativeTo } from './openInExplorer.js';
import { check } from '@tauri-apps/plugin-updater';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import ProjectTabs from './ProjectTabs.jsx';
import settings from './settings.js';

settings.init();

window.addEventListener('error', (e) => {
  if (e.message && /paste.?image|Failed to paste/i.test(e.message)) { e.preventDefault(); return; }
  try { invoke('log_error', { msg: e.message || String(e), stack: e.error?.stack || '' }); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason);
  if (/paste.?image/i.test(msg)) { e.preventDefault(); return; }
  try { invoke('log_error', { msg: 'Promise: ' + msg, stack: e.reason?.stack || '' }); } catch {}
});

const KIND_STYLE = {
  err:       'text-red-400',
  ok:        'text-emerald-400',
  info:      'text-sky-400',
  stdout:    'text-gray-300',
  stderr:    'text-red-400',
  dim:       'text-gray-600',
  done:      'text-gray-700',
  'run-active': 'text-amber-400',
  'run-end':    'text-gray-700',
};
const KIND_ICON = { err: '✕', ok: '✓', info: '▸', dim: '·', done: '─', 'run-active': '▶', 'run-end': '■' };

function shortPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  if (parts.length <= 3) return p;
  return `${parts[0]}\\…\\${parts.at(-2)}\\${parts.at(-1)}`;
}

const FILE_LINE_RE = /((?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:\w[\w.-]*[\\/])*\w[\w.-]*\.\w+):(\d+)(?::(\d+))?/g;

function splitLogLine(text, openFn) {
  if (!text) return [{ type: 'text', text: '' }];
  const parts = [];
  let last = 0, m;
  FILE_LINE_RE.lastIndex = 0;
  while ((m = FILE_LINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: text.slice(last, m.index) });
    const fp = m[1].replace(/\\/g, '/');
    const ln = parseInt(m[2], 10);
    const cn = m[3] ? parseInt(m[3], 10) : 1;
    parts.push({ type: 'link', text: m[0], path: fp, line: ln, onClick: () => openFn(fp, ln, cn) });
    last = FILE_LINE_RE.lastIndex;
  }
  if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
  return parts;
}

const FolderIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400/70">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="ml-0.5">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);
const BuildIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

function makeWorkspace(path) {
  return {
    path,
    info: null,
    activeMode: '',
    treeKey: 0,
    editorFiles: [],
    activeFileIdx: -1,
    gitEntries: null,
    gitBranches: null,
    gitWorking: false,
    commitMsg: '',
    gitOpenCards: { staged: true, changes: true, history: false },
    consoleTabs: [{ id: 'consola', label: 'Consola' }],
    activeConsoleTab: 'consola',
    debugSessionId: null,
    debugVars: [],
    debugStack: [],
    debugLocation: null,
    suspended: false,
    explorerTab: 'files',
    sidebarOpen: true,
    fileFilter: '',
  };
}

function App() {
  // ── Project management ──
  const [projects, setProjects] = useState({});
  const [projectOrder, setProjectOrder] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const activeProjectRef = useRef(null);
  useEffect(() => { activeProjectRef.current = activeProject; }, [activeProject]);

  const ws = activeProject ? projects[activeProject] : null;

  const updateWs = useCallback((path, updater) => {
    setProjects(prev => {
      const ws = prev[path];
      if (!ws) return prev;
      const next = typeof updater === 'function' ? { ...ws, ...updater(ws) } : { ...ws, ...updater };
      return { ...prev, [path]: next };
    });
  }, []);

  const updateActive = useCallback((updater) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    updateWs(proj, updater);
  }, [updateWs]);

  const wsRef = useRef(null);
  useEffect(() => { wsRef.current = ws; }, [ws]);

  // ── Terminal refs per project ──
  const terminalRefs = useRef({});  // { [projectPath]: { [tabId]: session } }

  // ── Global state ──
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const logEnd = useRef(null);
  const [showCmdMenu, setShowCmdMenu] = useState(null);
  const modeRef = useRef(null);
  const allCmdRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [, setSearching] = useState(false);
  const searchRef = useRef(null);
  const [recentProjects, setRecentProjects] = useState([]);
  const [showRecent, setShowRecent] = useState(false);
  const recentRef = useRef(null);
  const [consoleSearch, setConsoleSearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugPort, setDebugPort] = useState(5005);
  const [debugSuspend, setDebugSuspend] = useState(true);
  const [breakpoints, setBreakpoints] = useState({});
  const [editorFontSize, setEditorFontSize] = useState(12);
  const [consoleFontSize, setConsoleFontSize] = useState(11);
  const [toast, setToast] = useState(null);
  const [isGitHubRemote, setIsGitHubRemote] = useState(false);
  const [compactTerminal, setCompactTerminal] = useState(true);
  const [, setMaxLogLines] = useState(500);
  const [gitLog, setGitLog] = useState([]);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState(null); // 'file' | 'folder' | null
  const [, setMaxLineLength] = useState(300);
  const maxLogLinesRef = useRef(500);
  const maxLineLengthRef = useRef(300);

  const saveProjectState = useCallback(() => {
    const state = {};
    for (const [path, proj] of Object.entries(projects)) {
      state[path] = {
        editorFiles: proj.editorFiles,
        activeFileIdx: proj.activeFileIdx,
        consoleTabs: proj.consoleTabs,
        activeConsoleTab: proj.activeConsoleTab,
        sidebarOpen: proj.sidebarOpen,
        explorerTab: proj.explorerTab,
      };
    }
    settings.set('saved_project_state', state);
  }, [projects]);

  const restoreProjectState = useCallback(async () => {
    const saved = await settings.get('saved_project_state');
    if (!saved || typeof saved !== 'object') return;
    for (const [path, state] of Object.entries(saved)) {
      if (!projects[path]) continue;
      updateWs(path, {
        editorFiles: state.editorFiles || [],
        activeFileIdx: typeof state.activeFileIdx === 'number' ? state.activeFileIdx : -1,
        consoleTabs: state.consoleTabs || [{ id: 'consola', label: 'Consola' }],
        activeConsoleTab: state.activeConsoleTab || 'consola',
        sidebarOpen: state.sidebarOpen !== false,
        explorerTab: state.explorerTab || 'files',
      });
    }
  }, [projects, updateWs]);

  const collapseRepeated = (arr) => {
    if (!compactTerminal || !arr?.length) return arr || [];
    const maxLen = maxLineLengthRef.current || 300;
    const result = [];
    let repeatCount = 0;
    for (let i = 0; i < arr.length; i++) {
      const text = arr[i].text;
      const truncated = text.length > maxLen ? text.slice(0, Math.floor(maxLen * 0.6)) + `… (${text.length - Math.floor(maxLen * 0.6)} más)` : text;
      if (i > 0 && arr[i].text === arr[i-1].text && arr[i].kind === arr[i-1].kind) {
        repeatCount++;
        if (repeatCount === 1 || repeatCount === 10 || repeatCount === 50 || repeatCount === 100 || repeatCount % 200 === 0) {
          result[result.length - 1] = { text: `${truncated} (×${repeatCount + 1})`, kind: arr[i].kind, t: arr[i].t };
        }
      } else {
        repeatCount = 0;
        result.push({ ...arr[i], text: truncated });
      }
    }
    return result;
  };

  const filteredLogs = consoleSearch
    ? (logs || []).filter(l => l?.text && l.text.toLowerCase().includes(consoleSearch.toLowerCase()))
    : collapseRepeated(logs || []);

  const gitStaged = ws?.gitEntries ? ws.gitEntries.filter(([s]) => {
    const x = s[0];
    return x !== ' ' && x !== '?';
  }) : [];
  const gitUnstaged = ws?.gitEntries ? ws.gitEntries.filter(([s]) => {
    const y = s[1];
    return s === '??' || s === '!!' || y !== ' ' && y !== '?';
  }) : [];
  const gitModified = gitUnstaged.filter(([s]) => s !== '??' && s !== '!!');
  const gitUntracked = gitUnstaged.filter(([s]) => s === '??' || s === '!!');

  useEffect(() => {
    settings.onReady(async () => {
      const s = await settings.getAll();
      setRecentProjects(s.recent);
      setDebugPort(s.debug_port);
      setDebugSuspend(s.debug_suspend);
      setBreakpoints(s.breakpoints);
      setEditorFontSize(s.editor_font_size);
      setConsoleFontSize(s.console_font_size);
      setCompactTerminal(s.compact_terminal !== false);
      const ml = s.max_log_lines || 500;
      const mll = s.max_line_length || 300;
      setMaxLogLines(ml);
      setMaxLineLength(mll);
      maxLogLinesRef.current = ml;
      maxLineLengthRef.current = mll;
    });
  }, []);

  const addLog = useCallback((text, kind = 'stdout') => setLogs(prev => {
    const maxLen = maxLineLengthRef.current || 300;
    const trimmed = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
    const next = [...prev, { text: trimmed, kind, t: Date.now() }];
    const maxLines = maxLogLinesRef.current || 500;
    return next.length > maxLines ? next.slice(-maxLines) : next;
  }), []);
  const clearLogs = useCallback(() => setLogs([]), []);

  const doSearch = useCallback(async (q) => {
    if (!q.trim() || !activeProject) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const r = await invoke('search_files', { path: activeProject, query: q });
      setSearchResults(r);
    } catch { setSearchResults([]); }
    setSearching(false);
  }, [activeProject]);

  useEffect(() => {
    const t = setTimeout(() => doSearch(searchQuery), 200);
    return () => clearTimeout(t);
  }, [searchQuery, doSearch]);

  const addRecent = useCallback((p) => {
    if (!p) return;
    setRecentProjects(prev => {
      const next = [p, ...prev.filter(r => r !== p)].slice(0, 8);
      settings.set('recent', next);
      return next;
    });
  }, []);

  const openDiff = useCallback(async (file) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    try {
      const diff = await invoke('git_diff', { path: proj, file });
      const dpath = `diff:${file}`;
      updateWs(proj, prev => {
        const idx = prev.editorFiles.findIndex(f => f.path === dpath);
        if (idx >= 0) return { activeFileIdx: idx };
        return {
          editorFiles: [...prev.editorFiles, { path: dpath, line: 1, col: 1, content: diff, isDiff: true }],
          activeFileIdx: prev.editorFiles.length,
        };
      });
    } catch (e) { addLog(String(e), 'err'); }
  }, [addLog, updateWs]);

  const openFileAtLine = useCallback((fp, ln, cn) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    updateWs(proj, prev => {
      const idx = prev.editorFiles.findIndex(f => f.path === fp);
      if (idx >= 0) return { activeFileIdx: idx };
      return {
        editorFiles: [...prev.editorFiles, { path: fp, line: ln, col: cn || 1 }],
        activeFileIdx: prev.editorFiles.length,
      };
    });
  }, [updateWs]);

  const openFile = useCallback((fp) => openFileAtLine(fp, 1, 1), [openFileAtLine]);

  const closeEditor = useCallback((fp) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    updateWs(proj, prev => {
      const idx = prev.editorFiles.findIndex(f => f.path === fp);
      if (idx < 0) return {};
      const next = prev.editorFiles.filter((_, i) => i !== idx);
      let newIdx = prev.activeFileIdx;
      if (prev.activeFileIdx >= next.length) newIdx = Math.max(0, next.length - 1);
      else if (prev.activeFileIdx > idx) newIdx = prev.activeFileIdx - 1;
      else if (prev.activeFileIdx === idx) newIdx = next.length > 0 ? Math.min(idx, next.length - 1) : -1;
      return { editorFiles: next, activeFileIdx: newIdx };
    });
  }, [updateWs]);

  const openProject = useCallback(async (sel) => {
    if (!sel) return;
    if (projects[sel]) { setActiveProject(sel); return; }
    const newWs = makeWorkspace(sel);
    invoke('register_root', { path: sel }).catch(e => console.warn('register_root:', e));
    setProjects(prev => ({ ...prev, [sel]: newWs }));
    setProjectOrder(prev => [...prev.filter(p => p !== sel), sel]);
    setActiveProject(sel);
    addRecent(sel);
    settings.set('last_project', sel);
    setShowRecent(false);
    addLog(`Abriendo carpeta: ${sel}`, 'dim');
    try {
      const r = await invoke('detect_project', { path: sel });
      updateWs(sel, { info: r, activeMode: r.modes[0]?.id || '' });
      invoke('git_pull', { path: sel }).then(out => {
        if (out && !out.includes('Already up to date')) addLog(`git pull: ${out}`, 'dim');
      }).catch(e => addLog(`git pull: ${e}`, 'err'));
    } catch (e) {
      addLog(`Carpeta sin estructura de proyecto conocida — modo terminal activo`, 'info');
      const fallback = {
        path: sel,
        typ: 'folder',
        label: sel.split(/[\\/]/).pop() || 'Carpeta',
        emoji: '📁',
        color: '#6b7280',
        version: '',
        modes: [],
        profiles: [],
        gradle_tasks: [],
        build_cmd: '',
        clean_cmd: '',
        run_cmd: '',
        test_cmd: '',
      };
      updateWs(sel, { info: fallback, activeMode: '' });
    }
    if (!activeProjectRef.current) setActiveProject(sel);
  }, [projects, addLog, addRecent, updateWs]);

  const closeProject = useCallback((path) => {
    const termProj = terminalRefs.current[path];
    if (termProj) {
      Object.values(termProj).forEach(session => {
        session.dispose?.();
        if (session.term) { try { session.term.dispose(); } catch {} }
        if (session.sessionId) invoke('stop_terminal', { sessionId: session.sessionId }).catch(e => console.warn('stop_terminal:', e));
      });
      delete terminalRefs.current[path];
    }
    setProjects(prev => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    setProjectOrder(prev => {
      const next = prev.filter(p => p !== path);
      if (next.length === 0) {
        settings.set('last_project', '');
        setActiveProject(null);
      } else {
        const newActive = activeProjectRef.current === path ? next[0] : activeProjectRef.current;
        setActiveProject(newActive);
      }
      return next;
    });
  }, []);

  const onBrowse = useCallback(async () => {
    try {
      const sel = await open({ directory: true, multiple: false });
      if (sel) openProject(sel);
    } catch (e) { addLog(String(e), 'err'); }
  }, [openProject, addLog]);

  useEffect(() => {
    settings.set('project_order', projectOrder);
  }, [projectOrder]);

  useEffect(() => {
    if (activeProject) settings.set('last_project', activeProject);
  }, [activeProject]);

  useEffect(() => {
    settings.onReady(async () => {
      const order = await settings.get('project_order');
      if (Array.isArray(order) && order.length > 0) {
        order.forEach(p => openProject(p));
        return;
      }
      const last = await settings.get('last_project');
      if (last) openProject(last);
    });
  }, []);

  const refreshGit = useCallback(() => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    invoke('git_status', { path: proj }).then(r => updateWs(proj, { gitEntries: r })).catch(() => updateWs(proj, { gitEntries: null }));
    invoke('git_branches', { path: proj }).then(r => updateWs(proj, { gitBranches: r })).catch(() => updateWs(proj, { gitBranches: null }));
    invoke('git_remote_url', { path: proj }).then(url => {
      const isGitHub = url.includes('github.com');
      setIsGitHubRemote(isGitHub);
    }).catch(() => setIsGitHubRemote(false));
    invoke('git_log', { path: proj, count: 30 }).then(r => setGitLog(r)).catch(() => setGitLog([]));
  }, [updateWs]);

  const showToast = useCallback((message, type = 'ok') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const doGitCheckout = useCallback((branch) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    invoke('git_checkout', { path: proj, branch })
      .then(r => { addLog(r, 'ok'); refreshGit(); showToast(`✓ Switched to '${branch}'`, 'ok'); })
      .catch(e => { addLog(String(e), 'err'); showToast(`✕ ${e}`, 'err'); });
  }, [addLog, refreshGit, showToast]);

  const doCommit = useCallback(async () => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const currentWs = wsRef.current;
    if (!currentWs?.commitMsg.trim()) return;
    updateWs(proj, { gitWorking: true });
    try {
      const r = await invoke('git_commit', { path: proj, message: currentWs.commitMsg.trim() });
      addLog(r, 'ok');
      updateWs(proj, { commitMsg: '', gitWorking: false });
      refreshGit();
    } catch (e) { addLog(String(e), 'err'); updateWs(proj, { gitWorking: false }); }
  }, [addLog, refreshGit, updateWs]);

  const addTerminal = useCallback(async (label, initialCmd) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const prev = wsRef.current;
    termCounterRef.current++;
    const tabId = `term_${Date.now()}`;
    const displayLabel = label || `Term ${termCounterRef.current}`;
    updateWs(proj, prev => ({
      consoleTabs: [...prev.consoleTabs, { id: tabId, label: displayLabel }],
      activeConsoleTab: tabId,
      termCounter: (prev.termCounter || 0) + 1,
    }));
    if (initialCmd && prev?.info?.path) {
      try {
        await invoke('launch_external_terminal', { path: prev.info.path, initialCmd });
      } catch (e) { addLog(String(e), 'err'); }
    }
    return tabId;
  }, [addLog, updateWs]);

  const closeTerminal = useCallback((tabId) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const projTerms = terminalRefs.current[proj];
    if (projTerms) {
      const session = projTerms[tabId];
      if (session) {
        session.dispose?.();
        if (session.term) { try { session.term.dispose(); } catch {} }
        if (session.sessionId) invoke('stop_terminal', { sessionId: session.sessionId }).catch(e => console.warn('stop_terminal:', e));
        delete projTerms[tabId];
      }
    }
    updateWs(proj, prev => ({
      consoleTabs: prev.consoleTabs.filter(t => t.id !== tabId),
      activeConsoleTab: prev.activeConsoleTab === tabId ? 'consola' : prev.activeConsoleTab,
    }));
  }, [updateWs]);

  useEffect(() => {
    settings.set('breakpoints', breakpoints);
  }, [breakpoints]);

  useEffect(() => {
    const handler = () => saveProjectState();
    window.addEventListener('beforeunload', handler);
    let unlistenClose;
    listen('tauri://close-requested', () => {
      saveProjectState();
    }).then(fn => { unlistenClose = fn; });
    let unlistenUpdate;
    listen('tauri://update-available', () => {
      saveProjectState();
    }).then(fn => { unlistenUpdate = fn; });
    return () => {
      saveProjectState();
      window.removeEventListener('beforeunload', handler);
      unlistenClose?.();
      unlistenUpdate?.();
    };
  }, [saveProjectState]);

  const projectCount = Object.keys(projects).length;
  useEffect(() => {
    if (projectCount > 0) {
      restoreProjectState();
    }
  }, [projectCount]);

  useEffect(() => {
    settings.get('compact_terminal').then(v => {
      if (typeof v === 'boolean') setCompactTerminal(v);
    });
  }, []);

  const termCounterRef = useRef(0);

  const toggleBreakpoint = useCallback(async (filePath, line) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    setBreakpoints(prev => {
      const lines = [...(prev[filePath] || [])];
      const idx = lines.indexOf(line);
      if (idx >= 0) lines.splice(idx, 1); else lines.push(line);
      lines.sort((a, b) => a - b);
      return { ...prev, [filePath]: lines.length ? lines : undefined };
    });
    const currentWs = wsRef.current;
    if (currentWs?.debugSessionId) {
      const currentLines = breakpoints[filePath] || [];
      const isNowSet = !currentLines.includes(line);
      try {
        const cls = await invoke('resolve_bp_class', { path: filePath });
        if (isNowSet) {
          invoke('debug_cmd', { sessionId: currentWs.debugSessionId, cmd: `stop at ${cls}:${line}` })
            .catch(e => addLog(`jdb: ${e}`, 'err'));
        } else {
          invoke('debug_cmd', { sessionId: currentWs.debugSessionId, cmd: `clear ${cls}:${line}` })
            .catch(e => addLog(`jdb: ${e}`, 'err'));
        }
      } catch (e) { addLog(String(e), 'err'); }
    }
  }, [breakpoints, addLog]);

  useEffect(() => {
    const handler = (e) => {
      if (showSettings && !settingsRef.current?.contains(e.target)) setShowSettings(false);
      if (showRecent && !recentRef.current?.contains(e.target)) setShowRecent(false);
      if (showCmdMenu === null) return;
      const inMode = modeRef.current?.contains(e.target);
      const inAll = allCmdRef.current?.contains(e.target);
      if (showCmdMenu === 'mode' && !inMode) setShowCmdMenu(null);
      if (showCmdMenu === 'all' && !inAll) setShowCmdMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showCmdMenu, showRecent]);

  useEffect(() => {
    if (logEnd.current) {
      logEnd.current.scrollTop = logEnd.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    const unlisten = listen('log', (e) => {
      const p = e.payload;
      addLog(p.text, p.kind);
      if (p.kind === 'run-active') setRunning(true);
      if (p.kind === 'run-end') setRunning(false);
    });
    return () => { unlisten.then(fn => fn()); };
  }, [addLog]);

  useEffect(() => {
    const unlisten = listen('terminal-exited', (e) => {
      const { id } = e.payload;
      for (const [projPath, projTerms] of Object.entries(terminalRefs.current)) {
        const entry = Object.entries(projTerms).find(([, session]) => session.sessionId === id);
        if (entry) {
          const [tabId, session] = entry;
          session.dispose?.();
          if (session.term) { try { session.term.dispose(); } catch {} }
          delete projTerms[tabId];
          updateWs(projPath, prev => ({
            consoleTabs: prev.consoleTabs.filter(t => t.id !== tabId),
            activeConsoleTab: prev.activeConsoleTab === tabId ? 'consola' : prev.activeConsoleTab,
          }));
          break;
        }
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [updateWs]);

  // ── Clean up terminals when a project is removed ──
  useEffect(() => {
    return () => {
      Object.entries(terminalRefs.current).forEach(([_projPath, projTerms]) => {
        Object.values(projTerms).forEach(session => {
          session.dispose?.();
          if (session.term) { try { session.term.dispose(); } catch {} }
          if (session.sessionId) invoke('stop_terminal', { sessionId: session.sessionId }).catch(e => console.warn('stop_terminal:', e));
        });
      });
    };
  }, []);

  // ── Terminal lifecycle per active project ──
  const terminalKey = ws ? `${ws.path}:${ws.activeConsoleTab}` : null;
  useEffect(() => {
    if (!terminalKey || terminalKey.endsWith(':consola')) return;
    const colonIdx = terminalKey.lastIndexOf(':');
    const projPath = terminalKey.slice(0, colonIdx);
    const tabId = terminalKey.slice(colonIdx + 1);
    const projTerms = terminalRefs.current[projPath] || (terminalRefs.current[projPath] = {});
    const existing = projTerms[tabId];
    if (existing && existing.term) {
      try { existing.fitAddon?.fit(); } catch {}
      const d = existing.fitAddon?.proposeDimensions();
      if (d && d.cols > 0 && d.rows > 0 && existing.sessionId) {
        invoke('set_terminal_size', { sessionId: existing.sessionId, cols: d.cols, rows: d.rows }).catch(e => console.warn('set_terminal_size:', e));
      }
      return;
    }
    const container = document.getElementById(`xterm-${projPath}-${tabId}`);
    if (!container) return;
    const term = new Terminal({
      fontSize: consoleFontSize,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace",
      theme: { background: '#090a10', cursor: '#00ff88', cursorAccent: '#090a10', foreground: '#c8c8c8', selectionBackground: '#4a4a6a', black: '#090a10', brightBlack: '#555' },
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    const session = {
      term, fitAddon, sessionId: null, hasTTY: false, outputUnlisten: null,
      resizeObserver: null, inputDisposable: null, dispose: null, disposed: false,
    };
    projTerms[tabId] = session;
    term.open(container);
    try { fitAddon.fit(); } catch {}
    const getDims = () => {
      const d = fitAddon.proposeDimensions();
      return (d && d.cols > 0 && d.rows > 0) ? { cols: d.cols, rows: d.rows } : null;
    };
    const sendSize = () => {
      const dims = getDims();
      if (!dims) return;
        if (session.sessionId && !session.disposed) {
          invoke('set_terminal_size', { sessionId: session.sessionId, cols: dims.cols, rows: dims.rows }).catch(e => console.warn('set_terminal_size:', e));
        }
      };
    const initDims = getDims() || { cols: 80, rows: 24 };

    // Terminal output listener — buffer until sessionId is set, then route
    const outputBuffer = [];
    listen('terminal-output', (e) => {
      if (session.disposed || projTerms[tabId] !== session) return;
      if (session.sessionId) {
        if (e.payload.id === session.sessionId) {
          try { term.write(e.payload.data); } catch {}
        }
      } else {
        outputBuffer.push(e);
      }
    }).then(fn => {
      if (session.disposed || projTerms[tabId] !== session) {
        fn();
        return;
      }
      session.outputUnlisten = fn;
      // Do not start the child process until its event listener is ready.
      // Otherwise a fast shell prompt is emitted before xterm can receive it.
      startSession();
    });

    // Start the terminal session
    let started = false;
    const startSession = (retryDelay = 0) => {
      setTimeout(() => {
        if (session.disposed || projTerms[tabId] !== session) return;
        invoke('start_terminal', { path: projPath, cols: initDims.cols, rows: initDims.rows })
          .then(result => {
            if (started) return;
            started = true;
            if (session.disposed || projTerms[tabId] !== session) {
              invoke('stop_terminal', { sessionId: result.id }).catch(e => console.warn('stop_terminal:', e));
              return;
            }
            session.sessionId = result.id;
            session.hasTTY = result.has_tty;
            // Flush buffered output
            for (const e of outputBuffer) {
              if (e.payload.id === result.id) {
                try { term.write(e.payload.data); } catch {}
              }
            }
            outputBuffer.length = 0;
            sendSize();
            if (!result.has_tty) {
              try { term.write('\r\nPowerShell (piped)\r\n'); } catch {}
            }
          })
          .catch(e => {
            if (!started) term.writeln(`\r\n[Terminal error: ${e}]\r\n`);
            if (!started && retryDelay < 3) {
              startSession(retryDelay + 1);
            }
          });
      }, retryDelay * 1500);
    };
    // Forward keystrokes to backend + local echo for pipe mode
    session.inputDisposable = term.onData(data => {
      if (session.disposed || !session.sessionId) return;
      const isEnter = data === '\r' || data === '\n';
      if (session.hasTTY) {
        invoke('write_terminal', { sessionId: session.sessionId, data: isEnter ? '\r' : data })
          .catch(e => { try { term.write(`\r\n[write error: ${e}]\r\n`); } catch {} });
      } else {
        invoke('write_terminal', { sessionId: session.sessionId, data })
          .catch(e => { try { term.write(`\r\n[write error: ${e}]\r\n`); } catch {} });
        if (isEnter) {
          try { term.write('\r\n'); } catch {}
        } else if (data === '\x7f' || data === '\x08') {
          try { term.write('\b \b'); } catch {}
        } else {
          try { term.write(data); } catch {}
        }
      }
    });

    // Paste handler: Ctrl+V → clipboard → backend (all modes)
    const onKeyDown = async (e) => {
      if (!container.contains(e.target)) return;
      if (session.disposed || !session.sessionId) return;
      if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        e.stopPropagation();
        try {
          const raw = await readText();
          if (!raw) return;
          const normalized = raw.replace(/\r\n/g, '\n');
          if (session.term) {
            try { session.term.paste(normalized); } catch { session.term.write(normalized.replace(/\n/g, '\r\n')); }
          }
          invoke('write_terminal', { sessionId: session.sessionId, data: normalized })
            .catch(e => { try { session.term.write(`\r\n[write error: ${e}]\r\n`); } catch {} });
        } catch (e) { console.warn('paste failed:', e); }
        return;
      }
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        const sel = session.term?.getSelection();
        if (sel) {
          e.preventDefault();
          e.stopPropagation();
          try { writeText(sel); } catch {}
          session.term?.clearSelection();
          return;
        }
        // No selection — send SIGINT (Ctrl+C) to terminal process
        e.preventDefault();
        e.stopPropagation();
        invoke('write_terminal', { sessionId: session.sessionId, data: '\x03' })
          .catch(e => { try { session.term.write(`\r\n[write error: ${e}]\r\n`); } catch {} });
        return;
      }
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });

    let resizeTimer;
    const resizeObserver = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try { fitAddon.fit(); } catch {}
        sendSize();
      }, 100);
    });
    resizeObserver.observe(container);
    session.resizeObserver = resizeObserver;
    session.dispose = () => {
      if (session.disposed) return;
      session.disposed = true;
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      session.inputDisposable?.dispose();
      session.outputUnlisten?.();
      resizeObserver.disconnect();
      clearTimeout(resizeTimer);
    };

    // A terminal session may remain open while its tab is hidden.  Its event
    // handlers must therefore outlive this effect and are released by
    // session.dispose() only when the tab/project is actually closed.
    return () => {
      // Intentionally empty: changing terminalKey must not disconnect a live terminal.
    };
  }, [terminalKey]);

  // ── Live update terminal font size ──
  useEffect(() => {
    for (const projPath in terminalRefs.current) {
      for (const tabId in terminalRefs.current[projPath]) {
        const session = terminalRefs.current[projPath][tabId];
        if (session?.term) {
          session.term.options.fontSize = consoleFontSize;
        }
      }
    }
  }, [consoleFontSize]);

  // ── Debug output listener ──
  useEffect(() => {
    const unlisten = listen('debug-output', (e) => {
      const data = e.payload.data;
      const lines = data.split('\n');
      const newVars = [];
      const newStack = [];
      for (const line of lines) {
        const vm = line.match(/^\s{2,}(\w[\w\d]*)\s*=\s*(.+?)(?:\s*\(id=\d+\))?\s*$/);
        if (vm && !line.includes(' arguments:') && !line.includes('Method arguments:')) {
          newVars.push({ name: vm[1], value: vm[2].trim() });
        }
        const sm = line.match(/^\s+\[(\d+)\]\s+(.+)\s\((.+?):(\d+)\)/);
        if (sm) {
          newStack.push({ idx: sm[1], method: sm[2], file: sm[3], line: sm[4] });
        }
        const lm = line.match(/Step completed:.*,\s+(\S+(?:\.\w+)\(\)),\s+line=(\d+)/);
        if (lm) {
          const proj = activeProjectRef.current;
          if (proj) updateWs(proj, { debugLocation: `${lm[1]}:${lm[2]}` });
        }
        const bm = line.match(/Breakpoint hit:.*"(.+?)".*,\s+(\S+(?:\.\w+)\(\)),\s+line=(\d+)/i);
        if (bm) {
          const proj = activeProjectRef.current;
          if (proj) updateWs(proj, { debugLocation: `${bm[2]}:${bm[3]}` });
        }
      }
      if (newVars.length) {
        const proj = activeProjectRef.current;
        if (proj) updateWs(proj, { debugVars: newVars });
      }
      if (newStack.length) {
        const proj = activeProjectRef.current;
        if (proj) updateWs(proj, { debugStack: newStack });
      }
    });
    return () => { unlisten.then(fn => fn()); };
  }, [updateWs]);

  const _applyBreakpoints = useCallback(async (tabId) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const projTerms = terminalRefs.current[proj];
    const session = projTerms?.[tabId];
    if (!session?.sessionId) return;
    const entries = Object.entries(breakpoints).filter(([, lines]) => lines?.length);
    for (const [filePath, lines] of entries) {
      for (const line of lines) {
        try {
          const cls = await invoke('resolve_bp_class', { path: filePath });
          invoke('write_terminal', { sessionId: session.sessionId, data: `stop at ${cls}:${line}\r\n` })
            .catch(e => addLog(String(e), 'err'));
        } catch (e) { addLog(String(e), 'err'); }
      }
    }
  }, [breakpoints, addLog]);

  const debugSendCmd = useCallback(async (cmd) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const currentWs = wsRef.current;
    if (!currentWs?.debugSessionId) return;
    if (cmd === 'locals') updateWs(proj, { debugVars: [] });
    if (cmd === 'where') updateWs(proj, { debugStack: [] });
    try { await invoke('debug_cmd', { sessionId: currentWs.debugSessionId, cmd }); } catch (e) { addLog(`jdb error: ${e}`, 'err'); }
    if (['step', 'next', 'step up', 'cont'].includes(cmd)) {
      setTimeout(() => {
        invoke('debug_cmd', { sessionId: currentWs.debugSessionId, cmd: 'locals' }).catch(e => addLog(`jdb: ${e}`, 'err'));
        invoke('debug_cmd', { sessionId: currentWs.debugSessionId, cmd: 'where' }).catch(e => addLog(`jdb: ${e}`, 'err'));
      }, 100);
    }
  }, [addLog, updateWs]);

  const runCmd = useCallback((cmd, label) => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const currentWs = wsRef.current;
    if (!currentWs?.info || running) return;
    addLog(`\n▸ ${label}`, 'info');
    invoke('run_cmd', { path: currentWs.info.path, cmd, debugPort: debugEnabled ? debugPort : null, debugSuspend: debugEnabled ? debugSuspend : null }).catch(e => addLog(String(e), 'err'));
    if (debugEnabled) {
      updateWs(proj, { debugSessionId: null, debugVars: [], debugStack: [], debugLocation: null });
      invoke('debug_attach', { port: debugPort }).then(id => {
        updateWs(proj, { debugSessionId: id });
        addLog(`🐛 Debugger attached on port ${debugPort}`, 'ok');
        for (const [fp, lines] of Object.entries(breakpoints).filter(([, ls]) => ls?.length)) {
          for (const ln of lines) {
            invoke('resolve_bp_class', { path: fp }).then(cls => {
              invoke('debug_cmd', { sessionId: id, cmd: `stop at ${cls}:${ln}` }).catch(e => addLog(`jdb: ${e}`, 'err'));
            }).catch(e => addLog(String(e), 'err'));
          }
        }
        updateWs(proj, { explorerTab: 'debug' });
      }).catch(e => addLog(`debug_attach error: ${e}`, 'err'));
    }
  }, [running, addLog, debugEnabled, debugPort, debugSuspend, breakpoints, updateWs]);

  const runActive = useCallback(() => {
    const currentWs = wsRef.current;
    if (!currentWs?.info || running) return;
    const mode = currentWs.info.modes.find(m => m.id === currentWs.activeMode) || currentWs.info.modes[0];
    if (!mode) return;
    runCmd(mode.cmd, mode.label);
  }, [running, runCmd]);

  useEffect(() => {
    const proj = activeProjectRef.current;
    if (!proj) return;
    const currentWs = wsRef.current;
    if (currentWs?.gitEntries || currentWs?.gitBranches) return;
    refreshGit();
  }, [activeProject]);

  // ── Auto-refresh git status every 5s ──
  useEffect(() => {
    if (!activeProject) return;
    const interval = setInterval(() => {
      const proj = activeProjectRef.current;
      if (!proj) return;
      refreshGit();
    }, 5000);
    return () => clearInterval(interval);
  }, [activeProject]);

  // ── Closed editor tabs stack for Ctrl+Shift+T ──
  const closedTabsRef = useRef([]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault(); searchRef.current?.focus(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        if ((ws?.activeFileIdx ?? -1) < 0) { e.preventDefault(); document.querySelector('[placeholder="Ctrl+F"]')?.focus(); return; }
        return;
      }
      // Ctrl+W — close current editor tab
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        if (ws?.editorFiles?.length > 0 && ws.activeFileIdx >= 0) {
          e.preventDefault();
          const closed = ws.editorFiles[ws.activeFileIdx];
          closedTabsRef.current = [closed, ...closedTabsRef.current.filter(t => t.path !== closed.path)].slice(0, 20);
          closeEditor(closed.path);
        }
        return;
      }
      // Ctrl+Shift+T — reopen last closed tab
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'T') {
        if (closedTabsRef.current.length > 0) {
          e.preventDefault();
          const tab = closedTabsRef.current.shift();
          openFileAtLine(tab.path, tab.line || 1, tab.col || 1);
        }
        return;
      }
      // Ctrl+Tab — next editor tab
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab' && !e.shiftKey) {
        if (ws?.editorFiles?.length > 1) {
          e.preventDefault();
          const next = (ws.activeFileIdx + 1) % ws.editorFiles.length;
          updateActive({ activeFileIdx: next });
        }
        return;
      }
      // Ctrl+Shift+Tab — prev editor tab
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Tab') {
        if (ws?.editorFiles?.length > 1) {
          e.preventDefault();
          const prev = (ws.activeFileIdx - 1 + ws.editorFiles.length) % ws.editorFiles.length;
          updateActive({ activeFileIdx: prev });
        }
        return;
      }
      if (ws && (ws.activeFileIdx >= 0 && ws.editorFiles?.length > 0)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'r') { e.preventDefault(); runActive(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') { e.preventDefault(); clearLogs(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b' && ws?.info) { e.preventDefault(); runCmd(ws.info.build_cmd, 'Build'); }
      if ((e.ctrlKey || e.metaKey) && e.key === 't' && ws?.info?.test_cmd) { e.preventDefault(); runCmd(ws.info.test_cmd, 'Test'); }
      // Ctrl+Shift+? — show shortcuts modal
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '?' || e.key === '/')) {
        e.preventDefault(); setShowShortcuts(s => !s); return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [runActive, runCmd, clearLogs, ws, closeEditor, openFileAtLine, updateActive]);

  const modeLabel = (ws?.info?.modes?.find(m => m.id === ws.activeMode) || ws?.info?.modes?.[0])?.label || 'Compilar';

  const editorFile = ws?.editorFiles?.[ws.activeFileIdx] || null;

  const runningProject = projectOrder.find(p => {
    const terms = terminalRefs.current[p];
    return terms && Object.values(terms).some(t => t.sessionId);
  }) || null;

  return (
    <div className="h-screen flex flex-col bg-[#0c0d14] font-sans"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDrop={(e) => {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (files.length > 0) {
          const path = files[0].path;
          if (path) openProject(path);
        }
      }}>
      {/* ── PROJECT TABS ── */}
      <ProjectTabs
        projects={projectOrder.map(p => ({ path: p, label: shortPath(p), info: projects[p]?.info }))}
        activeProject={activeProject}
        onSwitch={setActiveProject}
        onClose={closeProject}
        onAdd={onBrowse}
        runningProject={runningProject}
      />

      {/* ── TITLE BAR ── */}
      <header className="h-[40px] flex items-center px-4 border-b border-white/[0.04] bg-[#0e1018]/90 backdrop-blur-xl z-20 shrink-0 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {ws?.info ? (
            <>
              <span className="text-lg leading-none">{ws.info.emoji}</span>
              <span className="text-[11px] font-semibold text-white truncate">{ws.info.label}</span>
              {ws.gitBranches && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-400"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 15l-6-6"/></svg>
                  <span className="text-[9px] font-mono text-emerald-400 font-semibold">{ws.gitBranches.find(([t]) => t === 'local*')?.[1] || ''}</span>
                </span>
              )}
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-[15px] font-bold text-white tracking-tight text-cyan-400">Pill</span>
              <span className="text-[13px] font-medium text-gray-400/70">Launcher</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative" ref={settingsRef}>
            <button onClick={() => setShowSettings(!showSettings)}
              className="neon-btn neon-btn-gray w-7 h-7 rounded-lg flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            {showSettings && (
              <div className="absolute top-full right-0 mt-2 w-52 dropdown-menu py-2 z-50">
                <div className="px-3 py-1 text-[7px] font-bold uppercase tracking-[0.2em] text-gray-600">Editor</div>
                <div className="px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-400">Font size</span>
                    <span className="text-[10px] font-mono text-gray-500">{editorFontSize}px</span>
                  </div>
                  <input type="range" min="10" max="24" value={editorFontSize}
                    onChange={e => { const v = parseInt(e.target.value, 10); setEditorFontSize(v); settings.set('editor_font_size', v); }}
                    className="w-full h-1 rounded-full appearance-none bg-gray-700 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gray-300" />
                </div>
                <div className="px-3 py-1 text-[7px] font-bold uppercase tracking-[0.2em] text-gray-600">Consola</div>
                <div className="px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-gray-400">Font size</span>
                    <span className="text-[10px] font-mono text-gray-500">{consoleFontSize}px</span>
                  </div>
                  <input type="range" min="8" max="24" value={consoleFontSize}
                    onChange={e => { const v = parseInt(e.target.value, 10); setConsoleFontSize(v); settings.set('console_font_size', v); }}
                    className="w-full h-1 rounded-full appearance-none bg-gray-700 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-gray-300" />
                </div>
                <div className="px-3 py-1 text-[7px] font-bold uppercase tracking-[0.2em] text-gray-600">Actualización</div>
                <div className="px-3 py-2">
                  <button onClick={async () => {
                    try {
                      const update = await check();
                      if (update?.isAvailable) {
                        addLog(`📦 Update disponible: ${update.version}`, 'info');
                        saveProjectState();
                        await update.downloadAndInstall();
                      } else {
                        addLog('✓ No hay actualizaciones disponibles', 'ok');
                      }
                    } catch (e) {
                      addLog(`Update error: ${e}`, 'err');
                    }
                  }}
                    className="neon-btn neon-btn-cyan w-full py-1.5 rounded-lg text-[9px] font-bold flex items-center justify-center gap-1.5">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                    Check for Updates
                  </button>
                </div>
              </div>
            )}
          </div>
          <span className={`flex items-center gap-1.5 text-[10px] font-mono font-medium tracking-wider
            ${running ? 'text-neon-red' : 'text-neon-green'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${running
              ? 'bg-[#ff2255] animate-pulse shadow-[0_0_10px_rgba(255,34,85,0.6)]'
              : 'bg-[#00ff88] shadow-[0_0_8px_rgba(0,255,136,0.4)]'}`}
            />
            {running ? 'RUNNING' : 'READY'}
          </span>
        </div>
      </header>

      {/* ── PATH BAR ── */}
      <div className="mx-4 mt-3 mb-0 flex gap-1.5 items-center bg-[#13151e]/70 backdrop-blur-md rounded-2xl px-3 py-3 border border-white/[0.05] shadow-sm overflow-hidden min-w-0">
        {ws?.info && (
          <button onClick={() => updateActive(prev => ({ sidebarOpen: !prev.sidebarOpen }))}
            className="neon-btn neon-btn-gray w-7 h-7 rounded-lg flex items-center justify-center shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
              {ws.sidebarOpen
                ? <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></>
                : <><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></>
              }
            </svg>
          </button>
        )}
        <div className="w-7 h-7 rounded-lg bg-gray-500/10 flex items-center justify-center border border-gray-500/20 shrink-0">
          <FolderIcon />
        </div>
        <input className="flex-1 bg-transparent text-xs text-gray-400 outline-none truncate font-mono placeholder:text-gray-700 min-w-0"
          value={shortPath(activeProject)} readOnly placeholder="Select a project folder…" />
        {activeProject && (
          <div className="relative shrink-0">
            <input ref={searchRef}
              value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setSearchQuery(''); setSearchResults([]); e.target.blur(); } }}
              placeholder="Ctrl+P" className="w-20 bg-[#1a1e2e] text-[10px] text-gray-400 placeholder:text-gray-700
                rounded-lg px-2 py-1.5 border border-white/[0.06] outline-none font-mono
                focus:border-gray-500/40 focus:text-gray-200 transition-all" />
            {searchResults.length > 0 && (
              <div className="absolute top-full right-0 mt-1 w-72 max-h-60 dropdown-menu py-1 z-50 overflow-y-auto">
                {searchResults.map((f, i) => (
                  <button key={i} onClick={() => { openFile(f); setSearchQuery(''); setSearchResults([]); }}
                    className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-gray-400 hover:text-white hover:bg-white/[0.03] transition-colors cursor-pointer truncate">
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="relative shrink-0" ref={recentRef}>
          <div className="flex">
            <button onClick={onBrowse} disabled={running}
              className="neon-btn neon-btn-green px-5 py-1.5 rounded-l-xl text-[10px] font-bold tracking-wide">
              Examinar
            </button>
            <button onClick={() => setShowRecent(!showRecent)} disabled={running || recentProjects.length === 0}
              className="neon-btn neon-btn-green px-1.5 py-1.5 rounded-r-xl text-[10px]" style={{ borderLeft: '1px solid rgba(0,255,136,0.15)' }}>
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          {showRecent && recentProjects.length > 0 && (
            <div className="absolute top-full right-0 mt-1 w-64 dropdown-menu py-1 z-50 max-h-60 overflow-y-auto">
              <div className="px-3 py-1 text-[7px] font-bold uppercase tracking-[0.2em] text-gray-600">Recientes</div>
              {recentProjects.map((p, i) => (
                <button key={i} onClick={() => openProject(p)}
                  className="w-full text-left px-3 py-1.5 text-[10px] font-mono text-gray-400 hover:text-white hover:bg-white/[0.03] transition-colors cursor-pointer truncate">
                  {shortPath(p)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── MAIN LAYOUT ── */}
      <div className="flex-1 flex px-4 pb-4 overflow-hidden">
        <Group orientation="horizontal" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          {ws?.info && ws.sidebarOpen && (
          <Panel defaultSize={200} minSize={140} maxSize={350}>
            <aside className="h-full flex flex-col gap-2 overflow-hidden min-h-0 sidebar-enter">
              {ws.info.modes.length > 0 && (
              <div className="flex gap-1 px-1">
                <button onClick={runActive} disabled={running}
                  className="neon-btn neon-btn-cyan flex-1 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5">
                  <BuildIcon /> {modeLabel}
                </button>
                <button onClick={() => runCmd(ws.info.run_cmd, 'Launch')}
                  disabled={running || !ws.info.run_cmd}
                  className="neon-btn neon-btn-green flex-1 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1.5">
                  <PlayIcon /> Launch
                </button>
                {running && (
                  <>
                    <button onClick={() => { const p = ws.suspended ? invoke('resume_cmd', { path: wsRef.current?.path }).then(() => updateActive({ suspended: false })) : invoke('suspend_cmd', { path: wsRef.current?.path }).then(() => updateActive({ suspended: true })); p.catch(e => addLog(String(e), 'err')); }}
                      className={`neon-btn px-2 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-1 ${ws.suspended ? 'neon-btn-green' : 'neon-btn-amber'}`}>
                      {ws.suspended
                        ? <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
                        : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                      }
                    </button>
                    <button onClick={() => invoke('stop_cmd', { path: wsRef.current?.path }).catch(e => addLog(String(e), 'err'))}
                      className="neon-btn neon-btn-red px-2 py-1.5 rounded-lg text-[10px] font-bold glow-stop flex items-center justify-center gap-1">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                    </button>
                  </>
                )}
              </div>
              )}
              <div className="flex-1 flex min-h-0">
                <div className="flex flex-col gap-1 py-1 pr-1 shrink-0">
                  <button onClick={() => updateActive({ explorerTab: 'files' })}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer text-sm
                      ${ws.explorerTab === 'files' ? 'bg-cyan-500/15 text-cyan-400 shadow-[0_0_8px_rgba(0,212,255,0.1)]' : 'text-white/30 hover:text-white/70'}`}
                    title="Files">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                  </button>
                  <button onClick={() => updateActive({ explorerTab: 'git' })}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer text-sm
                      ${ws.explorerTab === 'git' ? 'bg-cyan-500/15 text-cyan-400 shadow-[0_0_8px_rgba(0,212,255,0.1)]' : 'text-gray-600 hover:text-gray-400 hover:bg-white/[0.03]'}`}
                    title="Git">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 15l-6-6"/></svg>
                  </button>
                  <button onClick={() => updateActive({ explorerTab: 'debug' })}
                    className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer text-sm
                      ${ws.explorerTab === 'debug' ? 'bg-cyan-500/15 text-cyan-400 shadow-[0_0_8px_rgba(0,212,255,0.1)]' : 'text-gray-600 hover:text-gray-400 hover:bg-white/[0.03]'}`}
                    title={ws.debugSessionId ? 'Debugger connected' : 'Debug'}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/><line x1="5" y1="3" x2="3" y2="5"/><line x1="19" y1="3" x2="21" y2="5"/></svg>
                    {ws.debugSessionId && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_4px_rgba(0,255,136,0.5)]" />}
                  </button>
                  <button onClick={() => openInExplorer(ws.path, { isDir: true }).catch(e => {
                    const message = `No se pudo abrir el Explorador: ${e?.message || e}`;
                    addLog(message, 'err');
                    showToast(message, 'err');
                  })}
                    className="w-8 h-8 flex items-center justify-center rounded-lg transition-all cursor-pointer text-sm text-gray-600 hover:text-gray-400 hover:bg-white/[0.03]"
                    title="Abrir en Explorador">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9 14 12 11 15 14"/></svg>
                  </button>
                </div>
                <div className="flex-1 bg-[#13151e]/25 rounded-xl border border-white/[0.04] overflow-y-auto p-1 min-h-0">
                  {ws.explorerTab === 'files' ? (
                    <div className="flex flex-col h-full overflow-hidden">
                      <div className="px-2 py-1.5 border-b border-white/[0.04] shrink-0">
                        <div className="flex gap-1 mb-1">
                          <button onClick={() => setNewItemType(newItemType === 'file' ? null : 'file')}
                            className={`flex-1 text-[8px] font-bold py-1 rounded transition-colors cursor-pointer flex items-center justify-center gap-1
                              ${newItemType === 'file' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30' : 'bg-white/[0.04] text-gray-600 hover:text-gray-400'}`}
                            title="New file">
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            File
                          </button>
                          <button onClick={() => setNewItemType(newItemType === 'folder' ? null : 'folder')}
                            className={`flex-1 text-[8px] font-bold py-1 rounded transition-colors cursor-pointer flex items-center justify-center gap-1
                              ${newItemType === 'folder' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-white/[0.04] text-gray-600 hover:text-gray-400'}`}
                            title="New folder">
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Folder
                          </button>
                        </div>
                        {newItemType && (
                          <>
                          <p className="text-[8px] text-gray-600 truncate mb-1 font-mono" title={ws.path}>
                            se creará en: <span className="text-gray-400">{baseName(ws.path)}/</span>
                          </p>
                          <div className="flex gap-1">
                            <input value={newItemName} onChange={e => setNewItemName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && newItemName.trim()) {
                                  const fullPath = joinPath(ws.path, newItemName.trim());
                                  invoke(newItemType === 'file' ? 'create_file' : 'create_folder', { path: fullPath })
                                    .then(() => { addLog(`Created ${newItemType}: ${newItemName}`, 'ok'); setNewItemName(''); setNewItemType(null); updateActive({ treeKey: (ws.treeKey || 0) + 1 }); })
                                    .catch(err => addLog(String(err), 'err'));
                                }
                                if (e.key === 'Escape') { setNewItemType(null); setNewItemName(''); }
                              }}
                              placeholder={newItemType === 'file' ? 'filename.ext' : 'folder-name'}
                              className="flex-1 bg-[#1a1e2e] text-[10px] text-gray-300 placeholder:text-gray-700 rounded px-1.5 py-1 border border-white/[0.08] outline-none font-mono focus:border-cyan-500/40 transition-all" autoFocus />
                            <button onClick={() => {
                              if (newItemName.trim()) {
                                const fullPath = joinPath(ws.path, newItemName.trim());
                                invoke(newItemType === 'file' ? 'create_file' : 'create_folder', { path: fullPath })
                                  .then(() => { addLog(`Created ${newItemType}: ${newItemName}`, 'ok'); setNewItemName(''); setNewItemType(null); updateActive({ treeKey: (ws.treeKey || 0) + 1 }); })
                                  .catch(err => addLog(String(err), 'err'));
                              }
                            }} className="text-[8px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10 font-bold">✓</button>
                          </div>
                          </>
                        )}
                        <input value={ws.fileFilter} onChange={e => updateActive({ fileFilter: e.target.value })}
                          placeholder="Filter files…" className="w-full bg-[#1a1e2e] text-[10px] text-gray-400 placeholder:text-gray-700
                            rounded-lg px-2 py-1 border border-white/[0.06] outline-none font-mono
                            focus:border-gray-500/40 focus:text-gray-200 transition-all" />
                      </div>
                      <div className="flex-1 overflow-y-auto min-h-0">
                        <FileTree key={`${ws.path}-${ws.treeKey}`} rootPath={ws.path} onOpenFile={openFile} selectedFile={editorFile?.path} filter={ws.fileFilter} onLog={addLog} gitStatus={ws.gitEntries ? Object.fromEntries(ws.gitEntries.map(([s, f]) => [relativeTo(ws.path, f), s])) : undefined} />
                      </div>
                    </div>
                  ) : ws.explorerTab === 'git' ? (
                    <div className="flex flex-col h-full overflow-hidden">
                      <div className="shrink-0">
                        <div className="px-2 py-1.5 text-[8px] font-bold uppercase tracking-[0.2em] text-gray-600 flex items-center gap-1.5">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 15l-6-6"/></svg>
                          Branches
                          {ws.gitBranches && (
                            <div className="flex gap-1 ml-auto">
                              <button onClick={() => { addLog('Fetching...', 'dim'); invoke('git_fetch', { path: ws.path }).then(r => addLog(r, 'ok')).catch(e => addLog(String(e), 'err')).then(refreshGit); }}
                                className="neon-btn neon-btn-gray text-[8px] px-1.5 py-0.5 rounded font-semibold">Fetch</button>
                              <button onClick={() => { addLog('Pulling...', 'dim'); invoke('git_pull', { path: ws.path }).then(r => addLog(r, 'ok')).catch(e => addLog(String(e), 'err')).then(refreshGit); }}
                                className="neon-btn neon-btn-cyan text-[8px] px-1.5 py-0.5 rounded font-semibold">Pull</button>
                              <button onClick={() => { addLog('Pushing...', 'dim'); invoke('git_push', { path: ws.path }).then(r => addLog(r, 'ok')).catch(e => addLog(String(e), 'err')).then(refreshGit); }}
                                className="neon-btn neon-btn-pink text-[8px] px-1.5 py-0.5 rounded font-semibold">Push</button>
                              <button onClick={async () => {
                                addLog('Updating all projects...', 'dim');
                                const paths = projectOrder;
                                try {
                                  const results = await invoke('git_pull_all', { paths });
                                  results.forEach(r => addLog(r, r.startsWith('OK') ? 'ok' : 'err'));
                                  refreshGit();
                                } catch (e) { addLog(String(e), 'err'); }
                              }}
                                className="neon-btn neon-btn-green text-[8px] px-1.5 py-0.5 rounded font-semibold">Update All</button>
                            </div>
                          )}
                        </div>
                        {!ws.gitBranches ? (
                          <p className="text-[10px] text-gray-600 italic px-2 py-2 select-none text-center">No git repo</p>
                        ) : (
                          <div className="space-y-[1px] px-1 pb-1.5 border-b border-white/[0.04]">
                            {ws.gitBranches
                              .filter(([t]) => t === 'local*')
                              .concat(ws.gitBranches.filter(([t]) => t === 'local' && t !== 'local*'))
                              .concat(ws.gitBranches.filter(([t]) => t === 'remote'))
                              .map(([type, name], i) => {
                                const isCurrent = type === 'local*';
                                const displayName = (type === 'remote' && isGitHubRemote && name.startsWith('origin/'))
                                  ? name.replace('origin/', 'git/')
                                  : name;
                                return (
                                  <div key={i}
                                    onDoubleClick={isCurrent ? undefined : () => doGitCheckout(name)}
                                    className={`flex items-center gap-1.5 px-2 py-1 rounded-[6px] text-[11px] font-mono select-none
                                      ${isCurrent
                                        ? 'text-white bg-gray-500/15 ring-1 ring-gray-500/30 cursor-default'
                                        : 'text-gray-500 hover:bg-gray-500/10 hover:text-gray-300 active:bg-gray-500/20 active:text-white cursor-pointer transition-colors'}`}>
                                    {type === 'local*' && <span className="text-[9px] text-amber-400">▶</span>}
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                                      className={`shrink-0 ${type === 'remote' ? 'text-gray-600' : 'text-emerald-400'}`}>
                                      <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M18 15l-6-6"/>
                                    </svg>
                                    <span className={`truncate ${type === 'remote' ? 'text-gray-600' : ''}`}>{displayName}</span>
                                    {type === 'remote' && <span className="text-[7px] text-gray-700 ml-auto">{isGitHubRemote ? 'git' : 'remota'}</span>}
                                  </div>
                                );
                              })}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
                        {!ws.gitEntries && (
                          <p className="text-[10px] text-gray-600 italic px-2 py-6 select-none text-center">No git repo</p>
                        )}
                        {ws.gitEntries && ws.gitEntries.length === 0 && (
                          <div className="flex flex-col items-center justify-center py-8 text-gray-700 gap-2 select-none">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40"><circle cx="12" cy="12" r="10"/><polyline points="9 12 11 14 15 10"/></svg>
                            <p className="text-[10px] italic">Clean — no changes</p>
                          </div>
                        )}
                        {ws.gitEntries && ws.gitEntries.length > 0 && (
                          <>
                            {gitStaged.length > 0 && (
                              <div className="bg-emerald-500/[0.04] rounded-xl border border-emerald-500/15 overflow-hidden">
                                <div className="flex items-center px-3 py-2 border-b border-emerald-500/10 cursor-pointer select-none"
                                  onClick={() => updateActive(prev => ({ gitOpenCards: { ...prev.gitOpenCards, staged: !prev.gitOpenCards.staged } }))}>
                                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    className={`text-emerald-500/60 transition-transform duration-150 shrink-0 ${ws.gitOpenCards.staged ? 'rotate-90' : ''}`}>
                                    <polyline points="9 18 15 12 9 6" />
                                  </svg>
                                  <span className="text-[13px] ml-1">📦</span>
                                  <span className="text-[10px] font-bold text-emerald-400 ml-1.5">Staged Changes</span>
                                  <span className="text-[9px] font-mono text-emerald-500/60 ml-1">{gitStaged.length}</span>
                                  <div className="flex-1" />
                                  <button onClick={(e) => { e.stopPropagation(); Promise.all(gitStaged.map(([_, file]) => invoke('git_unstage', { path: ws.path, file }))).then(() => { refreshGit(); addLog('Unstaged all', 'ok'); }).catch(e => addLog(String(e), 'err')); }}
                                    className="text-[7px] font-bold text-red-400/50 hover:text-red-400 transition-colors px-1.5 py-0.5 rounded bg-red-500/10 hover:bg-red-500/20">
                                    − All
                                  </button>
                                </div>
                                <div style={{
                                  maxHeight: ws.gitOpenCards.staged ? '2000px' : '0px',
                                  opacity: ws.gitOpenCards.staged ? 1 : 0,
                                  overflow: 'hidden',
                                  transition: 'max-height 200ms ease, opacity 150ms ease',
                                }}>
                                  <div className="divide-y divide-emerald-500/8">
                                    {gitStaged.map(([status, file], i) => {
                                      const badgeColor = status[0] === 'M' ? 'bg-amber-500/20 text-amber-300' : status[0] === 'A' ? 'bg-emerald-500/20 text-emerald-300' : status[0] === 'D' ? 'bg-red-500/20 text-red-300' : 'bg-gray-500/20 text-gray-400';
                                      const badge = { 'M':'M','A':'A','D':'D','R':'R' }[status[0]] || '?';
                                      return (
                                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-gray-400 hover:bg-white/[0.02] transition-colors">
                                          <span className={`w-4 h-4 rounded text-[7px] font-bold flex items-center justify-center shrink-0 ${badgeColor}`}>{badge}</span>
                                          <span onClick={() => openDiff(file)} className="truncate cursor-pointer hover:text-gray-200 flex-1">{file}</span>
                                          <button onClick={(e) => { e.stopPropagation(); invoke('git_unstage', { path: ws.path, file }).then(r => { addLog(r, 'ok'); refreshGit(); }).catch(e => addLog(String(e), 'err')); }}
                                            className="text-[8px] text-red-400/50 hover:text-red-400 transition-colors px-1 py-0.5 rounded font-bold" title="Unstage">−</button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            )}
                            {(gitModified.length + gitUntracked.length) > 0 && (
                              <div className="bg-gray-500/[0.04] rounded-xl border border-gray-500/15 overflow-hidden">
                                <div className="flex items-center px-3 py-2 border-b border-gray-500/10 cursor-pointer select-none"
                                  onClick={() => updateActive(prev => ({ gitOpenCards: { ...prev.gitOpenCards, changes: !prev.gitOpenCards.changes } }))}>
                                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    className={`text-gray-500/60 transition-transform duration-150 shrink-0 ${ws.gitOpenCards.changes ? 'rotate-90' : ''}`}>
                                    <polyline points="9 18 15 12 9 6" />
                                  </svg>
                                  <span className="text-[13px] ml-1">📝</span>
                                  <span className="text-[10px] font-bold text-gray-300 ml-1.5">Changes</span>
                                  <span className="text-[9px] font-mono text-gray-500/60 ml-1">{gitModified.length + gitUntracked.length}</span>
                                  <div className="flex-1" />
                                  <button onClick={(e) => { e.stopPropagation(); Promise.all([...gitModified, ...gitUntracked].map(([_, file]) => invoke('git_add', { path: ws.path, file }))).then(() => refreshGit()).catch(err => addLog(String(err), 'err')); }}
                                    className="text-[7px] font-bold text-emerald-400/50 hover:text-emerald-400 transition-colors px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20">
                                    + All
                                  </button>
                                </div>
                                <div style={{
                                  maxHeight: ws.gitOpenCards.changes ? '2000px' : '0px',
                                  opacity: ws.gitOpenCards.changes ? 1 : 0,
                                  overflow: 'hidden',
                                  transition: 'max-height 200ms ease, opacity 150ms ease',
                                }}>
                                  <div className="divide-y divide-gray-500/8">
                                    {[...gitModified, ...gitUntracked].map(([status, file], i) => {
                                      const isModified = status !== '??' && status !== '!!';
                                      const isUntracked = status === '??';
                                      const badgeColor = isModified
                                        ? (status[1] === 'M' ? 'bg-amber-500/20 text-amber-300' : 'bg-red-500/20 text-red-300')
                                        : isUntracked ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-500/10 text-gray-600';
                                      const badge = isModified ? (status[1] === 'M' ? 'M' : 'D') : isUntracked ? 'U' : 'I';
                                      return (
                                        <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-[10px] font-mono text-gray-400 hover:bg-white/[0.02] transition-colors">
                                          <span className={`w-4 h-4 rounded text-[7px] font-bold flex items-center justify-center shrink-0 ${badgeColor}`}>{badge}</span>
                                          <span onClick={() => openDiff(file)} className="truncate cursor-pointer hover:text-gray-200 flex-1">{file}</span>
                                          <button onClick={(e) => { e.stopPropagation(); invoke('git_add', { path: ws.path, file }).then(r => { addLog(r, 'ok'); refreshGit(); }).catch(e => addLog(String(e), 'err')); }}
                                            className="text-[8px] text-emerald-400/50 hover:text-emerald-400 transition-colors px-1 py-0.5 rounded font-bold" title="Stage">+</button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            )}
                            <div className="bg-[#13151e]/40 rounded-xl border border-white/[0.04] p-2 space-y-1.5">
                              <textarea value={ws.commitMsg} onChange={e => updateActive({ commitMsg: e.target.value })}
                                placeholder={gitStaged.length === 0 ? 'Stage changes first…' : 'Describe the commit…'}
                                className="w-full bg-[#1a1e2e] text-[10px] text-gray-300 placeholder:text-gray-700 rounded-lg px-2 py-1.5 border border-white/[0.06] outline-none font-mono resize-none h-10 focus:border-gray-500/40 focus:text-gray-200 transition-all" />
                              <div className="flex gap-1">
                                <button onClick={doCommit} disabled={!ws.commitMsg.trim() || ws.gitWorking || gitStaged.length === 0}
                                  className="neon-btn neon-btn-green flex-1 py-1.5 rounded-lg text-[9px] font-bold flex items-center justify-center gap-1">
                                  {ws.gitWorking ? '…' : `✓ Commit${gitStaged.length > 0 ? ` (${gitStaged.length})` : ''}`}
                                </button>
                                <button onClick={() => { invoke('git_stash', { path: ws.path }).then(r => addLog(r, 'ok')).catch(e => addLog(String(e), 'err')).then(refreshGit); }}
                                  className="neon-btn neon-btn-gray text-[8px] px-2 py-1.5 rounded-lg font-semibold flex items-center gap-1">
                                  📦 Stash
                                </button>
                                <button onClick={() => { invoke('git_stash_pop', { path: ws.path }).then(r => addLog(r, 'ok')).catch(e => addLog(String(e), 'err')).then(refreshGit); }}
                                  className="neon-btn neon-btn-amber text-[8px] px-2 py-1.5 rounded-lg font-semibold flex items-center gap-1">
                                  📤 Pop
                                </button>
                              </div>
                            </div>
                            {/* ── COMMIT HISTORY ── */}
                            {gitLog.length > 0 && (
                              <div className="bg-[#13151e]/40 rounded-xl border border-white/[0.04] overflow-hidden">
                                <div className="flex items-center px-3 py-2 border-b border-white/[0.04] cursor-pointer select-none"
                                  onClick={() => updateActive(prev => ({ gitOpenCards: { ...prev.gitOpenCards, history: !prev.gitOpenCards.history } }))}>
                                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    className={`text-gray-500/60 transition-transform duration-150 shrink-0 ${ws.gitOpenCards.history ? 'rotate-90' : ''}`}>
                                    <polyline points="9 18 15 12 9 6" />
                                  </svg>
                                  <span className="text-[13px] ml-1">📋</span>
                                  <span className="text-[10px] font-bold text-gray-300 ml-1.5">History</span>
                                  <span className="text-[9px] font-mono text-gray-500/60 ml-1">{gitLog.length}</span>
                                </div>
                                <div style={{
                                  maxHeight: ws.gitOpenCards.history ? '4000px' : '0px',
                                  opacity: ws.gitOpenCards.history ? 1 : 0,
                                  overflow: 'hidden',
                                  transition: 'max-height 200ms ease, opacity 150ms ease',
                                }}>
                                  <div className="divide-y divide-white/[0.03]">
                                    {gitLog.map(([, short, author, time, msg], i) => (
                                      <div key={i} className="px-3 py-2 hover:bg-white/[0.02] transition-colors group">
                                        <div className="flex items-center gap-2">
                                          <span className="text-[9px] font-mono text-cyan-400/70 bg-cyan-500/10 px-1.5 py-[1px] rounded">{short}</span>
                                          <span className="text-[10px] text-gray-300 truncate flex-1">{msg}</span>
                                        </div>
                                        <div className="flex items-center gap-2 mt-1 ml-[28px]">
                                          <span className="text-[8px] text-gray-600">{author}</span>
                                          <span className="text-[8px] text-gray-700">·</span>
                                          <span className="text-[8px] text-gray-600">{time}</span>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ) : (
                    <DebugPanel sessionId={ws.debugSessionId} vars={ws.debugVars} stack={ws.debugStack} location={ws.debugLocation} onCmd={debugSendCmd}
                      debugPort={debugPort} debugSuspend={debugSuspend}
                      onToggleSuspend={() => { const v = !debugSuspend; setDebugSuspend(v); settings.set('debug_suspend', v); }}
                      onPortChange={v => { setDebugPort(v); settings.set('debug_port', v); }} />
                  )}
                </div>
              </div>
            </aside>
          </Panel>
          )}
          {ws?.info && ws.sidebarOpen && (
          <Separator className="w-1 bg-white/5 hover:bg-gray-500/50 transition-colors cursor-col-resize" />
          )}
          <Panel minSize={400}>
            <Group orientation="vertical" style={{ height: '100%', minHeight: 0 }}>
              <Panel minSize={15} defaultSize={55}>
                {ws?.editorFiles?.length > 0 ? (
                  <div className="h-full flex flex-col overflow-hidden">
                    <div className="flex shrink-0 bg-[#13151e]/40 border-b border-white/[0.04] overflow-x-auto">
                      {ws.editorFiles.map((f, i) => {
                        const isDiff = f.path.startsWith('diff:');
                        const name = isDiff ? f.path.replace(/^diff:/, '') : f.path.split(/[\\/]/).pop();
                        return (
                          <div key={f.path}
                            onClick={() => updateActive({ activeFileIdx: i })}
                            className={`editor-tab flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-mono cursor-pointer select-none shrink-0
                              ${i === ws.activeFileIdx ? 'editor-tab-active' : 'editor-tab-inactive'}`}>
                            {isDiff && <span className="text-[8px] text-amber-400">◆</span>}
                            <span className="truncate max-w-[100px]">{name}</span>
                            <button onClick={e => { e.stopPropagation(); closeEditor(f.path); }}
                              className="text-gray-700 hover:text-gray-400 transition-colors cursor-pointer">
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex-1 min-h-0">
                      {editorFile && (
                        editorFile.isDiff
                          ? <EditorModal key={`${editorFile.path}`} path={editorFile.path} line={1} col={1} onClose={() => closeEditor(editorFile.path)} panel initialContent={editorFile.content} readOnly fontSize={editorFontSize} breakpoints={breakpoints} onToggleBreakpoint={toggleBreakpoint} />
                          : <EditorModal key={`${editorFile.path}-${editorFile.line}`} path={editorFile.path} line={editorFile.line} col={editorFile.col} onClose={() => closeEditor(editorFile.path)} panel fontSize={editorFontSize} breakpoints={breakpoints} onToggleBreakpoint={toggleBreakpoint} />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center select-none">
                    <div className="text-center space-y-3">
                      <div className="w-14 h-14 mx-auto rounded-2xl bg-gradient-to-br from-gray-800/40 to-gray-900/40 border border-white/[0.04] flex items-center justify-center">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-600/60 opacity-50">
                          <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-[12px] text-gray-600 font-mono font-medium">Ningún archivo abierto</p>
                        <p className="text-[10px] text-gray-700/60 mt-1">Seleccioná un archivo del explorador o usá <kbd className="px-1 py-0.5 rounded bg-white/[0.04] text-gray-600 border border-white/[0.06] text-[9px] font-mono">Ctrl+P</kbd> para buscar</p>
                      </div>
                    </div>
                  </div>
                )}
              </Panel>
              <Separator className="h-1 bg-white/5 hover:bg-gray-500/50 transition-colors cursor-row-resize" />
              <Panel minSize={15} defaultSize={45}>
            <div className="h-full flex flex-col overflow-hidden min-w-0">
              {ws?.info && ws.info.modes.length > 0 && (
                <div className="flex items-center gap-1 bg-[#13151e]/25 rounded-xl border border-white/[0.04] px-1.5 py-1 mb-1.5 shrink-0 select-none flex-wrap">
                  <div className="relative" ref={modeRef}>
                    <button onClick={() => setShowCmdMenu(s => s === 'mode' ? null : 'mode')}
                      className="flex items-center gap-1.5 bg-[#1a1e2e] hover:bg-[#22273d] text-gray-300 text-[10px] font-medium
                        rounded-lg px-2 py-1.5 border border-white/[0.06] transition-colors cursor-pointer whitespace-nowrap">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                      <span className="max-w-[90px] truncate">{modeLabel}</span>
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {showCmdMenu === 'mode' && (
                      <div className="absolute top-full left-0 mt-1 w-44 dropdown-menu py-1 z-50" onClick={() => setShowCmdMenu(null)}>
                        <div className="px-3 py-1 text-[7px] font-bold uppercase tracking-[0.2em] text-gray-600 border-b border-white/[0.04] mb-1">{ws?.info?.typ} phases</div>
                        {ws?.info?.modes?.map(m => (
                          <button key={m.id} onClick={() => updateActive({ activeMode: m.id })}
                            className={`w-full text-left px-3 py-1.5 text-[10px] transition-colors cursor-pointer flex items-center gap-2
                              ${m.id === ws.activeMode
                                ? 'text-white bg-gray-500/20 border-l-2 border-gray-400'
                                : 'text-gray-400 hover:text-white hover:bg-white/[0.03] border-l-2 border-transparent'
                              }`}>
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button onClick={() => { setDebugEnabled(!debugEnabled); if (!debugEnabled) updateActive({ explorerTab: 'debug' }); }}
                    className={`flex items-center gap-1 px-1.5 py-1.5 rounded-lg text-[9px] font-bold transition-all cursor-pointer
                      ${debugEnabled
                        ? 'neon-btn-cyan bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shadow-[0_0_10px_rgba(0,212,255,0.15)]'
                        : 'bg-transparent text-gray-600 hover:text-gray-400'
                      }`}
                    title={debugEnabled ? 'Debug ON' : 'Activar JDWP debug'}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/><line x1="5" y1="3" x2="3" y2="5"/><line x1="19" y1="3" x2="21" y2="5"/>
                    </svg>
                    {debugEnabled && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_6px_rgba(0,212,255,0.6)]" />}
                  </button>
                  <button onClick={runActive} disabled={running}
                    className="neon-btn neon-btn-green flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[9px] font-bold">
                    <PlayIcon /> Run
                  </button>
                  {running && (
                    <>
                      <button onClick={() => { const p = ws.suspended ? invoke('resume_cmd', { path: wsRef.current?.path }).then(() => updateActive({ suspended: false })) : invoke('suspend_cmd', { path: wsRef.current?.path }).then(() => updateActive({ suspended: true })); p.catch(e => addLog(String(e), 'err')); }}
                        className={`neon-btn px-2 py-1.5 rounded-lg text-[9px] font-bold flex items-center justify-center gap-1 ${ws.suspended ? 'neon-btn-green' : 'neon-btn-amber'}`}>
                        {ws.suspended
                          ? <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
                          : <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                        }
                        <span className="text-[8px]">{ws.suspended ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button onClick={() => invoke('stop_cmd', { path: wsRef.current?.path }).catch(e => addLog(String(e), 'err'))}
                        className="neon-btn neon-btn-red flex items-center gap-1 px-2 py-1.5 rounded-lg text-[9px] font-bold glow-stop">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                        Stop
                      </button>
                    </>
                  )}
                  <div className="flex-1" />
                  <div className="relative" ref={allCmdRef}>
                    <button onClick={() => setShowCmdMenu(s => s === 'all' ? null : 'all')}
                      className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[9px] font-semibold
                        bg-[#1a1e2e] text-gray-500 hover:text-gray-300 hover:bg-[#22273d]
                        border border-white/[0.04] transition-all cursor-pointer">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
                      All
                      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                    </button>
                    {showCmdMenu === 'all' && (
                      <div className="absolute top-full right-0 mt-1 w-56 max-h-72 dropdown-menu py-1 z-50 overflow-y-auto" onClick={() => setShowCmdMenu(null)}>
                        {ws?.info?.modes?.map(m => (
                          <button key={m.id} onClick={() => { updateActive({ activeMode: m.id }); runCmd(m.cmd, m.label); }}
                            className="w-full text-left px-3 py-1.5 text-[10px] text-gray-400 hover:text-white hover:bg-white/[0.03] transition-colors cursor-pointer flex items-center gap-2 border-l-2 border-transparent hover:border-gray-400/50">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-500/30 shrink-0" />
                            {m.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {ws?.info?.profiles?.length > 0 && (
                    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-white/[0.04]">
                      {[...new Set(ws.info.profiles)].map(pr => (
                        <button key={pr} onClick={() => runCmd(`mvn clean package -P${pr} -DskipTests`, `Prof:${pr}`)}
                          className="px-1.5 py-0.5 rounded text-[7px] font-medium bg-amber-900/20 text-amber-400/60
                            border border-amber-700/15 hover:bg-amber-900/30 hover:text-amber-300 cursor-pointer transition-all">
                          {pr}
                        </button>
                      ))}
                    </div>
                  )}
                  {ws?.info?.gradle_tasks?.length > 0 && (
                    <div className="flex items-center gap-0.5 ml-1 pl-1 border-l border-white/[0.04]">
                      {ws.info.gradle_tasks.slice(0, 4).map(t => (
                        <button key={t.id} onClick={() => runCmd(`${ws.info.build_cmd.split(' ')[0]} ${t.id}`, t.label)}
                          className="px-1.5 py-0.5 rounded text-[7px] font-medium bg-[#1a1e2e] text-gray-500
                            border border-white/[0.04] hover:text-gray-300 cursor-pointer transition-all">
                          {t.label}
                        </button>
                      ))}
                      {ws.info.gradle_tasks.length > 4 && (
                        <span className="text-[7px] text-gray-600 ml-0.5">+{ws.info.gradle_tasks.length - 4}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="bg-[#090a10] rounded-2xl border border-white/[0.04] flex-1 flex flex-col overflow-hidden shadow-inner">
                <div className="flex items-center border-b border-white/[0.04] shrink-0 px-2 py-1.5 gap-0.5 overflow-x-auto">
                  {(ws?.consoleTabs || [{ id: 'consola', label: 'Consola' }]).map(tab => (
                    tab.id === 'consola' ? (
                      <button key="consola" onClick={() => { if (ws) updateActive({ activeConsoleTab: 'consola' }); }}
                        className={`text-[8px] font-bold uppercase tracking-[0.15em] transition-all cursor-pointer px-2 py-0.5 rounded-md shrink-0
                          ${(!ws || ws.activeConsoleTab === 'consola') ? 'text-white bg-white/[0.06]' : 'text-gray-500 hover:text-gray-300'}`}>
                        Consola
                      </button>
                    ) : (
                      <div key={tab.id}
                        className={`flex items-center gap-1 text-[8px] font-bold tracking-[0.15em] transition-all cursor-pointer px-2 py-0.5 rounded-md shrink-0
                          ${ws?.activeConsoleTab === tab.id ? 'text-amber-300 bg-amber-500/10' : 'text-amber-500/60 hover:text-amber-400'}`}
                        onClick={() => { if (ws) updateActive({ activeConsoleTab: tab.id }); }}>
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3v18h-2V3H9v18H7V3H5v18H3v-2h2V3h2v16h2V3h2v14h2V3h2v18h2V3h2v2"/></svg>
                        <span>{tab.label}</span>
                        <button onClick={(e) => { e.stopPropagation(); if (ws) closeTerminal(tab.id); }}
                          className="text-gray-600 hover:text-red-400 transition-colors ml-0.5 cursor-pointer">
                          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        </button>
                      </div>
                    )
                  ))}
                  {ws?.info && (
                    <button onClick={() => addTerminal()}
                      className="text-gray-500 hover:text-amber-400 transition-colors px-1.5 py-0.5 rounded-md text-[10px] font-bold shrink-0 cursor-pointer"
                      title="New PowerShell terminal">+</button>
                  )}
                   {ws && ws.activeConsoleTab === 'consola' && (
                    <>
                      <div className="flex-1 min-w-[4px]" />
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={() => { const v = !compactTerminal; setCompactTerminal(v); settings.set('compact_terminal', v); }}
                          className={`text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wide transition-all cursor-pointer
                            ${compactTerminal ? 'text-cyan-400 bg-cyan-500/10 border border-cyan-500/20' : 'text-gray-600 hover:text-gray-400'}`}
                          title="Compact mode: collapse repeated output to save tokens">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="4 21 4 14 20 14 20 21"/><polyline points="4 14 4 3 20 3 20 14"/></svg>
                        </button>
                        <input value={consoleSearch} onChange={e => setConsoleSearch(e.target.value)}
                          placeholder="Ctrl+F" className="w-20 bg-[#1a1e2e] text-[10px] text-gray-400 placeholder:text-gray-700
                            rounded-lg px-2 py-1 border border-white/[0.06] outline-none font-mono
                            focus:border-gray-500/40 focus:text-gray-200 transition-all" />
                        {logs.length > 0 && (
                          <button onClick={clearLogs}
                            className="text-[10px] text-gray-700 hover:text-gray-400 transition-colors cursor-pointer font-medium tracking-wide">
                            clear
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {/* Terminal containers per project (only active project's terminals are visible) */}
                {Object.entries(projects).map(([projPath, proj]) => {
                  const isActive = projPath === activeProject;
                  return (
                    <div key={projPath} className={`flex-1 flex flex-col overflow-hidden ${isActive ? '' : 'hidden'}`}>
                      {(proj.consoleTabs || []).filter(t => t.id !== 'consola').map(tab => (
                        <div key={tab.id} id={`xterm-${projPath}-${tab.id}`} className={`flex-1 overflow-hidden p-0 ${proj.activeConsoleTab === tab.id ? '' : 'hidden'}`} />
                      ))}
                      <div ref={logEnd} className={`flex-1 overflow-y-auto p-4 font-mono leading-[1.9] select-text ${proj.activeConsoleTab === 'consola' ? '' : 'hidden'}`} style={{ fontSize: consoleFontSize }}>
                        {filteredLogs.length === 0 && (
                          <div className="flex flex-col items-center justify-center h-full text-gray-700 select-none gap-3">
                            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-gray-800/30 to-gray-900/30 border border-white/[0.03] flex items-center justify-center">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
                                <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                              </svg>
                            </div>
                            <div className="text-center">
                              <p className="text-[11px] text-gray-600 font-mono">Consola</p>
                              <p className="text-[10px] text-gray-700/60 mt-0.5">{consoleSearch ? 'Sin resultados' : (projPath ? 'Ejecutá un comando para ver output aquí' : 'Seleccioná un proyecto para empezar.')}</p>
                            </div>
                          </div>
                        )}
                        {filteredLogs.map((l, i) => {
                          const parts = splitLogLine(l.text, openFileAtLine);
                          return (
                            <p key={i} className={`console-line ${KIND_STYLE[l.kind] || 'text-gray-300'} whitespace-pre-wrap break-all`}>
                              <span className="select-none text-[9px] opacity-40 mr-1">{KIND_ICON[l.kind] || ' '}</span>
                              {parts.map((p, j) =>
                                p.type === 'link' ? (
                                  <span key={j} onClick={p.onClick}
                                    className="cursor-pointer text-sky-300 border-b border-dashed border-sky-500/40 hover:text-white hover:border-sky-300 bg-sky-500/8 hover:bg-sky-500/15 rounded-[2px] px-0.5 transition-all font-medium"
                                    title={p.path ? `${p.path}:${p.line}` : ''}>{p.text}</span>
                                ) : (
                                  <span key={j}>{p.text}</span>
                                )
                              )}
                            </p>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </Panel>
        </Group>
      </Panel>
    </Group>
    </div>
      {toast && (
        <div className={`fixed bottom-6 right-6 z-[100] pl-4 pr-2 py-2 rounded-xl text-[11px] font-mono font-semibold shadow-2xl border backdrop-blur-xl toast-enter flex items-center gap-2
          ${toast.type === 'ok' ? 'bg-emerald-900/85 text-emerald-200 border-emerald-600/30' : 'bg-red-900/85 text-red-200 border-red-600/30'}`}>
          <span className="flex-1">{toast.message}</span>
          <button onClick={() => setToast(null)}
            className="text-white/40 hover:text-white/80 transition-colors cursor-pointer shrink-0 p-0.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}
      {/* ── SHORTCUTS MODAL ── */}
      {showShortcuts && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowShortcuts(false)}>
          <div className="bg-[#0e1118] border border-white/[0.08] rounded-2xl shadow-2xl w-[440px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
              <span className="text-[12px] font-bold text-white">Keyboard Shortcuts</span>
              <button onClick={() => setShowShortcuts(false)} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="overflow-y-auto max-h-[calc(80vh-48px)] p-4 space-y-4">
              {[
                { title: 'General', shortcuts: [
                  ['Ctrl+P', 'Buscar archivo'],
                  ['Ctrl+Shift+?', 'Mostrar atajos'],
                  ['Ctrl+R', 'Run mode actual'],
                  ['Ctrl+B', 'Build'],
                  ['Ctrl+T', 'Test'],
                  ['Ctrl+L', 'Limpiar consola'],
                ]},
                { title: 'Editor', shortcuts: [
                  ['Ctrl+W', 'Cerrar pestaña'],
                  ['Ctrl+Shift+T', 'Reabrir pestaña cerrada'],
                  ['Ctrl+Tab', 'Siguiente pestaña'],
                  ['Ctrl+Shift+Tab', 'Pestaña anterior'],
                  ['Ctrl+S', 'Guardar archivo'],
                  ['Ctrl+F', 'Buscar en consola/archivo'],
                ]},
                { title: 'Terminal', shortcuts: [
                  ['Ctrl+C', 'Copiar (con selección) / Interrumpir (sin selección)'],
                  ['Ctrl+V', 'Pegar desde portapapeles'],
                ]},
              ].map(({ title, shortcuts }) => (
                <div key={title}>
                  <h3 className="text-[9px] font-bold uppercase tracking-[0.2em] text-gray-500 mb-2">{title}</h3>
                  <div className="space-y-1">
                    {shortcuts.map(([key, desc]) => (
                      <div key={key} className="flex items-center justify-between py-1">
                        <span className="text-[10px] text-gray-400">{desc}</span>
                        <kbd className="text-[9px] font-mono text-cyan-300 bg-cyan-500/10 px-2 py-0.5 rounded border border-cyan-500/20">{key}</kbd>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null, info: '', errorStack: '' }; }
  componentDidCatch(error, info) {
    console.error('Render error:', error.message, '\nstack:', error.stack, '\ncomponentStack:', info.componentStack);
    this.setState({ error, info: info.componentStack, errorStack: error.stack });
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', { style: { padding: 20, color: '#f87171', background: '#0c0d14', height: '100vh', fontFamily: 'monospace', fontSize: 12 } },
        React.createElement('h2', null, 'Error al renderizar'),
        React.createElement('pre', null, String(this.state.error)),
        React.createElement('pre', { style: { fontSize: 10, color: '#888' } }, this.state.info),
        React.createElement('pre', { style: { fontSize: 10, color: '#aaa', marginTop: 8 } }, this.state.errorStack)
      );
    }
    return this.props.children;
  }
}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>
  );
} catch (e) {
  const root = document.getElementById('root');
  if (root) {
    root.textContent = '';
    const pre = document.createElement('pre');
    pre.style.color = 'red';
    pre.style.padding = '20px';
    pre.textContent = `${e.message}\n${e.stack}`;
    root.appendChild(pre);
  }
}
