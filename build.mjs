// Bundles the app into a single self-contained index.html (JS inlined),
// alongside the PWA files. Run: npm install && npm run build  → ./dist
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: ["safari15", "chrome100", "firefox100"],
  jsx: "automatic",
  loader: { ".jsx": "jsx" },
  define: {
    __STANDALONE__: "true",
    "process.env.NODE_ENV": '"production"',
  },
});

// Escape any literal closing-script sequences so the inline <script> can't terminate early
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const version = Date.now().toString(36);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Latent</title>
<meta name="description" content="Non-destructive AI photo developer">
<meta name="theme-color" content="#151412">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="icon" href="./icons/icon-192.png">
<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Latent">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>html,body{margin:0;background:#151412}#root{min-height:100vh}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

writeFileSync("dist/index.html", html);
cpSync("public", "dist", { recursive: true });
// stamp the service worker so every deploy invalidates the old cache
const sw = readFileSync("public/sw.js", "utf8").replace("__VERSION__", version);
writeFileSync("dist/sw.js", sw);
console.log(`built dist/index.html (${(html.length / 1024).toFixed(0)} KB), cache v${version}`);
