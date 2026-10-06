# Veyrafy on Railway: setup runbook

This guide is written for the account owner, not for developers. Follow it top to bottom. Every
step says **what to click or type** and **what you should see**. Nothing here needs code changes.

> **Never** paste a real password or PIN into GitHub, an e-mail, a chat or this document. You type
> them only into Railway (variables) or into the Railway shell (accounts), and store them in your
> password manager.

---

## 1. What you are building

| Address | Railway service | What it is | Database |
|---|---|---|---|
| `https://veyrafy.com` | **veyrafy-site** | The public website: homepage, *Client login*, *Request access* | none |
| `https://demo.veyrafy.com` | **veyrafy-demo** | The public demo, with sample data only (PIN sign-in) | its own PostgreSQL |
| `https://toit.veyrafy.com` | **veyrafy-toit** | Toit's real Veyrafy (e-mail and password sign-in) | its own PostgreSQL |

- All three services run **the same code** (one Docker image). A setting decides which one a
  service is. There is no `vite preview` anywhere in production.
- Each client gets **its own service and its own database**. Toit's data can never be seen from
  the demo or from another client's address.
- A future client (say *northwind*) is simply one more service like **veyrafy-toit**, at
  `northwind.veyrafy.com`. The website needs no change for it.

---

## 2. Before you start

- Access to the Railway project (the one that already has the Web, API and Postgres services).
- Access to the place where the `veyrafy.com` domain's DNS is managed (your registrar or
  Cloudflare).
- A password manager, to store the demo PIN and your admin password.
- About 60–90 minutes.

The existing services keep running until step 9, so the current site stays up while you build.

---

## 3. Create the three services (same code, three roles)

Do this three times, once per row in section 1 (names: `veyrafy-site`, `veyrafy-demo`,
`veyrafy-toit`).

1. In the Railway project: **New → GitHub Repo →** choose this repository.
2. Open the new service → **Settings**:
   - **Service name:** as in the table.
   - **Source → Branch:** the branch you deploy (ask your developer which one; today
     `claude/veyra-repo-planning-iszu4w`).
   - **Build → Builder:** *Dockerfile*. **Dockerfile path:** `apps/api/Dockerfile`.
     (Alternatively add the variable `RAILWAY_DOCKERFILE_PATH=apps/api/Dockerfile`.)
   - **Deploy → Start command:** leave **empty** (the image already knows how to start).
   - **Deploy → Healthcheck path:** `/api/v1/health/live`.
   - **Deploy → Restart policy:** *On failure*. Do not enable "sleep when idle" / serverless.
3. Do not add a domain yet (section 7).

**You should see:** three new services. They may fail to start until their variables are set
(section 5); that is expected.

---

## 4. Databases and storage (demo and Toit only)

For **veyrafy-demo** and for **veyrafy-toit**, separately:

1. **New → Database → PostgreSQL.** Rename it `postgres-demo` or `postgres-toit`, so it is obvious
   which client it belongs to. **Never share one database between two services.**
2. Open the app service (**veyrafy-demo** or **veyrafy-toit**) → **Settings → Volumes → Add
   volume**, mount path **`/var/lib/veyra`**, size 5 GB to start. This keeps uploaded invoice files
   when the service restarts or is redeployed.
   **Without it, every deploy deletes every uploaded invoice file** while the database still lists
   them: invoices then show "Original document · File missing". Veyrafy logs `document files are
   missing from storage` at start when this happens. Add the volume, then upload the same files
   again: each is reattached to its invoice.

**veyrafy-site** needs **no** database and **no** volume.

---

## 5. Variables (Settings → Variables)

Railway sets `PORT` and `RAILWAY_GIT_COMMIT_SHA` by itself; do not add them.

### 5.1 veyrafy-site (the website)

| Variable | Value |
|---|---|
| `VEYRA_SITE_ONLY` | `true` |
| `VEYRA_ENV` | `production` |

That is all. The website never connects to a database, so **do not** give it `DATABASE_URL`.

