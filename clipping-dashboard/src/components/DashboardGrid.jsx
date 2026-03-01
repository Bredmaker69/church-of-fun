import React from 'react';

const DashboardGrid = () => {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
            <div className="glass rounded-3xl p-6 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                    <span className="material-symbols-outlined text-[64px] text-primary">video_library</span>
                </div>
                <div className="relative z-10">
                    <p className="text-slate-500 font-medium mb-1">Total Videos</p>
                    <h3 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">128</h3>
                    <div className="flex items-center gap-1 text-sm font-medium text-emerald-500">
                        <span className="material-symbols-outlined text-[16px]">trending_up</span>
                        <span>+12 this week</span>
                    </div>
                </div>
            </div>

            <div className="glass rounded-3xl p-6 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 transition-opacity">
                    <span className="material-symbols-outlined text-[64px] text-accent-neon">content_cut</span>
                </div>
                <div className="relative z-10">
                    <p className="text-slate-500 font-medium mb-1">Generated Clips</p>
                    <h3 className="text-4xl font-bold text-slate-900 dark:text-white mb-2">1,024</h3>
                    <div className="flex items-center gap-1 text-sm font-medium text-emerald-500">
                        <span className="material-symbols-outlined text-[16px]">trending_up</span>
                        <span>+84 this week</span>
                    </div>
                </div>
            </div>

            <div className="md:col-span-2 lg:col-span-2 glass rounded-3xl p-6 relative overflow-hidden group flex flex-col justify-between">
                <div className="flex items-start justify-between mb-4">
                    <div>
                        <p className="text-slate-500 font-medium mb-1">Save Time</p>
                        <h3 className="text-4xl font-bold text-slate-900 dark:text-white">42<span className="text-xl text-slate-500 ml-1">hrs</span></h3>
                    </div>
                    <div className="bg-primary/10 text-primary px-3 py-1 rounded-full text-sm font-bold flex items-center gap-1">
                        <span className="material-symbols-outlined text-[16px]">schedule</span>
                        This Month
                    </div>
                </div>

                <div className="mt-auto flex items-end gap-2 h-16 w-full opacity-80 group-hover:opacity-100 transition-opacity">
                    {[40, 70, 45, 90, 65, 85, 100].map((height, i) => (
                        <div key={i} className="flex-1 bg-gradient-to-t from-primary/20 to-primary/60 dark:to-primary/40 rounded-t-sm" style={{ height: `${height}%` }}></div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default DashboardGrid;
