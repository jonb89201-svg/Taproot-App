# android/

The Bubblewrap project file for the Play Store wrapper (a Trusted Web Activity that opens
taproot.possessio.io full-screen). See `../docs/PLAY_STORE.md` for the whole path; the quick
PWABuilder route needs none of this.

- `twa-manifest.json` — the wrapper's settings. No secrets in it: the signing key is a path.
- `android.keystore` — the upload key. Created by `bubblewrap build` on your machine, never
  committed (`.gitignore`), never in chat. Lose it and you lose the ability to update the app.

```sh
npm i -g @bubblewrap/cli          # needs JDK 17 and the Android SDK; bubblewrap offers to fetch both
cd android && bubblewrap build    # -> app-release-bundle.aab (upload to Play) and app-release-signed.apk
```