### 5.2 veyrafy-demo (the public demo)

| Variable | Value |
|---|---|
| `VEYRA_ENV` | `staging` |
| `VEYRA_DEMO` | `true` |
| `VEYRA_DEMO_PIN` | **a PIN you choose**: 6 to 12 digits (see 5.4) |
| `VEYRA_ORGANIZATION_NAME` | `Veyrafy Demo` |
| `VEYRA_PUBLIC_ORIGIN` | `https://demo.veyrafy.com` |
| `DATABASE_URL` | `${{postgres-demo.DATABASE_URL}}` (Railway fills it in; type it exactly like this) |
| `VEYRA_ERP` | `fake` |
| `VEYRA_TRUST_PROXY` | `1` |
| `VEYRA_MIGRATE_ON_START` | `false` |

The demo's sample business is a fictional brewery (DEMO.md §10). Nothing needs to be set for it;
`VEYRA_DEMO_BUSINESS=manufacturing` would switch back to the older steel and parts business.

**The AI reader (optional, demo only for now).** With `VEYRA_AI_READER=gemini` and `GEMINI_API_KEY`
(from Google AI Studio, added as a Railway variable, never committed or pasted anywhere else), each
uploaded invoice is read by Gemini. Gemini only copies the printed text; Veyrafy re-parses and checks
every value, and falls back to the local reader if Gemini cannot be reached. `VEYRA_AI_MODEL` picks
the model (default `gemini-2.5-pro`); a comma-separated list adds backups (`main-model,backup-model`),
used at once when the main one is busy. ERP → Business system → *Test the reader* checks them. Because invoices then go to Google, a production instance
refuses to start with it unless `VEYRA_AI_ALLOW_PRODUCTION=true`, which is set only once that client
has agreed in writing.

### 5.3 veyrafy-toit (Toit's real Veyrafy)

| Variable | Value |
|---|---|
| `VEYRA_ENV` | `production` |
| `VEYRA_ORGANIZATION_NAME` | `Toit` |
| `VEYRA_PUBLIC_ORIGIN` | `https://toit.veyrafy.com` |
| `DATABASE_URL` | `${{postgres-toit.DATABASE_PUBLIC_URL}}?sslmode=require` |
| `VEYRA_ERP` | `fake` |
| `VEYRA_TRUST_PROXY` | `1` |

- **No** `VEYRA_DEMO` and **no** `VEYRA_DEMO_PIN`: production refuses to start with a demo, and
  Toit signs in with e-mail and password only.
