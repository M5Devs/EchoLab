import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInAnonymously,
  signOut as firebaseSignOut,
  linkWithPopup,
  updateProfile,
  type Auth,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  getDocs,
  deleteDoc,
  addDoc,
  serverTimestamp,
  query,
  orderBy,
  type Firestore,
} from 'firebase/firestore';


/**
 * EchoLab is offline-first: the studio, FX rack and export are entirely local
 * and must work with no configuration at all. Firebase only powers the optional
 * cloud sync, so when it is not configured we degrade instead of crashing.
 *
 * Without this guard, a missing `.env` makes `getAuth()` throw
 * `auth/invalid-api-key` while this module is still being evaluated — before
 * React mounts — which produces a blank white page with no error boundary and
 * no way out for the user.
 */
export const CLOUD_DISABLED_MESSAGE = 'Cloud sync is disabled (running in local offline mode)';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** A value is usable when it is a non-empty string and not an example placeholder. */
const isUsable = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  !/^(your_|your-|undefined|null$)/i.test(value.trim());

/**
 * `apiKey` and `projectId` are the two fields Firebase needs to construct the
 * app, auth and Firestore clients. The rest are optional for our usage.
 */
function buildFirebase(): { app: FirebaseApp; auth: Auth; db: Firestore } | null {
  if (!isUsable(config.apiKey) || !isUsable(config.projectId)) return null;
  try {
    const app = initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
      storageBucket: config.storageBucket,
      messagingSenderId: config.messagingSenderId,
      appId: config.appId,
    });
    const auth = getAuth(app);
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
    return { app, auth, db };
  } catch (error) {
    console.warn('[Firebase] Initialisation failed; continuing in local offline mode.', error);
    return null;
  }
}

const firebase = buildFirebase();

/** False when the app is running fully local with no cloud backend. */
export const isFirebaseConfigured: boolean = firebase !== null;

/** Safe handles: `null` (never a throwing stub) when unconfigured. */
export const app: FirebaseApp | null = firebase?.app ?? null;
export const auth: Auth | null = firebase?.auth ?? null;
export const db: Firestore | null = firebase?.db ?? null;

function requireAuth(): Auth {
  if (!auth) throw new Error(CLOUD_DISABLED_MESSAGE);
  return auth;
}

function requireDb(): Firestore {
  if (!db) throw new Error(CLOUD_DISABLED_MESSAGE);
  return db;
}


// ── Providers ─────────────────────────────────────────────────────────────────

// Constructed lazily: the provider classes touch app-level config and have no
// business being instantiated when there is no backend to sign in to.
const googleProvider = firebase ? new GoogleAuthProvider() : null;
const githubProvider = firebase ? new GithubAuthProvider() : null;
// ── Auth methods ──────────────────────────────────────────────────────────────

export const signInWithGoogle    = () => signInWithPopup(requireAuth(), googleProvider!);
export const signInWithGithub    = () => signInWithPopup(requireAuth(), githubProvider!);
export const signInAsGuest       = () => signInAnonymously(requireAuth());

export const signInWithEmail     = (email: string, password: string) =>
  signInWithEmailAndPassword(requireAuth(), email, password);

export const signUpWithEmail     = (email: string, password: string, displayName: string) =>
  createUserWithEmailAndPassword(requireAuth(), email, password).then(async (cred) => {
    await updateProfile(cred.user, { displayName });
    return cred;
  });

export const resetPassword       = (email: string) =>
  sendPasswordResetEmail(requireAuth(), email);

// link anonymous account to a real provider
export const linkGuestToGoogle   = () => linkWithPopup(requireAuth().currentUser!, googleProvider!);
export const linkGuestToGithub   = () => linkWithPopup(requireAuth().currentUser!, githubProvider!);

export const signOut             = () => firebaseSignOut(requireAuth());

// ── Firestore helpers ─────────────────────────────────────────────────────────

export async function saveCloudProject(
  uid: string,
  projectData: {
    name: string;
    effects: object;
    playlists: object[];
    metadata: object | null;
    duration?: number;
  }
) {
  const ref = collection(requireDb(), 'users', uid, 'projects');
  const docRef = await addDoc(ref, {
    ...projectData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function listCloudProjects(uid: string) {
  const ref = collection(requireDb(), 'users', uid, 'projects');
  const q = query(ref, orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }));
}

export async function deleteCloudProject(uid: string, projectId: string) {
  await deleteDoc(doc(requireDb(), 'users', uid, 'projects', projectId));
}

export async function sharePreset(uid: string, presetName: string, effects: object) {
  const ref = collection(requireDb(), 'sharedPresets');
  const docRef = await addDoc(ref, {
    name: presetName,
    effects,
    authorUid: uid,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}



