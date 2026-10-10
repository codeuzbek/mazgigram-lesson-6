/* =============================================================================
 * 1. CONFIGURATION
 * ========================================================================== */

// Base address of the Spring Boot backend. Change this one line when deploying.
const API_BASE = 'http://localhost:8080';

// How many messages one history request loads.
const PAGE_SIZE = 10;

/**
 * Minimum gap between two "user is typing" signals, in milliseconds.
 * Without this we would send one WebSocket frame per key press.
 * It is deliberately below TYPING_INDICATOR_HIDE_MS so the indicator on the
 * other side never flickers off while the user is still typing.
 */
const TYPING_SIGNAL_INTERVAL_MS = 1500;

/** How long the "... is typing" indicator stays on screen after the last signal. */
const TYPING_INDICATOR_HIDE_MS = 2000;


/* =============================================================================
 * 2. STATE
 * These are like the fields of a class: they describe what the page is currently showing.
 * ========================================================================== */

/** The STOMP client. Stays null until connect() succeeds. */
let stompClient = null;

/** Id of the logged-in user, saved by login.js. */
let currentProfileId = null;

/** Id of the chat currently open on the right side (null = nothing open). */
let selectedChatId = null;

/** Type of the open chat: 'CHAT' (one to one) or 'GROUP'. */
let selectedChatType = null;

/** The chat list as returned by the server. Used to fill the chat header. */
let chatList = [];

/** Timestamp of the last "user is typing" signal we sent. */
let lastTypingSentAt = 0;

/** Handle of the timer that hides the typing indicator. */
let typingIndicatorTimer = null;


/* =============================================================================
 * 3. DOM REFERENCES
 * Looked up once here instead of calling getElementById() over and over.
 * ========================================================================== */

// Left sidebar
const chatListContainer = document.getElementById('chatListContainerId');

// Chat header
const chatNameDiv = document.getElementById('chatNameDivId');
const chatStatusDiv = document.getElementById('chatOnlineMembersCountDivId');
const typingIndicator = document.getElementById('typingIndicatorId');
const typingUserSpan = document.getElementById('typingUserSpanId');

// Message area
const chatMessageContainer = document.getElementById('chatMessageContainerId');

// Message input
const messageInput = document.getElementById('inputMessageId');
const inputMessageClearIcon = document.getElementById('inputMessageClearIconId');

// Attachment preview modal
const imagePreviewModalOverlay = document.getElementById('imagePreviewModalOverlayId');
const imagePreviewModalImg = document.getElementById('imagePreviewModalImgId');
const imagePreviewModalInput = document.getElementById('imagePreviewModalInputId');


/* =============================================================================
 * 4. STARTUP
 * ========================================================================== */

/**
 * Runs once the HTML is ready.
 *
 * Order matters: all listeners are registered BEFORE connecting to the
 * WebSocket. If the connection fails, the page still works for everything
 * that does not need it.
 */
window.addEventListener('DOMContentLoaded', async () => {
    currentProfileId = localStorage.getItem('id');


    try {
        await connectWebSocket();
        console.log('WebSocket connection established');
    } catch (error) {
        console.error('Could not connect to the chat server:', error);
        chatStatusDiv.innerText = 'connection failed';
    }

    // load chat history
    loadChatList();
});

/* =============================================================================
 * 5. HTTP LAYER
 * ========================================================================== */

/**
 * Returns the saved JWT, or sends the user to the login page and returns null.
 *
 * IMPORTANT: assigning `window.location` does NOT stop the current function,
 * so every caller must `return` when this returns null.
 *
 * @returns {string|null} the token, or null when the user is not logged in
 */
function requireJwt() {
    const jwt = localStorage.getItem('jwtToken');
    if (!jwt) {
        window.location.href = './login.html';
        return null;
    }
    return jwt;
}

/**
 * Single entry point for every REST call. Adds the Authorization header,
 * checks the HTTP status and parses the JSON response.
 *
 * @param {string} path    path after API_BASE, e.g. '/api/v1/chat-message'
 * @param {object} options fetch options: method, body, ...
 * @returns {Promise<any>} the parsed response body, or null if not logged in
 * @throws  {Error}        when the server answers with a non-2xx status
 */
