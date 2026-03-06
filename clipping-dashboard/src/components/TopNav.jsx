import React from 'react';

const NAV_ITEMS = [
    { id: 'preview', label: 'Preview & Scrub', icon: 'movie' },
    { id: 'vault', label: 'Clip Vault', icon: 'inventory_2' },
];

const TopNav = ({
    isDarkMode,
    toggleTheme,
    onUpload,
    onToggleSidebar,
    isSidebarCollapsed,
    onNavigate,
    activeView = 'preview',
}) => {
    return (
        <header className="flex items-center gap-3 p-4 lg:p-8 lg:pb-0">
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

            <div className="flex items-center gap-3 lg:gap-6 ml-auto">
                <button
                    onClick={toggleTheme}
                    className="p-2.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors"
                    aria-label="Toggle dark mode"
                >
                    <span className="material-symbols-outlined">
                        {isDarkMode ? 'light_mode' : 'dark_mode'}
                    </span>
                </button>
                <button onClick={onUpload} className="hidden lg:flex items-center gap-2 bg-gradient-to-r from-primary to-accent-neon text-white px-5 py-2.5 rounded-full font-bold shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-0.5 transition-all">
                    <span className="material-symbols-outlined">upload</span>
                    Add Source
                </button>
            </div>
        </header>
    );
};

export default TopNav;
