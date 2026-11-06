# Cloud Run route retirement inventory

Generated from source by scripts/audit-orion-route-ownership.py.
STATIC CODE DISCOVERY ONLY: dynamic OAuth SDK routes, body shape, runtime
traffic, effective RBAC and frontend dynamic URLs require separate audits.

## Summary

- Express route declarations: 152
- Static frontend service endpoint references: 47
- Direct imports from old server source into Core Worker: 1
- Legacy/default or unverified: 133
- Worker canary but default Cloud Run: 7
- Eligible Worker read with possible fallback: 11
- Explicit Worker-live: 1

These numbers are a lower bound; do NOT turn off Cloud Run based on this file.

## Core Worker directly imports these old server modules

| Core source | Old-server source |
| --- | --- |
| cloudflare/bananaboom-worker/src/app.js | utils/r2Reference.js |

## Special routes not counted by the simple Express scan

- /authorize, /token, /register, /revoke: services/brain/oauth.js (MCP PKCE/OAuth)
- /.well-known/oauth-*: services/brain/oauth.js (discovery)
- /api/brain/sync/mcp: routes/brainSync.js (MCP protocol + auth)
- /api/brain/sync/v1/*: routes/brainSync.js (knowledge sync)
- /api/brain/*: routes/brain.js and services/brain/* (memory, imports, export, restore)
- /socket.io: retired human chat; Gateway blocks endpoint

## Express routes detected

| Method | Path | Static owner status | Implementation |
| --- | --- | --- | --- |
| DELETE | /api/audit/:id | legacy-default-or-unverified | routes/audit.js |
| DELETE | /api/audit/prune/old | legacy-default-or-unverified | routes/audit.js |
| DELETE | /api/chat/ai | legacy-default-or-unverified | routes/chat.js |
| DELETE | /api/chat/ai/conversation/:sessionId | legacy-default-or-unverified | routes/chat.js |
| DELETE | /api/fitness/:id | legacy-default-or-unverified | routes/fitness.js |
| DELETE | /api/footprints/:id | legacy-default-or-unverified | routes/footprint.js |
| DELETE | /api/menu/:id | legacy-default-or-unverified | routes/menu.js |
| DELETE | /api/period/:id | legacy-default-or-unverified | routes/period.js |
| DELETE | /api/permissions/:key | legacy-default-or-unverified | routes/permissions.js |
| DELETE | /api/photos/:id | legacy-default-or-unverified | routes/photos.js |
| DELETE | /api/posts/:id | worker-canary-legacy-default | routes/posts.js |
| DELETE | /api/projects/:id | legacy-default-or-unverified | routes/projects.js |
| DELETE | /api/resumes | legacy-default-or-unverified | routes/resume.js |
| DELETE | /api/roles/:name | legacy-default-or-unverified | routes/roles.js |
| DELETE | /api/todo/:id | legacy-default-or-unverified | routes/todo.js |
| DELETE | /api/upload | legacy-default-or-unverified | routes/upload.js |
| GET | /api/audit | legacy-default-or-unverified | routes/audit.js |
| GET | /api/audit/options | legacy-default-or-unverified | routes/audit.js |
| GET | /api/backup | legacy-default-or-unverified | routes/backup.js |
| GET | /api/chat/ai | legacy-default-or-unverified | routes/chat.js |
| GET | /api/chat/ai/conversations | legacy-default-or-unverified | routes/chat.js |
| GET | /api/cloudinary/config | legacy-default-or-unverified | routes/cloudinary.js |
| GET | /api/cloudinary/resources | legacy-default-or-unverified | routes/cloudinary.js |
| GET | /api/cloudinary/signature | legacy-default-or-unverified | routes/cloudinary.js |
| GET | /api/cloudinary/usage | legacy-default-or-unverified | routes/cloudinary.js |
| GET | /api/comments/:postId | legacy-default-or-unverified | routes/comments.js |
| GET | /api/comments/reply/:commentId | legacy-default-or-unverified | routes/comments.js |
| GET | /api/cron/trigger | legacy-default-or-unverified | routes/scheduler.js |
| GET | /api/external/daily-list | legacy-default-or-unverified | routes/external.js |
| GET | /api/external/recipe/detail | legacy-default-or-unverified | routes/external.js |
| GET | /api/fitness | legacy-default-or-unverified | routes/fitness.js |
| GET | /api/fitness/photos | legacy-default-or-unverified | routes/fitness.js |
| GET | /api/fitness/stats | legacy-default-or-unverified | routes/fitness.js |
| GET | /api/footprints | worker-canary-legacy-default | routes/footprint.js |
| GET | /api/footprints/:id | worker-canary-legacy-default | routes/footprint.js |
| GET | /api/homepage | worker-read-with-possible-legacy-fallback | routes/homepage.js |
| GET | /api/homepage/likes | worker-read-with-possible-legacy-fallback | routes/homepage.js |
| GET | /api/homepage/logs | worker-read-with-possible-legacy-fallback | routes/homepage.js |
| GET | /api/homepage/projects | worker-read-with-possible-legacy-fallback | routes/homepage.js |
| GET | /api/menu | worker-read-with-possible-legacy-fallback | routes/menu.js |
| GET | /api/menu/draw | legacy-default-or-unverified | routes/menu.js |
| GET | /api/period | legacy-default-or-unverified | routes/period.js |
| GET | /api/permission-requests | legacy-default-or-unverified | routes/permissionRequest.js |
| GET | /api/permissions | legacy-default-or-unverified | routes/permissions.js |
| GET | /api/photos | worker-read-with-possible-legacy-fallback | routes/photos.js |
| GET | /api/posts | worker-read-with-possible-legacy-fallback | routes/posts.js |
| GET | /api/posts/:id | legacy-default-or-unverified | routes/posts.js |
| GET | /api/posts/likes/:id | legacy-default-or-unverified | routes/posts.js |
| GET | /api/posts/private/posts | legacy-default-or-unverified | routes/posts.js |
| GET | /api/projects | worker-read-with-possible-legacy-fallback | routes/projects.js |
| GET | /api/projects/:id | legacy-default-or-unverified | routes/projects.js |
| GET | /api/resumes | worker-read-with-possible-legacy-fallback | routes/resume.js |
| GET | /api/resumes/export-pdf | legacy-default-or-unverified | routes/resume.js |
| GET | /api/resumes/list | worker-read-with-possible-legacy-fallback | routes/resume.js |
| GET | /api/resumes/users | legacy-default-or-unverified | routes/resume.js |
| GET | /api/roles | legacy-default-or-unverified | routes/roles.js |
| GET | /api/tags | worker-read-with-possible-legacy-fallback | routes/tags.js |
| GET | /api/todo | legacy-default-or-unverified | routes/todo.js |
| GET | /api/todo/done/:id | legacy-default-or-unverified | routes/todo.js |
| GET | /api/upload/list | legacy-default-or-unverified | routes/upload.js |
| GET | /api/upload/object | legacy-default-or-unverified | routes/upload.js |
| GET | /api/upload/r2/usage | legacy-default-or-unverified | routes/upload.js |
| GET | /api/users | legacy-default-or-unverified | routes/users.js |
| GET | /api/users/ai-status | worker-canary-legacy-default | routes/users.js |
| GET | /api/users/profile | worker-canary-legacy-default | routes/users.js |
| POST | /api/ai/ask | legacy-default-or-unverified | routes/ai.js |
| POST | /api/ai/ask-life | legacy-default-or-unverified | routes/ai.js |
| POST | /api/ai/ask-life/stream | legacy-default-or-unverified | routes/ai.js |
| POST | /api/ai/generate-sentences | legacy-default-or-unverified | routes/ai.js |
| POST | /api/ai/recipe-recommend | legacy-default-or-unverified | routes/ai.js |
| POST | /api/auth/firebase-verify | legacy-default-or-unverified | routes/auth.js |
| POST | /api/auth/send-otp | legacy-default-or-unverified | routes/auth.js |
| POST | /api/auth/subscribe | legacy-default-or-unverified | routes/auth.js |
| POST | /api/auth/verify-otp | legacy-default-or-unverified | routes/auth.js |
| POST | /api/auth/verify-secret | legacy-default-or-unverified | routes/auth.js |
| POST | /api/backup/database | worker-live | routes/backup.js |
| POST | /api/chat/ai/save | legacy-default-or-unverified | routes/chat.js |
| POST | /api/cloudinary/delete | legacy-default-or-unverified | routes/cloudinary.js |
| POST | /api/comments/:postId | legacy-default-or-unverified | routes/comments.js |
| POST | /api/comments/reply/:commentId | legacy-default-or-unverified | routes/comments.js |
| POST | /api/debater/audience-comment | legacy-default-or-unverified | routes/debater.js |
| POST | /api/debater/evaluate | legacy-default-or-unverified | routes/debater.js |
| POST | /api/debater/generate-personas | legacy-default-or-unverified | routes/debater.js |
| POST | /api/debater/generate-speech | legacy-default-or-unverified | routes/debater.js |
| POST | /api/debater/generate-turn | legacy-default-or-unverified | routes/debater.js |
| POST | /api/drawing/generate | legacy-default-or-unverified | routes/drawing.js |
| POST | /api/fitness | legacy-default-or-unverified | routes/fitness.js |
| POST | /api/footprints | legacy-default-or-unverified | routes/footprint.js |
| POST | /api/homepage/likes/:id/add | legacy-default-or-unverified | routes/homepage.js |
| POST | /api/homepage/likes/:id/batch-add | legacy-default-or-unverified | routes/homepage.js |
| POST | /api/homepage/likes/:id/remove | legacy-default-or-unverified | routes/homepage.js |
| POST | /api/menu | legacy-default-or-unverified | routes/menu.js |
| POST | /api/menu/confirm/:id | legacy-default-or-unverified | routes/menu.js |
| POST | /api/menu/recommend | legacy-default-or-unverified | routes/menu.js |
| POST | /api/period | legacy-default-or-unverified | routes/period.js |
| POST | /api/permission-requests | legacy-default-or-unverified | routes/permissionRequest.js |
| POST | /api/permission-requests/role | legacy-default-or-unverified | routes/permissionRequest.js |
| POST | /api/permissions | legacy-default-or-unverified | routes/permissions.js |
| POST | /api/photos | legacy-default-or-unverified | routes/photos.js |
| POST | /api/posts | worker-canary-legacy-default | routes/posts.js |
| POST | /api/posts/likes/:id/add | legacy-default-or-unverified | routes/posts.js |
| POST | /api/posts/likes/:id/remove | legacy-default-or-unverified | routes/posts.js |
| POST | /api/projects | legacy-default-or-unverified | routes/projects.js |
| POST | /api/projects/ai-rewrite/stream | legacy-default-or-unverified | routes/projects.js |
| POST | /api/projects/import-github/generate-cover | legacy-default-or-unverified | routes/projects.js |
| POST | /api/projects/import-github/preview | legacy-default-or-unverified | routes/projects.js |
| POST | /api/projects/import-github/stream | legacy-default-or-unverified | routes/projects.js |
| POST | /api/reading/chapter-guide | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/chat | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/flashcards | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/learning-plan | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/quiz | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/study-guide | legacy-default-or-unverified | routes/reading.js |
| POST | /api/reading/summary | legacy-default-or-unverified | routes/reading.js |
| POST | /api/resumes/set-default | legacy-default-or-unverified | routes/resume.js |
| POST | /api/roles | legacy-default-or-unverified | routes/roles.js |
| POST | /api/rpg/action | legacy-default-or-unverified | routes/rpg.js |
| POST | /api/rpg/initialize | legacy-default-or-unverified | routes/rpg.js |
| POST | /api/todo | legacy-default-or-unverified | routes/todo.js |
| POST | /api/todo/done/:id | legacy-default-or-unverified | routes/todo.js |
| POST | /api/todo/routine/:id/check | legacy-default-or-unverified | routes/todo.js |
| POST | /api/todo/routine/:id/test | legacy-default-or-unverified | routes/todo.js |
| POST | /api/upload | legacy-default-or-unverified | routes/upload.js |
| POST | /api/upload/presign | legacy-default-or-unverified | routes/upload.js |
| POST | /api/users | legacy-default-or-unverified | routes/users.js |
| POST | /api/users/logout | legacy-default-or-unverified | routes/users.js |
| POST | /api/users/reset-by-secret | legacy-default-or-unverified | routes/users.js |
| POST | /api/users/reset-password | legacy-default-or-unverified | routes/users.js |
| POST | /api/users/signin | legacy-default-or-unverified | routes/users.js |
| POST | /api/voice2map/enrich-maps | legacy-default-or-unverified | routes/voice2map.js |
| POST | /api/voice2map/enrich-search | legacy-default-or-unverified | routes/voice2map.js |
| POST | /api/voice2map/generate | legacy-default-or-unverified | routes/voice2map.js |
| PUT | /api/footprints/:id | legacy-default-or-unverified | routes/footprint.js |
| PUT | /api/menu/:id | legacy-default-or-unverified | routes/menu.js |
| PUT | /api/period/:id | legacy-default-or-unverified | routes/period.js |
| PUT | /api/permission-requests/:id/approve | legacy-default-or-unverified | routes/permissionRequest.js |
| PUT | /api/permission-requests/:id/reject | legacy-default-or-unverified | routes/permissionRequest.js |
| PUT | /api/permissions/:key | legacy-default-or-unverified | routes/permissions.js |
| PUT | /api/photos/:id | legacy-default-or-unverified | routes/photos.js |
| PUT | /api/photos/reorder | legacy-default-or-unverified | routes/photos.js |
| PUT | /api/posts/:id | worker-canary-legacy-default | routes/posts.js |
| PUT | /api/projects/:id | legacy-default-or-unverified | routes/projects.js |
| PUT | /api/resumes | legacy-default-or-unverified | routes/resume.js |
| PUT | /api/roles/:name | legacy-default-or-unverified | routes/roles.js |
| PUT | /api/users/:id | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/:id/permissions | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/:id/role | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/complete-profile | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/fitness-goal | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/grant-vip | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/password | legacy-default-or-unverified | routes/users.js |
| PUT | /api/users/revoke-vip | legacy-default-or-unverified | routes/users.js |

## Frontend static call sites

| Endpoint suffix | Service file |
| --- | --- |
| /ai/recipe-recommend | services/featureService.ts |
| /audit/options | services/authService.ts |
| /audit/prune/old | services/authService.ts |
| /auth/firebase-verify | services/authService.ts |
| /auth/send-otp | services/authService.ts |
| /auth/subscribe | services/authService.ts |
| /auth/verify-otp | services/authService.ts |
| /backup/database | services/authService.ts |
| /chat/ai | services/featureService.ts |
| /chat/ai/conversations | services/featureService.ts |
| /chat/ai/save | services/featureService.ts |
| /cloudinary/config | services/media.ts |
| /cloudinary/delete | services/contentService.ts |
| /cloudinary/resources | services/contentService.ts |
| /cloudinary/signature | services/media.ts |
| /cloudinary/usage | services/featureService.ts |
| /fitness | services/featureService.ts |
| /footprints | services/featureService.ts |
| /homepage/likes | services/contentService.ts |
| /homepage/logs | services/contentService.ts |
| /homepage/projects | services/contentService.ts |
| /menu | services/featureService.ts |
| /menu/recommend | services/featureService.ts |
| /period | services/featureService.ts |
| /permission-requests | services/authService.ts |
| /permission-requests/role | services/authService.ts |
| /permissions | services/authService.ts |
| /photos | services/contentService.ts |
| /photos/reorder | services/contentService.ts |
| /projects | services/contentService.ts |
| /projects/import-github/generate-cover | services/contentService.ts |
| /projects/import-github/preview | services/contentService.ts |
| /projects/import-github/stream | services/contentService.ts |
| /resume | services/contentService.ts |
| /resumes/set-default | services/contentService.ts |
| /resumes/users | services/contentService.ts |
| /roles | services/authService.ts |
| /todo | services/featureService.ts |
| /upload | services/featureService.ts |
| /upload/presign | services/featureService.ts |
| /upload/r2/usage | services/featureService.ts |
| /users | services/authService.ts |
| /users/complete-profile | services/authService.ts |
| /users/fitness-goal | services/featureService.ts |
| /users/logout | services/authService.ts |
| /users/password | services/authService.ts |
| /users/signin | services/authService.ts |

## Binary retirement gate

FAIL while any required legacy route, OAuth callback, MCP client,
upload, scheduled task or frontend network call still needs Cloud Run.
Only after API parity, production zero-upstream observation over rare
paths, and a reversible shutdown rehearsal may Cloud Run be retired.
