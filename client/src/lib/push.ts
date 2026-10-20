// Browser push notifications through Firebase Cloud Messaging. Available when the VITE_FIREBASE_* keys are set at build time.
import { api } from './api';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};
const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

export const pushAvailable = () => !!(config.apiKey && config.projectId && config.messagingSenderId && config.appId && vapidKey && 'serviceWorker' in navigator && 'Notification' in window);

/** Asks permission, registers the service worker and sends the device token to the server. */
export async function enablePush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!pushAvailable()) return 'unavailable';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const [{ initializeApp }, { getMessaging, getToken }] = await Promise.all([import('firebase/app'), import('firebase/messaging')]);
  const app = initializeApp(config);
  const qs = new URLSearchParams(Object.entries(config).map(([k, v]) => [k, v ?? '']));
  const reg = await navigator.serviceWorker.register(`/firebase-messaging-sw.js?${qs}`);
  const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
  await api('/push/register', { method: 'POST', json: { token } });
  return 'enabled';
}
