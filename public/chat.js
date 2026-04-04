const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const themeToggleBtn = document.getElementById("theme-toggle-btn");
const newChatBtn = document.getElementById("new-chat-btn");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);
let chatHistory = [];
let isProcessing = false;

// Theme Logic
if (localStorage.getItem("chatTheme") === "fancy") document.body.classList.add("theme-fancy");
themeToggleBtn.addEventListener("click", () => {
    document.body.classList.toggle("theme-fancy");
    localStorage.setItem("chatTheme", document.body.classList.contains("theme-fancy") ? "fancy" : "plain");
});

// Init
async function init() {
    addMessageToChat('assistant', 'Hello! I am Jolene, an LLM chat app powered by Cloudflare Workers AI. How can I help you today?');
}
init();

sendButton.addEventListener("click", sendMessage);
userInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

async function sendMessage() {
    const message = userInput.value.trim();
    if (!message || isProcessing) return;

    isProcessing = true;
    addMessageToChat("user", message);
    userInput.value = "";
    typingIndicator.classList.add("visible");
    chatHistory.push({ role: "user", content: message });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory }),
        });

        const contentType = response.headers.get("Content-Type") || "";

        // IMAGE HANDLER
        if (contentType.includes("image/png")) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const prompt = decodeURIComponent(response.headers.get("x-prompt") || "Image");
            typingIndicator.classList.remove("visible");
            
            const msgEl = createMessageElement("assistant");
            msgEl.querySelector(".message-content").innerHTML = `<p><strong>Jolene's Vision:</strong> "${prompt}"</p><img src="${url}" style="width:100%; border-radius:12px; margin-top:10px; display:block;" />`;
            chatMessages.appendChild(msgEl);
            chatHistory.push({ role: "assistant", content: "[Image]" });
        } 
        // TEXT HANDLER
        else {
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
                        const data = line.slice(6).trim();
                        if (data === "[DONE]") break;
                        try {
                            const json = JSON.parse(data);
                            text += json.response || json.choices?.[0]?.delta?.content || "";
                            contentEl.innerHTML = marked.parse(text);
                        } catch (e) {}
                    }
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
            chatHistory.push({ role: "assistant", content: text });
        }
    } catch (err) {
        addMessageToChat("assistant", "Error: " + err.message);
    } finally {
        typingIndicator.classList.remove("visible");
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
    el.querySelector(".message-content").innerHTML = role === "user" ? content : marked.parse(content);
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

newChatBtn.addEventListener("click", () => { localStorage.removeItem("chatSessionId"); location.reload(); });
