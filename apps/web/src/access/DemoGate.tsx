import { useId, useState, type FormEvent } from 'react';
import { Button, Logo } from '../design-system';
import { grantDemoAccess, isDemoPin } from './demoAccess';
import styles from './DemoGate.module.css';

/**
 * Shown in place of any product route until the demo PIN is entered in this browser session.
 * On success the requested route (still in the address bar) simply renders.
 */
export function DemoGate({ onGranted }: { onGranted: () => void }) {
  const id = useId();
  const [pin, setPin] = useState('');
  const [wrong, setWrong] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (isDemoPin(pin)) {
      grantDemoAccess();
      onGranted();
    } else {
      setWrong(true);
      setPin('');
    }
  };

  return (
    <main className={styles.page}>
      <a href="#top" className={styles.home} aria-label="Veyra home">
        <Logo />
      </a>
      <form className={styles.panel} onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
        <h1 id={`${id}-title`} className={styles.title}>
          See Veyra in action
        </h1>
        <p className={styles.text}>Enter the demo PIN to open the Veyra workspace.</p>
        <label className={styles.label} htmlFor={`${id}-pin`}>
          PIN
        </label>
        <input
          id={`${id}-pin`}
          className={styles.pin}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]{4}"
          placeholder="••••"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 4));
            setWrong(false);
          }}
          aria-invalid={wrong}
          aria-describedby={wrong ? `${id}-error` : undefined}
          autoFocus
        />
        <p id={`${id}-error`} className={styles.error} role="alert">
          {wrong ? 'That PIN isn’t correct.' : ''}
        </p>
        <Button type="submit" size="lg" arrow className={styles.submit}>
          Open demo
        </Button>
      </form>
      <a href="#top" className={styles.back}>
        Back to the homepage
      </a>
    </main>
  );
}
