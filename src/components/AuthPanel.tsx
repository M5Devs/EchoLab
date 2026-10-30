import { useState } from 'react';
import { useFirebase } from '../hooks/useFirebase';
import { CLOUD_DISABLED_MESSAGE } from '../firebase';
import { LogOut, Loader2, Mail, Github, Chrome, User, UserPlus, RotateCcw, CloudOff } from 'lucide-react';

type View = 'menu' | 'email-login' | 'email-register' | 'reset';

export function AuthPanel() {
  const {
    user, authLoading, isAnonymous, isOfflineMode,
    loginWithGoogle, loginWithGithub,
    loginWithEmail, registerWithEmail,
    loginAsGuest, sendReset, upgradeGuest, logout,
  } = useFirebase();

  const [open, setOpen]       = useState(false);
  const [view, setView]       = useState<View>('menu');
  const [email, setEmail]     = useState('');
  const [password, setPass]   = useState('');
  const [name, setName]       = useState('');
  const [loading, setLoading] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setLoading(true);
    await fn();
    setLoading(false);
    setOpen(false);
    setView('menu');
  };

  // No backend configured: make it obvious that cloud features are simply
  // unavailable, rather than offering a sign-in that can never succeed.
  if (isOfflineMode) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground bg-white/5 border border-white/10 px-3 py-1.5 rounded-full"
        title={CLOUD_DISABLED_MESSAGE}
      >
        <CloudOff className="w-3.5 h-3.5" />
        <span className="hidden lg:block">Local only</span>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="w-8 h-8 flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (user && !isAnonymous) {
    return (
      <div className="flex items-center gap-2">
        {user.photoURL ? (
          <img src={user.photoURL} alt={user.displayName ?? 'User'}
            className="w-7 h-7 rounded-full border border-white/20 ring-2 ring-primary/30" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs font-bold text-primary">
            {(user.displayName ?? user.email ?? 'U')[0].toUpperCase()}
          </div>
        )}
        <span className="text-xs text-muted-foreground hidden lg:block max-w-[100px] truncate">
          {user.displayName ?? user.email}
        </span>
        <button onClick={logout}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
          title="Sign out">
          <LogOut className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // guest banner — upgrade prompt
  if (user && isAnonymous) {
    return (
      <div className="relative">
        <button onClick={() => setOpen(!open)}
          className="flex items-center gap-2 text-xs bg-yellow-500/10 hover:bg-yellow-500/20 border border-yellow-500/30 px-3 py-1.5 rounded-full transition-all text-yellow-400">
          <User className="w-3.5 h-3.5" />
          Guest — save your work?
        </button>
        {open && (
          <div className="absolute right-0 top-10 z-50 w-56 bg-background border border-white/10 rounded-xl shadow-xl p-3 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground mb-1">Link your guest account</p>
            <SocialBtn icon={<Chrome className="w-4 h-4" />} label="Continue with Google"
              onClick={() => run(upgradeGuest.bind(null, 'google'))} />
            <SocialBtn icon={<Github className="w-4 h-4" />} label="Continue with GitHub"
              onClick={() => run(upgradeGuest.bind(null, 'github'))} />
            <hr className="border-white/10" />
            <button onClick={logout} className="text-xs text-muted-foreground hover:text-red-400 text-left px-2 py-1">
              Sign out
            </button>
          </div>
        )}
      </div>
    );
  }

  // not signed in
  return (
    <div className="relative">
      <button onClick={() => { setOpen(!open); setView('menu'); }}
        className="flex items-center gap-2 text-xs bg-white/5 hover:bg-white/10 border border-white/10 hover:border-primary/50 px-3 py-1.5 rounded-full transition-all text-muted-foreground hover:text-white">
        <User className="w-3.5 h-3.5" />
        Sign in
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-50 w-64 bg-background border border-white/10 rounded-xl shadow-xl p-4 flex flex-col gap-2">

          {view === 'menu' && (
            <>
              <p className="text-xs font-medium text-center mb-1">Sign in to EchoLab</p>

              <SocialBtn icon={<Chrome className="w-4 h-4" />} label="Continue with Google"
                onClick={() => run(loginWithGoogle)} disabled={loading} />
              <SocialBtn icon={<Github className="w-4 h-4" />} label="Continue with GitHub"
                onClick={() => run(loginWithGithub)} disabled={loading} />
              <div className="flex items-center gap-2 my-1">
                <hr className="flex-1 border-white/10" />
                <span className="text-[10px] text-muted-foreground">or</span>
                <hr className="flex-1 border-white/10" />
              </div>

              <SocialBtn icon={<Mail className="w-4 h-4" />} label="Sign in with Email"
                onClick={() => setView('email-login')} />
              <SocialBtn icon={<UserPlus className="w-4 h-4" />} label="Create account"
                onClick={() => setView('email-register')} />

              <hr className="border-white/10 my-1" />

              <button onClick={() => run(loginAsGuest)}
                className="text-xs text-muted-foreground hover:text-white text-center py-1 transition-colors">
                Continue as guest
              </button>
            </>
          )}

          {view === 'email-login' && (
            <>
              <BackBtn onClick={() => setView('menu')} />
              <p className="text-xs font-medium mb-1">Sign in with email</p>
              <Input placeholder="Email" type="email" value={email} onChange={setEmail} />
              <Input placeholder="Password" type="password" value={password} onChange={setPass} />
              <ActionBtn label={loading ? 'Signing in…' : 'Sign in'}
                onClick={() => run(() => loginWithEmail(email, password))} disabled={loading} />
              <button onClick={() => setView('reset')}
                className="text-[11px] text-muted-foreground hover:text-white text-center mt-1">
                Forgot password?
              </button>
            </>
          )}

          {view === 'email-register' && (
            <>
              <BackBtn onClick={() => setView('menu')} />
              <p className="text-xs font-medium mb-1">Create account</p>
              <Input placeholder="Display name" value={name} onChange={setName} />
              <Input placeholder="Email" type="email" value={email} onChange={setEmail} />
              <Input placeholder="Password (6+ chars)" type="password" value={password} onChange={setPass} />
              <ActionBtn label={loading ? 'Creating…' : 'Create account'}
                onClick={() => run(() => registerWithEmail(email, password, name))} disabled={loading} />
            </>
          )}

          {view === 'reset' && (
            <>
              <BackBtn onClick={() => setView('email-login')} />
              <p className="text-xs font-medium mb-1">Reset password</p>
              <Input placeholder="Email" type="email" value={email} onChange={setEmail} />
              <ActionBtn label={loading ? 'Sending…' : 'Send reset email'}
                onClick={() => run(() => sendReset(email))} disabled={loading} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── small sub-components ──────────────────────────────────────────────────────

function SocialBtn({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-xs border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left disabled:opacity-50">
      {icon}{label}
    </button>
  );
}

function Input({ placeholder, type = 'text', value, onChange }: { placeholder: string; type?: string; value: string; onChange: (v: string) => void }) {
  return (
    <input type={type} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg text-xs bg-white/5 border border-white/10 text-white placeholder:text-muted-foreground focus:outline-none focus:border-primary/50" />
  );
}

function ActionBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full py-2 rounded-lg text-xs bg-primary/20 hover:bg-primary/30 border border-primary/30 text-primary font-medium transition-colors disabled:opacity-50">
      {label}
    </button>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-[11px] text-muted-foreground hover:text-white flex items-center gap-1 mb-1">
      <RotateCcw className="w-3 h-3" /> Back
    </button>
  );
}
