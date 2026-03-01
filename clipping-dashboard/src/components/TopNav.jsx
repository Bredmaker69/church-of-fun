import React from 'react';
import logo from '../assets/logo.jpg';

const TopNav = ({ isDarkMode, toggleTheme, onUpload }) => {
    return (
        <header className="flex items-center justify-between p-4 lg:p-8 lg:pb-0">
            <div className="flex items-center gap-4 lg:hidden">
                <div className="size-10 overflow-hidden shadow-xl shadow-primary/30 flex items-center justify-center rounded-full aspect-square">
                    <img src={logo} alt="Church of Fun Logo" className="w-full h-full object-cover" />
                </div>
            </div>

            <div className="hidden lg:block relative flex-1 max-w-xl">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <span className="material-symbols-outlined text-slate-400">search</span>
                </div>
                <input
                    type="text"
                    className="w-full bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-full py-3 pl-12 pr-4 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all shadow-sm"
                    placeholder="Search videos, clips, or tags..."
                />
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
                <button className="relative p-2.5 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition-colors">
                    <span className="material-symbols-outlined">notifications</span>
                    <span className="absolute top-2 right-2 size-2.5 bg-accent-neon rounded-full border-2 border-background-light dark:border-background-dark"></span>
                </button>
                <button onClick={onUpload} className="hidden lg:flex items-center gap-2 bg-gradient-to-r from-primary to-accent-neon text-white px-5 py-2.5 rounded-full font-bold shadow-lg shadow-primary/30 hover:shadow-primary/50 hover:-translate-y-0.5 transition-all">
                    <span className="material-symbols-outlined">upload</span>
                    Upload Video
                </button>
                <button className="hidden lg:flex items-center gap-3 hover:opacity-80 transition-opacity">
                    <div className="text-right">
                        <div className="text-sm font-bold text-slate-900 dark:text-white">Alex Fox</div>
                        <div className="text-xs text-slate-500">Creator</div>
                    </div>
                    <img src="https://i.pravatar.cc/150?u=a042581f4e29026024d" alt="Profile" className="size-10 rounded-full border-2 border-primary/20" />
                </button>
            </div>
        </header>
    );
};

export default TopNav;
