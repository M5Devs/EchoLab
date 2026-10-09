import { initializeApp } from 'firebase/app';
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
} from 'firebase/firestore';


const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});


// ── Providers ─────────────────────────────────────────────────────────────────

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();
// ── Auth methods ──────────────────────────────────────────────────────────────

export const signInWithGoogle    = () => signInWithPopup(auth, googleProvider);
export const signInWithGithub    = () => signInWithPopup(auth, githubProvider);
export const signInAsGuest       = () => signInAnonymously(auth);

export const signInWithEmail     = (email: string, password: string) =>
  signInWithEmailAndPassword(auth, email, password);

export const signUpWithEmail     = (email: string, password: string, displayName: string) =>
  createUserWithEmailAndPassword(auth, email, password).then(async (cred) => {
    await updateProfile(cred.user, { displayName });
    return cred;
  });

export const resetPassword       = (email: string) =>
  sendPasswordResetEmail(auth, email);

// link anonymous account to a real provider
export const linkGuestToGoogle   = () => linkWithPopup(auth.currentUser!, googleProvider);
export const linkGuestToGithub   = () => linkWithPopup(auth.currentUser!, githubProvider);

export const signOut             = () => firebaseSignOut(auth);

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
  const ref = collection(db, 'users', uid, 'projects');
  const docRef = await addDoc(ref, {
    ...projectData,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function listCloudProjects(uid: string) {
  const ref = collection(db, 'users', uid, 'projects');
  const q = query(ref, orderBy('updatedAt', 'desc'));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as object) }));
}

export async function deleteCloudProject(uid: string, projectId: string) {
  await deleteDoc(doc(db, 'users', uid, 'projects', projectId));
}

export async function sharePreset(uid: string, presetName: string, effects: object) {
  const ref = collection(db, 'sharedPresets');
  const docRef = await addDoc(ref, {
    name: presetName,
    effects,
    authorUid: uid,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}


