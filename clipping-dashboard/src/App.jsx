import React, { useState, useEffect, useRef } from 'react';
import { db, storage, functions } from './firebase';
import { collection, addDoc, updateDoc, serverTimestamp, query, orderBy, onSnapshot } from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';
import Sidebar from './components/Sidebar';
import TopNav from './components/TopNav';
import DashboardGrid from './components/DashboardGrid';
import VideoGrid from './components/VideoGrid';
import MobileTabBar from './components/MobileTabBar';

function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [videos, setVideos] = useState([]);
  const fileInputRef = useRef(null);
  const generateClips = httpsCallable(functions, 'generateClips');
  const skipStorageUploadInLocalMode =
    import.meta.env.DEV && import.meta.env.VITE_SKIP_STORAGE_UPLOAD === 'true';

  const callGenerateClipsWithTimeout = async (payload, timeoutMs = 45000) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for generateClips`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([generateClips(payload), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  useEffect(() => {
    const q = query(collection(db, 'videos'), orderBy('createdAt', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const videosData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setVideos(videosData);
    });
    return () => unsubscribe();
  }, []);

  const toggleTheme = () => {
    setIsDarkMode(!isDarkMode);
    if (!isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const triggerUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file could be selected again if needed
    e.target.value = null;

    try {
      // 1. Create a processing document in Firestore immediately
      const docRef = await addDoc(collection(db, 'videos'), {
        title: file.name,
        status: 'processing',
        image: "https://images.unsplash.com/photo-1516280440502-a169b2752101?q=80&w=2670&auto=format&fit=crop",
        duration: "00:00",
        statusLabel: "Uploading...",
        dateLabel: "Just Now",
        clipsGenerated: 0,
        createdAt: serverTimestamp()
      });

      if (skipStorageUploadInLocalMode) {
        const localVideoReference = `local-file://${encodeURIComponent(file.name)}`;

        void updateDoc(docRef, {
          status: 'processing',
          statusLabel: 'Analyzing video (local mode)...',
          uploadProgress: 100,
          videoUrl: localVideoReference,
          updatedAt: serverTimestamp()
        }).catch((error) => {
          console.error("Failed to update local mode analysis status", error);
        });

        try {
          const result = await callGenerateClipsWithTimeout({
            videoUrl: localVideoReference,
            videoTitle: file.name
          });

          const generatedClips = Array.isArray(result.data?.clips) ? result.data.clips : [];

          await updateDoc(docRef, {
            status: 'processed',
            statusLabel: 'Ready',
            clips: generatedClips,
            clipsGenerated: generatedClips.length,
            uploadProgress: 100,
            updatedAt: serverTimestamp()
          });
        } catch (error) {
          console.error("Processing failed", error);
          await updateDoc(docRef, {
            status: 'failed',
            statusLabel: 'Processing failed',
            uploadProgress: 100,
            errorMessage: error.message || 'Processing error',
            updatedAt: serverTimestamp()
          });
        }

        return;
      }

      // 2. Upload video file to Firebase Storage
      const storageRef = ref(storage, `videos/${docRef.id}/${file.name}`);
      const uploadTask = uploadBytesResumable(storageRef, file);
      let lastProgressUpdate = -1;

      uploadTask.on('state_changed',
        (snapshot) => {
          const progress = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
          const shouldUpdate =
            progress === 100 ||
            lastProgressUpdate < 0 ||
            progress - lastProgressUpdate >= 10;

          if (!shouldUpdate) {
            return;
          }

          lastProgressUpdate = progress;
          void updateDoc(docRef, {
            status: 'processing',
            statusLabel: `Uploading... ${progress}%`,
            uploadProgress: progress,
            updatedAt: serverTimestamp()
          }).catch((error) => {
            console.error("Failed to update upload progress", error);
          });
        },
        async (error) => {
          console.error("Upload failed", error);
          try {
            await updateDoc(docRef, {
              status: 'failed',
              statusLabel: 'Upload failed',
              uploadProgress: 0,
              errorMessage: error.message || 'Upload error',
              updatedAt: serverTimestamp()
            });
          } catch (updateError) {
            console.error("Failed to update upload error state", updateError);
          }
        },
        async () => {
          try {
            const videoUrl = await getDownloadURL(uploadTask.snapshot.ref);

            await updateDoc(docRef, {
              status: 'processing',
              statusLabel: 'Analyzing video...',
              uploadProgress: 100,
              videoUrl,
              updatedAt: serverTimestamp()
            });

            const result = await callGenerateClipsWithTimeout({
              videoUrl,
              videoTitle: file.name
            });

            const generatedClips = Array.isArray(result.data?.clips) ? result.data.clips : [];

            await updateDoc(docRef, {
              status: 'processed',
              statusLabel: 'Ready',
              clips: generatedClips,
              clipsGenerated: generatedClips.length,
              uploadProgress: 100,
              updatedAt: serverTimestamp()
            });
          } catch (error) {
            console.error("Processing failed", error);
            try {
              await updateDoc(docRef, {
                status: 'failed',
                statusLabel: 'Processing failed',
                uploadProgress: 100,
                errorMessage: error.message || 'Processing error',
                updatedAt: serverTimestamp()
              });
            } catch (updateError) {
              console.error("Failed to update processing error state", updateError);
            }
          }
        }
      );
    } catch (err) {
      console.error("Error setting up upload", err);
    }
  };

  return (
    <div className={`min-h-screen font-display ${isDarkMode ? 'dark text-slate-100 bg-background-dark' : 'text-slate-900 bg-background-light'}`}>
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="video/*"
        className="hidden"
      />

      <div className="flex flex-col lg:flex-row min-h-[100dvh]">
        <Sidebar className="hidden lg:flex" />

        <main className="flex-1 flex flex-col h-[100dvh] overflow-hidden lg:pl-10">
          <TopNav isDarkMode={isDarkMode} toggleTheme={toggleTheme} onUpload={triggerUpload} />

          <div className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-8 scroll-smooth pb-24 lg:pb-8">
            <DashboardGrid />
            <div className="pt-4">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-primary to-accent-neon">
                  Recent Processed
                </h2>
                <button className="text-sm font-medium text-slate-500 hover:text-primary dark:text-slate-400 dark:hover:text-accent-neon transition-colors">
                  View All
                </button>
              </div>
              <VideoGrid videos={videos} />
            </div>
          </div>
        </main>
        <MobileTabBar onUpload={triggerUpload} />
      </div>
    </div>
  );
}

export default App;
