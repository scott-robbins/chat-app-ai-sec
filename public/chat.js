const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const fileInput = document.getElementById("file-input");
const modelSelector = document.getElementById("model-selector");

let chatHistory = [];
let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

// UI CONTROLS
function toggleTheme() {
    const isFancy = document.body.classList.contains("theme-fancy");
    document.body.className = isFancy ? "theme-plain" : "theme-fancy";
    localStorage.setItem("chatTheme", isFancy ? "plain" : "fancy");
    addMessageToChat('assistant', `Theme switched to **${isFancy ? "plain" : "fancy"}** mode.`);
}

function openSidebar() {
    document.getElementById("memory-sidebar").classList.toggle("open");
    updateSidebarContent();
}

function openHelp() {
    const modal = document.getElementById("help-modal");
    modal.style.display = (modal.style.display === "flex") ? "none" : "flex";
}

function modelChanged() {
    const name = modelSelector.options[modelSelector.selectedIndex].text;
    addMessageToChat('assistant', `I'm now using the **${name}** model.`);
}

function clearScreen() {
    chatMessages.innerHTML = `<div class="message assistant-message"><p>Screen cleared! What's next?</p></div>`;
    chatHistory = [];
}

function newChat() {
    if(confirm("Start a new session?")) {
        localStorage.removeItem("chatSessionId");
        location.reload();
    }
}

// CORE CHAT
async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    const uDiv = document.createElement("div");
    uDiv.innerHTML = `<p style="text-align:right; color:#f6821f; margin-bottom:1rem;"><b>You:</b> ${text}</p>`;
    chatMessages.appendChild(uDiv);
    userInput.value = "";
    chatHistory.push({ role: "user", content: text });

    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-session-id": sessionId },
            body: JSON.stringify({ messages: chatHistory, model: modelSelector.value })
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let aiText = "";
        const aDiv = document.createElement("div");
        chatMessages.appendChild(aDiv);

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = JSON.parse(line.slice(6));
                    aiText += data.response;
                    aDiv.innerHTML = `<p><b>Jolene:</b> ${aiText}</p>`;
                }
            }
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        chatHistory.push({ role: "assistant", content: aiText });
    } catch (e) { console.error(e); }
}

async function updateSidebarContent() {
    try {
        const res = await fetch("/api/profile", { headers: { 'x-session-id': sessionId } });
        const data = await res.json();
        document.getElementById("kv-profile-display").innerText = data.profile || "No profile data yet.";
    } catch (e) { console.log("Sidebar failed to load."); }
}

async function memorizeFile() {
    const file = fileInput.files[0];
    if (!file) return alert("Please select a file first.");
    const formData = new FormData();
    formData.append("file", file);
    try {
        const res = await fetch("/api/memorize", { method: "POST", headers: { "x-session-id": sessionId }, body: formData });
        if (res.ok) addMessageToChat('assistant', `I've memorized **${file.name}**.`);
    } catch (e) { alert("Upload failed."); }
}

function addMessageToChat(role, content) {
    const div = document.createElement("div");
    div.innerHTML = `<p><b>Jolene:</b> ${content}</p>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
