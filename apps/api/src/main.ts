/**
 * The one entry point of the Veyrafy image (`npm run start -w @veyra/api`, the Docker CMD):
 *
 * - `VEYRA_SITE_ONLY=true`: the public website (veyrafy.com). Static files and headers only; the
 *   application (database, storage, ERP, sign-in, jobs) is never loaded, let alone started.
 * - otherwise: a Veyrafy instance (API, job worker and, in production, the web app on the same
 *   origin), e.g. demo.veyrafy.com or toit.veyrafy.com, each with its own database.
 *
 * The switch is read here, before any other module is loaded.
 */
const siteOnly = process.env.VEYRA_SITE_ONLY;
if (siteOnly !== undefined && siteOnly !== '' && siteOnly !== 'true' && siteOnly !== 'false') {
  console.error(
    'Veyrafy configuration is not valid:\n  - VEYRA_SITE_ONLY is not valid (true or false)',
  );
  process.exit(1);
}
await (siteOnly === 'true' ? import('./site-main') : import('./app-main'));

export {};