async function apiRequest(path, options = {}) {
    const jwt = requireJwt();
    if (!jwt) {
        return null;
    }

    const headers = {'Authorization': 'Bearer ' + jwt};
    // FormData builds its own Content-Type (it contains a random boundary),
    // so we only set it ourselves for normal JSON bodies.
    if (!(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(API_BASE + path, {...options, headers});

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Request failed (${response.status}): ${errorText}`);
    }
    // 204 No Content has an empty body, so there is nothing to parse.
    if (response.status === 204) {
        return null;
    }
    return response.json();
}


/* =============================================================================
 * 6. WEBSOCKET LAYER
 * ========================================================================== */

/**
 * Opens the WebSocket connection.
 *
 * The STOMP library uses callbacks, so we wrap it in a Promise to be able to
 * `await` it in the startup function.
 *
 * @returns {Promise<void>} resolves when connected, rejects when it fails
 */
function connectWebSocket() {
    const jwt = requireJwt();
    if (!jwt) {
        return Promise.resolve();
    }

    const socket = new SockJS(`${API_BASE}/ws`);
    stompClient = Stomp.over(socket);

    return new Promise((resolve, reject) => {
        stompClient.connect(
            {Authorization: 'Bearer ' + jwt},
            () => resolve(),
            (error) => reject(error)
        );
    });
}

/** @returns {boolean} true when messages can be sent over the WebSocket. */
function isSocketConnected() {
    return stompClient !== null && stompClient.connected;
}

/**
 * Subscribes to the three private queues of the logged-in user.
 * These carry events from one-to-one chats.
 */
function subscribeToUserQueues() {
    // TODO Yegingi darslarda qilinadi
}

/**
 * Shows "<name> is typing..." and hides it again after a short pause.
 *
 * @param {object} messageDto contains senderId and name
 */
function onUserTypingReceived(messageDto) {
    if (messageDto.senderId === currentProfileId) {
        return;
    }

    typingUserSpan.innerText = `${messageDto.name} is typing...`;
    typingIndicator.style.display = 'flex';

    // Restart the timer on every signal, so the text stays while typing continues.
    clearTimeout(typingIndicatorTimer);
    typingIndicatorTimer = setTimeout(() => {
        typingIndicator.style.display = 'none';
    }, TYPING_INDICATOR_HIDE_MS);
}


/* =============================================================================
 * 7. CHAT LIST (left sidebar)
 * ========================================================================== */

/** Loads the chat list from the server, draws it and subscribes to its topics. */
async function loadChatList() {
    try {
        const page = await apiRequest(`/api/v1/chat?page=1&size=100`);
        if (!page) {
            return;
        }
        chatList = page.content;
        renderChatList(chatList);

        if (isSocketConnected()) {
            subscribeToUserQueues();
        }
    } catch (error) {
        console.error('Could not load the chat list:', error);
    }
}

/**
 * Draws the sidebar. Replaces the whole list at once, which is faster than
 * inserting the items one by one.
 *
 * @param {Array} chats chats to show
 */
function renderChatList(chats) {
    chatListContainer.innerHTML = chats.map(chat => {
        console.log(chat);
        const photoUrl = chat.photo?.url || './img/user-def.jpg';
        const lastMessage = chat.message || {};

        return `
            <div class="chat-item" id="${chat.id}"
                 data-chat-type="${chat.chatType}">
                <div class="chat-avatar">
                    <img src="${photoUrl}" alt="">
                </div>
                <div class="chat-info">
                    <div class="chat-name">${escapeHtml(chat.name)}</div>
                    ${lastMessage.content
            ? `<div class="chat-last-message">${escapeHtml(lastMessage.content)}</div>`
            : ''}
                </div>
                <div class="chat-meta">
                    ${lastMessage.content
            ? `<div class="chat-time">${formatDateTime(lastMessage.createdDate)}</div>`
            : ''}
                    ${chat.unreadMessageCount
            ? `<div class="chat-unread">${chat.unreadMessageCount}</div>`
            : ''}
                </div>
            </div>`;
    }).join('');
}

/* =============================================================================
 * 20. SMALL UTIL/HELPERS
 * ========================================================================== */

/**
 * Formats an ISO timestamp as "yyyy-MM-dd HH:mm".
 *
 * @param {string} isoDateTime
 * @returns {string}
 */
function formatDateTime(isoDateTime) {
    if (!isoDateTime) {
        return '';
    }
    const date = new Date(isoDateTime);

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // months start at 0
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Escapes text before it is put into HTML.
 *
 * Message text comes from other users. Without escaping, someone could send
 * `<script>...</script>` and it would run in everyone's browser (XSS).
 *
 * @param {string} text
 * @returns {string} safe text
 */
function escapeHtml(text) {
    if (text === null || text === undefined) {
        return '';
    }
    // Assigning to textContent and reading back innerHTML lets the browser
    // do the escaping for us.
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

