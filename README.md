# Roofline

Construction CRM (lead → closed job), built as an AMOS-hosted vertical app.
Own domain, own end-user auth, deployed and governed through AMOS.

Demo scope: 7-stage pipeline with role-scoped visibility (rep/manager/admin),
job files with communication threads + measurement reports, lead intake,
contacts, SRS-priced catalogue, commission view, production calendar.
Integrations (SRS Roof Hub, GAF QuickMeasure, QuickBooks, Google Calendar,
signing) are represented in Settings and stubbed at their exact seams.

Local demo persistence is node:sqlite. When `DATABASE_URL` is set (the
platform injects the managed Postgres URL in production) the same query
surface uses that database, and a database that already has users is not
reseeded. Platform end-user auth is the sign-in path.
