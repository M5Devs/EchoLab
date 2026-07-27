import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { toast } from 'sonner';
import {
  auth,
  signInWithGoogle,
  signInWithGithub,
  signInWithEmail,
  signUpWithEmail,
  signInAsGuest,
  resetPassword,
  linkGuestToGoogle,
  linkGuestToGithub,
  signOut,
  saveCloudProject,
  listCloudProjects,
  deleteCloudProject,
  sharePreset as fbSharePreset,
  uploadAudioFile,
} from '../firebase';

export type CloudProject = {
  id: string;
  name: string;
  effects: object;
  playlists: object[];
  metadata: object | null;
  duration?: number;
  createdAt?: { seconds: number };
  updatedAt?: { seconds: number };
};

type FirebaseContextType = {
  user: User | null;
  authLoading: boolean;
  isAnonymous: boolean;
  cloudProjects: CloudProject[];
  cloudLoading: boolean;

  login: () => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  loginWithGithub: () => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  loginAsGuest: () => Promise<void>;
  sendReset: (email: string) => Promise<void>;
  upgradeGuest: (provider: 'google' | 'github') => Promise<void>;
  logout: () => Promise<void>;

  saveToCloud: (data: {
    name: string;
    effects: object;
    playlists: object[];
    metadata: object | null;
    duration?: number;
  }) => Promise<void>;
  refreshCloudProjects: () => Promise<void>;
  deleteFromCloud: (projectId: string) => Promise<void>;
  sharePreset: (name: string, effects: object) => Promise<string | null>;
  uploadAudio: (filename: string, blob: Blob) => Promise<string | null>;
};

const FirebaseContext = createContext<FirebaseContextType | null>(null);

export function FirebaseProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]               = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
  const [cloudLoading, setCloudLoading]   = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (user && !user.isAnonymous) refreshCloudProjects();
    else setCloudProjects([]);
  }, [user]);

  // ── helpers ────────────────────────────────────────────────────────────────

  const wrap = useCallback(
    async (fn: () => Promise<unknown>, successMsg?: string) => {
      try {
        await fn();
        if (successMsg) toast.success(successMsg);
      } catch (err: any) {
        if (err.code !== 'auth/popup-closed-by-user') {
          toast.error(err.message ?? 'Something went wrong');
        }
      }
    },
    []
  );

  // ── auth actions ───────────────────────────────────────────────────────────

  const loginWithGoogle  = useCallback(() => wrap(signInWithGoogle,  'Signed in with Google ✓'),  [wrap]);
  const loginWithGithub  = useCallback(() => wrap(signInWithGithub,  'Signed in with GitHub ✓'),  [wrap]);
  const loginAsGuest     = useCallback(() => wrap(signInAsGuest,     'Browsing as guest'),         [wrap]);

  const loginWithEmail = useCallback(
    (email: string, password: string) =>
      wrap(() => signInWithEmail(email, password), 'Signed in ✓'),
    [wrap]
  );

  const registerWithEmail = useCallback(
    (email: string, password: string, displayName: string) =>
      wrap(() => signUpWithEmail(email, password, displayName), 'Account created ✓'),
    [wrap]
  );

  const sendReset = useCallback(
    (email: string) => wrap(() => resetPassword(email), 'Reset email sent ✓'),
    [wrap]
  );

  const upgradeGuest = useCallback(
    (provider: 'google' | 'github') =>
      wrap(
        () => (provider === 'google' ? linkGuestToGoogle() : linkGuestToGithub()),
        'Account upgraded ✓'
      ),
    [wrap]
  );

  const logout = useCallback(async () => {
    await signOut();
    toast.success('Signed out');
  }, []);

  // ── cloud ──────────────────────────────────────────────────────────────────

  const refreshCloudProjects = useCallback(async () => {
    if (!user || user.isAnonymous) return;
    setCloudLoading(true);
    try {
      const projects = await listCloudProjects(user.uid);
      setCloudProjects(projects as CloudProject[]);
    } catch (err) {
      console.error('Failed to load cloud projects', err);
    } finally {
      setCloudLoading(false);
    }
  }, [user]);

  const saveToCloud = useCallback(
    async (data: { name: string; effects: object; playlists: object[]; metadata: object | null; duration?: number }) => {
      if (!user || user.isAnonymous) { toast.error('Sign in to save to the cloud'); return; }
      try {
        await saveCloudProject(user.uid, data);
        await refreshCloudProjects();
        toast.success('Saved to cloud ☁️');
      } catch (err) {
        toast.error('Cloud save failed');
      }
    },
    [user, refreshCloudProjects]
  );

  const deleteFromCloud = useCallback(
    async (projectId: string) => {
      if (!user) return;
      try {
        await deleteCloudProject(user.uid, projectId);
        await refreshCloudProjects();
        toast.success('Deleted from cloud');
      } catch {
        toast.error('Delete failed');
      }
    },
    [user, refreshCloudProjects]
  );

  const sharePreset = useCallback(
    async (name: string, effects: object): Promise<string | null> => {
      if (!user || user.isAnonymous) { toast.error('Sign in to share presets'); return null; }
      try {
        const id = await fbSharePreset(user.uid, name, effects);
        const link = `${window.location.origin}${import.meta.env.BASE_URL}?preset=${id}`;
        await navigator.clipboard.writeText(link);
        toast.success('Preset link copied!');
        return id;
      } catch {
        toast.error('Failed to share preset');
        return null;
      }
    },
    [user]
  );

  const uploadAudio = useCallback(
    async (filename: string, blob: Blob): Promise<string | null> => {
      if (!user || user.isAnonymous) { toast.error('Sign in to upload audio'); return null; }
      try {
        const url = await uploadAudioFile(user.uid, filename, blob);
        toast.success('Audio uploaded ☁️');
        return url;
      } catch {
        toast.error('Upload failed');
        return null;
      }
    },
    [user]
  );

  return (
    <FirebaseContext.Provider
      value={{
        user,
        authLoading,
        isAnonymous: user?.isAnonymous ?? false,
        cloudProjects,
        cloudLoading,
        login: loginWithGoogle,
        loginWithGoogle,
        loginWithGithub,
        loginWithEmail,
        registerWithEmail,
        loginAsGuest,
        sendReset,
        upgradeGuest,
        logout,
        saveToCloud,
        refreshCloudProjects,
        deleteFromCloud,
        sharePreset,
        uploadAudio,
      }}
    >
      {children}
    </FirebaseContext.Provider>
  );
}

export function useFirebase() {
  const ctx = useContext(FirebaseContext);
  if (!ctx) throw new Error('useFirebase must be used within a FirebaseProvider');
  return ctx;
}
