import React from 'react';
import logo from '../assets/logo.jpg';

const Sidebar = ({ className }) => {
    return (
        <aside className={`flex flex-col w-64 border-r border-slate-200 dark:border-slate-800 p-6 gap-8 bg-background-light dark:bg-background-dark/50 backdrop-blur-xl ${className}`}>
            <div className="flex items-center gap-3 px-2">
                <div className="size-12 overflow-hidden shadow-2xl shadow-primary/30 flex items-center justify-center rounded-full aspect-square">
                    <img src={logo} alt="Church of Fun Logo" className="w-full h-full object-cover" />
                </div>
                <div className="flex flex-col">
                    <span className="font-bold text-lg tracking-tight leading-none bg-clip-text text-transparent bg-gradient-to-br from-primary to-accent-neon">Clipper AI</span>
                    <span className="text-[10px] uppercase font-bold tracking-widest text-slate-500">Church of Fun</span>
                </div>
            </div>

            <nav className="flex flex-col gap-2 flex-1">
                <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 px-4">Menu</div>
                <a href="#" className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary/10 text-primary font-medium neon-border">
                    <span className="material-symbols-outlined text-[20px]">dashboard</span>
                    Dashboard
                </a>
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
