# Wordfern

A language learning app for adults who want to get by on their next trip or in a new city. This project designs its
first run (onboarding and the subscription offer) and the core of the app: one lesson from start to finish, progress,
profile and a feature that needs the paid plan.

- **Product:** Wordfern, short lessons (about five minutes) of tap-to-answer questions, built around a personal plan.
  Free core course; an optional subscription (Wordfern Plus) unlocks speaking practice, offline lessons and unlimited
  reviews. A made-up brand: no real product, logo or mascot is imitated.
- **Audience:** adults 22–50, busy, phone-first, learning for a reason (travel, a move, family, work). Many tried a
  language app before and dropped it, so the app has to feel calm and useful, not like a game they owe something.
- **Platform and frames:** iOS, iPhone 16 (393×852). Light theme.
- **Tone and brand:** friendly, plain-spoken, a little dry. No guilt, no fake urgency, no countdowns. There is no
  mascot: the brand mark is a fern fiddlehead (an unfurling frond), used in the logo and in the plan-building loader.
  Warm off-white backgrounds, ink-navy text, one indigo accent for actions, apricot for highlights; a fern green and a
  soft red only for right and wrong answers. Bricolage Grotesque for headings, Atkinson Hyperlegible for UI and lesson
  text (easy to read for learners).
- **The moment that must feel great:** the first correct answer, and the lesson-complete screen where the XP bar fills
  and the daily-goal ring closes.
- **Decisions taken:**
  - No streaks: no streak counter, no flame, no "don't break your streak" anywhere. Motivation comes from the daily-goal
    ring and XP only. No lives or hearts either: a wrong answer never blocks the lesson.
  - Five short questions: language (Spanish, French, Italian, German, Portuguese, Japanese), why (travel, a move,
    family, work, just for fun), level, daily goal (5 / 10 / 15 / 20 min); each answer shows up in the plan.
  - Level: "I'm new" goes straight to the daily goal; "I know some" first takes a placement test of 3 questions, then
    says where the plan starts ("You'll start at Unit 3").
  - Reminders: our own explanation screen first, then the iOS prompt; "Don't Allow" is handled kindly (the plan still
    works, reminders can be turned on later in Profile).
  - Paywall after the plan and the reminder ask, in two versions to compare: **A** an honest trial timeline (today,
    day 5 reminder, day 7 first charge) and **B** a free vs Plus table. Both: 7-day free trial, €49.99/year or
    €7.99/month, and "Continue with free" as visible as the trial button. Prices in euros, EU English locale.
  - The locked feature is Speaking practice: its card in the app shows a small Plus badge and leads back to the
    paywall.
  - Wrong answers show the right one right away; a wrong answer never ends or blocks the lesson.
- **Motion (the point of this example: every screen moves, in plain CSS, live on the canvas):**
  - Welcome: the fiddlehead logo unfurls, then the headline and buttons rise in one after another.
  - Questions: the options cascade in; a picked option fills with a soft spring; the progress bar grows step by step.
  - Placement test: a small check draws itself after each answer.
  - Building your plan: the fiddlehead unfurls while three lines tick on ("Spanish for travel", "10 min a day",
    "Starting at Unit 3"), then the plan card flips in.
  - Reminders: a notification slides down from the top of the phone; on "denied" the bell swings once and settles.
  - Paywall: A's timeline draws itself from today to day 7; B's table fills in row by row with checkmarks; the trial
    button carries a slow shine.
  - Purchase done: a shower of small leaves in the brand colours, the Plus badge pops in.
  - Home: the lesson path draws from node to node; the current lesson breathes.
  - Question: the answer tiles slide up. Right: a pop, a green fill and a small burst. Wrong: a short shake, then the
    right answer lights up.
  - Lesson complete: XP counts up, the XP bar fills, the daily-goal ring closes, then "Continue" rises in.
  - Progress: the weekly bars grow in and the words-learned number ticks up.
  - Speaking practice (locked): the lock wiggles once and the Plus badge glows.
  - Every screen sets its own still moment (`<meta name="adl:snapshot">`), so the zoomed-out canvas and pictures show
    the finished state, and all motion respects the reduced-motion setting.
- **Flows to design:** one page, three sections.
  - **Onboarding:** Welcome → Pick a language → Why are you learning? → Your level (→ placement test, only for "I know
    some") → Daily goal → Building your plan (the fiddlehead unfurls while the plan is built) → Reminders → allowed /
    denied.
  - **Paywall:** version A and version B as a row of options → Purchase done. "Continue with free" goes into the app.
  - **App:** Home (the lesson path) → Question → Correct / Wrong → Lesson complete (XP bar, daily-goal ring) →
    Progress → Profile → Speaking practice (locked), which leads back to the Paywall.
  - States: loading (building the plan), permission allowed and denied, right and wrong answer, success (lesson
    complete, purchase done), locked feature.
- **Canvas features this example shows (each at least once):** arrows with a tap ("taps Continue"), an arrow with a
  condition ("only if 'I know some'"), a row of options (paywall A and B), a portal (Speaking practice → Paywall),
  notes and status chips (for example "To decide" on the two paywall versions), and real CSS animations on every
  screen (see Motion).
- **Out of scope:** account sign-up and sign-in, settings, audio and speech recognition, the full course content,
  Android, a dark theme, the App Store purchase sheet itself.
