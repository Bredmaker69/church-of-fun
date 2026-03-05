import React from 'react';

const CONTENT_PROFILES = [
    { id: 'generic', label: 'Generic' },
    { id: 'sports', label: 'Sports' },
    { id: 'gaming', label: 'Gaming' },
    { id: 'podcast', label: 'Podcast' },
];

const Sidebar = ({
    className,
    style,
    ingestPanel,
    activeSource,
    contentProfile = 'generic',
    onContentProfileChange,
    currentWorkspace = 'studio',
    onWorkspaceChange,
}) => {
    const sourceMode = activeSource?.kind === 'file'
        ? 'file'
        : activeSource?.kind === 'url'
            ? 'url'
            : 'none';

    const sourceLabel = sourceMode === 'file'
        ? `Local file: ${activeSource?.label || 'Untitled'}`
        : sourceMode === 'url'
            ? String(activeSource?.label || '')
            : 'No source loaded';

    const sourceTypeLabel = sourceMode === 'none'
        ? 'No Source'
        : sourceMode === 'file'
            ? 'Local Source'
            : 'URL Source';

    return (
        <aside
            style={style}
            className={`flex flex-col w-full border-r border-slate-200 dark:border-slate-800 p-4 gap-6 bg-background-light dark:bg-background-dark/50 backdrop-blur-xl h-screen overflow-y-auto ${className}`}
        >
            {ingestPanel ? (
                <div className="sticky top-0 z-10 pt-1 bg-background-light dark:bg-background-dark/95 backdrop-blur-sm pb-2">
                    {ingestPanel}
                </div>
            ) : (
                <div className="px-2 py-2">
                    <span className="font-bold text-lg tracking-tight leading-none bg-clip-text text-transparent bg-gradient-to-br from-primary to-accent-neon">
                        Clip Studio
                    </span>
                </div>
            )}

            <section className="glass rounded-2xl p-4 space-y-3">
                <div className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <span className="material-symbols-outlined text-[14px]">video_library</span>
                    {sourceTypeLabel}
                </div>

                <div className="space-y-1">
                    <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Active Source</div>
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 break-all">
                        {sourceLabel}
                    </div>
                </div>

                <div className="space-y-1.5">
                    <label htmlFor="sidebar-content-profile" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Profile
                    </label>
                    <select
                        id="sidebar-content-profile"
                        name="sidebarContentProfile"
                        value={contentProfile}
                        onChange={(event) => onContentProfileChange?.(event.target.value)}
                        className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm"
                    >
                        {CONTENT_PROFILES.map((profile) => (
                            <option key={profile.id} value={profile.id}>{profile.label}</option>
                        ))}
                    </select>
                </div>

                <div className="text-xs text-slate-500 dark:text-slate-400">
                    Shortcuts: <span className="font-semibold">I</span> mark start, <span className="font-semibold">O</span> mark end.
                </div>
            </section>

            <div className="h-px bg-slate-200 dark:bg-slate-800" />

            <nav className="flex flex-col gap-2 flex-1">
                <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 px-4">Workspace</div>
                <button
                    type="button"
                    onClick={() => onWorkspaceChange?.('studio')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-left transition-colors ${
                        currentWorkspace === 'studio'
                            ? 'bg-primary/10 text-primary neon-border'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                    }`}
                >
                    <span className="material-symbols-outlined text-[20px]">dashboard</span>
                    Clip Studio
                </button>
                <button
                    type="button"
                    onClick={() => onWorkspaceChange?.('vault')}
                    className={`flex items-center gap-3 px-4 py-3 rounded-xl font-medium text-left transition-colors ${
                        currentWorkspace === 'vault'
                            ? 'bg-primary/10 text-primary neon-border'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50'
                    }`}
                >
                    <span className="material-symbols-outlined text-[20px]">inventory_2</span>
                    Clip Vault
                </button>

                <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mt-3 mb-1 px-4">Library</div>
                <a href="#" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                    <span className="material-symbols-outlined text-[20px]">movie</span>
                    Source Videos
                </a>
                <a href="#" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                    <span className="material-symbols-outlined text-[20px]">content_cut</span>
                    Clips <span className="ml-auto bg-primary/20 text-primary text-xs px-2 py-0.5 rounded-full font-bold">12</span>
                </a>
                <a href="#" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                    <span className="material-symbols-outlined text-[20px]">analytics</span>
                    Analytics
                </a>
                <a href="#" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/50 transition-colors">
                    <span className="material-symbols-outlined text-[20px]">settings</span>
                    Settings
                </a>
            </nav>

            <div className="mt-auto">
                <div className="glass rounded-2xl p-4 relative overflow-hidden group">
                    <div className="absolute inset-0 bg-gradient-to-br from-primary/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                    <div className="flex items-center gap-3 relative z-10">
                        <span className="material-symbols-outlined text-accent-neon">bolt</span>
                        <div className="flex flex-col">
                            <span className="text-sm font-bold text-slate-800 dark:text-slate-200">Pro Plan</span>
                            <span className="text-xs text-slate-500">24/100 hrs used</span>
                        </div>
                    </div>
                    <div className="w-full bg-slate-200 dark:bg-slate-800 h-1.5 rounded-full mt-3 overflow-hidden">
                        <div className="bg-gradient-to-r from-primary to-accent-neon h-full w-[24%]" />
                    </div>
                </div>
            </div>
        </aside>
    );
};

export default Sidebar;
