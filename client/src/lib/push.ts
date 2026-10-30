// Browser push notifications through Firebase Cloud Messaging. The web config comes from the server
// (Settings → Integrations → Firebase), with VITE_FIREBASE_* build variables as a fallback.
import { api } from './api';

type WebConfig = { apiKey: string; authDomain: string; projectId: string; messagingSenderId: string; appId: string; vapidKey: string };
const buildConfig = (): WebConfig | null => {
  const e = import.meta.env;
  const c = { apiKey: e.VITE_FIREBASE_API_KEY, authDomain: e.VITE_FIREBASE_AUTH_DOMAIN, projectId: e.VITE_FIREBASE_PROJECT_ID, messagingSenderId: e.VITE_FIREBASE_MESSAGING_SENDER_ID, appId: e.VITE_FIREBASE_APP_ID, vapidKey: e.VITE_FIREBASE_VAPID_KEY } as Partial<WebConfig>;
  return c.apiKey && c.projectId && c.messagingSenderId && c.appId && c.vapidKey ? (c as WebConfig) : null;
};

let config: WebConfig | null | undefined;
/** Loads the push config once; resolves to null when push isn't set up. */
export async function loadPushConfig() {
  if (config !== undefined) return config;
  config = (await api<WebConfig | null>('/integrations/push-config').catch(() => null)) ?? buildConfig();
  return config;
}

export const pushAvailable = () => !!config && 'serviceWorker' in navigator && 'Notification' in window;

/** Asks permission, registers the service worker and sends the device token to the server. */
export async function enablePush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  const c = await loadPushConfig();
  if (!c || !pushAvailable()) return 'unavailable';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const [{ initializeApp }, { getMessaging, getToken }] = await Promise.all([import('firebase/app'), import('firebase/messaging')]);
  const { vapidKey, ...web } = c;
  const app = initializeApp(web);
  const qs = new URLSearchParams(Object.entries(web));
  const reg = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${qs}`);
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
  await api('/push/register', { method: 'POST', json: { token } });
  return 'enabled';
}
