import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { connectFunctionsEmulator, getFunctions } from "firebase/functions";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

const missingFirebaseConfig = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

if (missingFirebaseConfig.length > 0) {
    throw new Error(
        `Missing Firebase config values: ${missingFirebaseConfig.join(", ")}. ` +
        "Set the required VITE_FIREBASE_* values in your .env.local file."
    );
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize Firebase services
export const db = getFirestore(app);
export const storage = getStorage(app);
export const functions = getFunctions(
    app,
    import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || "us-central1"
);

const useFunctionsEmulator =
    import.meta.env.DEV &&
    import.meta.env.VITE_USE_FUNCTIONS_EMULATOR !== "false";

if (useFunctionsEmulator && !globalThis.__functionsEmulatorConnected) {
    const host = import.meta.env.VITE_FUNCTIONS_EMULATOR_HOST || "127.0.0.1";
    const port = Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT || 5001);
    connectFunctionsEmulator(functions, host, port);
    globalThis.__functionsEmulatorConnected = true;
}

export default app;
