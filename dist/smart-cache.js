(function() {
    // Configuration and Constants
    const CONFIG = window.SmartCacheConfig || {};
    const SW_PATH = CONFIG.swPath || '/sw.js'; // Path to the Service Worker file
    const SHOW_NOTIFICATIONS = CONFIG.showNotifications !== false; // Defaults to true unless explicitly set to false

    // IndexedDB configuration for offline request caching
    const DB_NAME = 'smart-cache-db'; // Database name
    const STORE_NAME = 'offline-requests'; // Object store name
    const DB_VERSION = 1; // Version number for schema upgrade handling

    // Cleanup policy
    const MAX_RETRIES = 5; // Maximum number of retry attempts per request
    const MAX_AGE = 1000 * 60 * 60 * 24 * 7; // 7 days in milliseconds - maximum age for offline requests

    // Notification queue management to avoid overlapping messages
    const messageQueue = []; // Holds pending UI messages
    let isShowingMessage = false; // Flag to indicate if a message is being displayed

    // --- IndexedDB Utility Functions ---

    /**
     * Opens the IndexedDB database and handles upgrade events.
     * Supports creation of object stores and indexes based on version.
     * @returns {Promise<IDBDatabase>} Resolves to an open database instance
     */
    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => reject(request.error);

            request.onsuccess = () => resolve(request.result);

            request.onupgradeneeded = (event) => {
                const db = request.result;
                const oldVersion = event.oldVersion;

                if (oldVersion < 1) {
                    // Create store on first version
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    }
                }
                if (oldVersion < 2) {
                    // Add index for filtering/sorting by timestamp
                    const store = request.transaction.objectStore(STORE_NAME);
                    if (!store.indexNames.contains('timestamp')) {
                        store.createIndex('timestamp', 'timestamp', { unique: false });
                    }
                }
            };
        });
    }

    /**
     * Stores a new offline request object in the database.
     * @param {Object} requestData - Request metadata (URL, method, headers, etc.)
     * @returns {Promise<void>}
     */
    async function saveRequest(requestData) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add(requestData).onsuccess = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Retrieves all stored offline requests.
     * @returns {Promise<Array>} Resolves to an array of offline request records
     */
    async function getAllRequests() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Deletes a specific offline request by ID.
     * @param {number} id - Request ID
     * @returns {Promise<void>}
     */
    async function deleteRequest(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(id).onsuccess = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Updates the retry count of a given request object.
     * Used for retry-limiting sync operations.
     * @param {number} id - ID of request
     * @param {number} retryCount - New retry count to store
     * @returns {Promise<void>}
     */
    async function updateRequestRetryCount(id, retryCount) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (data) {
                    data.retryCount = retryCount;
                    store.put(data).onsuccess = () => resolve();
                } else {
                    resolve(); // Record not found, silently resolve
                }
            };
            getReq.onerror = () => reject(getReq.error);
        });
    }

    // --- UI Notification Handling ---

    /**
     * Pushes a message to the queue and displays it if allowed.
     * @param {string} message - Notification text
     * @param {string} [type='info'] - Type of message: 'info', 'success', or 'error'
     */
    function notifyUser(message, type = 'info') {
        if (!SHOW_NOTIFICATIONS) return;

        messageQueue.push({ message, type });
        if (!isShowingMessage) {
            showNextMessage();
        }
    }

    /**
     * Shows the next queued notification message using a floating toast.
     * Applies CSS styles dynamically for positioning and color.
     */
    function showNextMessage() {
        if (messageQueue.length === 0) {
            isShowingMessage = false;
            return;
        }

        isShowingMessage = true;
        const { message, type } = messageQueue.shift();

        const containerId = 'smart-cache-notify';
        let container = document.getElementById(containerId);
        if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            Object.assign(container.style, {
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                zIndex: '9999',
                maxWidth: '300px',
                fontFamily: 'sans-serif',
                fontSize: '14px',
            });
            document.body.appendChild(container);
        }

        const box = document.createElement('div');
        box.textContent = message;
        box.style.background = type === 'error' ? '#f44336' : type === 'success' ? '#4caf50' : '#2196f3';
        box.style.color = '#fff';
        box.style.padding = '12px 16px';
        box.style.marginTop = '8px';
        box.style.borderRadius = '6px';
        box.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
        box.style.opacity = '1';
        box.style.transition = 'opacity 0.5s ease';

        container.appendChild(box);

        setTimeout(() => {
            box.style.opacity = '0';
            setTimeout(() => {
                container.removeChild(box);
                isShowingMessage = false;
                showNextMessage(); // Continue showing next messages
            }, 500);
        }, 3000);
    }

    // --- Request Body Preparation ---

    /**
     * Converts a body object into a JSON string, or returns it if already a string.
     * Returns undefined for null/undefined or non-serializable values.
     * @param {*} body - Body content to serialize
     * @returns {string|undefined}
     */
    function prepareRequestBody(body) {
        if (body == null) return undefined;
        if (typeof body === 'string') return body;

        try {
            return JSON.stringify(body);
        } catch {
            return undefined;
        }
    }

    // --- Service Worker Registration and Message Handling ---

    if ('serviceWorker' in navigator) {
        // Register the service worker to intercept and cache requests
        navigator.serviceWorker.register(SW_PATH, { scope: '/' })
            .then(registration => {
                console.log('[SmartCache] Service Worker registered:', registration.scope);
            })
            .catch(err => {
                console.error('[SmartCache] Service Worker registration failed:', err);
                notifyUser('SmartCache failed to register.', 'error');
            });

        // Handle messages sent by the Service Worker
        navigator.serviceWorker.addEventListener('message', async event => {
            if (!event.data) return;

            switch(event.data.type) {
                case 'OFFLINE_REQUEST_SAVED':
                    notifyUser(`Saved ${event.data.method} request to ${event.data.url} for later sync.`, 'info');
                    break;
                case 'OFFLINE_USAGE':
                    notifyUser(`You're offline. Loaded from cache.`, 'success');
                    break;
                case 'OFFLINE_REQUEST_SYNCED':
                    notifyUser(`Synced ${event.data.method} to ${event.data.url}`, 'success');
                    break;
                case 'SYNC_OFFLINE_REQUESTS':
                    await syncOfflineRequests();
                    break;
                default:
                    // No-op for unrecognized message types
                    break;
            }
        });

        // Automatically sync requests once the user comes back online
        window.addEventListener('online', () => {
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'SYNC_OFFLINE_REQUESTS' });
                console.log('[SmartCache] Back online, syncing offline requests...');
            }
        });
    } else {
        console.warn('[SmartCache] Service workers not supported in this browser.');
    }

    // --- Offline Requests Synchronization ---

    /**
     * Sends all stored offline requests if they have not expired or exceeded retry limit.
     * Deletes successfully synced or expired requests.
     */
    async function syncOfflineRequests() {
        const requests = await getAllRequests();
        const now = Date.now();

        for (const req of requests) {
            if (req.retryCount >= MAX_RETRIES || (now - req.timestamp) > MAX_AGE) {
                await deleteRequest(req.id);
                console.log(`[SmartCache] Removed offline request ID ${req.id} due to retry or age limits.`);
                continue;
            }

            try {
                const fetchOptions = {
                    method: req.method,
                    headers: req.headers || {},
                    body: prepareRequestBody(req.body),
                };

                const response = await fetch(req.url, fetchOptions);

                if (response.ok) {
                    await deleteRequest(req.id);
                    notifyUser(`Synced offline request: ${req.method} ${req.url}`, 'success');
                } else {
                    await updateRequestRetryCount(req.id, (req.retryCount || 0) + 1);
                    notifyUser(`Failed to sync ${req.method} ${req.url} - status ${response.status}`, 'error');
                }
            } catch (err) {
                await updateRequestRetryCount(req.id, (req.retryCount || 0) + 1);
                notifyUser(`Error syncing ${req.method} ${req.url}: ${err.message}`, 'error');
            }
        }
    }

    // --- Public API Exposure ---

    /**
     * Expose saveOfflineRequest method globally for external use.
     * Allows external code to save failed requests when offline.
     */
    window.smartCache = {
        saveOfflineRequest: saveRequest,
    };

})();
