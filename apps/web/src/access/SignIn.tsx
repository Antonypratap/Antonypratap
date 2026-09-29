import { useId, useState, type FormEvent } from 'react';
import { Button, Logo } from '../design-system';
import { SignInError, demoSignIn, signIn } from './session';
import styles from './SignIn.module.css';

/**
 * Shown in place of any product route until the server says someone is signed in. On success the
 * requested route (still in the address bar) simply renders. Demo environments also offer the
 * demo PIN (checked by the server, never here); production has no demo sign-in at all.
 */
export function SignIn({ demo, notice }: { demo: boolean; notice: string | null }) {
  const [mode, setMode] = useState<'pin' | 'password'>(demo ? 'pin' : 'password');
  return (
    <main className={styles.page}>
      <a href="#top" className={styles.home} aria-label="Veyra home">
        <Logo />
      </a>
      {mode === 'pin' ? <PinForm notice={notice} /> : <PasswordForm notice={notice} />}
      {demo && (
        <button
          type="button"
          className={styles.back}
          onClick={() => setMode(mode === 'pin' ? 'password' : 'pin')}
        >
          {mode === 'pin' ? 'Sign in with email instead' : 'Use the demo PIN instead'}
        </button>
      )}
      <a href="#top" className={styles.back}>
        Back to the homepage
      </a>
    </main>
  );
}

function PasswordForm({ notice }: { notice: string | null }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof SignInError ? err.message : 'Sign-in did not work. Try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.panel}
      onSubmit={(e) => void submit(e)}
      aria-labelledby={`${id}-title`}
      noValidate
    >
      <h1 id={`${id}-title`} className={styles.title}>
        Sign in to Veyra
      </h1>
      <p className={styles.text}>{notice ?? 'Use the email address your administrator set up.'}</p>
      <label className={styles.label} htmlFor={`${id}-email`}>
        Email
      </label>
      <input
        id={`${id}-email`}
        className={styles.input}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        required
      />
      <label className={styles.label} htmlFor={`${id}-password`}>
        Password
      </label>
      <input
        id={`${id}-password`}
        className={styles.input}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        required
      />
      <p id={`${id}-error`} className={styles.error} role="alert">
        {error ?? ''}
      </p>
      <Button type="submit" size="lg" arrow className={styles.submit} disabled={busy}>
        Sign in
      </Button>
    </form>
  );
}

function PinForm({ notice }: { notice: string | null }) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await demoSignIn(pin);
    } catch (err) {
      setError(err instanceof SignInError ? err.message : 'That PIN isn’t correct.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.panel}
      onSubmit={(e) => void submit(e)}
      aria-labelledby={`${id}-title`}
      noValidate
    >
      <h1 id={`${id}-title`} className={styles.title}>
        See Veyra in action
      </h1>
      <p className={styles.text}>{notice ?? 'Enter the demo PIN to open the Veyra workspace.'}</p>
      <label className={styles.label} htmlFor={`${id}-pin`}>
        PIN
      </label>
      <input
        id={`${id}-pin`}
        className={styles.pin}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        placeholder="••••"
        value={pin}
        onChange={(e) => {
          setPin(e.target.value.replace(/\D/g, '').slice(0, 12));
          setError(null);
        }}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        autoFocus
      />
      <p id={`${id}-error`} className={styles.error} role="alert">
        {error ?? ''}
      </p>
      <Button type="submit" size="lg" arrow className={styles.submit} disabled={busy}>
        Open demo
      </Button>
    </form>
  );
}
