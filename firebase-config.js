// Konfigurasi Firebase untuk klien (web). Nilai ini memang publik,
// keamanan data dijaga oleh database.rules.json dan server.
window.firebaseConfig = {
  apiKey: "AIzaSyD_7kCTW5TgS37mcpp8o3BisqM3sD4O_No",
  authDomain: "shinpo-chat.firebaseapp.com",
  projectId: "shinpo-chat",
  storageBucket: "shinpo-chat.firebasestorage.app",
  messagingSenderId: "134702890947",
  appId: "1:134702890947:web:b64e6b768d3fd87ad88776"
};

if (window.firebase && !firebase.apps.length) {
  firebase.initializeApp(window.firebaseConfig);
}
