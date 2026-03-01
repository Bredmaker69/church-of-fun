import React from 'react';

const VideoCard = ({ image, title, duration, statusLabel, dateLabel, clipsGenerated, clipFiles, uploadProgress, status = 'processed' }) => {
    const isProcessing = status === 'processing';
    const isFailed = status === 'failed';
    const progressValue = Number.isFinite(uploadProgress) ? Math.max(0, Math.min(100, uploadProgress)) : null;
    const displayStatus = statusLabel || (isProcessing ? 'Processing...' : isFailed ? 'Failed' : 'Ready');
    const downloadableClips = Array.isArray(clipFiles) ? clipFiles : [];

    return (
        <div className={`glass rounded-3xl overflow-hidden group cursor-pointer transition-all duration-300 ${isProcessing ? 'animate-pulse' : 'hover:-translate-y-1'}`}>
            <div className="relative aspect-video overflow-hidden">
                <img src={image} alt={`Thumbnail for ${title}`} className={`w-full h-full object-cover transition-transform duration-500 ${isProcessing ? 'opacity-50 grayscale' : 'group-hover:scale-105'}`} />
                <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-transparent to-transparent"></div>
                <div className="absolute bottom-4 right-4 bg-black/60 backdrop-blur-md px-2 py-1 rounded-md text-xs font-bold text-white flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">schedule</span>
                    {duration}
                </div>
                <div className={`absolute top-4 left-4 backdrop-blur-md px-3 py-1 rounded-full text-xs font-bold text-white shadow-lg flex items-center gap-1 ${isProcessing ? 'bg-primary/90' : isFailed ? 'bg-rose-500/90' : 'bg-emerald-500/90'}`}>
                    <span className="material-symbols-outlined text-[14px]">
                        {isProcessing ? 'sync' : isFailed ? 'error' : 'check_circle'}
                    </span>
                    {displayStatus}
                </div>
                {isProcessing && (
                    <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/50">
                        <div
                            className="h-full bg-gradient-to-r from-primary to-accent-neon transition-all duration-500"
                            style={{ width: `${progressValue ?? 100}%` }}
                        ></div>
                    </div>
                )}
            </div>

            <div className="p-5">
                <h3 className="font-bold text-slate-900 dark:text-white mb-2 line-clamp-1 group-hover:text-primary transition-colors">
                    {title}
                </h3>
                <div className="flex items-center justify-between text-sm text-slate-500">
                    <div className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-[16px]">calendar_today</span>
                        {dateLabel}
                    </div>
                    {!isProcessing && !isFailed && (
                        <div className="flex items-center gap-1 text-primary bg-primary/10 px-2 py-1 rounded-lg font-bold">
                            <span className="material-symbols-outlined text-[16px]">content_cut</span>
                            {clipsGenerated} clips
                        </div>
                    )}
                </div>
                {!isProcessing && !isFailed && downloadableClips.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                        {downloadableClips.map((clip, index) => (
                            <a
                                key={`${clip.fileName || clip.title || 'clip'}-${index}`}
                                href={clip.downloadUrl}
                                download={clip.fileName || `clip-${index + 1}.mp4`}
                                onClick={(event) => event.stopPropagation()}
                                className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
                            >
                                Download Clip {index + 1}
                            </a>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default VideoCard;
