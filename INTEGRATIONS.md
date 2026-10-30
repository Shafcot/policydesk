# Connecting the client's accounts

Everything is already built. Sign in as the Super Admin and open **Settings → Integrations**:

- Each provider has a card. Paste its keys, click **Save**, then **Test connection**.
- Keys are stored encrypted in the database. Each service switches on as soon as it's saved; no restart or file editing needed.
- The page also lists every webhook address to paste into the providers, with copy buttons.

Until a provider is connected, the app works in fallback mode: agents dial from their own phones, and texts and emails are saved as **queued** and sent automatically once the provider is connected.

Keys can also be set as environment variables (`server/.env`, names shown in `server/.env.example`). A key saved in the app wins over the same environment variable. Saved keys are encrypted with `SETTINGS_ENCRYPTION_KEY`, or `JWT_SECRET` if that isn't set, so keep that value the same or re-enter the keys.

The app must be reachable over HTTPS. Twilio, SendGrid, Facebook and Google all call it on that address, which defaults to the address the app is served from (`CLIENT_ORIGIN`). Override it in the **App address** card if needed.

## 1. Twilio — calling, recording, SMS

1. **Account:** upgrade from trial, then paste the **Account SID** and **Auth Token** into the Twilio card and save.
2. Click **Set up calling**. It creates the API key and the TwiML App (pointed at this CRM) in the Twilio account and saves them.
3. **SMS:** in Twilio, create a **Messaging Service**. Set its incoming-message webhook to `https://<app>/webhooks/twilio/sms`, then paste its SID (MG…) into the Twilio card.
4. **Phone numbers:** open **Phone numbers** in the menu.
   - **Buy a number** searches by area code and buys it in the Twilio account.
   - **Add a number** adds one the agency already has. **Import from Twilio** adds every number in the account.
   - Numbers bought or found in the account are pointed at the CRM automatically (calls ring the assigned user in the browser; texts go to the inbox) and added to the Messaging Service.
   - Assign one number per user, there or when creating/editing a user. Users without one call from the **default caller ID** in the Twilio card.
5. **US texting:** register the brand and campaign for **A2P 10DLC** (Trust Hub → A2P). US texting stays blocked until it's approved, which takes days to weeks.
6. **Optional:** register the business in Trust Hub for CNAM / SHAKEN-STIR, so calls aren't labelled spam.
7. **Optional:** fill in **Recording notice** if agents call two-party-consent states.

Agents can also call any number from the **Dial pad** in the Power Dialer. If the number belongs to one of their leads, it's a normal lead call. If it's new, they can save it as a lead after the call to log it with its recording.

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

1. Create a Firebase project and add a **Web app**. Copy its config values (API key, auth domain, project ID, messaging sender ID, app ID) into the Firebase card.
2. Under Cloud Messaging → Web Push certificates, generate a key pair. Paste it as **Web push key (VAPID)**.
3. Under Project settings → Service accounts, generate a private key and paste the whole JSON file into **Service account JSON**. Save, then **Test connection**.
4. Each user then picks **Turn on push notifications** in their account menu. No rebuild needed.

## 5. Facebook / Instagram Lead Ads

1. In Meta for Developers, create an app (Business type) and add the **Webhooks** product.
2. Subscribe the **Page** object to `leadgen`, with callback `https://<app>/webhooks/facebook` and a verify token you choose → `FACEBOOK_VERIFY_TOKEN`.
3. Copy the app secret → `FACEBOOK_APP_SECRET`.
4. Get a long-lived Page access token with `leads_retrieval` and `pages_manage_metadata` → `FACEBOOK_PAGE_ACCESS_TOKEN`. The app needs Meta **App Review** for these permissions.
5. Subscribe the app to the Page (Graph API: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`).

## 6. Google Ads lead forms

In each lead form asset, open Lead delivery → Webhook. Set the URL to `https://<app>/webhooks/google-ads` and the key to a secret → `GOOGLE_ADS_WEBHOOK_KEY`. Use "Send test data" to check it; test leads are acknowledged but not saved.

## 7. Lead vendors and website forms

In **Settings → Integrations → Lead vendors**, click **Add vendor** for each vendor and send them its address. **New address** replaces a vendor's address if it leaks.

Each lead source has its own address, listed in Settings → Integrations: `https://<app>/webhooks/leads/<key>`.

- Vendors (EverQuote, MediaAlpha, …) and website forms POST JSON or form fields: `first_name`, `last_name` (or `full_name`), `phone`, `email`, `zip`, `insurance_type`.
- Leads with a phone number already in the CRM are ignored.
- New leads are auto-assigned and start the new-lead automations.

## 8. Moving data from the old tools

- **GoHighLevel / AgencyZoom contacts and leads:** export to CSV, then use Leads → Import. Columns are matched automatically. Keep "Start new-lead automations" off so old leads don't get welcome texts.
- **Customers and policies:** use Customers & policies → Import spreadsheet. There's a template button on that page.
- **RingCentral numbers:** port them to Twilio (Twilio Console → Port & Host). The client signs a letter of authorization.
