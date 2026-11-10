/* Firebase Cloud Messaging service worker: shows push notifications while the app tab is closed.
   The Firebase web config is passed in the registration URL by src/lib/push.ts. */
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
firebase.initializeApp({
  apiKey: params.get('apiKey'), authDomain: params.get('authDomain'), projectId: params.get('projectId'),
  messagingSenderId: params.get('messagingSenderId'), appId: params.get('appId'),
});
firebase.messaging();
