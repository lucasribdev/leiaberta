LeiAberta — Agent Instructions
Product
LeiAberta is a Brazilian federal-law discovery and civic discussion platform. Visitors can search and read laws. Authenticated users can vote, comment, and publish structured PRO/CON arguments under public pseudonyms.
MVP boundaries
- Federal legislation only.
- Public browsing; authentication required for participation.
- One active approval vote per user per law (+1 or -1), editable or removable.
- Comments, replies (maximum depth 2), PRO/CON arguments, and usefulness votes.
- Rankings, reports, and basic moderation.
- Do not add AI explanations, municipal/state law, notifications, or gamification without an explicit request.
Stack
- TanStack Start, TanStack Router, TypeScript strict, Tailwind CSS, shadcn/ui, Supabase PostgreSQL and Supabase Auth.
- Prefer a modular TanStack Start application, Supabase SQL migrations, and database-enforced Row Level Security (RLS). Use TanStack Query when client caching is needed.
- Use Zod for external input validation.
- Use Supabase Auth with Google/GitHub OAuth; store public pseudonyms in public.profiles, separate from auth.users.
Source integrity
- Import federal legislation from https://github.com/ctresb/leis using an idempotent, incremental pipeline.
- Preserve source identifiers, paths, URLs, hashes, and import timestamps.
- Never claim a law is in force without verifiable evidence.
- Clearly separate official legislative text from user-generated opinions.
- Do not silently discard malformed source documents; report import failures.
Security and privacy
- Public profiles use pseudonyms. Never expose email or OAuth identifiers.
- Enforce permissions through Supabase RLS and trusted server-side checks, never only in the UI. Never expose Supabase service-role or secret keys to browsers.
- Protect writes with rate limiting and anti-spam controls.
- Render user text safely; avoid raw HTML.
- Keep moderation actions auditable and support account privacy/deletion workflows.
Engineering conventions
- Prefer small, testable changes and descriptive naming.
- Add Supabase SQL migrations for schema changes; never edit production data manually.
- Keep import logic separate from request handlers; run imports with a server-only credential and least privilege.
- Write tests for voting uniqueness, permissions, discussion depth, and importer idempotency.
- Run lint, typecheck, and relevant tests before declaring work complete.
- Do not commit secrets, credentials, or real personal data.
Workflow
1. Read docs/PRD.md, docs/ARCHITECTURE.md, and docs/BACKLOG.md when present.
2. State a short implementation plan before substantial changes.
3. Implement only the requested issue; avoid unrelated refactors.
4. Report changed files, tests executed, remaining risks, and follow-up tasks.
5. Ask before making irreversible or externally visible changes.