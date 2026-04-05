const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const modelSelector = document.getElementById("model-selector");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// Theme Logic
if (localStorage.getItem("chatTheme") === "fancy") document.body.classList.add("theme-fancy");
themeToggleBtn?.addEventListener("click", () => {
    document.body.classList.toggle("theme-fancy");
    localStorage.setItem("chatTheme", document.body.classList.contains("theme-fancy") ? "fancy" : "plain");
});

// Init - Hydrate from D1
async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (res.ok) {
            const data = await res.json();
            // CLEAR first to prevent double greetings
            chatMessages.innerHTML = ''; 
            
            if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                chatHistory.forEach(msg => { 
                    if (msg.role !== "system") addMessageToChat(msg.role, msg.content); 
                });
            } else {
                addMessageToChat('assistant', "Hi there! I'm Jolene. I'm here to help you brainstorm, analyze files, or just chat. What's on your mind today?");
            }
        }
    } catch (e) {
        console.error("History failed to load:", e);
    }
}
init();

// Visual Feedback when Model is Switched
modelSelector?.addEventListener("change", () => {
    const selectedModelName = modelSelector.options[modelSelector.selectedIndex].text;
    addMessageToChat('assistant', `*Switched brain to **${selectedModelName}**. Our conversation continues!*`);
});

// Reusable rendering logic that handles both Markdown and Base64 Images
function renderContent(element, content) {
    // This Regex is robust: it looks for the Base64 data URL pattern directly
    const base64Regex = /data:image\/.*?;base64,[A-Za-z0-9+/=]+/g;
    const foundBase64 = content.match(base64Regex);

    if (foundBase64) {
        // 1. Remove the raw Markdown syntax and the giant Base64 strings from the text content
        // This prevents the "wall of text" from showing up
        let cleanText = content.replace(/!\[.*?\]\(.*?\)/g, "").replace(base64Regex, "");
        
        // 2. Create actual HTML image tags for each found image
        let imageTags = foundBase64.map(url => 
            `<img src="${url}" style="max-width: 100%; border-radius: 12px; margin-top: 10px; box-shadow: 0 8px 25px rgba(0,0,0,0.4); display: block;" alt="Generated Image" />`
        ).join("");
        
        // 3. Render the remaining text as Markdown and append the images
        element.innerHTML = marked.parse(cleanText) + imageTags;
    } else {
        // Standard Markdown rendering
        element.innerHTML = marked.parse(content);
    }
}

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    
    typingIndicator?.classList.add("visible");
    chatMessages.scrollTop = chatMessages.scrollHeight;

    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ 
                messages: chatHistory,
                model: modelSelector?.value || "@cf/meta/llama-3.2-11b-vision-instruct"
            }),
        });

        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        typingIndicator?.classList.remove("visible");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const msgEl = createMessageElement("assistant");
        chatMessages.appendChild(msgEl);
        const contentEl = msgEl.querySelector(".message-content");
        
        let text = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const dataString = line.slice(6).trim();
                    if (dataString === "[DONE]") break;
                    
                    try {
                        const json = JSON.parse(dataString);
                        const content = json.response || json.choices?.[0]?.delta?.content || "";
                        text += content;

                        // LIVE RENDER: Handled by our robust renderContent function
                        renderContent(contentEl, text);
                    } catch (e) {}
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        chatHistory.push({ role: "assistant", content: text });

    } catch (err) {
        typingIndicator?.classList.remove("visible");
        addMessageToChat("assistant", "**Error:** " + err.message);
    } finally {
        isProcessing = false;
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
}

function createMessageElement(role) {
    const div = document.createElement("div");
    div.className = `message ${role}-message`;
    div.innerHTML = `<div class="message-content"></div>`;
    return div;
}

function addMessageToChat(role, content) {
    const el = createMessageElement(role);
    const contentEl = el.querySelector(".message-content");
    const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
    
    renderContent(contentEl, safeContent);
    
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

sendButton?.addEventListener("click", sendMessage);
userInput?.addEventListener("keydown", (e) => { 
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } 
});

newChatBtn?.addEventListener("click", () => {
    localStorage.removeItem("chatSessionId");
    location.reload(); 
});

clearScreenBtn?.addEventListener("click", () => {
    chatMessages.innerHTML = '';
    addMessageToChat('assistant', "Screen cleared! I'm ready for a fresh start. What's on your mind?");
});
