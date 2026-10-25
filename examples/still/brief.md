# Still

A meditation app for busy, stressed adults. This project designs its first-run onboarding: from the first open to the
first Home screen.

- **Product:** Still, short guided meditations, breathing exercises and sleep sessions. Free core plan; an optional
  subscription (Still Plus) unlocks the full library, sleep stories and offline downloads.
- **Audience:** adults 25–45, new to meditation or restarting after giving up, phone-first. They often open the app in
  a stressed moment or at bedtime, so onboarding has to be calm, short and kind.
- **Platform and frames:** iOS, iPhone 16 (393×852). Light, warm theme; the session player uses a dark "dusk"
  palette because sessions are immersive and often happen in the evening.
- **Tone and brand:** warm, quiet, plain-spoken. No guru-speak, no guilt, no fake urgency. Serif display type
  (Fraunces) for a human voice, Figtree for UI. Warm paper backgrounds, one pine-green accent for actions, sunset
  orange only in illustrations.
- **The moment that must feel great:** the first one-minute breathing session, offered *before* any account or
  paywall, and the small celebration after it.
- **Decisions taken (no questions could be asked in this run):**
  - Three short questions only (goals, experience, daily time); each answer visibly shapes the plan.
  - Try first, then ask: breath → reminder → account → subscription offer.
  - Reminders: our own explanation screen first, then the iOS prompt; "Don't Allow" is handled kindly.
  - Account is optional ("Not now"); progress stays on the phone and syncs later.
  - Paywall: 7-day free trial of Still Plus, €59.99/year or €9.99/month, with a clear "Continue with free plan" and an
    honest trial timeline. Prices in euros, times in 24 h (EU English locale).
  - Returning users skip the questions: "I already have an account" → sign in → Home with their progress.
- **Flows to design:** Welcome & questions, First breath, Reminders (allowed / denied), Account & plan (incl. offline
  sign-in error), Returning user. States: loading (building the plan), error/offline, permission asked and denied,
  success (session done), first-run vs returning Home.
- **Out of scope:** the rest of the app (library, player settings, profile), Android, a full dark theme, email sign-up
  details, the App Store purchase sheet itself.
