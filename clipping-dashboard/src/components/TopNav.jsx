import React, { useState } from 'react';

const NAV_ITEMS = [
    { id: 'preview', label: 'Sermon Prep', icon: 'movie' },
    { id: 'vault', label: 'Sanctuary', icon: 'inventory_2' },
];

const TopNav = ({
    isDarkMode,
    toggleTheme,
    onUpload,
    onStudioUrlSubmit,
    studioPrepMode = 'single',
    onStudioPrepModeChange,
    onToggleSidebar,
    isSidebarCollapsed,
    showSidebarToggle = true,
    showStudioIngest = false,
    contentProfile = 'generic',
    onContentProfileChange,
    onNavigate,
    activeView = 'preview',
}) => {
    const [studioUrlValue, setStudioUrlValue] = useState('');

    return (
        <header className="flex items-center gap-4 p-4 lg:p-8 lg:pb-0">
            {showSidebarToggle ? (
                <button
                    type="button"
                    onClick={onToggleSidebar}
                    className="hidden lg:flex p-2.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
                    aria-label={isSidebarCollapsed ? 'Show menu pane' : 'Hide menu pane'}
                    title={isSidebarCollapsed ? 'Show menu pane' : 'Hide menu pane'}
                >
                    <span className="material-symbols-outlined">
                        {isSidebarCollapsed ? 'left_panel_open' : 'left_panel_close'}
                    </span>
                </button>
            ) : null}

            <div className="hidden lg:flex items-center flex-1 min-w-0">
                <nav className="inline-flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 bg-white/75 dark:bg-slate-900/40 p-1">
                    {NAV_ITEMS.map((item) => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => onNavigate?.(item.id)}
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-full text-xs font-semibold transition-colors ${
                                activeView === item.id
                                    ? 'bg-primary text-white shadow-md shadow-primary/30'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                        >
                            <span className="material-symbols-outlined text-[16px]">{item.icon}</span>
                            {item.label}
                        </button>
                    ))}
                </nav>
            </div>

            {showStudioIngest ? (
                <div className="hidden lg:flex items-center justify-end gap-4 flex-[1.6] min-w-0 pl-6">
                    <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 dark:border-slate-700 bg-white/75 dark:bg-slate-900/40 p-1 shrink-0">
                        <button
                            type="button"
                            onClick={() => onStudioPrepModeChange?.('single')}
                            className={`px-4 py-2 rounded-full text-xs font-semibold transition-colors ${
                                studioPrepMode === 'single'
                                    ? 'bg-primary text-white shadow-md shadow-primary/30'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                        >
                            Single Source
                        </button>
                        <button
                            type="button"
                            onClick={() => onStudioPrepModeChange?.('multicam')}
                            className={`px-4 py-2 rounded-full text-xs font-semibold transition-colors ${
                                studioPrepMode === 'multicam'
                                    ? 'bg-primary text-white shadow-md shadow-primary/30'
                                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                            }`}
                        >
                            Multicam
                        </button>
                    </div>
                    <button onClick={onUpload} className="hidden lg:flex items-center gap-2 bg-gradient-to-r from-primary to-accent-neon text-white px-6 py-2.5 rounded-full font-bold shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-0.5 transition-all shrink-0">
                        <span className="material-symbols-outlined">upload</span>
                        {studioPrepMode === 'multicam' ? 'Add Cameras' : 'Add Source'}
                    </button>
                    <div className="flex-[1.2] min-w-[260px] max-w-[420px]">
                        <input
                            id="studio-inline-url-input"
                            name="studioInlineUrl"
                            type="text"
                            value={studioUrlValue}
                            onChange={(event) => setStudioUrlValue(event.target.value)}
                            disabled={studioPrepMode === 'multicam'}
                            onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                onStudioUrlSubmit?.(studioUrlValue);
                            }}
                            placeholder={studioPrepMode === 'multicam'
                                ? 'Multicam mode uses Add Source for Camera 1 + Camera 2.'
                                : 'Paste URL or use Add Source for a local video.'}
                            className="w-full bg-white/75 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-full px-4 py-2.5 text-sm"
                        />
                    </div>
                    <select
                        id="topnav-content-profile"
                        name="topnavContentProfile"
                        value={contentProfile}
                        onChange={(event) => onContentProfileChange?.(event.target.value)}
                        className="w-40 bg-white/75 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-700 rounded-full px-4 py-2.5 text-sm shrink-0"
                    >
                        <option value="generic">Generic</option>
                        <option value="sports">Sports</option>
                        <option value="gaming">Gaming</option>
                        <option value="podcast">Podcast</option>
                    </select>
                </div>
            ) : null}

            <div className="flex items-center gap-3 lg:gap-6 ml-auto shrink-0">
                <button
                    onClick={toggleTheme}
                    className="p-2.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
                    aria-label="Toggle dark mode"
                >
                    <span className="material-symbols-outlined">
                        {isDarkMode ? 'light_mode' : 'dark_mode'}
                    </span>
                </button>
            </div>
        </header>
    );
};

export default TopNav;
