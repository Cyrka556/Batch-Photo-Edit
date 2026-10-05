# Latent

Non-destructive AI photo developer — manual develop mode plus an automatic
cull → develop → crop → save workflow for large batches (CR2/CR3/NEF/ARW/DNG,
JPEG, PNG, WebP). Runs entirely in the browser; installable as a PWA.


## Your API key

The AI features (Develop this frame, Suggest crop, Auto batch) call Anthropic
directly from the browser using **your** key:

1. Open the app and tap **⚙** (or the "Add key" banner).
2. Paste your key and press **Save**, then **Test key**.

The key is stored in that browser's localStorage and sent only to
`api.anthropic.com`. It is not in the source, the build, or the hosted files,
so sharing the URL does not share your key. Anyone else opening the app can
edit photos manually but needs their own key for the AI features.

Things to know:
- Enter it once **per device and per browser**. On iOS, an app installed to the
  Home Screen has storage separate from Safari, so enter the key again inside
  the installed app.
- Use a dedicated key with a monthly spend limit (Anthropic Console). A key in
  browser storage is exposed to malicious extensions or page-script injection,
  so cap the blast radius.
- Clearing site data removes the key (just re-enter it).
- The default model is set in Settings; change it there if Anthropic retires it.

## Local development / manual build

    npm install
    npm run build     # writes ./dist (index.html + PWA files)

Serve `dist/` from any static host (HTTPS needed for install/offline, and for
choosing an output folder in batch mode on Chrome/Edge).

## Source layout

- `src/App.jsx` — the whole app. `__STANDALONE__` is defined at build time;
  without it (e.g. pasted into a Claude artifact) the key/settings UI is
  inert and the platform handles the API call.
- `src/main.jsx` — mounts the app and registers the service worker.
- `public/` — manifest, service worker, icons.
- `build.mjs` — esbuild bundle, inlined into a single `index.html`.
