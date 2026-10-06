import { useEffect, type ReactNode } from 'react';
import { Logo } from '../design-system';
import { CONTACT_PHONE, CONTACT_PHONE_HREF, WEBSITE_ADDRESS } from './host';
import { LEGAL, LEGAL_PATHS, legalComplete, type LegalPage } from './legal';
import styles from './LegalPages.module.css';

/**
 * The privacy notice and the terms of use (veyrafy.com/privacy, /terms; the same on every
 * Veyrafy address). They describe what the software actually does: what the 5 Invoice Challenge
 * keeps, for how long, who processes it. A client's own Veyrafy is governed by its agreement.
 */
const who = () => LEGAL.entity ?? 'Veyrafy';
const date = () =>
  new Date(`${LEGAL.updated}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

function Contact() {
  return (
    <>
      {LEGAL.privacyEmail ? (
        <>
          e-mail <a href={`mailto:${LEGAL.privacyEmail}`}>{LEGAL.privacyEmail}</a> or call{' '}
        </>
      ) : (
        'call '
      )}
      <a href={CONTACT_PHONE_HREF}>{CONTACT_PHONE}</a>
    </>
  );
}

function Frame({ page, children }: { page: LegalPage; children: ReactNode }) {
  const title = page === 'privacy' ? 'Privacy notice' : 'Terms of use';
  useEffect(() => {
    document.title = `${title} · Veyrafy`;
  }, [title]);
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <a href={WEBSITE_ADDRESS} aria-label="Veyrafy home">
          <Logo />
        </a>
        <nav className={styles.nav} aria-label="Legal">
          <a href={LEGAL_PATHS.privacy} aria-current={page === 'privacy' ? 'page' : undefined}>
            Privacy
          </a>
          <a href={LEGAL_PATHS.terms} aria-current={page === 'terms' ? 'page' : undefined}>
            Terms
          </a>
        </nav>
      </header>
      <main className={styles.main} id="main">
        {!legalComplete() && (
          <p className={styles.draft} role="note">
            Draft: the legal details of this text are being confirmed.
          </p>
        )}
        <h1 className={styles.h1}>{title}</h1>
        <p className={styles.updated}>Last updated {date()}</p>
        {children}
      </main>
    </div>
  );
}

export function PrivacyNotice() {
  return (
    <Frame page="privacy">
      <p className={styles.lede}>
        This notice explains what {who()} does with information on veyrafy.com, the Veyrafy demo and
        the 5 Invoice Challenge. If your company uses its own Veyrafy (yourcompany.veyrafy.com),
        your company’s agreement with us governs that data.
      </p>

      <h2>Who we are</h2>
      <p>
        {who()}
        {LEGAL.address ? `, ${LEGAL.address}` : ''}. For anything in this notice, <Contact />.
      </p>

      <h2>The 5 Invoice Challenge</h2>
      <h3>What we receive</h3>
      <ul>
        <li>
          <strong>The invoices you upload</strong> (up to five) and, if you add it, the record your
          accounting or ERP system holds for them. Invoices can contain other people’s details, such
          as a supplier’s contact name, phone number or bank account.
        </li>
        <li>
          <strong>Your details</strong>, when you give them to see the full results: your work
          e-mail and company name, and your name and phone number if you add them.
        </li>
        <li>
          <strong>When you agreed</strong> to how your invoices are processed, and which reading
          service was named to you at that moment.
        </li>
      </ul>
      <h3>Why</h3>
      <ul>
        <li>To read the invoices, check them and show you the results and the evidence.</li>
        <li>To e-mail you the report, and to follow up with you about it and about Veyrafy.</li>
        <li>To keep the challenge fair and safe: one challenge per company, and limits per day.</li>
      </ul>
      <p>
        We do not sell your information, and we show your invoices to no one outside Veyrafy and the
        providers named below.
      </p>
      <h3>Who reads the documents</h3>
      <p>
        Your invoices are read and checked on Veyrafy’s servers. If, before you upload, the
        challenge tells you that <strong>Google Gemini</strong> reads the documents, they are also
        sent to Google’s Gemini service for reading, under Google’s terms for that service; it
        returns what is printed and Veyrafy checks every value itself. If it does not say so, no AI
        service outside Veyrafy reads them.
      </p>
      <h3>How long we keep it</h3>
      <ul>
        <li>
          <strong>Invoices, your system’s record and what was read from them:</strong> deleted 24
          hours after you see your full results, or after 30 days if you never open them.
        </li>
        <li>
          <strong>The report</strong> is e-mailed to you as a PDF; your copy is yours to keep.
        </li>
        <li>
          <strong>The numbers of your challenge</strong> (invoices checked, how many needed
          attention, their value) and <strong>your details</strong> are kept so we can follow up,
          until you ask us to delete them.
        </li>
      </ul>

      <h2>The demo and this website</h2>
      <p>
        The demo is a shared workspace with sample invoices: please do not upload real documents to
        it (use the 5 Invoice Challenge instead). This website itself sets no cookies.
      </p>

      <h2>Cookies</h2>
      <ul>
        <li>
          <code>veyra_challenge</code>: keeps your challenge open in your browser, for at most 30
          days.
        </li>
        <li>
          <code>veyra_challenge_used</code>: remembers that this browser has taken the challenge,
          for one year.
        </li>
        <li>On the demo, a sign-in cookie while you are signed in.</li>
      </ul>
      <p>None of these is used for advertising or tracking across websites.</p>

      <h2>Your internet address and logs</h2>
      <p>
        Your internet address is used, for that day only, to limit how many challenges one
        connection can start. It is not stored with your challenge. Our servers keep technical logs
        (for example, the time of a request and its result) for security and fault-finding.
      </p>

      <h2>Who processes it for us</h2>
      <ul>
        <li>Our hosting provider (Railway), which runs Veyrafy’s servers and database.</li>
        <li>Our e-mail delivery provider (Resend), which sends the report e-mail.</li>
        <li>Google (Gemini), only when named to you before you upload, as above.</li>
      </ul>
      <p>
        These providers may process information outside India. They act on our instructions only.
      </p>

      <h2>Security</h2>
      <p>
        Each challenge is kept in its own separate workspace; one company never reaches another’s
        invoices. Connections are encrypted (HTTPS), and the private link to your results is stored
        only in a form that cannot be read back.
      </p>

      <h2>Your rights</h2>
      <p>
        Under India’s Digital Personal Data Protection Act, 2023 you can ask us for a summary of the
        personal data we hold about you, have it corrected or deleted, withdraw your consent, and
        nominate someone to exercise these rights for you. To do any of this, or to raise a
        grievance, <Contact />. If you are not satisfied with our answer, you can complain to the
        Data Protection Board of India.
      </p>

      <h2>Children</h2>
      <p>Veyrafy is for businesses. It is not meant for anyone under 18.</p>

      <h2>Changes</h2>
      <p>
        We update this notice when what we do changes, and show the date at the top. Questions:{' '}
        <Contact />.
      </p>
    </Frame>
  );
}

export function TermsOfUse() {
  return (
    <Frame page="terms">
      <p className={styles.lede}>
        These terms apply when you use veyrafy.com, the Veyrafy demo or the 5 Invoice Challenge. A
        client’s own Veyrafy is governed by its agreement with {who()}.
      </p>

      <h2>The 5 Invoice Challenge</h2>
      <ul>
        <li>
          It is free. You can check up to five invoices, once per company, browser and work e-mail.
        </li>
        <li>
          By uploading, you confirm that you are authorised by your company to share these invoices
          and records with Veyrafy for this purpose.
        </li>
        <li>
          Your invoices are handled as described in the{' '}
          <a href={LEGAL_PATHS.privacy}>privacy notice</a>, and deleted 24 hours after you see your
          results.
        </li>
      </ul>

      <h2>What the results are</h2>
      <p>
        The results are produced automatically from what is printed on your invoices and from the
        records you provide. Veyrafy shows the evidence for each finding and never guesses a value
        it could not read, but a reading or a record can still be wrong. The results are not
        accounting, tax or legal advice: check a finding against the documents before you act on it.
        Veyrafy never pays, approves or changes anything in your systems.
      </p>

      <h2>Fair use</h2>
      <p>Please do not:</p>
      <ul>
        <li>upload documents you are not entitled to share, or files meant to cause harm;</li>
        <li>use automated tools to start challenges or upload in bulk;</li>
        <li>try to reach anyone else’s data, or to get around the limits;</li>
        <li>use the challenge to copy Veyrafy or to build a competing product.</li>
      </ul>
      <p>We may refuse or stop a challenge that does not follow these terms.</p>

      <h2>Availability</h2>
      <p>
        The demo and the challenge are offered as they are. They may be limited each day, changed or
        stopped at any time.
      </p>

      <h2>Ownership</h2>
      <p>
        Your documents remain yours; you allow Veyrafy to process them only to run your challenge.
        The Veyrafy software, website and report design belong to {who()}.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, {who()} is not liable for decisions made on the results, or
        for indirect losses, arising from the free demo or challenge.
      </p>

      <h2>Law</h2>
      <p>
        These terms are governed by the laws of India
        {LEGAL.jurisdiction ? `, and the courts at ${LEGAL.jurisdiction} have jurisdiction` : ''}.
        Questions: <Contact />.
      </p>
    </Frame>
  );
}

export function LegalPageView({ page }: { page: LegalPage }) {
  return page === 'privacy' ? <PrivacyNotice /> : <TermsOfUse />;
}
