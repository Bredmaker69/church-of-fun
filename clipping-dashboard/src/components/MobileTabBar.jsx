import React from 'react';

const MobileTabBar = ({ onUpload }) => {
    return (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 glass border-t border-slate-200/20 dark:border-slate-800/50 z-50 px-6 py-4 flex items-center justify-between">
            <a href="#" className="flex flex-col items-center gap-1 text-primary">
                <span className="material-symbols-outlined text-[24px]">dashboard</span>
                <span className="text-[10px] font-medium">Home</span>
            </a>
            <a href="#" className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                <span className="material-symbols-outlined text-[24px]">movie</span>
                <span className="text-[10px] font-medium">Videos</span>
            </a>
            <div className="relative -top-6">
                <button onClick={onUpload} className="flex items-center justify-center size-14 rounded-full bg-gradient-to-br from-primary to-accent-neon text-white shadow-xl shadow-primary/30 hover:scale-105 active:scale-95 transition-all">
                    <span className="material-symbols-outlined text-[28px]">add</span>
                </button>
            </div>
            <a href="#" className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                <span className="relative material-symbols-outlined text-[24px]">
                    content_cut
                    <span className="absolute -top-1 -right-1 flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-neon opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-primary border-2 border-background-dark"></span>
                    </span>
                </span>
                <span className="text-[10px] font-medium">Clips</span>
            </a>
            <a href="#" className="flex flex-col items-center gap-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
                <span className="material-symbols-outlined text-[24px]">settings</span>
                <span className="text-[10px] font-medium">Menu</span>
            </a>
        </div>
    );
};

export default MobileTabBar;