- `DATABASE_URL` must end in **`?sslmode=require`**: production refuses a database connection
  that is not encrypted. Use exactly the value above (the database's TLS address). Do **not** add
  `VEYRA_DB_REQUIRE_TLS=false`.
- The ERP is the built-in one for now. The iBEAM connection comes later, as its own project.

### 5.4 Choosing and storing the demo PIN

1. Let your password manager generate a random number of 8 digits (not a birthday, not
   `12345678`).
2. Save it in the password manager as "Veyrafy demo PIN".
3. Paste it as the value of `VEYRA_DEMO_PIN` in **veyrafy-demo** only.
4. Give it only to people you want to show the demo to. The PIN is never shown on the website, in
   the code or in the logs.

---

## 6. Database set-up on every release (demo and Toit)

In **veyrafy-demo** and **veyrafy-toit** → **Settings → Deploy → Pre-deploy command**:

```
node --import tsx apps/api/src/cli/migrate.ts
```

This brings the database up to date **before** each new version starts. Running it again is safe.

Then **Deploy** each of the three services.

**You should see:** each service turns green (*Active*). If one stays red, open **Deployments →
View logs**. The first lines name the missing or wrong variable (never its value); fix it in
Variables and deploy again.

---

## 7. Addresses (domains)

### 7.1 In Railway

- **veyrafy-demo → Settings → Networking → Custom domain:** `demo.veyrafy.com`.
- **veyrafy-toit → Settings → Networking → Custom domain:** `toit.veyrafy.com`.
- **veyrafy-site:** `veyrafy.com` is attached to your **current** web service today. Leave it
  there until section 9, then move it.

For each domain Railway shows a DNS record to create (type and value). Keep that page open.

### 7.2 At your DNS provider (you do this; nothing in the code changes DNS)

| Name | Type | Value |
|---|---|---|
| `demo` | CNAME | the target Railway shows for `demo.veyrafy.com` |
| `toit` | CNAME | the target Railway shows for `toit.veyrafy.com` |
| `veyrafy.com` (apex) | as Railway shows (CNAME flattening / ALIAS / ANAME) | only at the switch-over in section 9 |

- Do **not** create a wildcard (`*`) record now. It is possible later, for many clients, but it
  is not part of this setup.
- DNS changes can take a few minutes to an hour. Railway issues the HTTPS certificate on its own
  once the record is visible.

---

## 8. Accounts: sign-in for Toit (and for the Veyrafy team)

Accounts are created **only from the service's shell**. The password is typed by you and never
appears on the screen, in the logs or anywhere in the code.

1. Install the Railway command line tool on your computer (railway.com/docs → CLI) and run
   `railway login`, then `railway link` and choose this project.
2. Open a shell **inside Toit's service**:

   ```
   railway ssh --service veyrafy-toit
   ```

3. Create the Toit administrator (replace the e-mail and name with the real person's; the
   password is asked for, and typing is hidden):

   ```
   read -rs P && printf '%s\n' "$P" | npm run users -w @veyra/api -- create --email name@toit.example --name "Full Name" --role ADMIN && unset P
   ```

   Type the password (at least 12 characters; use your password manager), press Enter.
   **You should see** a line confirming the account (e-mail, role). The password is not shown.
4. **Optional:** a Veyrafy operator account, for the Veyrafy Operations console of this instance
   (plans, usage, system health; it cannot see Toit's invoices). The same command with
   `--role VEYRA_ADMIN` and a Veyrafy e-mail address.
5. Check: `npm run users -w @veyra/api -- list` shows the accounts (never passwords).
6. Type `exit`.

The Toit administrator can then add Toit's other users from inside the app. Each user gets their
own account; accounts are never shared.

The demo needs no accounts: visitors use the demo PIN.

---

## 9. Check, then switch veyrafy.com over

### 9.1 Check the new services first

Until DNS points at them, open the Railway-generated address of each service (Settings →
Networking → *Generate domain*, e.g. `veyrafy-toit-production.up.railway.app`):

| Open | You should see |
|---|---|
| demo's address | The demo sign-in (PIN). Your PIN opens the inbox. A wrong PIN is refused. |
| toit's address | "Toit" above an e-mail sign-in. Your admin account opens the inbox. |
| site's address `/api/v1/health` | `{"ok":true,"site":true,"version":"…"}` |

Before DNS, the Toit and demo sign-in may say the request came from the wrong address, because
`VEYRA_PUBLIC_ORIGIN` names the final address. That is correct and safe. Checking the page loads
is enough; sign in once the real address works (section 7).

### 9.2 Switch

1. Remove `veyrafy.com` from the **old** web service's custom domains, and add it to
   **veyrafy-site** (Settings → Networking). Update the apex DNS record if Railway shows a new
   target.
2. Open `https://veyrafy.com`. **You should see** the homepage with **Client login** and
   **Request access** in the menu, and *See Veyrafy in action* leading to `demo.veyrafy.com`.
3. When everything works for a day, **remove the old Web and API services** (and the old database
   only after confirming nothing on it is needed).

---

## 10. Which version is live?

Open any of:

- `https://veyrafy.com/api/v1/health`
- `https://demo.veyrafy.com/api/v1/health`
- `https://toit.veyrafy.com/api/v1/health`

`"version"` is the Git commit Railway deployed (e.g. `"version":"a1b2c3d…"`). Compare it with the
latest commit on GitHub, or with Railway → **Deployments**. If the homepage looks old, this tells
you whether the new version is actually deployed. After a deploy, reload with Ctrl/Cmd + Shift + R.

---

## 11. Changing credentials (rotation)

| What | How |
|---|---|
| **Demo PIN** | Generate a new one (5.4), replace `VEYRA_DEMO_PIN` in veyrafy-demo, **Deploy**. The old PIN stops working at once. |
| **A user's password** | `railway ssh --service veyrafy-toit`, then `read -rs P && printf '%s\n' "$P" \| npm run users -w @veyra/api -- set-password --email name@toit.example && unset P` |
| **Sign someone out everywhere** | Same shell: `npm run users -w @veyra/api -- revoke-sessions --email name@toit.example` |
| **Someone leaves** | Same shell: `npm run users -w @veyra/api -- disable --email name@toit.example` (their sessions end; their history stays in the audit trail) |
| **Database password** | Railway → postgres-toit → rotate credentials. `DATABASE_URL` follows automatically (it is a reference); redeploy veyrafy-toit. |

Do these at once if a password or PIN may have been seen by someone else.

---

## 12. Adding the next client (later)

1. Repeat sections 3–6 for a new service `veyrafy-<name>` with its **own** PostgreSQL and volume,
   `VEYRA_ORGANIZATION_NAME` and `VEYRA_PUBLIC_ORIGIN=https://<name>.veyrafy.com`.
2. Add the domain `<name>.veyrafy.com` (section 7) and the CNAME record.
3. Create their administrator (section 8).

The website's *Client login* already sends `<name>` to `https://<name>.veyrafy.com`; no website
change or release is needed. An address with no service behind it shows "This Veyrafy address
isn't set up."

---

## 13. If something is wrong

| Symptom | Likely cause | What to do |
|---|---|---|
| Service stays red; log says "configuration is not valid" | A variable is missing or wrong | The log names it. Fix it in Variables, deploy again. |
| Log says "DATABASE_URL must set sslmode" | Toit's database address is not encrypted | Use exactly `${{postgres-toit.DATABASE_PUBLIC_URL}}?sslmode=require` (5.3). |
| "This Veyrafy address isn't set up." | The address has no instance behind it | Check the domain is attached to the right service (7.1) and the DNS record (7.2). |
| Sign-in says the request came from the wrong address | `VEYRA_PUBLIC_ORIGIN` does not match the address you opened | Set it to exactly `https://<address>` (no trailing slash). |
| The homepage looks old | The new version is not deployed yet, or the browser cached the old one | Check `/api/v1/health` "version" (section 10); hard-reload. |
| Demo PIN refused | The PIN in Railway differs from yours | Replace `VEYRA_DEMO_PIN` (section 11) and use the new one. |

---

## 14. The 5 Invoice Challenge (prospects try Veyrafy on their own invoices)

The challenge page is `/5-invoice-challenge`. It runs on **veyrafy-demo**; the homepage's main
button ("Check 5 of your invoices free") opens it there directly, and `veyrafy.com/5-invoice-challenge`
explains it with a button to the same place.

The prospect's journey: tick one consent box and drop in invoices (no form first), optionally add
their records and confirm their GSTIN (pre-filled from the invoices), watch the checks, and see the
headline result (invoices checked, value, what needs attention, the kinds of findings). Their work
e-mail and company name open the full results, the evidence and the PDF report, and the report
e-mail is sent then, with the report attached as a PDF. Until then the server sends the numbers
only. Up to 5 invoices per challenge.

**What the invoices are compared with.** "Compare with your system" takes the record the prospect's
own accounting or ERP system holds for the invoices: an Excel or CSV export of their purchase
register or bills (one row per invoice line; common column names such as "Bill No", "Party",
"Qty", "Taxable Value" are recognised; templates at `/api/v1/challenge/templates/Veyrafy-Invoice-Register.xlsx`
and `.csv`), the same in JSON, or an ERP goods-receipt export. Each invoice is then compared line
by line: item, quantity, rate, amount, GST and total. Without it, each invoice is verified on its
own (calculations, GST, GSTINs, duplicates). The systems named on the page (Tally, Zoho Books, SAP
and others) are ones to export from; there is no live connection to them in the challenge.

**One challenge each, then it ends.** A browser that has started a challenge cannot start another
(a cookie kept for a year), and a work e-mail opens the results of one challenge only. Once the
full results are shown, the invoices and their readings are deleted after
`VEYRA_CHALLENGE_RESULTS_HOURS` (24 by default); the numbers stay, and the page then says the
challenge is complete. The earlier address `/10-invoice-challenge` still opens it.

If the demo does not have `VEYRA_CHALLENGE=true`, the page says the challenge "isn't open right
now" and gives the contact number. Each prospect's invoices
and records are kept in their own separate workspace on the demo's volume. They are never mixed
with the demo's sample data or with another prospect's invoices, and they are deleted after the
retention period.

In **veyrafy-demo → Variables**, add:

| Variable | Value |
|---|---|
| `VEYRA_CHALLENGE` | `true` |
| `VEYRA_CHALLENGE_RETENTION_DAYS` | `30` (the longest invoices are kept, if the results are never opened) |
| `VEYRA_CHALLENGE_RESULTS_HOURS` | `24` (how long invoices are kept after the results are shown) |
| `VEYRA_CHALLENGE_DAILY_LIMIT` | `20` (new challenges per day, all prospects together; the notify address is told once when it is reached) |
| `VEYRA_CHALLENGE_PER_ADDRESS` | `3` (new challenges per internet connection per day, so one person cannot use up the day) |
| `VEYRA_CHALLENGE_READER` | `ai` or `local`: `local` keeps prospects' documents on Veyrafy's server even when the demo reads with Gemini |
| `VEYRA_PUBLIC_ORIGIN` | `https://demo.veyrafy.com` (links in the e-mail point here) |
| `VEYRA_BOOKING_URL` | optional: your booking page, e.g. a Calendly 15-minute link |
| `VEYRA_CHALLENGE_NOTIFY_EMAIL` | optional: where you are told about completions and walkthrough requests |
| `VEYRA_EMAIL_PROVIDER` | `resend` to send the follow-up e-mail (otherwise nothing is sent, and the Control Centre shows "not configured") |
| `VEYRA_EMAIL_API_KEY` | your Resend API key (type it in Railway only) |
| `VEYRA_EMAIL_FROM` | e.g. `Veyrafy <reports@veyrafy.com>` (a domain verified in Resend) |

**Privacy notice and terms.** `/privacy` and `/terms` (on every Veyrafy address; linked from the
consent box and the website footer) describe what the challenge keeps, for how long and who
processes it. Fill in the legal entity, registered address, grievance e-mail and jurisdiction in
`apps/web/src/site/legal.ts` before opening the challenge publicly: until then both pages say
they are a draft. Have them reviewed by your counsel.

**Its own service (recommended once traffic grows).** The challenge can run on a separate Railway
service from the same image, so heavy scans never slow the demo: copy veyrafy-demo's variables
to a new service with its own PostgreSQL and volume and its own address, then point the
challenge address (`CHALLENGE_ADDRESS` in `apps/web/src/site/host.ts`) at it and switch the
challenge off on the demo. Not done yet; it needs a new domain name and a release.

**Before you switch it on**, decide how invoices are read. If the demo has the AI reader on
(`VEYRA_AI_READER=gemini`), the prospect is told that Google Gemini reads their documents, and must
agree to that before uploading. To keep prospects' documents on Veyrafy's own server, leave the
AI reader off; the local reader is used instead (slower on scans and photos, and less accurate on
them).

**You should see:**
- `https://demo.veyrafy.com/5-invoice-challenge` shows the challenge.
- After a test challenge, it appears in the Control Centre under **5 Invoice Challenge**, with its
  results, report downloads and walkthrough requests. You can update the follow-up status there;
  every change is recorded in the Audit Log.
