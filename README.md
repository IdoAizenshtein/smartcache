# SmartCache

SmartCache is a lightweight Service Worker library that can be seamlessly integrated into any website. Once installed, it intercepts *all* network requests initiated by the page and:

- **Caches all `GET` and `HEAD` requests** via the Cache API under a configurable `CACHE_NAME`, enabling instant offline retrieval and reduced latency.
- **Persists other HTTP methods** (`POST`, `PUT`, `DELETE`, etc.) into IndexedDB under a configurable database and store name, ensuring that data-changing operations performed while offline are not lost.
- **Automatically replays stored requests** when the user returns online, keeping server-side data synchronized without manual intervention.
- **Refreshes cached resources** on reconnection, so that updated content is fetched and stored for future offline use.

SmartCache also supports versioning of both the cache and IndexedDB schema, and can broadcast real-time notifications to the client page about cache hits, offline usage, and sync events via `postMessage`.

---

## Table of Contents

- [Features](#features)
- [Getting Started](#getting-started)
    - [Integration via `<head>` Tags](#integration-via-head-tags)
    - [Integration via npm](#integration-via-npm)
    - [Node/Bundler (CommonJS) Usage](#nodebundler-commonjs-usage)
    - [Integration in React](#integration-in-react)
    - [Integration in Angular](#integration-in-angular)
    - [Integration in Vue](#integration-in-vue)
    - [Integration in Nuxt](#integration-in-nuxt)
- [Configuration](#configuration)
    - [Cache Naming and Versioning](#cache-naming-and-versioning)
    - [IndexedDB Naming and Versioning](#indexeddb-naming-and-versioning)
    - [Controlling Notifications](#controlling-notifications)
- [File Structure](#file-structure)
- [Usage](#usage)
    - [Offline `POST` Synchronization](#offline-post-synchronization)
    - [Cache-First `GET`/`HEAD` Strategy](#cache-first-gethead-strategy)
    - [Message Handling](#message-handling)
- [API Reference](#api-reference)
- [Development](#development)
- [License](#license)

---

## Features

1. **Full-Site Request Interception**  
   SmartCache registers a Service Worker that takes control of *all* network requests from the page. This allows it to cache or queue any HTTP request automatically.

2. **Cache-First Strategy for `GET`/`HEAD`**
    - Every successful `GET` or `HEAD` response (status `200–299`) is stored in the Cache API under `CACHE_NAME`.
    - Subsequent requests for the same URL are served immediately from cache if available, dramatically improving performance and enabling offline usage.

3. **IndexedDB Queue for Non-`GET` Methods**
    - Any network request using methods other than `GET`/`HEAD` (e.g., `POST`, `PUT`, `DELETE`) is intercepted and stored in an IndexedDB object store.
    - Requests are saved as structured objects (URL, method, headers, body payload).
    - This ensures that data-changing operations performed while offline are not lost.

4. **Automatic Replay on Reconnect**
    - As soon as the browser detects an online event, SmartCache automatically replays all queued IndexedDB requests in their original order.
    - After successful server responses, those entries are removed from IndexedDB.

5. **Cache Refresh on Reconnect**
    - Upon reconnection, SmartCache iterates through all cached `GET`/`HEAD` requests and attempts to fetch updated versions from the network.
    - If a newer response (status `200–299`) is received, it replaces the cached entry, ensuring that offline users see the most recent content.

6. **Versionable Cache Name**
    - Developers can embed a version string in `CACHE_NAME` (e.g., `smart-cache-v2`).
    - When you bump the version, SmartCache will treat it as a separate cache, allowing you to invalidate old caches and force a full refresh.

7. **IndexedDB Naming and Versioning**
    - SmartCache creates an IndexedDB database (default name: `smart-cache-db`) with an object store (default name: `pending-requests`).
    - Both the database name and store name are configurable, and you can also set a version number for the IndexedDB schema.
    - Whenever you increment the version number, SmartCache will run an upgrade callback to update the schema if needed.

8. **Configurable Notifications**
    - Via `showNotifications`, SmartCache can broadcast `postMessage` events to the client page to indicate:
        - Cached resource served (`type: 'OFFLINE_USAGE'`).
        - Offline request synced (`type: 'OFFLINE_REQUEST_SYNCED'`).
    - Pages can listen to these messages and display custom UI notifications (e.g., banners, toast messages) to inform users of offline/online activity.

9. **Bi-Directional Client ↔ Service Worker Messaging**
    - SmartCache exposes helper functions like `sendMessageToClients(message)` to broadcast arbitrary messages.
    - Developers can also use `navigator.serviceWorker.controller.postMessage(...)` from the page to trigger actions like `SYNC_OFFLINE_REQUESTS` on demand.

---

## Getting Started

Select the integration method that matches your project:

### Integration via `<head>` Tags

> **IMPORTANT:** Both the configuration script and `<script src="/smart-cache.js"></script>` **must** appear inside the `<head>` section of your HTML, **before** any other resources (CSS, JS, images, or page content). This guarantees that SmartCache registers the Service Worker *immediately* and intercepts all subsequent fetch requests.

1. **Copy to Web Root**  
   Place `smart-cache.js` and `sw.js` in your web root or `public/` folder:
   ```
   /public
   ├── index.html
   ├── smart-cache.js
   └── sw.js
   ```

2. **Modify `index.html`**
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>My Application</title>

     <!-- SmartCache Configuration (MUST be in <head> BEFORE other content) -->
     <script>
       window.SmartCacheConfig = {
         swPath: '/sw.js',            // Service Worker file path
         showNotifications: true      // Enable or disable UI notifications
       };
     </script>

     <!-- SmartCache Script (MUST be in <head> BEFORE any page elements) -->
     <script src="/smart-cache.js"></script>

     <!-- Your other CSS/JS or page content can follow here -->
   </head>
   <body>
     <h1>Welcome to My App</h1>
     <!-- Page content -->
   </body>
   </html>
   ```

3. **Serve over HTTPS or localhost**  
   Service Workers only work on secure contexts (HTTPS) or on `http://localhost`.

### Integration via npm

1. **Install SmartCache**
   ```bash
   npm install smartcache-serviceworker --save
   ```

2. **Copy or Bundle Necessary Files**
    - **Option A: Copy to `public/`**
      ```bash
      cp node_modules/smartcache-serviceworker/dist/smart-cache.js public/smart-cache.js
      cp node_modules/smartcache-serviceworker/dist/sw.js public/sw.js
      ```
    - **Option B: Import in Your Build**  
      In your main JavaScript entry file (e.g., `src/index.js`):
      ```js
      // Ensure SmartCache script is loaded early
      import 'smartcache-serviceworker/dist/smart-cache.js';
 
      // Register Service Worker (sw.js should be served from root)
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
          .then(reg => console.log('SmartCache SW registered:', reg))
          .catch(err => console.error('SmartCache registration failed:', err));
      }
      ```
        - Use a plugin like `copy-webpack-plugin` to copy `sw.js` into your build output:
      ```js
      // webpack.config.js
      const path = require('path');
      const CopyPlugin = require('copy-webpack-plugin');
 
      module.exports = {
        entry: './src/index.js',
        output: {
          filename: 'bundle.js',
          path: path.resolve(__dirname, 'dist'),
          publicPath: '/'
        },
        plugins: [
          new CopyPlugin({
            patterns: [
              { from: 'node_modules/smartcache-serviceworker/dist/sw.js', to: '' }
            ]
          })
        ]
      };
      ```

3. **Inject Scripts into HTML Template**  
   Ensure your HTML template (e.g., `public/index.html` or equivalent) includes:
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>My App</title>

     <!-- SmartCache Configuration -->
     <script>
       window.SmartCacheConfig = {
         swPath: '/sw.js',
         showNotifications: true
       };
     </script>

     <!-- SmartCache Script -->
     <script src="/smart-cache.js"></script>
   </head>
   <body>
     <div id="root"></div>
     <script src="/bundle.js"></script>
   </body>
   </html>
   ```

---

## Node/Bundler (CommonJS) Usage

If you installed SmartCache from npm and provided an `index.js` that exports `dist/smart-cache.js`, you can simply:

```js
// Node or bundler environment:
const SmartCache = require('smartcache-serviceworker');
// or (ESM-aware bundlers):
import SmartCache from 'smartcache-serviceworker';
```

This works because `index.js` contains:

```js
module.exports = require('./dist/smart-cache.js');
```

No need to reference `dist` manually.

---

## Integration in React

For a React application (Create React App or similar), you must place SmartCache scripts in `public/index.html`:

1. **Install SmartCache**
   ```bash
   npm install smartcache-serviceworker --save
   ```

2. **Copy Files to `public/`**
   ```bash
   cp node_modules/smartcache-serviceworker/dist/smart-cache.js public/smart-cache.js
   cp node_modules/smartcache-serviceworker/dist/sw.js public/sw.js
   ```

3. **Update `public/index.html`**
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <meta name="viewport" content="width=device-width, initial-scale=1" />
     <title>React App with SmartCache</title>

     <!-- SmartCache Configuration (MUST be in head BEFORE other content) -->
     <script>
       window.SmartCacheConfig = {
         swPath: '/sw.js',            // Path to the Service Worker
         showNotifications: true      // Toggle UI notifications
       };
     </script>

     <!-- SmartCache Script (MUST be in head BEFORE other content) -->
     <script src="/smart-cache.js"></script>

     <!-- React bundle and other resources -->
   </head>
   <body>
     <noscript>You need to enable JavaScript to run this app.</noscript>
     <div id="root"></div>
   </body>
   </html>
   ```

4. **Disable CRA’s Default SW**  
   If using Create React App’s default service worker, comment out or remove its registration in `src/index.js`:
   ```js
   // import * as serviceWorkerRegistration from './serviceWorkerRegistration';
   // serviceWorkerRegistration.unregister();
   ```

5. **Build and Serve**
   ```bash
   npm run build
   npm install -g serve
   serve -s build
   ```

6. **Verify**
    - Open DevTools → Application → Service Workers
    - Confirm `sw.js` is registered and activated
    - Test offline/online behavior

---

## Integration in Angular

For an Angular application created with Angular CLI, you must manually inject SmartCache scripts into `src/index.html`:

1. **Install SmartCache**
   ```bash
   npm install smartcache-serviceworker --save
   ```

2. **Copy `sw.js` and `smart-cache.js` to `src/`**
   ```
   your-angular-app/
   ├── src/
   │   ├── assets/
   │   ├── index.html
   │   ├── main.ts
   │   ├── smart-cache.js  ← node_modules/smartcache-serviceworker/dist
   │   └── sw.js           ← node_modules/smartcache-serviceworker/dist
   └── angular.json
   ```

3. **Configure `angular.json` to copy `sw.js`**
   ```json
   {
     "projects": {
       "your-angular-app": {
         "architect": {
           "build": {
             "options": {
               "assets": [
                 "src/favicon.ico",
                 "src/assets",
                 "src/sw.js"
               ]
             }
           }
         }
       }
     }
   }
   ```

4. **Edit `src/index.html`**
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <title>Angular App with SmartCache</title>

     <!-- SmartCache Configuration (MUST be in head BEFORE other content) -->
     <script>
       window.SmartCacheConfig = {
         swPath: '/sw.js',
         showNotifications: true
       };
     </script>

     <!-- SmartCache Script (MUST be in head BEFORE other content) -->
     <script src="/smart-cache.js"></script>

     <!-- Angular bundles follow -->
   </head>
   <body>
     <app-root></app-root>
   </body>
   </html>
   ```

5. **Build and Serve**
   ```bash
   ng build --prod
   npm install -g http-server
   http-server -p 8080 -c-1 dist/your-angular-app
   ```

6. **Verify**
    - DevTools → Application → Service Workers
    - Confirm `sw.js` registered and activated
    - Test offline behavior

---

## Integration in Vue

For a Vue.js application created with Vue CLI:

1. **Install SmartCache**
   ```bash
   npm install smartcache-serviceworker --save
   ```

2. **Copy `sw.js` and `smart-cache.js` to `public/`**
   ```
   your-vue-app/
   ├── public/
   │   ├── index.html
   │   ├── smart-cache.js  ← node_modules/smartcache-serviceworker/dist
   │   └── sw.js           ← node_modules/smartcache-serviceworker/dist
   └── src/
       └── ...
   ```

3. **Edit `public/index.html`**
   ```html
   <!DOCTYPE html>
   <html lang="en">
   <head>
     <meta charset="UTF-8" />
     <meta name="viewport" content="width=device-width, initial-scale=1" />
     <title>Vue App with SmartCache</title>

     <!-- SmartCache Configuration (MUST be in head BEFORE other content) -->  
     <script>
       window.SmartCacheConfig = {
         swPath: '/sw.js',
         showNotifications: true
       };
     </script>

     <!-- SmartCache Script (MUST be in head BEFORE other content) -->  
     <script src="/smart-cache.js"></script>

     <!-- Vue bundle injection by CLI -->  
   </head>
   <body>
     <noscript>You need to enable JavaScript to run this app.</noscript>
     <div id="app"></div>
   </body>
   </html>
   ```

4. **Build and Serve**
   ```bash
   npm run build
   npm install -g serve
   serve -s dist
   ```

5. **Verify**
    - DevTools → Application → Service Workers
    - Confirm `sw.js` registered and activated
    - Test offline behavior

---

## Integration in Nuxt

For a Nuxt.js application:

1. **Install SmartCache**
   ```bash
   npm install smartcache-serviceworker --save
   ```

2. **Copy `sw.js` and `smart-cache.js` to `static/`**
   ```
   your-nuxt-app/
   ├── static/
   │   ├── smart-cache.js  ← node_modules/smartcache-serviceworker/dist
   │   └── sw.js           ← node_modules/smartcache-serviceworker/dist
   └── nuxt.config.js
   ```

3. **Edit `nuxt.config.js` to inject scripts into `<head>`**
   ```js
   export default {
     head: {
       script: [
         // Configuration inline must come before script src
         {
           hid: 'smartcache-config',
           innerHTML: `window.SmartCacheConfig = { swPath: '/sw.js', showNotifications: true };`,
           type: 'text/javascript',
           charset: 'utf-8'
         },
         {
           src: '/smart-cache.js',
           type: 'text/javascript',
           charset: 'utf-8'
         }
       ],
       __dangerouslyDisableSanitizersByTagID: {
         'smartcache-config': ['innerHTML']
       }
     },
     generate: {
       fallback: true
     }
   };
   ```

4. **Build and Serve**
   ```bash
   npm run build
   npm run start
   ```

5. **Verify**
    - DevTools → Application → Service Workers
    - Confirm `/sw.js` registered and activated
    - Test offline behavior

---

## Configuration

SmartCache supports multiple configuration options via the global `window.SmartCacheConfig` object. Define this object *before* loading `smart-cache.js`.

| Property            | Type    | Default            | Description                                                                 |
| ------------------- | ------- | ------------------ | --------------------------------------------------------------------------- |
| `swPath`            | String  | `/sw.js`           | URL path to the Service Worker script.                                       |
| `showNotifications` | Boolean | `true`             | Enable or disable broadcast notifications.                                   |

### Controlling Notifications

- When `showNotifications: true`, SmartCache sends `postMessage` events to the client page for the following scenarios:
    - **`{ type: 'OFFLINE_USAGE', url }`**: A `GET`/`HEAD` request was served from cache.
    - **`{ type: 'OFFLINE_REQUEST_SYNCED', url, method }`**: An offline request from the IndexedDB queue was successfully replayed.
- The page can listen to these messages and present custom UI indicators.

---

## File Structure

```
/ (Package Root)
├── dist/
│   ├── smart-cache.js
│   └── sw.js
├── index.js          ← Optional CommonJS entry exporting `dist/smart-cache.js`
├── README.md
├── LICENSE
└── package.json
```

---

## License

MIT License

---

**Author:** Ido Aizenshtein (idoaizenshtein@gmail.com)