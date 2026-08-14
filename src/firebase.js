import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// sathya-projects — shared Firebase project for all apps.
// These values are public identifiers, safe to commit; Firestore rules enforce access.
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyA5oCwmNMatPoisUnyYhm75ySj95ZK-xs4",
  authDomain: "sathya-projects.firebaseapp.com",
  projectId: "sathya-projects",
  storageBucket: "sathya-projects.firebasestorage.app",
  messagingSenderId: "94556040311",
  appId: "1:94556040311:web:ec705c3e209b6f1ad92a72",
  measurementId: "G-JCDF63N311"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
