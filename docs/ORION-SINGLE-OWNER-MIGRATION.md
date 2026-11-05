# Orion personal site: Workers-only migration scope

Last reviewed 2026-11-06. Cloud Run remains active until all retained
paths and integrations are migrated, not merely the Gateway deployed.

Keep and migrate:
- Public posts/visitor comments, resume, project portfolio and photos
- Owner login, super_admin access, sessions, Google/OAuth
- Second Brain and its actively used public MCP/OAuth endpoints
- AI tools and AI conversation history under /api/chat/ai
- Media uploading and R2 browsing, footprints, fitness, Todo, period,
  menus, other personal dashboard modules, administrative editing
- Recoverable full database backup and restore, with old JSON export intact
- Todo reminder scheduling via native Worker Cron

Retire in this change:
- Human chat rooms/private messages/Socket.IO presence, sockets and UI
- Stripe checkout and payment webhooks, not existing account records
- Gateway returns HTTP 410 for retired human-chat and payments endpoints
  when the matching replacement frontend is live. AI history stays.

PDF replacement:
- Browser Run quickAction(pdf) in Gateway, fixed public Orion resume URL
- Validated user/slug, language, paper size, page limit, no arbitrary host
- Separate expensive rate-limit bucket and verified PDF magic bytes
- PDF_BROWSER_CUTOVER = 0 initially; x-orion-pdf-canary: 1 tests it.
  Switch only after a real rendered PDF passes acceptance.
- Keep old Cloud Run Puppeteer fallback during validation.

Cron and Browser Run Free:
- Workers Free: 5 Cron Triggers/account, 100k requests/day, 10ms CPU.
- Browser Run: 10 minutes/day browser time, rate limits apply.
- Existing GCP todo reminder Scheduler job is PAUSED. Native Cron will
  retain paused behavior until an explicitly controlled activation.

Before Cloud Run shutdown:
- Port live login/Google OAuth and Second Brain MCP/OAuth clients/tokens
- Port private CMS/data write methods, comments and uploaded media
- Port retained AI tools with streaming/provider access and tests
- Replace mongodump backup with a verifiably restorable snapshot in R2
- Move Todo reminders without retroactive notification floods
- Verify complete route/method/webhook coverage and a zero-upstream period
- Rehearse rollback, disable reversibly, only then remove GCP resources
