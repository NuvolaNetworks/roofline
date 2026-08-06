# Roofline

Construction CRM (lead → closed job), built as an AMOS-hosted vertical app.
Own domain, own end-user auth, deployed and governed through AMOS.

Demo scope: 7-stage pipeline with role-scoped visibility (rep/manager/admin),
job files with communication threads + measurement reports, lead intake,
contacts, SRS-priced catalogue, commission view, production calendar.
Integrations (SRS Roof Hub, GAF QuickMeasure, QuickBooks, Google Calendar,
signing) are represented in Settings and stubbed at their exact seams.

Demo persistence is node:sqlite in-container (resets on redeploy); phase 2 is
AMOS managed Postgres + platform end-user auth.
