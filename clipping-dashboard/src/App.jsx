import React, { useState, useEffect, useRef } from 'react';
import { db, storage, functions } from './firebase';
import { collection, addDoc, setDoc, updateDoc, serverTimestamp, query, orderBy, onSnapshot } from 'firebase/firestore';
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
  const [localDebugStatus, setLocalDebugStatus] = useState('');
  const fileInputRef = useRef(null);
  const generateClips = httpsCallable(functions, 'generateClips');
  const skipStorageUploadInLocalMode =
    import.meta.env.DEV && import.meta.env.VITE_SKIP_STORAGE_UPLOAD !== 'false';

  const waitWithTimeout = async (promise, timeoutMs, errorMessage) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const callGenerateClipsWithTimeout = async (payload, timeoutMs = 20000) => {
    return waitWithTimeout(
      generateClips(payload),
      timeoutMs,
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for generateClips`
    );
  };

  const setLocalDebug = (message) => {
    if (!import.meta.env.DEV) return;
    setLocalDebugStatus(message);
    console.log(`[local-debug] ${message}`);
  };

  const safeMergeDoc = async (docRef, data, context) => {
    try {
      await setDoc(docRef, data, { merge: true });
      return true;
    } catch (error) {
      console.error(`${context} failed`, error);
      setLocalDebug(`${context} failed: ${error.message || 'Unknown error'}`);
      return false;
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
      if (skipStorageUploadInLocalMode) {
        setLocalDebug('Local mode active');
        const localVideoReference = `local-file://${encodeURIComponent(file.name)}`;
        setLocalDebug('Creating Firestore document...');
        const docRef = await addDoc(collection(db, 'videos'), {
          title: file.name,
          status: 'processing',
          image: "https://images.unsplash.com/photo-1516280440502-a169b2752101?q=80&w=2670&auto=format&fit=crop",
          duration: "00:00",
          statusLabel: "Analyzing video (local mode)...",
          dateLabel: "Just Now",
          clipsGenerated: 0,
          uploadProgress: 100,
          videoUrl: localVideoReference,
          createdAt: serverTimestamp()
        });
        setLocalDebug('Firestore document created');
        await safeMergeDoc(docRef, {
          status: 'processing',
          statusLabel: 'Calling AI (local mode)...',
          updatedAt: serverTimestamp()
        }, 'Pre-call status update');

        try {
          setLocalDebug('Calling generateClips...');
          const result = await callGenerateClipsWithTimeout({
            videoUrl: localVideoReference,
            videoTitle: file.name
          });
          const generatedClips = Array.isArray(result.data?.clips) ? result.data.clips : [];
          setLocalDebug(`AI returned ${generatedClips.length} clips`);

          await safeMergeDoc(docRef, {
            status: 'processed',
            statusLabel: 'Ready',
            clips: generatedClips,
            clipsGenerated: generatedClips.length,
            uploadProgress: 100,
            updatedAt: serverTimestamp()
          }, 'Final success update');
          setLocalDebug('Done');
        } catch (error) {
          console.error("Processing failed", error);
          setLocalDebug(`AI failed: ${error.message || 'Unknown error'}`);
          await safeMergeDoc(docRef, {
            status: 'failed',
            statusLabel: 'Processing failed',
            uploadProgress: 100,
            errorMessage: error.message || 'Processing error',
            updatedAt: serverTimestamp()
          }, 'Final failure update');
        }

        return;
      }

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
      {import.meta.env.DEV && localDebugStatus && (
        <div className="fixed top-3 right-3 z-[100] rounded-lg bg-slate-900/90 text-white text-xs px-3 py-2 shadow-xl max-w-xs">
          {localDebugStatus}
        </div>
      )}
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
