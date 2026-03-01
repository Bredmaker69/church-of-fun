import React from 'react';
import VideoCard from './VideoCard';

const VideoGrid = ({ videos }) => {
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
            {videos.map((video, index) => (
                <VideoCard key={index} {...video} />
            ))}
        </div>
    );
};

export default VideoGrid;
