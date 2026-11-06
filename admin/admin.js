import { auth, firestore, onAuthStateChanged, loginUser, registerUser, logoutUser, loginWithGoogle, saveApiKeysToFirebase } from '../js/firebase.js';
import { db } from '../js/storage/db.js';
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const authBtn = document.getElementById('authBtn');
const registerBtn = document.getElementById('registerBtn');
const authGoogleBtn = document.getElementById('authGoogleBtn');
const logoutBtn = document.getElementById('logoutBtn');
const authError = document.getElementById('authError');
const saveBtn = document.getElementById('saveApiKeysBtn');
const saveBackendUrlBtn = document.getElementById('saveBackendUrlBtn');
const backendBaseUrlInput = document.getElementById('backendBaseUrl');
const toggleToSignUp = document.getElementById('toggleToSignUp');
const toggleToSignIn = document.getElementById('toggleToSignIn');
const emailSignInForm = document.getElementById('emailSignInForm');
const emailSignUpForm = document.getElementById('emailSignUpForm');

function mapFirebaseError(err) {
  const code = (err && err.code) ? String(err.code) : '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return 'Invalid email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/email-already-in-use':
      return 'This email is already in use. Try signing in instead.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 6 characters.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    case 'auth/popup-blocked':
      return 'Popup was blocked. Allow popups for this site and try again.';
    case 'auth/popup-closed-by-user':
      return 'Popup closed before completing sign-in. Please try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled in Firebase Auth.';
    default:
      return err?.message || 'Authentication failed. Please try again.';
  }
}

authBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
    await loginUser(email, password);
  } catch (err) {
    authError.textContent = mapFirebaseError(err);
    authError.style.display = 'block';
  }
});

registerBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  const email = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regConfirm').value;
  try {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
    if (password !== confirm) throw new Error('Passwords do not match.');
    await registerUser(email, password);
  } catch (err) {
    authError.textContent = mapFirebaseError(err);
    authError.style.display = 'block';
  }
});

authGoogleBtn.addEventListener('click', async () => {
  authError.style.display = 'none';
  authGoogleBtn.disabled = true;
  const prevText = authGoogleBtn.textContent;
  authGoogleBtn.textContent = 'Opening Google…';
  try {
    await loginWithGoogle();
  } catch (err) {
    authError.textContent = mapFirebaseError(err);
    authError.style.display = 'block';
  } finally {
    authGoogleBtn.disabled = false;
    authGoogleBtn.textContent = prevText;
  }
});

logoutBtn.addEventListener('click', () => logoutUser());

// Save backend_base_url to IndexedDB settings
saveBackendUrlBtn?.addEventListener('click', async () => {
  try {
    const valRaw = backendBaseUrlInput.value.trim();
    const val = valRaw.replace(/\/$/, '');
    if (!/^https?:\/\//i.test(val)) {
      alert('Please enter a valid URL starting with https:// (recommended).');
      return;
    }
    await db.setSetting('backend_base_url', val);
    // Also save to Firestore so other devices can pick it up via sync
    try { await saveApiKeysToFirebase({ backend_base_url: val }); } catch (e) { console.warn('Saving to Firestore failed, local setting persisted:', e); }
    document.getElementById('backendSaveStatus').style.display = 'block';
    setTimeout(() => document.getElementById('backendSaveStatus').style.display = 'none', 3000);
  } catch (err) {
    alert('Failed to save backend URL: ' + (err?.message || err));
  }
});

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  try {
    const keys = {
      tiktok_client_key: document.getElementById('tiktokClientKey').value.trim(),
      tiktok_client_secret: document.getElementById('tiktokClientSecret').value.trim(),
      facebook_app_id: document.getElementById('facebookAppId').value.trim(),
      facebook_app_secret: document.getElementById('facebookAppSecret').value.trim(),
      google_client_id: document.getElementById('googleClientId').value.trim(),
      google_client_secret: document.getElementById('googleClientSecret').value.trim(),
    };
    await saveApiKeysToFirebase(keys);
    document.getElementById('saveStatus').style.display = 'block';
    setTimeout(() => document.getElementById('saveStatus').style.display = 'none', 3000);
  } catch (err) {
    alert('Error saving keys: ' + err.message);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save Global API Keys';
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    document.getElementById('view-login').style.display = 'none';
    document.getElementById('view-admin').style.display = 'block';
    document.body.classList.remove('logged-out');
    
    // Load existing keys from Firestore to populate inputs
    try {
      const snap = await getDoc(doc(firestore, "settings", "global_api_keys"));
      if (snap.exists()) {
        const data = snap.data();
        if (data.tiktok_client_key) document.getElementById('tiktokClientKey').value = data.tiktok_client_key;
        if (data.tiktok_client_secret) document.getElementById('tiktokClientSecret').value = data.tiktok_client_secret;
        if (data.facebook_app_id) document.getElementById('facebookAppId').value = data.facebook_app_id;
        if (data.facebook_app_secret) document.getElementById('facebookAppSecret').value = data.facebook_app_secret;
        if (data.google_client_id) document.getElementById('googleClientId').value = data.google_client_id;
        if (data.google_client_secret) document.getElementById('googleClientSecret').value = data.google_client_secret;
        if (data.backend_base_url && backendBaseUrlInput) backendBaseUrlInput.value = data.backend_base_url;
      }
    } catch (err) {
      console.warn("Could not fetch API keys on load:", err);
    }

    // Prefill backend_base_url from IndexedDB settings
    try {
      const base = await db.getSetting('backend_base_url');
      if (base && backendBaseUrlInput && !backendBaseUrlInput.value) backendBaseUrlInput.value = base;
    } catch (e) {
      console.warn('Could not load backend_base_url from settings:', e);
    }
  } else {
    document.getElementById('view-admin').style.display = 'none';
    document.getElementById('view-login').style.display = 'block';
    document.body.classList.add('logged-out');
  }
});

// Toggle between sign-in and sign-up forms
toggleToSignUp?.addEventListener('click', (e) => {
  e.preventDefault();
  emailSignInForm?.classList.add('hidden');
  emailSignUpForm?.classList.remove('hidden');
  authError.style.display = 'none';
});

toggleToSignIn?.addEventListener('click', (e) => {
  e.preventDefault();
  emailSignUpForm?.classList.add('hidden');
  emailSignInForm?.classList.remove('hidden');
  authError.style.display = 'none';
});
