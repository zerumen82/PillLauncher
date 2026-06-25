import React from 'react';

const FolderOpenIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export default function ProjectTabs({ projects, activeProject, onSwitch, onClose, onAdd, runningProject }) {
  return (
    <div className="flex items-center gap-0.5 px-3 py-1 bg-[#0e1018] border-b border-white/[0.04] overflow-x-auto shrink-0">
      {projects.map((p, i) => {
        const isActive = p.path === activeProject;
        const isRunning = runningProject === p.path;
        const label = p.label || p.path.split(/[\\/]/).pop() || 'Proyecto';
        const emoji = p.info?.emoji || '📁';
        return (
          <div key={p.path}
            className={`group flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-mono rounded-lg cursor-pointer select-none shrink-0 transition-all
              ${isActive
                ? 'bg-white/[0.07] text-white shadow-sm'
                : 'text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]'
              }`}
            onClick={() => onSwitch(p.path)}>
            <span className="text-xs leading-none">{emoji}</span>
            <span className="truncate max-w-[120px]">{label}</span>
            {isRunning && (
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_6px_rgba(251,191,36,0.5)]" />
            )}
            <button onClick={(e) => { e.stopPropagation(); onClose(p.path); }}
              className="ml-0.5 text-gray-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 cursor-pointer">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        );
      })}
      <button onClick={onAdd}
        className="flex items-center justify-center w-6 h-6 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-white/[0.04] transition-all cursor-pointer shrink-0"
        title="Abrir proyecto">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </div>
  );
}
