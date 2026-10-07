# Ask the Bible (web version)

A chat page that answers Bible questions with Scripture, context and a tiered theological stance
(essentials vs. disputed matters), in the tradition the visitor picks. Hosted free on Vercel.

## Files
- `public/index.html`  the chat page (history and choices are saved in the visitor's own browser)
- `api/chat.js`        serverless function: calls Claude, streams the answer, fetches exact verse text
- `lib/prompt.js`      the theology rules and tradition profiles. **Edit this to tune the stance.**

## Deploy on Vercel (free Hobby plan)
1. Put this folder in a GitHub repo (do not upload a real `.env`).
2. vercel.com > Add New > Project > import the repo. Leave build settings as they are.
3. Settings > Environment Variables: add `ANTHROPIC_API_KEY`. Optional: `ACCESS_CODE`, `CLAUDE_MODEL`, `HOURLY_LIMIT`.
4. Deploy. Your site is live at the `.vercel.app` address (you can add your own domain later).
5. **Protect your credit:** in console.anthropic.com set a monthly spend limit.

## Run locally
`npm i -g vercel`, copy `.env.example` to `.env.local`, fill it in, then run `vercel dev`.

## Notes
- Cost is only the Anthropic API (Haiku 4.5 is the cheapest model). `ACCESS_CODE` makes the site private.
- The hourly limit is per visitor IP and best-effort (serverless memory resets). For stronger protection add
  a shared store such as Upstash Redis, but the spend limit in step 5 is the real safety net.
- Only public-domain translations (KJV, WEB, ASV, WEBBE) are quoted word for word.
- Rename the site by editing the `<title>` and `<h1>` in `public/index.html`.
