import { signOut } from '../access/session';
import { Logo } from '../design-system';
import { hrefFor } from '../product/router';
import styles from './Ops.module.css';

/** A Veyra operator account opened the customer application: it has no access there. */
export function OperatorNotice() {
  return (
    <div className={styles.denied}>
      <Logo />
      <h1>You are signed in as a Veyra operator</h1>
      <p>Operator accounts manage Veyra; they do not see customer invoices.</p>
      <a className={styles.link} href={hrefFor({ name: 'ops', section: 'overview', id: null })}>
        Open Veyra Operations
      </a>
      <button type="button" className={styles.linkButton} onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
