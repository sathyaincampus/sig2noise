# sig2noise

Pick 3 signals for the next 18 hours. Everything else is noise.

Live: https://sathyaincampus.github.io/sig2noise/

## Setup

### 1. Firebase — reusing your existing project (~3 min)

This app shares your existing Firebase project (the paadal-pettagam one). Optionally rename its
display name to something generic: Project settings → General → edit name (the project ID can't change — cosmetic only).

1. Project settings → **Your apps → Add app → Web (</>)** → register `sig2noise` → copy its `firebaseConfig` into `src/firebase.js`. (Public identifiers, safe to commit — rules are the protection.)
2. Firestore → **Rules** → add this block inside the existing `match /databases/{database}/documents`, keeping paadal-pettagam's rules as-is → Publish:

```
    match /sig2noise/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
```

3. Google sign-in and the `sathyaincampus.github.io` authorized domain are already set up from paadal-pettagam — nothing to do.

Data lives in the shared (default) database under a `sig2noise/{uid}` collection, fully separate
from paadal-pettagam's collections and still on the free tier. (A separate *named* database would
work too, but named databases aren't covered by Firestore's free quota and require billing.)

### 2. GitHub Pages (one time)

Repo → **Settings → Pages → Source: GitHub Actions**. Then push to `main` — the workflow builds and deploys automatically.

## How it works

- Signed out → saves to localStorage on that device.
- Signed in with Google → live sync across all devices via Firestore (`users/{uid}`).
- At midnight the day archives: completion count goes to the 7-day strip, unfinished signals carry into the next day's noise.

## Local dev

```
npm install
npm run dev
```
