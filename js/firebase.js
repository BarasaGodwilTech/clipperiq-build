import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence, indexedDBLocalPersistence } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { db as localDb } from "./storage/db.js";

// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyAGOdj5KjOiespwIm4uy2CR25CLVI3JP9s",
  authDomain: "clipperiq-da448.firebaseapp.com",
  projectId: "clipperiq-da448",
  storageBucket: "clipperiq-da448.firebasestorage.app",
  messagingSenderId: "970532047088",
  appId: "1:970532047088:web:81f33d1d10779ec5da1a35"
};


// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const firestore = getFirestore(app);
export const storage = getStorage(app);

// Prefer persistent sessions across reloads. Try IndexedDB first, then Local, Session, In-Memory.
try {
  setPersistence(auth, indexedDBLocalPersistence)
    .catch(() => setPersistence(auth, browserLocalPersistence))
    .catch(() => setPersistence(auth, browserSessionPersistence))
    .catch(() => setPersistence(auth, inMemoryPersistence))
    .catch(() => {});
} catch {}
try { auth.useDeviceLanguage && auth.useDeviceLanguage(); } catch {}

/**
 * Sync global API keys from Firestore to local IndexedDB
 */
export async function syncApiKeysFromFirebase() {
  try {
    const keysRef = doc(firestore, "settings", "global_api_keys");
    const snap = await getDoc(keysRef);
    if (snap.exists()) {
      const keys = snap.data();
      // keys is an object like { tiktok_client_key: "...", google_client_id: "..." }
      const onLocalhost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
      for (const [key, value] of Object.entries(keys)) {
        // The backend URL is a deployment detail: on localhost the app always talks to the
        // server that served it, so a remote (e.g. ngrok) URL stored in Firestore is ignored.
        if (key === 'backend_base_url' && onLocalhost) continue;
        if (value) {
          await localDb.setSetting(key, value);
        }
      }
      console.log("[Firebase] API keys synced successfully.");
    } else {
      console.log("[Firebase] No global API keys found in Firestore.");
    }
  } catch (error) {
    console.error("[Firebase] Error syncing API keys:", error);
  }
}

/**
 * Save API keys to Firestore (Super Admin only)
 */
export async function saveApiKeysToFirebase(keysObject) {
  try {
    const keysRef = doc(firestore, "settings", "global_api_keys");
    await setDoc(keysRef, keysObject, { merge: true });
    console.log("[Firebase] API keys saved to Firestore successfully.");
    return true;
  } catch (error) {
    console.error("[Firebase] Error saving API keys:", error);
    throw error;
  }
}

export function loginUser(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function registerUser(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function logoutUser() {
  return signOut(auth);
}

export async function loginWithGoogle(options = {}) {
  const provider = new GoogleAuthProvider();
  try { provider.setCustomParameters({ prompt: 'select_account' }); } catch {}

  const maxRetries = Number(options.maxRetries ?? 1); // one quick automatic retry
  const retryDelayMs = Number(options.retryDelayMs ?? 400);

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      // Always prefer popup to avoid opening a new tab or full-page redirect
      return await signInWithPopup(auth, provider);
    } catch (error) {
      const code = error && error.code ? String(error.code) : '';
      // If the popup was blocked or closed immediately, do a brief auto-retry once
      if (code === 'auth/popup-blocked') {
        if (attempt < maxRetries) { await new Promise(r => setTimeout(r, retryDelayMs)); continue; }
        throw new Error('Popup was blocked by your browser. Please allow popups for this site and try again.');
      }
      if (code === 'auth/popup-closed-by-user') {
        const elapsed = Date.now() - startedAt;
        if (elapsed < 1200 && attempt < maxRetries) { await new Promise(r => setTimeout(r, retryDelayMs)); continue; }
        throw new Error('Popup closed before completing sign-in. Please try again.');
      }
      if (code === 'auth/operation-not-supported-in-this-environment') {
        throw new Error('Sign-in popup is not supported in this environment. Please try a different browser.');
      }
      lastError = error;
    }
  }
  throw lastError || new Error('Google sign-in failed. Please try again.');
}

export { onAuthStateChanged };

/**
 * Upload a Blob to Firebase Storage and return a public download URL.
 * The returned URL contains an access token and can be fetched by Instagram Graph.
 */
export async function uploadBlobAndGetUrl(path, blob, contentType = 'application/octet-stream') {
  try {
    const ref = storageRef(storage, path);
    await uploadBytes(ref, blob, { contentType });
    const url = await getDownloadURL(ref);
    return url;
  } catch (e) {
    console.error('[Firebase] Storage upload failed:', e);
    throw e;
  }
}
