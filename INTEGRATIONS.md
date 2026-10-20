# Connecting the client's accounts

Everything is already built. Each integration switches on when its keys go into `server/.env` (and, for push, `client/.env`) and the server restarts. Until then the app works in fallback mode: agents dial from their own phones, and texts and emails are saved as **queued** and sent automatically once the provider is connected.

Check what's connected at **Settings → Integrations**. That page also lists every webhook address to paste into the providers, with copy buttons.

Before you start, the app must be reachable over HTTPS, and `PUBLIC_API_URL` must be set to that address (e.g. `https://crm.agency.com`). Twilio, SendGrid, Facebook and Google all call the app on that address.

## 1. Twilio — calling, recording, SMS

1. **Account:** upgrade from trial, then copy the **Account SID** and **Auth Token** → `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`.
2. **API key** (Console → Account → API keys → Standard) → `TWILIO_API_KEY` (SK…) and `TWILIO_API_SECRET`.
3. **TwiML App** (Voice → TwiML Apps → Create). Set its Voice Request URL to `https://<app>/webhooks/twilio/voice` (POST) → `TWILIO_TWIML_APP_SID` (AP…).
4. **Phone numbers:** buy one per agent, plus a main number for `TWILIO_CALLER_ID`.
   - On each number, set "A call comes in" to `https://<app>/webhooks/twilio/inbound` (POST).
   - In Settings → Integrations → Agent phone numbers, enter each agent's number.
5. **SMS:** create a **Messaging Service** and add the numbers → `TWILIO_MESSAGING_SERVICE_SID` (MG…).
   - Set its incoming-message webhook to `https://<app>/webhooks/twilio/sms`.
   - Register the brand and campaign for **A2P 10DLC** (Trust Hub → A2P). US texting stays blocked until it's approved, which takes days to weeks.
6. **Optional:** register the business in Trust Hub for CNAM / SHAKEN-STIR, so calls aren't labelled spam.
7. **Optional:** set `CALL_RECORDING_NOTICE` if agents call two-party-consent states.

Every call is recorded (dual channel). The recording is attached to the logged call and transcribed if OpenAI is connected.

## 2. SendGrid — email

1. Create an API key with Mail Send permission → `SENDGRID_API_KEY`.
2. Authenticate the sending domain (Settings → Sender Authentication). This adds SPF/DKIM records in the domain's DNS.
3. Set `SENDGRID_FROM_EMAIL` (an address on that domain) and, optionally, `SENDGRID_FROM_NAME`.
4. **Replies:** add an MX record for a subdomain (e.g. `reply.agency.com`) pointing to `mx.sendgrid.net`.
   - In Settings → Inbound Parse, add that subdomain with the URL `https://<app>/webhooks/sendgrid/inbound?key=<random secret>`.
   - Put the same subdomain and secret in `SENDGRID_INBOUND_DOMAIN` and `SENDGRID_INBOUND_KEY`.

Every email to a lead includes an unsubscribe link. Clicking it opts the lead out of everything.

## 3. OpenAI — transcripts, summaries, AI replies

Set `OPENAI_API_KEY`. The models can be changed with `OPENAI_TRANSCRIBE_MODEL` and `OPENAI_CHAT_MODEL`. Edit the speed-to-lead screening questions in Settings → Integrations.

## 4. Firebase — browser push notifications

1. Create a Firebase project and add a **Web app**. Copy its config into `client/.env` (`VITE_FIREBASE_*`).
2. Under Cloud Messaging → Web Push certificates, generate a key pair → `VITE_FIREBASE_VAPID_KEY`.
3. Under Project settings → Service accounts, generate a private key. Paste the JSON, on one line, into `FIREBASE_SERVICE_ACCOUNT_JSON` in `server/.env`.
4. Rebuild the app. Each user then picks **Turn on push notifications** in their account menu.

## 5. Facebook / Instagram Lead Ads

1. In Meta for Developers, create an app (Business type) and add the **Webhooks** product.
2. Subscribe the **Page** object to `leadgen`, with callback `https://<app>/webhooks/facebook` and a verify token you choose → `FACEBOOK_VERIFY_TOKEN`.
3. Copy the app secret → `FACEBOOK_APP_SECRET`.
4. Get a long-lived Page access token with `leads_retrieval` and `pages_manage_metadata` → `FACEBOOK_PAGE_ACCESS_TOKEN`. The app needs Meta **App Review** for these permissions.
5. Subscribe the app to the Page (Graph API: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`).

## 6. Google Ads lead forms

In each lead form asset, open Lead delivery → Webhook. Set the URL to `https://<app>/webhooks/google-ads` and the key to a secret → `GOOGLE_ADS_WEBHOOK_KEY`. Use "Send test data" to check it; test leads are acknowledged but not saved.

## 7. Lead vendors and website forms

Each lead source has its own address, listed in Settings → Integrations: `https://<app>/webhooks/leads/<key>`.

- Vendors (EverQuote, MediaAlpha, …) and website forms POST JSON or form fields: `first_name`, `last_name` (or `full_name`), `phone`, `email`, `zip`, `insurance_type`.
- Leads with a phone number already in the CRM are ignored.
- New leads are auto-assigned and start the new-lead automations.

## 8. Moving data from the old tools

- **GoHighLevel / AgencyZoom contacts and leads:** export to CSV, then use Leads → Import. Columns are matched automatically. Keep "Start new-lead automations" off so old leads don't get welcome texts.
- **Customers and policies:** use Customers & policies → Import spreadsheet. There's a template button on that page.
- **RingCentral numbers:** port them to Twilio (Twilio Console → Port & Host). The client signs a letter of authorization.
