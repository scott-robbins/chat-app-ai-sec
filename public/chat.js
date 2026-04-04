/**
 * LLM Chat App Frontend - Final Stable Release
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const clearScreenBtn = document.getElementById("clear-screen-btn");
const newChatBtn = document.getElementById("new-chat-btn");
const fileUpload = document.getElementById("file-upload");
const themeToggleBtn = document.getElementById("theme-toggle-btn");

let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

let chatHistory = [];
let isProcessing = false;
let pendingImageBase64 = null; 

marked.setOptions({ breaks: true });

async function init() {
    try {
        const res = await fetch('/api/history', { headers: { 'x-session-id': sessionId } });
        if (res.ok) {
            const data = await res.json();
            chatMessages.innerHTML = ''; 
            if (data.messages && data.messages.length > 0) {
                chatHistory = data.messages;
                chatHistory.forEach(msg => { if (msg.role !== "system") addMessageToChat(msg.role, msg.content); });
            } else {
                addMessageToChat('assistant', 'Hello! I am Jolene, an LLM chat app powered by Cloudflare Workers AI. How can I help you today?');
            }
        }
    } catch (e) { 
        addMessageToChat('assistant', 'Hello! I am Jolene. Ready to assist.'); 
    }
}

init();

if (fileUpload) {
    fileUpload.addEventListener("change", () => {
        const file = fileUpload.files[0];
        if (file && file.type.startsWith("image/")) {
            const reader = new FileReader();
            reader.onload = (e) => {
                pendingImageBase64 = e.target.result;
                addMessageToChat('system', `**SYSTEM:** Attached \`${file.name}\`.`);
            };
            reader.readAsDataURL(file);
        }
    });
}

userInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
sendButton.addEventListener("click", sendMessage);

async function sendMessage() {
    const message = userInput.value.trim();
    if (message === "" || isProcessing) return;

    isProcessing = true;
    userInput.disabled = true;
    sendButton.disabled = true;
    addMessageToChat("user", message);
    userInput.value = "";
    typingIndicator.classList.add("visible");
    chatHistory.push({ role: "user", content: message });

    let assistantTextEl;
    let assistantMessageEl;

    try {
        assistantMessageEl = document.createElement("div");
        assistantMessageEl.className = "message assistant-message";
        assistantMessageEl.innerHTML = "<div class='message-content'></div>";
        chatMessages.appendChild(assistantMessageEl);
        assistantTextEl = assistantMessageEl.querySelector(".message-content");
        chatMessages.scrollTop = chatMessages.scrollHeight;

        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory, image: pendingImageBase64 }),
        });

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json")) {
            const data = await response.json();
            if (data.image) {
                typingIndicator.classList.remove("visible");
                // Cleanest possible injection to avoid parsing issues
                const img = document.createElement("img");
                img.src = data.image;
                img.style.width = "100%";
                img.style.borderRadius = "12px";
                img.style.marginTop = "10px";
                img.style.display = "block";
                
                assistantTextEl.innerHTML = `<p><strong>Jolene's Vision:</strong> "${data.prompt}"</p>`;
                assistantTextEl.appendChild(img);
                
                chatHistory.push({ role: "assistant", content: `Generated Image: ${data.prompt}` });
                chatMessages.scrollTop = chatMessages.scrollHeight;
                return;
            }
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let responseText = "";
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");
            buffer = lines.pop();
            for (const line of lines) {
                const data = line.replace(/^data: /, "").trim();
                if (data === "[DONE]") break;
                try {
                    const json = JSON.parse(data);
                    responseText += json.response || json.choices?.[0]?.delta?.content || "";
                    assistantTextEl.innerHTML = marked.parse(responseText);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                } catch (e) {}
            }
        }
        chatHistory.push({ role: "assistant", content: responseText });

    } catch (error) {
        if (assistantTextEl) assistantTextEl.innerHTML = "<p>Error processing request.</p>";
    } finally {
        typingIndicator.classList.remove("visible");
        isProcessing = false;
        userInput.disabled = false;
        sendButton.disabled = false;
        pendingImageBase64 = null;
    }
}

function addMessageToChat(role, content) {
    const messageEl = document.createElement("div");
    messageEl.className = `message ${role}-message`;
    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    contentEl.innerHTML = (role === "user") ? content : marked.parse(content);
    messageEl.appendChild(contentEl);
    chatMessages.appendChild(messageEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

if (newChatBtn) newChatBtn.addEventListener("click", () => { sessionId = crypto.randomUUID(); localStorage.setItem("chatSessionId", sessionId); location.reload(); });
if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
        document.body.classList.toggle("theme-fancy");
        localStorage.setItem("chatTheme", document.body.classList.contains("theme-fancy") ? "fancy" : "plain");
    });
}
if (localStorage.getItem("chatTheme") === "fancy") document.body.classList.add("theme-fancy");
