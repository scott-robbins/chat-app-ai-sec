const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const settingsDropdown = document.getElementById("settings-dropdown");

let chatHistory = [];
let sessionId = localStorage.getItem("chatSessionId") || crypto.randomUUID();
localStorage.setItem("chatSessionId", sessionId);

function toggleSettings() { settingsDropdown.classList.toggle('show'); }

function toggleTheme() {
    const body = document.body;
    const isFancy = body.classList.contains("theme-fancy");
    body.classList.remove("theme-fancy", "theme-plain");
    const newTheme = isFancy ? "plain" : "fancy";
    body.classList.add(`theme-${newTheme}`);
    localStorage.setItem("chatTheme", newTheme);
    settingsDropdown.classList.remove('show');
}

function openSidebar() { alert("Sidebar Opening..."); settingsDropdown.classList.remove('show'); }
function openHelp() { alert("Help Opening..."); settingsDropdown.classList.remove('show'); }

function clearScreen() { chatMessages.innerHTML = '<p>Cleared.</p>'; chatHistory = []; }

function newChat() { localStorage.removeItem("chatSessionId"); location.reload(); }

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;
    
    // Add user message to UI
    const userDiv = document.createElement("div");
    userDiv.innerHTML = `<p><b>You:</b> ${text}</p>`;
    chatMessages.appendChild(userDiv);
    userInput.value = "";

    chatHistory.push({ role: "user", content: text });

    const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({ messages: chatHistory })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let assistantText = "";
    
    const assistDiv = document.createElement("div");
    chatMessages.appendChild(assistDiv);

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const data = JSON.parse(line.slice(6));
                assistantText += data.response;
                assistDiv.innerHTML = `<p><b>Jolene:</b> ${assistantText}</p>`;
            }
        }
    }
    chatHistory.push({ role: "assistant", content: assistantText });
}
