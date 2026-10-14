# How Veyrafy protects your clients' invoices

*For ERP partners and their clients (prepared for Innosolv). October 2026. This describes the code
in the repository; the "Evidence" column says how each statement is known.*

**Evidence labels:**
- **Code:** in the code;
- **Test:** proven by an automated test run on every release;
- **Deployment:** must be confirmed on the live service;
- **Provider:** a hosting provider's stated control, to be confirmed with the provider.

## What Veyrafy does with ERP data

| Statement | Evidence |
|---|---|
| Veyrafy only **reads** from the ERP: suppliers, items, orders, receipts and bills. It never writes, creates records or approves payments. | Code, Test |
| It uses a read-only API user that the ERP issues to it, limited to one company or outlet. The ERP owner can revoke it at any time. | Code (the login is issued and revoked in the ERP) |
| ERP login credentials are encrypted (AES-256-GCM), never shown again, never written to logs, and can be rotated. | Code, Test |
| ERP calls cannot be redirected into private networks, and credentials never follow a redirect to another address. | Code, Test |

## Where invoices are kept, and how

| Statement | Evidence |
|---|---|
| Each client has its **own** Veyrafy service, database and file storage. One client's data is not reachable from another's. | Deployment (each client is a separate service) |
| Every stored invoice file is **encrypted by Veyrafy** with its own key (AES-256-GCM), wrapped by a master key that only that client's service holds. Production refuses to start without it. | Code, Test |
| A changed or swapped file is refused rather than shown. | Test |
| Invoices are read on Veyrafy's own server (text extraction and OCR). No decrypted copy is written to disk. | Code, Test |
| **No AI service receives invoices by default.** An optional Google AI reader exists; production refuses it unless it is deliberately switched on after the client agrees in writing. | Code, Test |
| Connections to Veyrafy use HTTPS. Session cookies are secure and HTTP-only. | Code; HTTPS at the edge: Deployment |
| The database connection is encrypted in production; an unencrypted connection is refused. | Code, Test; the certificate check level: Deployment |
| Extracted invoice values (amounts, lines, supplier details) are stored in the database **without** Veyrafy's own encryption. They are protected by the database provider's disk encryption. | Provider (to be confirmed) |
| Database and file backups are the hosting provider's. Their schedule, retention and encryption must be confirmed. | Provider, Deployment |

## Who can see what

| Statement | Evidence |
|---|---|
| Every user signs in individually. Roles limit what each can do. Every page and API call checks them. | Code, Test |
| Every action (upload, view of a file, answer, deletion, ERP sync) is recorded with who did it and when. | Code, Test |
| The audit trail cannot be edited by the application once the least-privilege database role is in use. | Code, Test; role in use: Deployment |
| Veyrafy staff with hosting access can technically reach the service and its keys. There is no independent key-management service yet. | Code (stated limit) |

## Retention and deletion

| Statement | Evidence |
|---|---|
| The client chooses: keep originals, delete after successful checking, or delete after N days. | Code, Test |
| Deleting an original removes the file, any copy attached to an ERP record, and the text read from it. The checked values, the decision and the audit history stay. | Code, Test |
| Deleted data stays in backups until those backups expire. | Provider (retention to be confirmed) |
| Erasing a complete invoice record, or all of one person's data, is not yet available. | Code (stated limit) |

## What we do not claim

- **Not certified.** Veyrafy is not certified (ISO 27001, SOC 2 or similar).
- **Not independently tested yet.** No independent security audit or penetration test has been
  done. One is planned before wider rollout.
- **No absolute guarantee.** Encryption reduces risk; it does not make any system immune to
  attack.

## What we offer

- **A data processing agreement** with each client: invoice checking only, no other use, no
  sale, no model training, deletion on exit, breach notification, audit rights.
- **Self-hosting:** Veyrafy ships as one container image and can run in the client's own
  environment, so invoices never leave it.
- **A pilot:** one outlet, read-only, with the audit log shared with the ERP partner.

Questions about any statement: the evidence for each "Code" and "Test" item can be shown on
request (docs/SECURITY.md §22–23).
