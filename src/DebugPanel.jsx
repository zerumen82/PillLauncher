import React from 'react';
import { invoke } from '@tauri-apps/api/core';

export default function DebugPanel({ sessionId, vars, stack, location, onCmd, debugPort, debugSuspend, onToggleSuspend, onPortChange }) {
  if (!sessionId) {
    return (
      <div className="flex flex-col h-full text-[10px] font-mono select-none p-3 gap-3">
        <div className="text-[8px] font-bold uppercase tracking-[0.15em] text-gray-600">JDWP Config</div>
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-[9px]">Port:</span>
          <input type="number" min="1024" max="65535" value={debugPort}
            onChange={e => { const v = parseInt(e.target.value, 10); if (v > 0 && v < 65536) onPortChange(v); }}
            className="w-14 bg-[#1a1e2e] text-[9px] text-cyan-300 font-mono rounded px-1.5 py-1 border border-white/[0.06] outline-none text-center" />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onToggleSuspend}
            className={`text-[8px] font-mono px-1.5 py-0.5 rounded border transition-all cursor-pointer
              ${debugSuspend
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/25'
                : 'bg-emerald-500/10 text-emerald-400/60 border-emerald-500/15'
              }`}
            title={debugSuspend ? 'suspend=y: espera al debugger' : 'suspend=n: arranca sin esperar'}>
            {debugSuspend ? '⏳ suspend=y' : '▶ suspend=n'}
          </button>
        </div>
        <div className="flex gap-1">
          <button onClick={() => { const url = `jdb -attach localhost:${debugPort}`; navigator.clipboard.writeText(url).then(() => {}).catch(() => {}); }}
            className="text-[8px] text-gray-500 hover:text-cyan-400 transition-colors px-1.5 py-0.5 rounded font-mono cursor-pointer border border-white/[0.04]"
            title="Copiar comando JDWP">📋 Copy jdb cmd</button>
        </div>
        <div className="flex-1 flex items-center justify-center text-[9px] text-gray-600 italic">
          Run with Debug enabled to attach
        </div>
      </div>
    );
  }

  const btn = (label, cmd, cls = '') => (
    <button onClick={() => onCmd(cmd)}
      className={`px-2 py-1 rounded text-[9px] font-bold transition-all cursor-pointer ${cls}`}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full text-[10px] font-mono select-none">
      {/* Location bar */}
      {location && (
        <div className="px-2 py-1 bg-amber-500/10 border-b border-amber-500/15 text-amber-400 text-[9px] truncate shrink-0">
          ▸ {location}
        </div>
      )}

      {/* Step buttons */}
      <div className="flex gap-1 px-2 py-1.5 border-b border-white/[0.04] shrink-0 flex-wrap">
        {btn('⬇ Into', 'step', 'bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/20')}
        {btn('⬆ Over', 'next', 'bg-indigo-500/15 text-indigo-400 hover:bg-indigo-500/25 border border-indigo-500/20')}
        {btn('⬅ Out', 'step up', 'bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 border border-violet-500/20')}
        {btn('▶ Cont', 'cont', 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 border border-emerald-500/20')}
        {btn('⟳', 'locals', 'bg-gray-500/10 text-gray-400 hover:bg-gray-500/20 border border-white/[0.04]')}
      </div>

      {/* Variables */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {vars.length > 0 && (
          <div className="border-b border-white/[0.04]">
            <div className="px-2 py-1 text-[8px] font-bold uppercase tracking-[0.15em] text-gray-600 sticky top-0 bg-[#13151e]/90 backdrop-blur-sm">Variables</div>
            {vars.map((v, i) => (
              <div key={i} className="flex items-start gap-2 px-2 py-0.5 hover:bg-white/[0.02]">
                <span className="text-gray-400 truncate max-w-[80px] shrink-0">{v.name}</span>
                <span className="text-gray-600 text-[8px] shrink-0">=</span>
                <span className="text-emerald-300 break-all min-w-0">{v.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* Stack */}
        {stack.length > 0 && (
          <div>
            <div className="px-2 py-1 text-[8px] font-bold uppercase tracking-[0.15em] text-gray-600 sticky top-0 bg-[#13151e]/90 backdrop-blur-sm">Stack</div>
            {stack.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-white/[0.02] text-[9px]">
                <span className="text-gray-600 w-3 shrink-0 text-right">{f.idx}</span>
                <span className="text-gray-300 truncate">{f.method}</span>
                <span className="text-gray-600 shrink-0">at</span>
                <span className="text-cyan-400/70 truncate">{f.file}:{f.line}</span>
              </div>
            ))}
          </div>
        )}

        {vars.length === 0 && stack.length === 0 && !location && (
          <div className="flex items-center justify-center h-20 text-[9px] text-gray-600 italic">
            Waiting for breakpoint…
          </div>
        )}
      </div>
    </div>
  );
}
